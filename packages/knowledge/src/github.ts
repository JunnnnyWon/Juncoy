import { createHmac, sign as cryptoSign, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { KnowledgeStore, sql, first } from '@meeting/knowledge-db';
import { documentKeys } from '@meeting/contracts';
import { queueExtract } from './indexer.ts';

// GitHub 수집기 — spec §6.2.
// ref별 HEAD/tree/blob으로 현재 코드를 추적하고, push/delete/force-push/revert를
// tree diff로 반영한다. webhook은 재조회 신호일 뿐 원문 자체가 아니다.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── GitHub App 인증: RS256 JWT + installation access token (§2.3 C02) ──
const base64url = (s: string | Buffer) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function appJwt(appId: string, privateKeyPem: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const body =
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
    '.' +
    base64url(JSON.stringify(payload));
  return body + '.' + base64url(cryptoSign('RSA-SHA256', Buffer.from(body), privateKeyPem));
}

// X-Hub-Signature-256 검증 — timing-safe 비교 (§6.2).
export function verifyWebhookSignature(secret: string, rawBody: string, signature: string | null) {
  if (!signature?.startsWith('sha256=')) return false;
  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface TokenProvider {
  token(): Promise<string>;
}
/** App installation 토큰 캐시 — 1시간 유효, 5분 여유 갱신. */
export class InstallationTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly installationId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async token() {
    if (this.cached && this.cached.expiresAt > Date.now() + 5 * 60_000) return this.cached.token;
    const res = await this.fetchImpl(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt(this.appId, this.privateKeyPem)}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!res.ok) throw new Error(`installation token failed: ${res.status}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    this.cached = { token: body.token, expiresAt: new Date(body.expires_at).getTime() };
    return body.token;
  }
}
/** PAT/고정 토큰 — 개발·fixture용. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly t: string) {}
  async token() {
    return this.t;
  }
}

export class GitHubRest {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async request(path: string, params?: Record<string, string>) {
    for (let attempt = 0; ; attempt++) {
      const url = new URL(`https://api.github.com${path}`);
      for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
      const res = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${await this.tokens.token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(30_000),
      });
      const retryAfter = Number(res.headers.get('retry-after'));
      const remaining = res.headers.get('x-ratelimit-remaining');
      if ((res.status === 429 || res.status === 403 && remaining === '0') && attempt < 3) {
        await sleep((retryAfter || 60) * 1000 + Math.random() * 500);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(2 ** attempt * 500 + Math.random() * 250);
        continue;
      }
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* 빈 본문 */
      }
      return { status: res.status, body, headers: res.headers };
    }
  }
  branch(repo: string, ref: string) {
    return this.request(`/repos/${repo}/branches/${encodeURIComponent(ref)}`);
  }
  tree(repo: string, sha: string) {
    return this.request(`/repos/${repo}/git/trees/${sha}`, { recursive: '1' });
  }
  blob(repo: string, sha: string) {
    return this.request(`/repos/${repo}/git/blobs/${sha}`);
  }
  /** ref의 tarball — codeload 리다이렉트를 따라간다. 첫 백필용 대용량 응답. */
  async tarball(repo: string, ref: string) {
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${await this.tokens.token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(300_000),
        redirect: 'follow',
      },
    );
    if (!res.ok) return { status: res.status, buf: null };
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  }
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

/** 최소 ustar 파서 — ref tarball 백필용. prefix 디렉터리 엔트리를 벗겨 path→내용 맵을 만든다. */
export function untar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  let prefix = '';
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/\/$/, '');
  while (off + 512 <= buf.length) {
    const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break; // end blocks
    const size = parseInt(buf.subarray(off + 124, off + 136).toString('utf8').trim(), 8) || 0;
    const type = String.fromCharCode(buf[off + 156]);
    const pfx = buf.subarray(off + 345, off + 500).toString('utf8').replace(/\0.*$/, '');
    const full = norm(pfx ? `${pfx}/${name}` : name);
    off += 512;
    if ((type === '0' || type === '') && full) {
      const content = buf.subarray(off, off + size);
      // 첫 경로 구성 요소(<repo>-<sha>)를 벗긴 상대 경로로 저장한다.
      const rel = prefix
        ? full === prefix
          ? ''
          : full.startsWith(prefix + '/')
            ? full.slice(prefix.length + 1)
            : full
        : full.includes('/')
          ? full.slice(full.indexOf('/') + 1)
          : full;
      if (rel) out.set(rel, content);
    } else if (type === '5' && !prefix && full) {
      prefix = full; // 첫 디렉터리 엔트리가 <repo>-<sha>/ 형태의 루트
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

export class GitHubCollector {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly rest: GitHubRest,
    private readonly repo: string, // "owner/name"
    private readonly repoId: string, // 안정 식별자 (rename 무관)
    private readonly sourceId: string,
  ) {}

  private cursorKey(ref: string) {
    return `ref:${ref}`;
  }
  private async lastHead(ref: string) {
    const row = await first<{ cursor: any }>(
      sql`SELECT cursor FROM connector_cursors WHERE source_id=${this.sourceId} AND scope_key=${this.cursorKey(ref)}`,
      this.store.db,
    );
    return (row?.cursor ?? {}) as { head_sha?: string; tree?: Record<string, string> };
  }
  private async saveCursor(ref: string, cursor: object) {
    await sql`
      INSERT INTO connector_cursors(source_id, scope_key, cursor, last_reconciled_at, updated_at)
      VALUES (${this.sourceId}, ${this.cursorKey(ref)}, ${JSON.stringify(cursor)}::jsonb, now(), now())
      ON CONFLICT (source_id, scope_key) DO UPDATE
        SET cursor=EXCLUDED.cursor, last_reconciled_at=now(), updated_at=now()`.execute(
      this.store.db,
    );
  }

  /** recursive tree의 blob 경로→SHA 맵. truncated면 잘린 하위 tree만 비재귀로 재조회 (§6.2-7). */
  private async flattenTree(sha: string): Promise<Record<string, string>> {
    const r = await this.rest.tree(this.repo, sha);
    if (r.status !== 200 || !Array.isArray(r.body?.tree)) {
      process.stderr.write(`github tree ${sha.slice(0, 8)}: status ${r.status}\n`);
      return {};
    }
    const out: Record<string, string> = {};
    for (const e of r.body.tree as TreeEntry[]) if (e.type === 'blob') out[e.path] = e.sha;
    if (r.body.truncated) {
      // 응답이 잘렸다 — 'tree' 엔트리별로 비재귀 조회해 누락분을 메운다.
      const fill = async (treeSha: string, prefix: string) => {
        const sub = await this.rest.request(
          `/repos/${this.repo}/git/trees/${treeSha}`,
        );
        if (sub.status !== 200 || !Array.isArray(sub.body?.tree)) return;
        for (const e of sub.body.tree as TreeEntry[]) {
          const p = prefix ? `${prefix}/${e.path}` : e.path;
          if (e.type === 'blob') out[p] = e.sha;
          else if (e.type === 'tree') await fill(e.sha, p);
        }
      };
      for (const e of r.body.tree as TreeEntry[])
        if (e.type === 'tree') await fill(e.sha, e.path);
    }
    return out;
  }

  /**
   * ref HEAD 대조 — push/rename/delete/force-push/revert를 모두 tree diff로 커버한다.
   * 반환: {changed, head, added, removed}
   */
  async reconcileRef(ref: string) {
    const prev = await this.lastHead(ref);
    const br = await this.rest.branch(this.repo, ref);
    if (br.status === 404) {
      // 브랜치 삭제 — 기존 문서 전부 tombstone.
      if (prev.tree)
        for (const path of Object.keys(prev.tree))
          await this.store.applyTombstone(
            documentKeys.githubFile(this.repoId, ref, path),
            this.sourceId,
            'ref_deleted',
          );
      await this.saveCursor(ref, { head_sha: null, tree: {} });
      return { changed: true, deleted_ref: true };
    }
    if (br.status !== 200) return { changed: false, status: br.status };
    const head = br.body.commit?.sha as string;
    if (!head || head === prev.head_sha) return { changed: false, head };
    const tree = await this.flattenTree(head);
    const old = prev.tree ?? {};
    const added = Object.keys(tree).filter((p) => !(p in old));
    const modified = Object.keys(tree).filter((p) => p in old && old[p] !== tree[p]);
    const removed = Object.keys(old).filter((p) => !(p in tree));
    process.stdout.write(
      `github ${this.repo}@${ref} head=${head.slice(0, 8)} files=${Object.keys(tree).length} +${added.length} ~${modified.length} -${removed.length}\n`,
    );
    const work = [...added, ...modified];
    // 첫 동기화(빈 cursor)는 blob GET × N 대신 tarball 1회 다운로드로 수집한다.
    let tarContents: Map<string, Buffer> | null = null;
    if (!prev.head_sha && work.length > 0) {
      const t = await this.rest.tarball(this.repo, ref);
      if (t.status === 200 && t.buf) {
        tarContents = untar(gunzipSync(t.buf));
        process.stdout.write(
          `github ${this.repo}@${ref} tarball ${t.buf.length}B → ${tarContents.size} files\n`,
        );
      } else process.stderr.write(`github ${this.repo}@${ref} tarball ${t.status} — blob 경로로 대체\n`);
    }
    // 파일당 REST 1회 + DB 왕복 수 회라 직렬은 느리다 — 8개씩 병렬 수집.
    const PAR = 8;
    for (let i = 0; i < work.length; i += PAR) {
      if (i && i % 200 === 0)
        process.stdout.write(`github ${this.repo}@${ref} ingest ${i}/${work.length}\n`);
      await Promise.all(
        work.slice(i, i + PAR).map((p) =>
          this.ingestFile(ref, p, tree[p], head, tarContents?.get(p)).catch((e) => {
            process.stderr.write(`github ingest ${p}: ${e}\n`);
          }),
        ),
      );
    }
    for (const p of removed)
      await this.store.applyTombstone(
        documentKeys.githubFile(this.repoId, ref, p),
        this.sourceId,
        'path_removed',
        old[p],
      );
    await this.saveCursor(ref, { head_sha: head, tree });
    return { changed: true, head, added: added.length, modified: modified.length, removed: removed.length };
  }

  /** blob 내용을 문서로 기록. LFS 포인터는 내용을 읽은 것으로 표시하지 않는다 (§6.2-8). */
  private async ingestFile(
    ref: string,
    path: string,
    blobSha: string,
    head: string,
    tarContent?: Buffer,
  ) {
    const key = documentKeys.githubFile(this.repoId, ref, path);
    const ok = await this.store.markDocumentDirty(this.sourceId, key, {
      repo: this.repo,
      ref,
      path,
    });
    if (!ok) return;
    const doc = await first<{ id: string; current_version_id: string | null }>(
      sql`SELECT id, current_version_id FROM documents WHERE source_id=${this.sourceId} AND stable_key=${key}`,
      this.store.db,
    );
    if (!doc) return;
    // 동일 blob 재사용 — 내용이 같으면 재조회 없이 revision만 갱신한다 (§6.2-5).
    const cur = await first<{ content_hash: string }>(
      sql`SELECT v.content_hash FROM documents d
          JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=${doc.id}`,
      this.store.db,
    );
    if (cur?.content_hash === blobSha) {
      await sql`UPDATE documents SET dirty=false, updated_at=now() WHERE id=${doc.id}`.execute(
        this.store.db,
      );
      return;
    }
    let buf: Buffer | null = tarContent ?? null;
    if (!buf) {
      const b = await this.rest.blob(this.repo, blobSha);
      if (b.status === 200 && b.body?.encoding === 'base64' && typeof b.body.content === 'string')
        buf = Buffer.from(b.body.content.replace(/\n/g, ''), 'base64');
    }
    let text: string | null = null;
    let lfsPointer = false;
    let oversize = false;
    if (buf) {
      // git-lfs pointer 판별 (version https://git-lfs.github.com/spec/v1 헤더)
      const head = buf.subarray(0, 200).toString('utf8');
      // NUL 바이트가 있으면 바이너리 — utf8 강제 변환은 pg text가 거부하는 \u0000을 만든다.
      const isBinary = buf.subarray(0, 8000).includes(0x00);
      if (head.startsWith('version https://git-lfs.github.com/spec/v1')) lfsPointer = true;
      else if (buf.length > 2_000_000) oversize = true;
      else if (!isBinary) text = buf.toString('utf8').replace(/\u0000/g, '');
    }
    const published = await this.store.publishVersion(doc.id, {
      contentHash: blobSha, // blob SHA 자체가 내용 해시 (§6.2-5)
      sourceRevision: `${head}:${blobSha}`,
      sourceModifiedAt: new Date(),
      normalized: {
        text: text ?? '',
        path,
        ref,
        binary: text === null && !lfsPointer && !oversize,
        lfs_pointer: lfsPointer,
        oversize,
        sha: blobSha,
      },
    });
    if (published) await queueExtract(this.store, doc.id, blobSha);
  }
}

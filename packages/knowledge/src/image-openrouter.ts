import { sql } from 'kysely';
import { first, rows, type KnowledgeStore } from '@meeting/knowledge-db';
import { createHash, randomUUID } from 'node:crypto';
import type { UploadStorage } from './uploads.ts';

// 이미지 생성 — OpenRouter 경유 (사용자 지정: GPT image2.5 Flare 계열).
// OpenRouter 전용 이미지 endpoint만 사용한다. 이미지 입력을 지원하지 않는
// 모델로 chat/completions에 조용히 폴백하지 않는다.
// 429/5xx는 지수 백오프 재시도, 일일 쿼터와 동시 실행 상한을 둔다 (spec §12).

export interface ImageResult {
  b64: string;
  width?: number;
  height?: number;
}
export interface ImageReferenceInput {
  bytes: Buffer;
  mime: string;
  role?: string;
  instruction?: string;
}

export class OpenRouterImages {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(
    private apiKey: string,
    private model: string,
    private concurrency = 2,
    private baseUrl = 'https://openrouter.ai/api/v1',
  ) {}

  private async acquire() {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
    this.running++;
  }
  private release() {
    this.running--;
    this.queue.shift()?.();
  }

  /** 모델 카탈로그에서 slug 존재 여부 확인 — 설정 검증용. */
  async checkModel(): Promise<boolean> {
    const r = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!r.ok) return false;
    const body = (await r.json()) as any;
    return (body.data ?? []).some((m: any) => m.id === this.model);
  }

  /** 실제 생성. 결과는 base64 png/jpeg. 실패 시 throw. */
  async generate(
    prompt: string,
    negative?: string,
    references: ImageReferenceInput[] = [],
  ): Promise<ImageResult> {
    const fullPrompt = negative ? `${prompt}\n\n제외: ${negative}` : prompt;
    await this.acquire();
    try {
      return await this.withRetry(() => this.callImages(fullPrompt, references));
    } finally {
      this.release();
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let delay = 1500;
    for (let i = 0; i < 4; i++) {
      try {
        return await fn();
      } catch (e: any) {
        const status = e?.status ?? 0;
        if (e?.code === 'images_api_unsupported') throw e;
        if (status !== 429 && status < 500) throw e;
        if (i === 3) throw e;
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      }
    }
    throw new Error('unreachable');
  }

  private async callImages(
    prompt: string,
    references: ImageReferenceInput[],
  ): Promise<ImageResult> {
    const r = await fetch(`${this.baseUrl}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt: references.length
          ? prompt +
            '\n\nReference use instructions:\n' +
            references
              .map(
                (r) => (r.role ?? 'reference') + ': ' + (r.instruction ?? 'use as reference only'),
              )
              .join('\n')
          : prompt,
        n: 1,
        input_references: references.map((r) => ({
          type: 'image_url',
          image_url: { url: 'data:' + r.mime + ';base64,' + r.bytes.toString('base64') },
        })),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (r.status === 404 || r.status === 400)
      throw Object.assign(new Error(`openrouter_${r.status}`), { status: r.status });
    if (!r.ok) throw Object.assign(new Error(`openrouter_${r.status}`), { status: r.status });
    const body = (await r.json()) as any;
    const item = body.data?.[0];
    if (item?.b64_json) return { b64: item.b64_json };
    if (item?.url) {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) throw new Error(`image_fetch_${img.status}`);
      return { b64: Buffer.from(await img.arrayBuffer()).toString('base64') };
    }
    throw new Error('empty_image_response');
  }

  private async callChat(prompt: string, references: ImageReferenceInput[]): Promise<ImageResult> {
    const r = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        modalities: ['image', 'text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...references.map((r) => ({
                type: 'image_url',
                image_url: { url: 'data:' + r.mime + ';base64,' + r.bytes.toString('base64') },
              })),
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) throw Object.assign(new Error(`openrouter_${r.status}`), { status: r.status });
    const body = (await r.json()) as any;
    const msg = body.choices?.[0]?.message;
    // OpenRouter image 응답: message.images[0].image_url.url (data:image/...;base64,...)
    const url = msg?.images?.[0]?.image_url?.url ?? msg?.images?.[0]?.url;
    if (typeof url === 'string' && url.startsWith('data:')) {
      const b64 = url.slice(url.indexOf(',') + 1);
      return { b64 };
    }
    throw new Error('no_image_in_response');
  }
}

// ── 잡/결과 저장소 도우미 ────────────────────────────────────────────

export async function imageCountToday(store: KnowledgeStore, projectId: string) {
  const r = await first<{ c: string }>(
    sql`SELECT count(*)::text AS c FROM image_jobs
        WHERE project_id=${projectId} AND created_at > date_trunc('day', now())`,
    store.db,
  );
  return Number(r?.c ?? 0);
}

export async function createImageJob(
  store: KnowledgeStore,
  j: {
    projectId: string;
    ownerId: string;
    approvalId?: string;
    model: string;
    prompt: string;
    negative?: string;
    evidence?: unknown;
    options?: unknown;
    idempotencyKey: string;
  },
) {
  const id = randomUUID();
  const promptHash = createHash('sha256').update(j.prompt).digest('hex');
  const r = await first<{ id: string }>(
    sql`INSERT INTO image_jobs(id, project_id, owner_id, approval_id, status, provider,
            model, prompt, negative_prompt, evidence, prompt_hash, options, idempotency_key)
        VALUES (${id}, ${j.projectId}, ${j.ownerId}, ${j.approvalId ?? null}, 'PENDING',
            'openrouter', ${j.model}, ${j.prompt}, ${j.negative ?? null},
            ${JSON.stringify(j.evidence ?? [])}, ${promptHash},
            ${JSON.stringify(j.options ?? {})}, ${j.idempotencyKey})
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id`,
    store.db,
  );
  if (r) return { id: r.id, created: true };
  const existing = await first<{ id: string; status: string }>(
    sql`SELECT id, status FROM image_jobs WHERE idempotency_key=${j.idempotencyKey}`,
    store.db,
  );
  return { id: existing!.id, created: false };
}

export async function getImageJobResult(store: KnowledgeStore, projectId: string, jobId: string) {
  return first<any>(sql`
    SELECT j.id, j.status, j.error, r.id AS result_id
    FROM image_jobs j
    LEFT JOIN image_results r ON r.job_id=j.id
    WHERE j.id=${jobId} AND j.project_id=${projectId}
  `, store.db);
}

export async function finishImageJob(
  store: KnowledgeStore,
  jobId: string,
  status: 'DONE' | 'FAILED',
  error?: string,
  result?: { storageKey: string; bytes: number; width?: number; height?: number; costUsd?: number },
) {
  await sql`UPDATE image_jobs SET status=${status}, error=${error ?? null},
        finished_at=now() WHERE id=${jobId}`.execute(store.db);
  if (result)
    await sql`INSERT INTO image_results(id, job_id, storage_key, bytes, width, height, cost_usd)
      VALUES (${randomUUID()}, ${jobId}, ${result.storageKey}, ${result.bytes},
        ${result.width ?? null}, ${result.height ?? null}, ${result.costUsd ?? null})`.execute(
      store.db,
    );
}

export async function listImages(store: KnowledgeStore, projectId: string) {
  return rows<any>(
        sql`SELECT r.id, r.job_id, r.bytes, r.width, r.height, r.created_at,
               r.review_status, r.reviewed_by, r.reviewed_at, r.review_note,
               j.prompt, j.model, j.owner_id
        FROM image_results r JOIN image_jobs j ON j.id=r.job_id
        WHERE j.project_id=${projectId} ORDER BY r.created_at DESC LIMIT 100`,
    store.db,
  );
}

export async function getImage(store: KnowledgeStore, projectId: string, resultId: string) {
  return first<any>(
    sql`SELECT r.*, j.prompt, j.project_id FROM image_results r
        JOIN image_jobs j ON j.id=r.job_id
        WHERE r.id=${resultId} AND j.project_id=${projectId}`,
    store.db,
  );
}

export async function reviewImageResult(
  store: KnowledgeStore,
  projectId: string,
  resultId: string,
  userId: string,
  status: 'REVIEW' | 'APPROVED_CANONICAL' | 'REJECTED',
  role: string,
  note?: string,
) {
  const r = await first<any>(sql`UPDATE image_results r SET
      review_status=${status}, reviewed_by=${userId}, reviewed_at=now(), review_role=${role}, review_note=${note ?? null}
    FROM image_jobs j WHERE r.id=${resultId} AND j.id=r.job_id AND j.project_id=${projectId}
    RETURNING r.id`, store.db);
  return Boolean(r);
}

// 프로덕션 E2E QA — api 컨테이너 내부에서 localhost로 전체 기능을 검증한다.
//   QA_COOKIE=<session> node --import tsx scripts/qa-e2e.ts
// 커버: knowledge.ask(discord/meeting/github) → assistant run+SSE 재개 → 업로드 → 아트보드
const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:3000';
const COOKIE = process.env.QA_COOKIE!;
if (!COOKIE) {
  console.error('QA_COOKIE required');
  process.exit(1);
}
const ORIGIN = process.env.QA_ORIGIN ?? 'https://juncoystt.junnnny.kr';
const H = {
  cookie: 'session=' + COOKIE,
  'content-type': 'application/json',
  origin: ORIGIN,
};

let pass = 0,
  fail = 0;
const results: { name: string; ok: boolean; detail: string }[] = [];
function report(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}
const j = (r: Response) => r.json() as Promise<any>;
async function call(path: string, init?: RequestInit) {
  const r = await fetch(BASE + path, { headers: H, ...init });
  const body = r.status === 204 ? null : await j(r).catch(() => null);
  return { status: r.status, body, headers: r.headers };
}
const post = (path: string, body: unknown, extra?: RequestInit) =>
  call(path, { method: 'POST', body: JSON.stringify(body), ...extra });

// ── T1: Discord 근거 검색 ─────────────────────────────────────
{
  const q = '디스코드 채널에서 최근에 어떤 이야기가 오갔는지 알려줘';
  const { status, body } = await post('/api/knowledge/ask', { question: q });
  const ev = body?.evidence ?? [];
  const kinds = [...new Set(ev.map((e: any) => e.kind ?? e.source ?? e.source_kind))];
  const withDates = ev.filter(
    (e: any) => e.source_occurred_at || e.source_modified_at || e.observed_at,
  ).length;
  report(
    'T1 ask→discord 근거',
    status === 200 && ev.length > 0 && kinds.some((k) => String(k).includes('discord')),
    `status=${status} evidence=${ev.length} kinds=${kinds} dates=${withDates}/${ev.length}`,
  );
  if (ev[0])
    console.log(
      '  sample:',
      JSON.stringify(ev[0]).slice(0, 300),
    );
}
// ── T2: 회의 최신성 ─────────────────────────────────────────
{
  const q = '가장 최근 회의의 날짜와 주요 내용을 알려줘';
  const { status, body } = await post('/api/knowledge/ask', { question: q });
  const ev = (body?.evidence ?? []) as any[];
  const meeting = ev.filter((e) =>
    String(
      e.stable_key ?? e.document_key ?? e.source ?? e.kind ?? '',
    ).includes('meeting'),
  );
  const dates = ev
    .map((e) => e.source_occurred_at ?? e.source_modified_at)
    .filter(Boolean)
    .sort()
    .reverse();
  report(
    'T2 ask→meeting 근거',
    status === 200 && ev.length > 0 && meeting.length > 0,
    `status=${status} evidence=${ev.length} meeting=${meeting.length} newest=${dates[0] ?? 'none'} kinds=${[...new Set(ev.map((e: any) => e.source))]}`,
  );
}
// ── T3: GitHub permalink ─────────────────────────────────────
{
  const q = 'GitHub 저장소의 최근 변경 내용을 파일 근거와 함께 알려줘';
  const { status, body } = await post('/api/knowledge/ask', { question: q });
  const ev = (body?.evidence ?? []) as any[];
  const gh = ev.filter((e) => String(e.url ?? '').includes('github.com'));
  const shaLinks = gh.filter((e) => /\/blob\/[0-9a-f]{40}\//.test(e.url ?? ''));
  const branchLinks = gh.filter((e) =>
    /\/blob\/(main|master|SideView|Stairs)\//.test(e.url ?? ''),
  );
  report(
    'T3 ask→github SHA permalink',
    status === 200 && gh.length > 0 && shaLinks.length === gh.length && branchLinks.length === 0,
    `status=${status} github=${gh.length} sha=${shaLinks.length} branch=${branchLinks.length}`,
  );
  if (gh[0]) console.log('  link:', gh[0].url);
}
// ── T4+T5: assistant run + SSE 재개 ─────────────────────────
async function readSse(url: string, opts: { lastEventId?: number; limit?: number }) {
  const ctrl = new AbortController();
  const res = await fetch(BASE + url, {
    headers: {
      cookie: 'session=' + COOKIE,
      accept: 'text/event-stream',
      origin: ORIGIN,
      ...(opts.lastEventId ? { 'last-event-id': String(opts.lastEventId) } : {}),
    },
    signal: ctrl.signal,
  });
  const events: { id: number; event: string; data: string }[] = [];
  let buf = '';
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const e: any = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) e.id = Number(line.slice(3));
        else if (line.startsWith('event:')) e.event = line.slice(6).trim();
        else if (line.startsWith('data:')) e.data = line.slice(5);
      }
      if (e.event) {
        events.push(e);
        if (e.event === 'done') {
          ctrl.abort();
          return { events, status: res.status };
        }
        if (opts.limit && events.length >= opts.limit) {
          ctrl.abort();
          return { events, status: res.status, aborted: true };
        }
      }
    }
  }
  ctrl.abort();
  return { events, status: res.status };
}

let convId: string | undefined;
{
  const { status, body } = await post('/api/assistant/conversations', {
    title: 'QA ' + new Date().toISOString(),
  });
  convId = body?.id ?? body?.conversation_id;
  report('T4a conversation 생성', status === 200 && !!convId, `status=${status} id=${convId}`);
}
if (convId) {
  // 이전 "조회 항목"/hang 유발 질의 유형: 커넥터 도구가 필요한 조회
  const { status, body } = await post(
    `/api/assistant/conversations/${convId}/messages`,
    { content: 'Notion에 등록된 작업 목록을 보여줘' },
  );
  const runId = body?.run_id;
  report('T4b run 생성', status === 202 && !!runId, `status=${status} run=${runId}`);
  if (runId) {
    // 첫 연결: 이벤트 2개만 받고 끊기
    const first = await readSse(`/api/assistant/runs/${runId}/stream`, { limit: 2 });
    const lastId = first.events.at(-1)?.id ?? 0;
    // 재연결: Last-Event-ID로 이어서
    const second = await readSse(`/api/assistant/runs/${runId}/stream`, {
      lastEventId: lastId,
    });
    const resumedIds = second.events.map((e) => e.id).filter(Boolean);
    const noReplay = resumedIds.every((id) => id > lastId);
    const done = second.events.find((e) => e.event === 'done');
    report(
      'T5 SSE Last-Event-ID 재개',
      first.events.length >= 1 && noReplay && !!done,
      `first=${first.events.length} lastId=${lastId} resumed=${resumedIds.length} minResumed=${Math.min(...resumedIds)} replay=${!noReplay} done=${JSON.stringify(done?.data ?? null)}`,
    );
    // run 최종 상태 + 메시지 저장 확인
    const run = await call(`/api/assistant/runs/${runId}`);
    const conv = await call(`/api/assistant/conversations/${convId}`);
    const msgs = (conv.body?.messages ?? []) as any[];
    const answer = msgs.find((m) => m.role === 'assistant');
    const text = JSON.stringify(answer?.content ?? answer?.body ?? '');
    const genericOnly =
      /조회 항목/.test(text) && text.replace(/조회 항목/g, '').trim().length < 30;
    report(
      'T4c run 완료+답변 저장',
      run.status === 200 && !!answer && !genericOnly,
      `run_status=${run.body?.status} msgs=${msgs.length} answer_len=${text.length} generic_only=${genericOnly} warnings=${JSON.stringify(answer?.warnings ?? answer?.result?.warnings ?? null)}`,
    );
    if (answer) console.log('  answer:', text.slice(0, 400));
  }
}
// ── T6: 업로드 라운드트립 ────────────────────────────────────
{
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const sha = (await import('node:crypto')).createHash('sha256').update(png).digest('hex');
  const init = await post('/api/assistant/files/init', {
    filename: 'qa-pixel.png',
    mime: 'image/png',
    bytes: png.length,
    sha256: sha,
  });
  const fid = init.body?.id;
  if (init.status !== 200 || !fid) {
    report('T6 업로드 init', false, `status=${init.status} body=${JSON.stringify(init.body)}`);
  } else {
    const complete = await call(`/api/assistant/files/${fid}/complete`, {
      method: 'POST',
      headers: {
        cookie: 'session=' + COOKIE,
        'content-type': 'application/octet-stream',
        origin: ORIGIN,
      },
      body: png,
    });
    const got = await fetch(`${BASE}/api/assistant/files/${fid}/content`, {
      headers: { cookie: 'session=' + COOKIE },
    });
    const back = Buffer.from(await got.arrayBuffer());
    report(
      'T6 업로드→content 라운드트립',
      complete.status < 300 && got.status === 200 && back.equals(png),
      `init=${init.status} complete=${complete.status} get=${got.status} bytes=${back.length}/${png.length} equal=${back.equals(png)}`,
    );
  }
}
// ── T7: 아트보드 API ────────────────────────────────────────
{
  const list = await call('/api/assistant/art-boards');
  const created = await post('/api/assistant/art-boards', { title: 'QA 보드' });
  const bid = created.body?.id;
  const got = bid ? await call(`/api/assistant/art-boards/${bid}`) : null;
  report(
    'T7 art-board 목록/생성/조회',
    list.status === 200 && created.status === 200 && got?.status === 200,
    `list=${list.status} create=${created.status} get=${got?.status} boards=${Array.isArray(list.body?.boards ?? list.body) ? (list.body.boards ?? list.body).length : '?'}`,
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
export {};

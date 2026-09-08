import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { fixture, guild, user } from '../tests/integration/helpers.ts';
import { buildServer } from '../apps/api/src/server.ts';
import { Auth } from '../apps/api/src/auth.ts';
import { markQaRun } from './lib/qa-retention.ts';
const option = (k: string, d: string) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : process.argv[i + 1]!;
};
const count = Number(option('samples', '200')),
  output = resolve(option('output', '.data/qa/web-latency-' + Date.now()));
if (!Number.isInteger(count) || count < 20 || count > 1000) throw new Error('INVALID_SAMPLE_COUNT');
await markQaRun(output);
const f = await fixture(),
  m = await f.begin(),
  app = await buildServer(f.config, f.store),
  url = await app.listen({ host: '127.0.0.1', port: 0 });
const people = Array.from({ length: 12 }, (_, i) => ({
  id: (900000000000001000n + BigInt(i)).toString(),
  name: '뷰어 ' + i,
}));
await f.store.setConfig(
  guild,
  { ...(await f.store.getConfig(guild)), admin_user_ids: [user, ...people.map((p) => p.id)] },
  user,
);
const auth = new Auth(f.store, f.config),
  browser = await chromium.launch({ headless: true });
const commits = new Map<string, number>(),
  observations: { viewer: number; key: string; at: number }[] = [],
  errors: string[] = [];
try {
  for (const [i, p] of people.entries()) {
    const cookie = await auth.create(
      { id: p.id, username: p.name },
      { access_token: 'mock', refresh_token: 'mock', expires_at: Date.now() + 3600000, mock: true },
    );
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([{ name: 'session', value: cookie, url }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('__qaRender', (key: string, at: number) =>
      observations.push({ viewer: i, key, at }),
    );
    await page.addInitScript({
      content: `(() => {
      const seen = new Set();
      let scheduled = false;
      function scan() {
        scheduled = false;
        for (const row of document.querySelectorAll('.transcript-row.final')) {
          const key = row.dataset.segmentId + ':' + row.dataset.revision;
          if (seen.has(key)) continue;
          let bounds = row.getBoundingClientRect(),
            visible = bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight;
          for (let p = row.parentElement; p && visible; p = p.parentElement) {
            if (/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) {
              const clip = p.getBoundingClientRect();
              visible = bounds.bottom > clip.top && bounds.top < clip.bottom;
            }
          }
          if (visible) {
            seen.add(key);
            void window.__qaRender(key, Date.now());
          }
        }
      }
      const start = () =>
        new MutationObserver(() => {
          if (!scheduled) {
            scheduled = true;
            requestAnimationFrame(() => requestAnimationFrame(scan));
          }
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    })();`,
    });
    await page.goto(url + '/meetings/' + m.id + '?tab=transcript');
    await page.getByText('실시간 연결됨', { exact: true }).waitFor();
  }
  const began = Date.now();
  for (let i = 0; i < count; i++) {
    const saved = await f.store.upsertTranscript({
      guildId: guild,
      meetingId: m.id,
      userId: user,
      displayName: '지연 검증',
      sourceKey: 'render-' + i,
      start: i * 1000,
      end: i * 1000 + 800,
      text: `웹 표시 지연 검증 발언 ${i}. 새로 저장한 문장이 같은 전사 행에 정확히 표시되는지 확인합니다.`,
      final: true,
    });
    commits.set(saved!.segment_id + ':' + saved!.revision, Date.parse(saved!.updated_at));
    await new Promise((r) => setTimeout(r, 300));
  }
  const deadline = Date.now() + 10000;
  while (observations.length < 12 * count && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  const samples = observations
    .filter((o) => commits.has(o.key))
    .map((o) => ({
      ...o,
      segment_timestamp: commits.get(o.key)!,
      delta_ms: o.at - commits.get(o.key)!,
    }));
  const times = samples.map((s) => s.delta_ms).sort((a, b) => a - b);
  const withMissing = [...times, ...Array(Math.max(0, count * 12 - times.length)).fill(Infinity)];
  const at95 = withMissing[Math.ceil(count * 12 * 0.95) - 1];
  const p95 = Number.isFinite(at95) ? at95 : null;
  const perViewer = people.map((_, i) => samples.filter((s) => s.viewer === i).length);
  const report = {
    source: 'MOCK_DATABASE_TO_BROWSER',
    actual_discord: false,
    viewers: 12,
    commits: count,
    observed_samples: samples.length,
    expected_samples: count * 12,
    per_viewer_samples: perViewer,
    p95_ms: p95,
    max_ms: times.at(-1),
    min_ms: times[0],
    errors,
    elapsed_seconds: (Date.now() - began) / 1000,
    time_basis:
      'segment timestamp before transaction commit to visible DOM after two animation frames, same host; includes transaction tail',
    status:
      errors.length === 0 &&
      p95 !== null &&
      p95 <= 1000 &&
      people.every(
        (_, i) =>
          samples.filter((s) => s.viewer === i && s.delta_ms <= 1000).length >= count * 0.95,
      )
        ? 'PASS'
        : 'FAIL',
    samples,
  };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o644 });
  process.stdout.write(JSON.stringify({ ...report, samples: undefined }) + '\n');
  if (report.status !== 'PASS') process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  await f.dispose();
}

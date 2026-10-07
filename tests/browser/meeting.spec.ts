import { test, expect } from '@playwright/test';
const origin = { Origin: 'http://127.0.0.1:3100' };
test.beforeEach(async ({ page }) => {
  await page.goto('/auth/discord?return_to=/meetings');
  await expect(page.getByRole('heading', { name: '모든 회의', exact: true })).toBeVisible();
});
test('login, live transcript, whole-history search, speaker filter, deep evidence and export', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('link', { name: /실시간 기록 보기/ }).click();
  await expect(page.getByText('실시간 연결됨')).toBeVisible();
  await expect(page.locator('.transcript-row').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/web-desktop.png', fullPage: true });
  await page.getByRole('textbox', { name: '전체 전사 검색' }).fill('네온벚꽃');
  await expect(page.getByText(/장기보관 검색 검증/)).toBeVisible();
  await page.getByRole('combobox', { name: '화자 필터' }).selectOption({ label: '이서연 · 0011' });
  await expect(page.getByRole('heading', { name: '검색 결과가 없습니다.' })).toBeVisible();
  await page.getByRole('combobox', { name: '화자 필터' }).selectOption('');
  await page.getByRole('button', { name: '검색 지우기' }).click();
  await page.getByRole('tab', { name: '회의 요약', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '회의가 끝나면 여기에 정리할게요.' }),
  ).toBeVisible();
  await page.getByRole('link', { name: '모든 회의', exact: true }).first().click();
  await page.getByRole('link', { name: /플레이테스트 리뷰/ }).click();
  await expect(page.getByRole('heading', { name: /이번 회의에서 나눈 이야기/ })).toBeVisible();
  await page.getByRole('button', { name: '근거 보기' }).first().click();
  await expect(page.getByText(/근거 발언 · 전사 버전/)).toBeVisible();
  await expect(page.locator('.highlighted')).toBeVisible();
  await page.getByText('내보내기', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown (.md)' }).click();
  const file = await download;
  expect(
    await file.failure(),
    JSON.stringify({ filename: file.suggestedFilename(), url: file.url(), errors }),
  ).toBeNull();
  expect(file.suggestedFilename()).toMatch(/\.md$/);
  expect(errors).toEqual([]);
});
test('partial updates keep the same row, final persists across offline reconnect and refresh', async ({
  page,
  context,
}) => {
  await page.getByRole('link', { name: /실시간 기록 보기/ }).click();
  await expect(page.getByText('실시간 연결됨')).toBeVisible();
  const key = 'browser-' + Date.now(),
    start = 5000000;
  const send = async (text: string, final = false) => {
    const res = await page.request.post('/__test/transcript', {
      headers: origin,
      data: { key, text, start, final },
    });
    expect(res.ok()).toBeTruthy();
    return res.json();
  };
  const first = await send('브라우저 확인 중');
  const row = page.locator(`[data-segment-id="${first.segment_id}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.getByText(/^인식 중/)).toBeVisible();
  await send('브라우저 확인을 진행하고 있습니다.');
  await expect(row).toContainText('확인을 진행');
  await send('브라우저 확인을 완료했습니다.', true);
  await expect(row.getByText(/^인식 중/)).toHaveCount(0);
  await context.setOffline(true);
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByText('실시간 연결됨')).toBeVisible();
  await expect(page.locator(`[data-segment-id="${first.segment_id}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-segment-id="${first.segment_id}"]`)).toContainText(
    '확인을 완료',
  );
});
test('360px mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('link', { name: /실시간 기록 보기/ }).click();
  await expect(page.getByText('실시간 연결됨')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByRole('combobox', { name: '화자 필터' })).toBeVisible();
  await expect(page.locator('.transcript-row').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/web-mobile.png', fullPage: true });
});
test('a temporary snapshot 503 reconnects automatically without a login or reload', async ({
  page,
}) => {
  let snapshots = 0;
  await page.route('**/api/meetings/*/snapshot', async (route) => {
    if (++snapshots === 1)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TEMPORARY_FAILURE' } }),
      });
    else await route.continue();
  });
  await page.getByRole('link', { name: /실시간 기록 보기/ }).click();
  await expect(
    page.getByRole('heading', {
      name: '기록을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.',
    }),
  ).toBeVisible();
  await expect(page.getByText('실시간 연결됨')).toBeVisible({ timeout: 10000 });
  expect(snapshots).toBeGreaterThanOrEqual(2);
});
test('12 separate viewers receive the same commit without multiplying provider connections or jobs', async ({
  browser,
  page,
}) => {
  const base = await (await page.request.get('/__test/state')).json();
  const contexts = [],
    pages = [];
  for (let i = 0; i < 12; i++) {
    const res = await page.request.post('/__test/session', { headers: origin, data: { user: i } });
    const { cookie } = await res.json();
    const context = await browser.newContext();
    await context.addCookies([{ name: 'session', value: cookie, url: 'http://127.0.0.1:3100' }]);
    contexts.push(context);
    const p = await context.newPage();
    pages.push(p);
  }
  try {
    await Promise.all(
      pages.map(async (p) => {
        await p.goto('/meetings/' + base.meeting_id);
        await expect(p.getByText('실시간 연결됨')).toBeVisible();
      }),
    );
    const text = '12개 뷰어 동기화 검증 ' + Date.now();
    const start = Date.now();
    await page.request.post('/__test/transcript', {
      headers: origin,
      data: { key: 'viewers-' + start, text, start: 5100000, final: true },
    });
    await Promise.all(pages.map((p) => expect(p.getByText(text, { exact: true })).toBeVisible()));
    const delay = Date.now() - start;
    const after = await (await page.request.get('/__test/state')).json();
    expect(after.streams).toBe(base.streams);
    expect(after.jobs).toBe(base.jobs);
    test.info().annotations.push({ type: 'commit_to_all_views_ms', description: String(delay) });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
test('permission removal closes SSE and clears transcript within 30 seconds', async ({ page }) => {
  await page.getByRole('link', { name: /실시간 기록 보기/ }).click();
  await expect(page.getByText('실시간 연결됨')).toBeVisible();
  const start = Date.now();
  const revoked = await page.request.post('/__test/access', {
    headers: origin,
    data: { allowed: false },
  });
  expect(revoked.ok()).toBeTruthy();
  try {
    await expect(
      page.getByRole('heading', { name: '회의를 찾을 수 없거나 열람 권한이 없습니다.' }),
    ).toBeVisible({ timeout: 31000 });
    expect(Date.now() - start).toBeLessThan(31000);
    await expect(page.locator('.transcript-row')).toHaveCount(0);
  } finally {
    await page.request.post('/__test/access', { headers: origin, data: { allowed: true } });
  }
});
test('speaker filtering retrieves a former participant outside the latest snapshot', async ({
  page,
}) => {
  const response = await page.request.post('/__test/transcript', {
    headers: origin,
    data: {
      key: 'old-speaker-' + Date.now(),
      text: '오래전에만 발언한 화자의 기록',
      start: 10,
      user: 11,
      final: true,
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.getByRole('link', { name: /실시간 기록 보기/ }).click();
  await page.getByRole('combobox', { name: '화자 필터' }).selectOption({ label: '권도현 · 0021' });
  await expect(page.getByText('오래전에만 발언한 화자의 기록', { exact: true })).toBeVisible();
});
test('shared workspace copy and membership loss clear all meeting content', async ({ page }) => {
  await expect(page.locator('.topbar').getByText('23시 정시퇴근 회의록')).toBeVisible();
  await expect(
    page.locator('.sidebar, .mobile-menu, .workspace, .sidebar-note, .list-footnote'),
  ).toHaveCount(0);
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'WORKSPACE_FORBIDDEN',
          message: '23시 정시퇴근에 연결된 Discord 서버 구성원만 이용할 수 있습니다.',
        },
      }),
    }),
  );
  await expect(page.getByRole('alert')).toHaveText(
    '23시 정시퇴근에 연결된 Discord 서버 구성원만 이용할 수 있습니다.',
    { timeout: 20000 },
  );
  await expect(page.getByRole('heading', { name: '모든 회의', exact: true })).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveCount(0);
});
test('text playback opens waveform, pauses, resumes, switches and collapses on end', async ({
  page,
}) => {
  const pcm = Buffer.alloc(16000 * 2 * 4);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / 16000) * 3000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  let requests = 0;
  await page.route('**/segments/*/audio*', (route) => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.concat([h, pcm]) });
  });
  await page.getByRole('link', { name: /실시간 기록 보기/ }).click();
  const row = page.locator('.transcript-row.final').last();
  await row.locator('.utterance-text').click();
  await expect(row.locator('.audio-wave')).toBeVisible();
  await expect(row.locator('.audio-time')).toContainText('/ 00:04');
  await row.locator('.utterance-text').click();
  await expect(row.locator('.audio-wave')).toHaveCount(0);
  await row.locator('.utterance-text').click();
  await expect(row.locator('.audio-wave')).toBeVisible();
  expect(requests).toBe(1);
  const other = page.locator('.transcript-row.final').nth(-2);
  await other.locator('.utterance-text').click();
  await expect(row.locator('.audio-wave')).toHaveCount(0);
  await expect(other.locator('.audio-wave')).toBeVisible();
  await expect(other.locator('.audio-wave')).toHaveCount(0, { timeout: 7000 });
  await expect(page.locator('.sidebar')).toHaveCount(0);
  const bounds = await page
    .locator('.meeting-aside')
    .evaluate((e) => ({ bottom: e.getBoundingClientRect().bottom, height: innerHeight }));
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
  await page.setViewportSize({ width: 1100, height: 600 });
  const scroll = await page.locator('.meeting-aside').evaluate((e) => {
    e.scrollTop = e.scrollHeight;
    return { scrollTop: e.scrollTop, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, overflowY: getComputedStyle(e).overflowY };
  });
  expect(['auto', 'scroll']).toContain(scroll.overflowY);
  if (scroll.scrollHeight > scroll.clientHeight) expect(scroll.scrollTop).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/audio-panel-layout.png' });
});
test('text selection does not play and rapid cancellation cannot revive audio', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/segments/*/audio*', async (route) => {
    requests++;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route
      .fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'AUDIO_UNAVAILABLE',
            message: '원음이 만료됐거나 아직 저장되지 않았습니다.',
          },
        }),
      })
      .catch(() => {});
  });
  await page.getByRole('link', { name: /실시간 기록 보기/ }).click();
  const text = page.locator('.transcript-row.final').last().locator('.utterance-text');
  await text.scrollIntoViewIfNeeded();
  await expect(text).toBeVisible();
  const selected = await text.evaluate((e) => {
    const range = document.createRange();
    range.selectNodeContents(e);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const before = selection.toString();
    (e as HTMLElement).click();
    return { before, after: selection.toString(), text: e.textContent };
  });
  expect(selected.before, JSON.stringify(selected)).not.toBe('');
  expect(requests).toBe(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await text.focus();
  await text.press('Enter');
  await expect(page.locator('.audio-loading')).toHaveText('원음 불러오는 중…');
  await text.press('Enter');
  await expect(page.locator('.audio-reveal')).toHaveCount(0);
  await text.press('Enter');
  await expect(page.getByRole('alert')).toContainText('원음이 만료됐거나');
  await expect(page.locator('.audio-wave')).toHaveCount(0);
});

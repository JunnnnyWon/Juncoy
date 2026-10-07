import { test, expect } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const boardId = '00000000-0000-4000-8000-000000000001';
const uploadId = '00000000-0000-4000-8000-000000000002';
const assetId = '00000000-0000-4000-8000-000000000003';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/assistant/art-boards*', async (route) => {
    if (route.request().url().includes(`/art-boards/${boardId}`)) return route.continue();
    if (route.request().method() === 'GET') return route.fulfill({ json: [{ id: boardId, name: '테스트 아트 보드', current_revision: 1 }] });
    return route.fulfill({ json: { id: boardId } });
  });
  await page.route(`**/api/assistant/art-boards/${boardId}/history`, (route) => route.fulfill({ json: [{ revision: 1, created_at: new Date().toISOString() }] }));
  await page.route(`**/api/assistant/art-boards/${boardId}`, (route) => route.fulfill({ json: { board: { id: boardId, name: '테스트 아트 보드', current_revision: 1 }, revision: { revision: 1, snapshot: { references: [
    { id: 'ref-a', upload_id: uploadId, art_asset_id: assetId, name: 'character.png', url: `/api/assistant/files/${uploadId}/content`, role: 'face_shape', roles: ['face_shape'], roleUsage: { face_shape: 'STRONG_REFERENCE' }, usage: 'STRONG_REFERENCE', note: '얼굴 비율', selected: false, x: 80, y: 110, width: 220, height: 210 },
    { id: 'ref-b', upload_id: uploadId, art_asset_id: assetId, name: 'corridor.png', url: `/api/assistant/files/${uploadId}/content`, role: 'mood', roles: ['mood'], roleUsage: { mood: 'MOOD_ONLY' }, usage: 'MOOD_ONLY', note: '공간 분위기', selected: false, x: 360, y: 110, width: 220, height: 210 },
  ], nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } } }));
  await page.route('**/api/assistant/images', (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/assistant/files/${uploadId}/content`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await page.route(`**/api/assistant/art-assets/${assetId}/extraction`, (route) => route.fulfill({ json: { asset_id: assetId, observations: { description: '반실사 얼굴', materials: ['피부'], palette: ['회색'] }, human_corrections: {} } }));
  await page.route(`**/api/assistant/art-boards/${boardId}/revisions`, (route) => route.fulfill({ json: { revision: 2 } }));
  await page.goto('/auth/discord?return_to=/meetings');
  await page.goto('/art-reference');
  await expect(page.getByRole('heading', { name: '테스트 아트 보드' })).toBeVisible();
});

test('art canvas supports selection, grouping, undo, and mobile inspector access', async ({ page }) => {
  await expect(page.getByRole('button', { name: '레퍼런스 이동' }).first()).toBeVisible();
  await page.getByRole('button', { name: '다중 선택' }).first().click();
  await page.getByRole('button', { name: '다중 선택' }).nth(1).click();
  await expect(page.getByRole('button', { name: '선택 묶기' })).toBeEnabled();
  await page.getByRole('button', { name: '선택 묶기' }).click();
  await expect(page.getByText('그룹 · character.png, corridor.png')).toBeVisible();
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(page.getByText('그룹 · character.png, corridor.png')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByText('그룹 · character.png, corridor.png')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '검토 패널' }).click();
  await expect(page.getByText('REFERENCE INSPECTOR')).toBeVisible();
  await page.screenshot({ path: 'artifacts/art-reference-mobile.png', fullPage: true });
});

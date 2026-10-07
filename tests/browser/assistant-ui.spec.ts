import { test, expect } from '@playwright/test';

test('assistant file panel separates list and inspector and stays usable on mobile', async ({ page }) => {
  const fileId = '00000000-0000-4000-8000-000000000010';
  await page.route('**/api/assistant/conversations', (route) => route.fulfill({ json: [{ id: 'conv-1', title: '아트 검토', updated_at: new Date().toISOString() }] }));
  await page.route('**/api/assistant/conversations/conv-1', (route) => route.fulfill({ json: { conversation: { id: 'conv-1', title: '아트 검토' }, messages: [], pending_approvals: [] } }));
  await page.route('**/api/assistant/files', (route) => route.fulfill({ json: [{ id: fileId, filename: 'art-direction.pdf', mime: 'application/pdf', bytes: 10240, state: 'READY', document_state: 'READY', parse_status: 'READY', parser_kind: 'upstage_document_parse', parser_version: 'document-parse-260930', cache_hit: true, sha256: 'a'.repeat(64), original_verified_at: new Date().toISOString(), document_id: '00000000-0000-4000-8000-000000000011' }] }));
  await page.route('**/api/assistant/images', (route) => route.fulfill({ json: [{ id: 'image-1', model: 'openai/gpt-image-2.5-flare', review_status: 'DRAFT', mime: 'image/png', bytes: 2048, sha256: 'b'.repeat(64), prompt: 'test' }] }));
  await page.goto('/auth/discord?return_to=/meetings');
  await page.goto('/assistant');
  await expect(page.getByRole('heading', { name: '프로젝트 어시스턴트' })).toBeVisible();
  await page.getByRole('button', { name: '파일' }).click();
  await expect(page.getByText('art-direction.pdf')).toBeVisible();
  await page.getByText('art-direction.pdf').click();
  await expect(page.getByText('원본 SHA-256')).toBeVisible();
  await expect(page.getByText('HIT')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/assistant-mobile.png', fullPage: true });
});

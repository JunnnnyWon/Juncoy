import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  blockLine,
  pageTitle,
  verifyNotionSignature,
  NotionRest,
  NotionCollector,
} from '@meeting/knowledge';

describe('verifyNotionSignature', () => {
  const secret = 'test-secret';
  const body = '{"id":"evt1"}';
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  it('accepts a valid signature and rejects tampering', () => {
    expect(verifyNotionSignature(secret, body, sig)).toBe(true);
    expect(verifyNotionSignature(secret, body + 'x', sig)).toBe(false);
    expect(verifyNotionSignature('other', body, sig)).toBe(false);
    expect(verifyNotionSignature(secret, body, null)).toBe(false);
    expect(verifyNotionSignature(secret, body, 'sha1=abc')).toBe(false);
  });
});

describe('blockLine', () => {
  const t = (s: string) => [{ plain_text: s }];
  it('maps block types to markdown-ish lines', () => {
    expect(blockLine({ type: 'heading_2', heading_2: { rich_text: t('제목') } })).toBe('## 제목');
    expect(blockLine({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: t('항목') } })).toBe('- 항목');
    expect(blockLine({ type: 'to_do', to_do: { checked: true, rich_text: t('완료') } })).toBe('[x] 완료');
    expect(blockLine({ type: 'quote', quote: { rich_text: t('인용') } })).toBe('> 인용');
    expect(
      blockLine({ type: 'table_row', table_row: { cells: [t('a'), t('b')] } }),
    ).toBe('| a | b |');
    expect(blockLine({ type: 'code', code: { rich_text: t('x=1') } })).toBe('```\nx=1\n```');
    expect(blockLine({ type: 'divider', divider: {} })).toBe('');
    expect(blockLine({ type: 'child_page', child_page: { title: '하위' } })).toBe('# 하위');
  });
});

describe('pageTitle', () => {
  it('finds the title property', () => {
    expect(
      pageTitle({
        properties: {
          Name: { type: 'title', title: [{ plain_text: '페이지 A' }] },
          Status: { type: 'status', status: { name: 'Done' } },
        },
      }),
    ).toBe('페이지 A');
    expect(pageTitle({ properties: {} })).toBe('');
  });
});

describe('NotionRest incremental paging', () => {
  it('posts search with page filter and desc edited sort', async () => {
    const calls: any[] = [];
    const rest = new NotionRest('tok', async (_u: any, o: any) => {
      calls.push(JSON.parse(o.body));
      return new Response(
        JSON.stringify({ results: [], has_more: false }),
        { status: 200 },
      );
    });
    await rest.searchPages();
    expect(calls[0].filter).toEqual({ property: 'object', value: 'page' });
    expect(calls[0].sort).toEqual({ direction: 'descending', timestamp: 'last_edited_time' });
  });
});

describe('NotionCollector.syncIncremental', () => {
  it('stops paging at the cursor watermark and ingests only newer pages', async () => {
    const ingested: string[] = [];
    const collector = Object.create(NotionCollector.prototype) as any;
    collector.getCursor = async () => ({ last_edited_time: '2026-10-01T00:00:00.000Z' });
    collector.saveCursor = async () => {};
    collector.ingestPage = async (id: string) => {
      ingested.push(id);
      return { stored: true };
    };
    collector.rest = {
      searchPages: async () => ({
        status: 200,
        body: {
          results: [
            { id: 'new-1', last_edited_time: '2026-10-05T00:00:00.000Z' },
            { id: 'new-2', last_edited_time: '2026-10-02T00:00:00.000Z' },
            { id: 'old-1', last_edited_time: '2026-09-30T00:00:00.000Z' },
            { id: 'old-2', last_edited_time: '2026-09-20T00:00:00.000Z' },
          ],
          has_more: true,
          next_cursor: 'page2',
        },
      }),
    };
    const r = await collector.syncIncremental();
    expect(r.ingested).toBe(2);
    expect(ingested).toEqual(['new-1', 'new-2']);
  });
});

import { untar } from '@meeting/knowledge';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('untar', () => {
  it('strips the repo-<sha> prefix directory and yields file contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    mkdirSync(join(dir, 'owner-repo-abc1234/src'), { recursive: true });
    writeFileSync(join(dir, 'owner-repo-abc1234/src/main.ts'), 'export const a = 1;');
    writeFileSync(join(dir, 'owner-repo-abc1234/README.md'), '# hi');
    const tar = execSync(`tar -C ${dir} -cf - .`).subarray(0);
    const files = untar(tar as unknown as Buffer);
    expect(files.get('src/main.ts')?.toString()).toBe('export const a = 1;');
    expect(files.get('README.md')?.toString()).toBe('# hi');
  });
});

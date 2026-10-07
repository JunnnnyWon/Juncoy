import { describe, expect, it } from 'vitest';
import { ImageBrief } from '@meeting/contracts';

const hash = 'a'.repeat(64);
const base = {
  schema_version: 1 as const,
  request: '반실사 캐릭터 컨셉',
  role_directives: [{ role: 'face_shape', instruction: '얼굴 형태만 참고' }],
  negative_constraints: ['워터마크'],
  board_id: '00000000-0000-4000-8000-000000000001',
  board_revision: 3,
  art_bible_version: 2,
  references: [{
    asset_id: '00000000-0000-4000-8000-000000000002',
    upload_id: '00000000-0000-4000-8000-000000000003',
    asset_revision: hash, source_sha256: hash, order: 0, role: ['face_shape'],
    usage: { face_shape: 'STRONG_REFERENCE' as const }, crop: null, instruction: '얼굴 비율만 참고',
  }],
  evidence: [{ id: 'board:3', source: 'art_board' as const, stable_key: 'art_board:1', revision: '3', read_status: 'OK' as const }],
  coverage: { notion: { read_status: 'OK' as const, latest_at: '2026-10-07T00:00:00.000Z', gaps: [] } },
  provider: 'openrouter' as const, model: 'openai/gpt-image-2.5-flare' as const,
  prompt: '반실사 캐릭터', prompt_hash: hash, brief_hash: hash,
};

describe('ImageBrief contract', () => {
  it('accepts ordered references and crop metadata', () => {
    expect(ImageBrief.parse({
      ...base,
      coverage: {
        notion: base.coverage.notion, github: { read_status: 'PARTIAL', latest_at: null, gaps: ['no recent sync'] },
        discord: { read_status: 'OK', latest_at: null, gaps: [] }, meeting: { read_status: 'NOT_CONFIGURED', latest_at: null, gaps: [] },
      },
      references: [{ ...base.references[0], crop: { left: 0, top: 0, right: 0.8, bottom: 1 } }],
    }).references[0]?.crop?.right).toBe(0.8);
  });

  it('rejects invalid crop and a non-Flare provider model', () => {
    expect(() => ImageBrief.parse({
      ...base, coverage: { notion: base.coverage.notion },
      references: [{ ...base.references[0], crop: { left: 0.8, top: 0, right: 0.2, bottom: 1 } }],
    })).toThrow();
    expect(() => ImageBrief.parse({ ...base, coverage: { notion: base.coverage.notion }, model: 'other/model' })).toThrow();
  });
});

import { it, expect } from 'vitest';
import { encodeEvidence, orderedBatches } from '../../packages/providers/src/summary-evidence.ts';
import { SUMMARY_SCHEMA, emptySummary } from '@meeting/providers';
const first = 'a8d1123b-0088-4d8e-8000-328721287691';
const second = '9a11223b-0088-4d8e-8000-328721287692';

it('request-local evidence aliases round-trip without changing text, identities or original data', () => {
  const source = {
    segments: [
      { segment_id: first, user_id: '800000000000000000', text: '원문 ' + second },
      { segment_id: second, text: '둘째' },
    ],
  };
  const encoded = encodeEvidence(source, SUMMARY_SCHEMA);
  expect(encoded.input.segments[0]).toEqual({
    segment_id: 's1',
    user_id: '800000000000000000',
    text: '원문 ' + second,
  });
  expect(source.segments[0]!.segment_id).toBe(first);
  const summary = {
    ...emptySummary('검증'),
    decisions: [{ decision: '예시', reason: null, evidence_segment_ids: ['s2', 's1', 's2'] }],
  };
  expect(encoded.decode(summary).decisions[0].evidence_segment_ids).toEqual([second, first]);
  const merge = encodeEvidence({ extracts: [encoded.decode(summary)] }, SUMMARY_SCHEMA);
  expect(merge.decode({ evidence_segment_ids: ['s1'] }).evidence_segment_ids).toEqual([second]);
  expect(() => merge.decode({ evidence_segment_ids: ['s99'] })).toThrow('UNKNOWN_EVIDENCE_ALIAS');
  expect(() => merge.decode({ evidence_segment_ids: [first] })).toThrow('UNKNOWN_EVIDENCE_ALIAS');
  expect(JSON.stringify(encoded.schema)).not.toContain('uniqueItems');
});

it('parallel summary stages preserve chronology even when responses finish in reverse order', async () => {
  const pending: (() => void)[] = [];
  let active = 0,
    maxActive = 0;
  const result = orderedBatches([0, 1, 2, 3], 3, async (i) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => {
      pending[i] = resolve;
    });
    active--;
    return i;
  });
  expect(active).toBe(3);
  pending[2]!();
  pending[1]!();
  pending[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  expect(active).toBe(1);
  pending[3]!();
  expect(await result).toEqual([0, 1, 2, 3]);
  expect(maxActive).toBe(3);
});

it('a failed batch drains in-flight calls and never starts another batch', async () => {
  let finish!: () => void;
  const started: number[] = [];
  const result = orderedBatches([0, 1, 2], 2, async (i) => {
    started.push(i);
    if (i === 0) throw new Error('provider unavailable');
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return i;
  });
  let settled = false;
  const checked = expect(result)
    .rejects.toThrow('provider unavailable')
    .then(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  finish();
  await checked;
  expect(started).toEqual([0, 1]);
});

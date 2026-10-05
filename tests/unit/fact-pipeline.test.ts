import { it, expect } from 'vitest';
import {
  runFactLedger,
  ProviderError,
  type StructuredEngine,
  type LedgerStore,
} from '@meeting/providers';
import { caseSegments, summaryCases, qaPeople } from '../fixtures/summary-cases.ts';
const input = (id: string) => {
  const c = summaryCases.find((c) => c.id === id)!;
  return {
    meeting_id: '00000000-0000-4000-8000-000000000001',
    started_at: c.started_at,
    segments: caseSegments(c),
    participants: qaPeople,
    metadata: { transcript_version: 1 },
    glossary: [],
    markers: [],
    gaps: [],
  };
};
it('returning only the first unit cannot pass coverage or publish a long summary', async () => {
  let calls = 0;
  const engine: StructuredEngine = {
    model: 'contract-test',
    concurrency: 3,
    async request(schema) {
      calls++;
      try {
        return {
          result: schema.parse({ labels: { 0: 'CORE_DISCUSSION' } }),
          model: 'contract-test',
        };
      } catch {
        throw new ProviderError('STRUCTURE_MISSING_REQUIRED_UNIT_KEYS', true);
      }
    },
  };
  await expect(runFactLedger(input('long-late-topics'), engine, async () => {})).rejects.toThrow(
    'STRUCTURE_MISSING_REQUIRED_UNIT_KEYS',
  );
  expect(calls).toBe(9); // Three simultaneous groups, each at most three total attempts.
});
it('an independent kind disagreement downgrades the fact instead of rejecting the run', async () => {
  let calls = 0;
  const engine: StructuredEngine = {
    model: 'contract-test',
    concurrency: 3,
    async request(schema, payload: any) {
      calls++;
      if (!payload.units)
        return {
          result: schema.parse({
            kind: 'PROPOSAL',
            assignment: 'UNSPECIFIED',
            deadline: 'NONE',
          }),
          model: 'contract-test',
        };
      const labels = Object.fromEntries(payload.units.map((u: any) => [u.unit_key, 'DECISION']));
      const claims = Object.fromEntries(
        Object.keys(payload.structured_values ?? {}).map((k) => [
          k,
          { kind_supported: false, owner_supported: false, due_supported: false },
        ]),
      );
      return {
        result: schema.parse({ labels, ...(payload.structured_values ? { claims } : {}) }),
        model: 'contract-test',
      };
    },
  };
  const run = await runFactLedger(input('explicit-decision'), engine, async () => {});
  expect(calls).toBe(3);
  const downgraded = run.facts.filter((f) => f.reason_code === 'CLAIM_KIND_DOWNGRADED');
  expect(downgraded).toHaveLength(1);
  expect(downgraded[0]).toMatchObject({
    kind: 'PROPOSAL',
    section: 'topics',
    verification: 'DOWNGRADED',
    owner_user_id: null,
    due_date: null,
  });
  expect(run.result.decisions).toHaveLength(0);
});

it('turn-taking and generic effort are not assigned work', async () => {
  const { ruleKind } = await import('../../packages/providers/src/fact-units.ts');
  const kind = (quote: string) => ruleKind({ span: { quote }, instruction: false } as any);
  expect(kind('네, 먼저 얘기해 주세요.')).toBeNull();
  expect(kind('예, 열심히 하겠습니다.')).toBeNull();
  expect(kind('회의록을 정리해서 노션에 업로드하겠습니다.')).toBe('ACTION');
});

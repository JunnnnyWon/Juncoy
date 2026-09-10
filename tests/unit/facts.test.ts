import { it, expect } from 'vitest';
import { sourceUnits, ruleKind, unitsToFacts } from '../../packages/providers/src/fact-units.ts';
import { caseSegments, summaryCases, qaPeople } from '../fixtures/summary-cases.ts';
import { integrateFacts, renderFactLedger, isExplicitFactChange } from '@meeting/domain';
import type { LedgerFact, UnitClassificationDTO, UnitReviewDTO } from '@meeting/contracts';
function ledger(caseId: string) {
  const c = summaryCases.find((c) => c.id === caseId)!,
    segments = caseSegments(c),
    units = sourceUnits(segments);
  const draft: UnitClassificationDTO = {
    items: units.map((u) => ({
      unit_key: u.key,
      kind: ruleKind(u) ?? 'DISCUSSION',
      section: 'topics',
      category: '프로그래밍',
    })),
  };
  const review: UnitReviewDTO = { items: draft.items.map((i) => ({ ...i, supported: true })) };
  const map = new Map(segments.map((s) => [s.segment_id, s]));
  const facts = unitsToFacts(units, draft, review, {
    runKey: caseId,
    version: 1,
    sources: map,
    participants: qaPeople,
    startedAt: c.started_at,
    verifiedOwners: c.verified_owners,
  });
  return { c, segments, units, facts, map };
}
it('a suggestion is retained without creating a decision or task', () => {
  const { facts, map, segments } = ledger('proposal-only');
  const { result } = renderFactLedger(
    facts,
    integrateFacts(facts, { links: [] }, map),
    segments,
    1,
  );
  expect(result.decisions).toEqual([]);
  expect(result.action_items).toEqual([]);
  expect(result.topics.map((t) => t.discussion).join(' ')).toContain('후보');
});
it('renders topics as short grouped paragraphs instead of a fact dump', () => {
  const { facts, map, segments } = ledger('long-late-topics');
  const { result } = renderFactLedger(
    facts,
    integrateFacts(facts, { links: [] }, map),
    segments,
    1,
  );
  expect(result.topics.every((topic) => topic.discussion.split('\n').length === 1)).toBe(true);
  expect(result.topics.every((topic) => topic.discussion.length <= 900)).toBe(true);
  expect(result.summary.length).toBeGreaterThan(0);
  expect(result.summary.every((line) => !line.startsWith('논의:'))).toBe(true);
});
it('request and acceptance deduplicate while preserving both fact dispositions', () => {
  const { facts, map, segments } = ledger('explicit-assignment');
  const rendered = renderFactLedger(facts, integrateFacts(facts, { links: [] }, map), segments, 1, {
    participants: qaPeople,
    startedAt: '2026-09-07T01:00:00Z',
  });
  expect(rendered.result.action_items).toHaveLength(1);
  expect(rendered.result.action_items[0]).toMatchObject({
    owner_user_id: qaPeople[0]!.user_id,
    due_date: '2026-09-10',
  });
  expect(rendered.report.dispositions).toHaveLength(facts.length);
  expect(rendered.report.dispositions.some((d) => d.status === 'DUPLICATE')).toBe(true);
});
it('invented statements, changed source revisions and dropped facts fail closed', () => {
  const { facts, map, segments } = ledger('explicit-decision');
  const dispositions = integrateFacts(facts, { links: [] }, map);
  const modified: LedgerFact[] = structuredClone(facts);
  modified[0]!.statement = '없는 예산을 승인했습니다.';
  expect(() => renderFactLedger(modified, structuredClone(dispositions), segments, 1)).toThrow(
    'NON_LITERAL_FACT_STATEMENT',
  );
  expect(() => renderFactLedger(facts, dispositions.slice(1), segments, 1)).toThrow(
    'FACT_DISPOSITION_COVERAGE',
  );
  expect(() =>
    renderFactLedger(
      facts,
      dispositions,
      segments.map((s) => ({ ...s, revision: 2 })),
      1,
    ),
  ).toThrow('INVALID_EVIDENCE_SPAN');
});
it('known self identity is derived from source metadata; ambiguous names and unknown dates remain null', () => {
  const duplicate = ledger('duplicate-names');
  expect(duplicate.facts.find((f) => f.kind === 'ACTION')?.owner_user_id).toBeNull();
  const unknown = ledger('unknown-identity-date');
  expect(unknown.facts.find((f) => f.kind === 'ACTION')).toMatchObject({
    owner_user_id: null,
    due_date: null,
  });
  const midnight = ledger('midnight-relative');
  expect(midnight.facts.find((f) => f.kind === 'ACTION')?.due_date).toBe('2026-09-09');
});
it('source attack quotations cannot become committed facts', () => {
  const { facts } = ledger('transcript-instruction');
  expect(
    facts.filter((f) => f.statement.includes('1억원')).every((f) => f.verification === 'REJECTED'),
  ).toBe(true);
  expect(facts.some((f) => f.kind === 'DECISION' && f.statement.includes('Aurora'))).toBe(true);
});

it('a possible future change is not an actual cancellation of a verified fact', () => {
  expect(isExplicitFactChange('새 아이디어가 나오면 엔진을 바꾸면 좋을 것 같습니다.')).toBe(false);
  expect(isExplicitFactChange('앞의 Unity 결정은 취소합니다.')).toBe(true);
  expect(isExplicitFactChange('기한을 9월 11일로 변경합니다.')).toBe(true);
  const { facts, map } = ledger('decision-reversal');
  const committed = facts.find((f) => f.kind === 'DECISION')!;
  const suggested = {
    ...structuredClone(committed),
    fact_id: '00000000-0000-4000-8000-000000000099',
    source_order: committed.source_order + 1,
    statement: '나중에 바꾸면 좋을 것 같습니다.',
    evidence: committed.evidence.map((e) => ({ ...e, quote: '나중에 바꾸면 좋을 것 같습니다.' })),
    kind: 'PROPOSAL' as const,
  };
  expect(() =>
    integrateFacts(
      [committed, suggested],
      {
        links: [
          {
            earlier_fact_key: 0,
            later_fact_key: 1,
            relation: 'SUPERSEDED',
            evidence_segment_ids: [committed.evidence[0]!.segment_id],
          },
        ],
      },
      map,
    ),
  ).toThrow('UNSUPPORTED_REVERSAL');
});

it('supporting detail cannot hide an identical core fact and has an explicit exclusion reason', () => {
  const { facts, map, segments } = ledger('pronoun-is-not-assignment');
  const core = { ...facts[0]!, salience: 'CORE' as const },
    detail = {
      ...structuredClone(facts[0]!),
      fact_id: '00000000-0000-4000-8000-000000000098',
      source_order: 1,
      salience: 'DETAIL' as const,
    };
  const other = { ...facts[1]!, salience: 'DETAIL' as const };
  const result = renderFactLedger(
    [core, detail, other],
    integrateFacts([core, detail, other], { links: [] }, map),
    segments,
    1,
  );
  expect(result.report.dispositions.find((d) => d.fact_id === core.fact_id)?.status).toBe(
    'RENDERED',
  );
  expect(result.report.dispositions.find((d) => d.fact_id === detail.fact_id)).toMatchObject({
    status: 'DUPLICATE',
    target_fact_id: core.fact_id,
  });
  expect(result.report.dispositions.find((d) => d.fact_id === other.fact_id)).toMatchObject({
    status: 'EXCLUDED',
    reason_code: 'SUPPORTING_DETAIL_IN_TRANSCRIPT',
  });
});
it('technical constraints remain visible as uncertain source content when both classifiers ignore them', () => {
  const c = summaryCases.find((c) => c.id === 'explicit-decision')!,
    segments = caseSegments(c).slice(0, 1);
  segments[0]!.text = '엔진은 유니티이고 리눅스 호환 문제를 확인 중입니다.';
  const units = sourceUnits(segments),
    draft: UnitClassificationDTO = {
      items: units.map((u) => ({
        unit_key: u.key,
        kind: 'IGNORE',
        salience: 'NON_CONTENT',
        section: 'topics',
        category: '프로그래밍',
      })),
    };
  const facts = unitsToFacts(
    units,
    draft,
    { items: draft.items.map((x) => ({ ...x, supported: true })) },
    {
      runKey: 'guard',
      version: 1,
      sources: new Map(segments.map((s) => [s.segment_id, s])),
      participants: qaPeople,
      startedAt: c.started_at,
      verifiedOwners: true,
    },
  );
  expect(facts[0]).toMatchObject({
    kind: 'UNCERTAIN',
    salience: 'CORE',
    verification: 'UNCERTAIN',
    owner_user_id: null,
    due_date: null,
  });
});

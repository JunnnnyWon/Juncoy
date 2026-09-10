import {
  MeetingSummary,
  type SummaryDTO,
  type SegmentDTO,
  type ParticipantDTO,
  type FactDraftDTO,
  type FactVerificationDTO,
  type FactRelationsDTO,
  type LedgerFact,
  type EvidenceSpan,
  type FactDisposition,
  type LedgerReport,
} from '@meeting/contracts';
import { DomainError, localDate, compareSegments } from './index.ts';

export function canonicalJson(value: unknown): string {
  const order = (v: any): any =>
    Array.isArray(v)
      ? v.map(order)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, order(v[k])]),
          )
        : v;
  return JSON.stringify(order(value));
}
export function spanFor(s: SegmentDTO): EvidenceSpan {
  return {
    segment_id: s.segment_id,
    revision: s.revision,
    start_char: 0,
    end_char: s.text.length,
    quote: s.text,
  };
}
export function assertSpan(span: EvidenceSpan, sources: Map<string, SegmentDTO>) {
  const source = sources.get(span.segment_id);
  if (
    !source ||
    source.revision !== span.revision ||
    span.start_char < 0 ||
    span.end_char <= span.start_char ||
    span.end_char > source.text.length ||
    source.text.slice(span.start_char, span.end_char) !== span.quote
  )
    throw new DomainError('INVALID_EVIDENCE_SPAN');
}
const negative =
  /(맡지 않|하지 않|하겠다는 뜻[은이]? 아|말한 적[은이]? 없|배정.*취소|담당.*미정|담당.*특정하지|아직.*정하지)/;
const intent =
  /(하겠습니다|진행하겠습니다|맡겠습니다|구현하겠습니다|작성하겠습니다|정리하겠습니다|보내드리겠습니다|해주세요|해 주세요|부탁|요청|담당.*(?:합니다|확정)|대신 맡)/;
function ownerSupported(
  id: string,
  span: EvidenceSpan | null,
  sources: Map<string, SegmentDTO>,
  participants: ParticipantDTO[],
) {
  if (!span) return false;
  const s = sources.get(span.segment_id);
  if (!s) return false;
  const text = span.quote,
    pronoun = /(제가|저는|저 |내가|나는)/.exec(text);
  const promise = /(하겠습니다|맡겠습니다|보내드리겠습니다)/.test(text);
  const self = pronoun ? text.slice(pronoun.index) : text;
  if (promise && !negative.test(self) && !/(함께|공동|둘이)/.test(self)) {
    if (pronoun) return s.user_id === id;
  }
  if (negative.test(text) || !intent.test(text)) return false;
  const names = new Map<string, Set<string>>();
  for (const p of [
    ...participants,
    ...[...sources.values()].map((s) => ({ user_id: s.user_id, display_name: s.display_name })),
  ]) {
    const set = names.get(p.display_name) ?? new Set<string>();
    set.add(p.user_id);
    names.set(p.display_name, set);
  }
  const targets = [...names].filter(([name]) =>
    new RegExp(
      '(^|[\\s,(])' +
        name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '(님|씨|이|가|은|는|에게|한테|와|과|[\\s,.)]|$)',
    ).test(text),
  );
  if (!targets.length && promise) return s.user_id === id;
  return targets.some(([, ids]) => ids.size === 1 && ids.has(id));
}
export function resolveFactDate(
  text: string | null,
  span: EvidenceSpan | null,
  sources: Map<string, SegmentDTO>,
  startedAt: string | null,
) {
  if (
    !text ||
    !span ||
    !startedAt ||
    !span.quote.includes(text) ||
    /(쯤|스프린트|언젠가|가능하면|미정|추후)/.test(text)
  )
    return null;
  const source = sources.get(span.segment_id)!;
  const relative = /(오늘|내일|모레)/.exec(text);
  if (relative) {
    const d = new Date(localDate(startedAt, source.start_ms) + 'T00:00:00Z');
    d.setUTCDate(
      d.getUTCDate() + ({ 오늘: 0, 내일: 1, 모레: 2 } as Record<string, number>)[relative[1]!]!,
    );
    return d.toISOString().slice(0, 10);
  }
  const full = /(\d{4})\s*(?:년|[-./])\s*(\d{1,2})\s*(?:월|[-./])\s*(\d{1,2})\s*일?/.exec(text);
  const md = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(text);
  if (!full && !md) return null;
  const date = full
    ? `${full[1]}-${full[2]!.padStart(2, '0')}-${full[3]!.padStart(2, '0')}`
    : `${localDate(startedAt, source.start_ms).slice(0, 4)}-${md![1]!.padStart(2, '0')}-${md![2]!.padStart(2, '0')}`;
  const parsed = new Date(date + 'T00:00:00Z');
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}
export function materializeFact(
  draft: FactDraftDTO,
  options: {
    id: string;
    version: number;
    sources: Map<string, SegmentDTO>;
    order: Map<string, number>;
    participants: ParticipantDTO[];
    startedAt: string | null;
    verifiedOwners: boolean;
    spans?: EvidenceSpan[];
  },
): LedgerFact {
  const evidence =
    options.spans ??
    draft.evidence_segment_ids.map((id) => {
      const s = options.sources.get(id);
      if (!s) throw new DomainError('INVALID_EVIDENCE');
      return spanFor(s);
    });
  const dueSpan =
    draft.due_evidence_index === null ? null : (evidence[draft.due_evidence_index] ?? null);
  let owner: string | null = null,
    ownerSpan: EvidenceSpan | null = null;
  if (options.verifiedOwners)
    for (const span of [...evidence].sort(
      (a, b) =>
        options.sources.get(b.segment_id)!.start_ms - options.sources.get(a.segment_id)!.start_ms,
    )) {
      const matches = options.participants.filter((p) =>
        ownerSupported(p.user_id, span, options.sources, options.participants),
      );
      if (matches.length === 1) {
        owner = matches[0]!.user_id;
        ownerSpan = span;
        break;
      }
    }
  const rawDue =
    draft.due_date_text && dueSpan?.quote.includes(draft.due_date_text)
      ? draft.due_date_text
      : null;
  return {
    fact_id: options.id,
    transcript_version: options.version,
    source_order: Math.min(
      ...draft.evidence_segment_ids.map((id) => options.order.get(id) ?? Infinity),
    ),
    kind: draft.kind,
    section:
      draft.kind === 'DECISION'
        ? 'decisions'
        : draft.kind === 'ACTION'
          ? 'action_items'
          : draft.section === 'decisions' || draft.section === 'action_items'
            ? 'topics'
            : draft.section,
    category: draft.category,
    topic: draft.topic,
    statement: draft.statement,
    evidence,
    owner_user_id: owner,
    owner_evidence: owner ? ownerSpan : null,
    due_date: resolveFactDate(rawDue, dueSpan, options.sources, options.startedAt),
    due_date_text: rawDue,
    due_evidence: rawDue ? dueSpan : null,
    verification: 'UNCERTAIN',
    reason_code: 'NOT_VERIFIED',
  };
}
export function applyFactVerification(
  facts: LedgerFact[],
  result: FactVerificationDTO,
  sources: Map<string, SegmentDTO>,
) {
  if (result.missing_evidence_segment_ids.length) throw new DomainError('MISSING_FACT_COVERAGE');
  if (
    result.checks.length !== facts.length ||
    new Set(result.checks.map((c) => c.fact_key)).size !== facts.length
  )
    throw new DomainError('INVALID_VERIFICATION_COVERAGE');
  const checks = new Map(result.checks.map((c) => [c.fact_key, c]));
  return facts.map((original, i) => {
    const check = checks.get(i);
    if (!check) throw new DomainError('INVALID_VERIFICATION_COVERAGE');
    original.evidence.forEach((e) => assertSpan(e, sources));
    const fact = { ...original, reason_code: check.reason_code };
    if (check.verdict === 'UNSUPPORTED') {
      fact.verification = 'REJECTED';
      return fact;
    }
    if (check.verdict === 'UNCERTAIN') {
      fact.kind = 'UNCERTAIN';
      fact.section = 'open_questions';
      fact.verification = 'UNCERTAIN';
    } else {
      const text = fact.evidence.map((e) => e.quote).join(' ');
      const quoted = /(공격 예시|가정입니다|인용문|예시입니다|실제 결정으로 기록하면 안)/.test(
        text,
      );
      const action =
        !quoted &&
        (/(?:제가|저는|저 |내가)[^.!?]{0,180}(?:하겠습니다|맡겠습니다|보내드리겠습니다)/.test(
          text,
        ) ||
          /(?:님|에게)[^.!?]{0,120}(?:요청|부탁|해 주세요|해주세요)/.test(text));
      const decision =
        !quoted &&
        /(최종\s*(?:합의|결정)|결정합니다|확정합니다|합의했습니다|확정(?:이 )?(?:됐|되었))/.test(
          text,
        );
      const kind = action
        ? 'ACTION'
        : decision
          ? 'DECISION'
          : check.kind === 'ACTION' || check.kind === 'DECISION'
            ? 'PROPOSAL'
            : check.kind;
      fact.verification = kind === fact.kind ? 'SUPPORTED' : 'DOWNGRADED';
      fact.kind = kind;
      fact.section =
        kind === 'ACTION'
          ? 'action_items'
          : kind === 'DECISION'
            ? 'decisions'
            : kind === 'UNCERTAIN'
              ? 'open_questions'
              : fact.section === 'decisions' || fact.section === 'action_items'
                ? 'topics'
                : fact.section;
    }
    if (!check.section_supported && fact.kind !== 'ACTION' && fact.kind !== 'DECISION')
      fact.section = 'topics';
    if (fact.kind !== 'ACTION' || !check.owner_supported) {
      fact.owner_user_id = null;
      fact.owner_evidence = null;
    }
    if (fact.kind !== 'ACTION' || !check.due_supported) {
      fact.due_date = null;
      if (!check.due_supported) {
        fact.due_date_text = null;
        fact.due_evidence = null;
      }
    }
    return fact;
  });
}
const norm = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, '');
function actionStem(text: string, sources: Map<string, SegmentDTO>) {
  let result = text
    .split(/[.!?](?=\s|$)/)[0]!
    .replace(/^(?:네|예)[,\s]*/, '')
    .replace(/^(제가|저는|내가|나는)\s*/, '');
  const names = [...new Set([...sources.values()].map((s) => s.display_name))].sort(
    (a, b) => b.length - a.length,
  );
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp('^' + escaped + '(?:님|씨)?(?:이|가|은|는|에게|한테)?(?=\\s)\\s*'),
      '',
    );
  }
  result = result
    .replace(/(?:해\s*주세요|하겠습니다|부탁드립니다|요청합니다)[.\s]*$/, '')
    .replace(/([가-힣])(?:을|를)(?=\s|$)/g, '$1');
  return norm(result);
}
export function isExplicitFactChange(text: string) {
  return /(?:취소|철회|번복|정정)(?:합니다|했습니다|하겠습니다|하기로\s*(?:했|결정)|되었|됐)|변경(?:합니다|했습니다|하기로\s*(?:확정|결정))|바꿉니다|맡지\s*않겠습니다|대신[^.!?]{0,180}맡겠습니다|배정[^.!?]{0,80}보류합니다/.test(
    text,
  );
}
export function integrateFacts(
  facts: LedgerFact[],
  relations: FactRelationsDTO,
  sources: Map<string, SegmentDTO>,
): FactDisposition[] {
  if (new Set(facts.map((f) => f.fact_id)).size !== facts.length)
    throw new DomainError('DUPLICATE_FACT_ID');
  const disposition = new Map(
    facts.map((f) => [
      f.fact_id,
      {
        fact_id: f.fact_id,
        status:
          f.verification === 'REJECTED'
            ? 'REJECTED'
            : f.salience === 'DETAIL'
              ? 'EXCLUDED'
              : 'RENDERED',
        target_fact_id: null,
        output_path: null,
        reason_code: f.salience === 'DETAIL' ? 'SUPPORTING_DETAIL_IN_TRANSCRIPT' : f.reason_code,
      } as FactDisposition,
    ]),
  );
  const fingerprint = (f: LedgerFact) =>
    canonicalJson([
      f.kind,
      f.kind === 'ACTION' ? actionStem(f.statement, sources) : norm(f.statement),
      f.owner_user_id,
      f.due_date,
      f.due_date_text,
    ]);
  const seen = new Map<string, LedgerFact>();
  for (const fact of facts.filter((f) => f.verification !== 'REJECTED')) {
    const key = fingerprint(fact),
      older = seen.get(key);
    if (
      older &&
      disposition.get(older.fact_id)!.status === 'RENDERED' &&
      disposition.get(fact.fact_id)!.status === 'EXCLUDED'
    ) {
      Object.assign(disposition.get(fact.fact_id)!, {
        status: 'DUPLICATE',
        target_fact_id: older.fact_id,
        reason_code: 'EXACT_DUPLICATE',
      });
      continue;
    }
    if (older) {
      const d = disposition.get(older.fact_id)!;
      d.status = 'DUPLICATE';
      d.target_fact_id = fact.fact_id;
      d.reason_code = 'EXACT_DUPLICATE';
    }
    seen.set(key, fact);
  }
  for (const link of relations.links) {
    const older = facts[link.earlier_fact_key],
      later = facts[link.later_fact_key];
    if (
      !older ||
      !later ||
      older.source_order >= later.source_order ||
      later.verification === 'REJECTED'
    )
      throw new DomainError('INVALID_FACT_RELATION');
    if (older.verification === 'REJECTED') continue;
    const ids = new Set([...older.evidence, ...later.evidence].map((e) => e.segment_id));
    if (link.evidence_segment_ids.some((id) => !ids.has(id) || !sources.has(id)))
      throw new DomainError('INVALID_RELATION_EVIDENCE');
    if (link.relation === 'DUPLICATE' && fingerprint(older) !== fingerprint(later)) continue;
    if (link.relation === 'SUPERSEDED') {
      const text = later.evidence.map((e) => e.quote).join(' ');
      if (!isExplicitFactChange(text)) throw new DomainError('UNSUPPORTED_REVERSAL');
      if (!['DECISION', 'ACTION'].includes(older.kind)) continue;
    }
    Object.assign(disposition.get(older.fact_id)!, {
      status: link.relation,
      target_fact_id: later.fact_id,
      reason_code: link.relation === 'SUPERSEDED' ? 'EXPLICIT_CHANGE' : 'EXACT_DUPLICATE',
    });
  }
  return [...disposition.values()];
}
export function renderFactLedger(
  facts: LedgerFact[],
  dispositions: FactDisposition[],
  sources: SegmentDTO[],
  inputVersion: number,
  context?: { participants: ParticipantDTO[]; startedAt: string | null },
): { result: SummaryDTO; report: LedgerReport } {
  const sourceMap = new Map(sources.map((s) => [s.segment_id, s]));
  const byDisposition = new Map(dispositions.map((d) => [d.fact_id, d]));
  if (byDisposition.size !== facts.length || dispositions.length !== facts.length)
    throw new DomainError('FACT_DISPOSITION_COVERAGE');
  for (const f of facts) {
    if (f.transcript_version !== inputVersion) throw new DomainError('WRONG_FACT_VERSION');
    f.evidence.forEach((e) => assertSpan(e, sourceMap));
    if (!f.evidence.some((e) => e.quote === f.statement))
      throw new DomainError('NON_LITERAL_FACT_STATEMENT');
    if (
      f.owner_user_id !== null &&
      context &&
      !ownerSupported(f.owner_user_id, f.owner_evidence, sourceMap, context.participants)
    )
      throw new DomainError('UNSUPPORTED_FACT_OWNER');
    if (
      f.due_date !== null &&
      context &&
      resolveFactDate(f.due_date_text, f.due_evidence, sourceMap, context.startedAt) !== f.due_date
    )
      throw new DomainError('UNSUPPORTED_FACT_DATE');
  }
  const result: SummaryDTO = {
    title: '회의 기록',
    summary: [],
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    blockers: [],
    next_agenda: [],
    quality_notes: [],
  };
  const active = facts
    .filter((f) => byDisposition.get(f.fact_id)?.status === 'RENDERED')
    .sort((a, b) => a.source_order - b.source_order || a.fact_id.localeCompare(b.fact_id));
  const topics = new Map<string, number>();
  for (const fact of active) {
    if (fact.verification === 'REJECTED') throw new DomainError('REJECTED_FACT_RENDERED');
    const ids = [...new Set(fact.evidence.map((e) => e.segment_id))],
      d = byDisposition.get(fact.fact_id)!;
    if (fact.kind === 'DECISION') {
      d.output_path = `decisions[${result.decisions.length}]`;
      result.decisions.push({ decision: fact.statement, reason: null, evidence_segment_ids: ids });
    } else if (fact.kind === 'ACTION') {
      d.output_path = `action_items[${result.action_items.length}]`;
      result.action_items.push({
        task: fact.statement,
        owner_user_id: fact.owner_user_id,
        due_date: fact.due_date,
        due_date_text: fact.due_date_text,
        evidence_segment_ids: ids,
      });
    } else if (fact.section === 'open_questions') {
      d.output_path = `open_questions[${result.open_questions.length}]`;
      result.open_questions.push({ question: fact.statement, evidence_segment_ids: ids });
    } else if (fact.section === 'blockers') {
      d.output_path = `blockers[${result.blockers.length}]`;
      result.blockers.push({
        issue: fact.statement,
        impact: null,
        mentioned_solution: null,
        evidence_segment_ids: ids,
      });
    } else if (fact.section === 'next_agenda') {
      d.output_path = `next_agenda[${result.next_agenda.length}]`;
      result.next_agenda.push({
        agenda: fact.statement,
        origin: /(다음|차주).*(회의|안건)/.test(fact.evidence.map((e) => e.quote).join(' '))
          ? 'EXPLICIT'
          : 'DERIVED',
        evidence_segment_ids: ids,
      });
    } else {
      const key = fact.category;
      let index = topics.get(key);
      if (index === undefined) {
        index = result.topics.length;
        topics.set(key, index);
        result.topics.push({
          category: fact.category,
          title: fact.category + ' 논의',
          discussion: '',
          evidence_segment_ids: [],
        });
      }
      const topic = result.topics[index]!;
      topic.discussion += [
        topic.discussion ? '\n' : '',
        fact.kind === 'PROPOSAL' ? '제안: ' : fact.kind === 'UNCERTAIN' ? '확인 필요: ' : '',
        fact.statement,
      ].join('');
      topic.evidence_segment_ids = [...new Set([...topic.evidence_segment_ids, ...ids])];
      d.output_path = `topics[${index}].discussion`;
    }
  }
  // Keep each topic readable: select a few distinct, substantive utterances
  // and join them into a compact paragraph instead of dumping the ledger.
  for (const topic of result.topics) {
    const lines = topic.discussion
      .split('\n')
      .map((line) => line.replace(/^(?:확인 필요|제안):\s*/, '').trim())
      .filter(
        (line) =>
          line.length >= 20 &&
          !/[?？]$/.test(line) &&
          !/^(?:네|예|아|음|어|안녕하세요|봤으니까|먼저 얘기|다른 분들|혹시)/.test(line),
      );
    const selected: string[] = [];
    for (const line of lines) {
      const words = new Set(line.split(/\s+/).filter((word) => word.length >= 2));
      const duplicate = selected.some((previous) => {
        const prior = new Set(previous.split(/\s+/).filter((word) => word.length >= 2));
        const overlap = [...words].filter((word) => prior.has(word)).length;
        return overlap >= 3 && overlap / Math.max(1, Math.min(words.size, prior.size)) > 0.55;
      });
      if (!duplicate) selected.push(line);
      if (selected.length >= 6) break;
    }
    topic.discussion = selected.join(' ');
  }
  for (const d of dispositions) {
    if (d.status === 'RENDERED' && !d.output_path) throw new DomainError('MISSING_FACT_OUTPUT');
    if (d.target_fact_id) {
      let current = d,
        visited = new Set<string>();
      while (current.target_fact_id) {
        if (visited.has(current.fact_id)) throw new DomainError('FACT_RELATION_CYCLE');
        visited.add(current.fact_id);
        const next = byDisposition.get(current.target_fact_id);
        if (!next || next.status === 'REJECTED') throw new DomainError('MISSING_FACT_TARGET');
        current = next;
      }
    }
  }
  const titles = [...new Set(active.map((f) => f.category + ' 논의'))];
  result.title = sources.length ? '회의 기록' : '기록된 발언이 없는 회의';
  result.summary = result.topics
    .filter((topic) => topic.discussion.length > 0)
    .map((topic) => `${topic.category}에서는 ${topic.discussion.split(/(?<=[.!?다요])\s+/)[0]}`)
    .slice(0, 5);
  if (dispositions.some((d) => d.status === 'EXCLUDED'))
    result.quality_notes.push('반복 설명과 보충 발언은 전체 전사에서 확인할 수 있습니다.');
  if (facts.some((f) => f.verification === 'REJECTED'))
    result.quality_notes.push('원문 근거가 뒷받침하지 않는 자동 추출 항목은 제외했습니다.');
  if (active.some((f) => f.kind === 'PROPOSAL'))
    result.quality_notes.push('제안은 확정 결정이나 업무와 구분했습니다.');
  if (active.some((f) => f.verification === 'UNCERTAIN' || f.verification === 'DOWNGRADED'))
    result.quality_notes.push('불명확한 발언은 확정하지 않고 확인이 필요한 내용으로 남겼습니다.');
  if (!sources.length) result.quality_notes.push('확정 전사가 없어 요약할 수 없습니다.');
  const used = active.flatMap((f) => f.evidence.map((e) => sourceMap.get(e.segment_id)!.start_ms));
  return {
    result: MeetingSummary.parse(result),
    report: {
      pipeline_version: 'facts-v1',
      input_segments: sources.length,
      primary_coverage: sources.length,
      facts: facts.length,
      rendered: active.length,
      rejected: facts.filter((f) => f.verification === 'REJECTED').length,
      excluded: dispositions.filter((d) => d.status === 'EXCLUDED').length,
      dispositions,
      source_min_ms: used.length ? Math.min(...used) : null,
      source_max_ms: used.length ? Math.max(...used) : null,
      quality_passed: true,
    },
  };
}

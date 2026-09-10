import type {
  SegmentDTO,
  ParticipantDTO,
  EvidenceSpan,
  LedgerFact,
  UnitClassificationDTO,
  UnitReviewDTO,
} from '@meeting/contracts';
import { DomainError, materializeFact, localDate, isExplicitFactChange } from '@meeting/domain';
import { hash } from './crypto.ts';
import { z } from 'zod';

const UnitLabel = z.enum([
  'CORE_DISCUSSION',
  'DETAIL_DISCUSSION',
  'CORE_PROPOSAL',
  'DETAIL_PROPOSAL',
  'DECISION',
  'ACTION',
  'UNCERTAIN',
  'NON_CONTENT',
]);
export function classificationSchema(count: number) {
  return z
    .object({
      labels: z
        .object(Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), UnitLabel])))
        .strict(),
    })
    .strict();
}
function categoryFor(text: string) {
  if (/(?:AD|아트|폴리곤|모델링|텍스처|색감|캐릭터|로우폴리)/.test(text)) return '아트' as const;
  if (
    /(?:유니티|언리얼|원리얼|얼리얼|Unity|Unreal|엔진|스크립트|코드|메모리|프로그래|렌더링|최적화)/i.test(
      text,
    )
  )
    return '프로그래밍' as const;
  if (/(?:사운드|음악|효과음|BGM)/i.test(text)) return '사운드' as const;
  if (/(?:테스트|버그|QA|플레이테스트)/i.test(text)) return 'QA' as const;
  if (/(?:일정|마감|담당자|다음 회의|배포|서버)/.test(text)) return '운영' as const;
  return '기획' as const;
}
export function decodeClassification(
  value: { labels: Record<string, string> },
  units: FactUnit[],
): UnitReviewDTO {
  return {
    items: Object.entries(value.labels).map(([key, label]) => {
      const kind =
        label === 'NON_CONTENT'
          ? 'IGNORE'
          : (label.replace(/^(CORE|DETAIL)_/, '') as UnitReviewDTO['items'][number]['kind']);
      return {
        unit_key: Number(key),
        kind,
        category: categoryFor(units[Number(key)]!.span.quote),
        section:
          kind === 'UNCERTAIN' &&
          /(미정|아직.*정하지|누가.*맡|언제.*결정)/.test(units[Number(key)]!.span.quote)
            ? 'open_questions'
            : 'topics',
        supported: kind !== 'UNCERTAIN',
        salience:
          label === 'NON_CONTENT' ? 'NON_CONTENT' : label.startsWith('DETAIL_') ? 'DETAIL' : 'CORE',
      };
    }),
  };
}

export interface FactUnit {
  key: number;
  source: SegmentDTO;
  span: EvidenceSpan;
  source_order: number;
  instruction: boolean;
}
const commit =
  /(하겠습니다|맡겠습니다|보내드리겠습니다|해 주세요|해주세요|부탁드립니다|요청합니다)/;
const change = /(취소|철회|번복|대신|변경|맡지 않)/;
export function sourceUnits(segments: SegmentDTO[]): FactUnit[] {
  const units: FactUnit[] = [];
  for (const [index, source] of segments.entries()) {
    const pieces: { start: number; end: number }[] = [];
    let from = 0;
    for (const match of source.text.matchAll(/[.!?](?=\s|$)/g)) {
      pieces.push({ start: from, end: match.index! + 1 });
      from = match.index! + 1;
    }
    if (from < source.text.length) pieces.push({ start: from, end: source.text.length });
    const grouped: { start: number; end: number }[] = [];
    for (const part of pieces) {
      while (part.start < part.end && /\s/.test(source.text[part.start]!)) part.start++;
      while (part.end > part.start && /\s/.test(source.text[part.end - 1]!)) part.end--;
      if (part.start === part.end) continue;
      const text = source.text.slice(part.start, part.end),
        last = grouped.at(-1),
        previous = last ? source.text.slice(last.start, last.end) : '';
      const deadline = /^(기한|마감|내일|모레|오늘|\d{4}년|다음\s*(주|스프린트)|금요일)/.test(text);
      if (
        last &&
        ((commit.test(previous) && deadline && !change.test(text)) ||
          (/기한.*변경/.test(previous) && commit.test(text)) ||
          (change.test(previous) && /(미정|아직.*정하지|대체 담당자)/.test(text)) ||
          /^(?:최종\s*)?(?:합의|결정|결론)(?:사항)?입니다[.!]?$/.test(previous))
      )
        last.end = part.end;
      else grouped.push({ ...part });
    }
    for (const group of grouped) {
      let start = group.start;
      while (start < group.end) {
        let end = Math.min(group.end, start + 750);
        if (end < group.end) {
          const space = source.text.lastIndexOf(' ', end);
          if (space > start + 200) end = space;
        }
        const quote = source.text.slice(start, end);
        if (quote.trim())
          units.push({
            key: units.length,
            source,
            span: {
              segment_id: source.segment_id,
              revision: source.revision,
              start_char: start,
              end_char: end,
              quote,
            },
            source_order: index * 1000000 + start,
            instruction:
              /(공격 예시|이전 지시를 무시|시스템 프롬프트|실제 결정으로 기록하면 안|가정입니다|인용문)/.test(
                source.text,
              ),
          });
        start = end;
        while (start < group.end && /\s/.test(source.text[start]!)) start++;
      }
    }
  }
  return units;
}
export function unitGroups(units: FactUnit[], maxChars = 16000) {
  const result: FactUnit[][] = [];
  let current: FactUnit[] = [],
    size = 0;
  for (const u of units) {
    const n = u.span.quote.length + 90;
    if (current.length && (size + n > maxChars || current.length >= 20)) {
      result.push(current);
      current = [];
      size = 0;
    }
    current.push(u);
    size += n;
  }
  if (current.length) result.push(current);
  return result;
}
export function ruleKind(u: FactUnit): 'IGNORE' | 'DECISION' | 'ACTION' | 'PROPOSAL' | null {
  const t = u.span.quote;
  if (u.instruction) return 'IGNORE';
  // Turn-taking and generic effort are not concrete work assignments.
  if (
    /^(?:(?:네|예|아|자|그럼)[,\s]*)?(?:먼저\s*|계속\s*|한번\s*)?(?:(?:얘기|이야기|말씀)(?:해|하셔)\s*주세요|열심히\s*하겠습니다)[.!?]?$/.test(
      t,
    )
  )
    return null;
  if (/^(?:최종\s*)?(?:합의|결정|결론)(?:사항)?입니다[.!]?$/.test(t)) return null;
  if (
    /(?:맡지 않|하지 않|약속이 아|뜻[은이]? 아|말한 적[은이]? 없|배정.*취소)/.test(t) &&
    !/(대신.*맡겠습니다)/.test(t)
  )
    return null;
  if (/^(만약|가령|예를 들어|내일.*결정|나중에.*결정)/.test(t)) return null;
  if (/(?:^|[,\s])(?:안\s*되면(?:은)?|가능하면|할 수 있으면)/.test(t)) return 'PROPOSAL';
  if (/(방향|안건|주제).*논의하겠습니다/.test(t)) return null;
  if (commit.test(t) && !/(취소(?:해 주세요|해주세요)|요청.*취소)/.test(t)) return 'ACTION';
  if (
    /(최종\s*(?:합의|결정)|(?:로|으로)\s*(?:결정|확정)합니다|합의했습니다|확정(?:이 )?(?:됐|되었))/.test(
      t,
    ) &&
    !/(결정은 취소|확정은 취소)/.test(t)
  )
    return 'DECISION';
  if (/(아이디어|선호|후보|어떨까요|좋을 것 같)/.test(t)) return 'PROPOSAL';
  return null;
}
function uuid(v: string) {
  const h = hash(v);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function unitsToFacts(
  units: FactUnit[],
  draft: UnitClassificationDTO,
  review: UnitReviewDTO,
  options: {
    runKey: string;
    version: number;
    sources: Map<string, SegmentDTO>;
    participants: ParticipantDTO[];
    startedAt: string | null;
    verifiedOwners: boolean;
  },
): LedgerFact[] {
  const first = new Map(draft.items.map((x) => [x.unit_key, x])),
    second = new Map(review.items.map((x) => [x.unit_key, x]));
  if (
    first.size !== units.length ||
    second.size !== units.length ||
    draft.items.length !== units.length ||
    review.items.length !== units.length
  )
    throw new DomainError('UNIT_COVERAGE');
  const result: LedgerFact[] = [];
  for (const unit of units) {
    const a = first.get(unit.key),
      b = second.get(unit.key);
    if (!a || !b) throw new DomainError('UNIT_COVERAGE');
    const rule = ruleKind(unit);
    const criticalTopic =
      unit.span.quote.length >= 12 &&
      /(?:Unity|Unreal|유니티|언리얼|원리얼|얼리얼|\bAD\b|폴리[곤건]|기한|마감|담당|역할|작업량|공수|제약|의존)/i.test(
        unit.span.quote,
      );
    const scopeStatement = /(미정|아직.*(?:결정|확정|정하지|배정).*(?:없|않))/.test(
      unit.span.quote,
    );
    const rejected =
      rule === 'IGNORE' ||
      (!rule &&
        a.kind === 'IGNORE' &&
        b.kind === 'IGNORE' &&
        !isExplicitFactChange(unit.span.quote) &&
        !scopeStatement &&
        !criticalTopic);
    let kind =
      (rule === 'ACTION' || rule === 'DECISION'
        ? b.supported && b.kind === rule
          ? rule
          : 'UNCERTAIN'
        : rule) ??
      (b.supported && b.kind !== 'IGNORE' ? b.kind : a.kind === 'IGNORE' ? 'UNCERTAIN' : a.kind);
    if (!rule && (kind === 'ACTION' || kind === 'DECISION')) kind = 'UNCERTAIN';
    if (kind === 'IGNORE') kind = 'DISCUSSION';
    const section =
      kind === 'ACTION'
        ? 'action_items'
        : kind === 'DECISION'
          ? 'decisions'
          : kind === 'UNCERTAIN'
            ? scopeStatement
              ? 'open_questions'
              : 'topics'
            : b.section === 'decisions' || b.section === 'action_items'
              ? 'topics'
              : b.section;
    const dates = [
      ...unit.span.quote.matchAll(
        /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}-\d{2}-\d{2}|\d{1,2}\s*월\s*\d{1,2}\s*일|다음\s*스프린트|[월화수목금토일]요일쯤|내일|모레|오늘/g,
      ),
    ];
    const raw = dates.at(-1)?.[0] ?? null;
    const fact = materializeFact(
      {
        kind,
        section,
        category: b.supported ? b.category : a.category,
        topic: unit.span.quote.slice(0, 100),
        statement: unit.span.quote,
        evidence_segment_ids: [unit.source.segment_id],
        owner_user_id: null,
        owner_evidence_index: 0,
        due_date_text: raw,
        due_evidence_index: raw ? 0 : null,
      },
      {
        id: uuid(
          options.runKey +
            ':unit:' +
            unit.source.segment_id +
            ':' +
            unit.span.start_char +
            ':' +
            unit.span.end_char,
        ),
        version: options.version,
        sources: options.sources,
        order: new Map([[unit.source.segment_id, unit.source_order]]),
        participants: options.participants,
        startedAt: options.startedAt,
        verifiedOwners: options.verifiedOwners,
        spans: [unit.span],
      },
    );
    fact.salience = rejected
      ? 'NON_CONTENT'
      : ['ACTION', 'DECISION', 'PROPOSAL'].includes(kind) ||
          isExplicitFactChange(unit.span.quote) ||
          scopeStatement ||
          criticalTopic
        ? 'CORE'
        : a.salience === 'DETAIL' && b.salience === 'DETAIL'
          ? 'DETAIL'
          : 'CORE';
    fact.verification = rejected ? 'REJECTED' : kind === 'UNCERTAIN' ? 'UNCERTAIN' : 'SUPPORTED';
    fact.reason_code = rejected
      ? unit.instruction
        ? 'TRANSCRIPT_INSTRUCTION'
        : 'NON_SUBSTANTIVE'
      : rule
        ? 'EXPLICIT_SOURCE_RULE'
        : b.supported
          ? 'SOURCE_CLASSIFIED'
          : 'UNCERTAIN_SOURCE';
    if (kind !== 'ACTION') {
      fact.owner_user_id = null;
      fact.owner_evidence = null;
      fact.due_date = null;
      fact.due_date_text = null;
      fact.due_evidence = null;
    } else {
      if (b.owner_supported === false) {
        fact.owner_user_id = null;
        fact.owner_evidence = null;
      }
      if (b.due_supported === false) {
        fact.due_date = null;
        fact.due_evidence = null;
      }
    }
    result.push(fact);
  }
  return result;
}
export function unitInput(units: FactUnit[], startedAt: string | null) {
  return units.map((u) => ({
    unit_key: u.key,
    text: u.span.quote,
    speaker: u.source.display_name,
    topic_hint: categoryFor(u.source.text),
    local_date: startedAt ? localDate(startedAt, u.source.start_ms) : null,
  }));
}

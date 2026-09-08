import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Solar, loadConfig } from '@meeting/providers';
import { chunkSegments, validateSummary } from '@meeting/domain';
import type { SegmentDTO, ParticipantDTO, SummaryDTO } from '@meeting/contracts';
const directory = resolve(process.argv[2] ?? '.data/qa/offline-20260907');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
const source = JSON.parse(await readFile(resolve(directory, 'provider-result.json'), 'utf8'));
const uuid = (key: string) => {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
const segments: SegmentDTO[] = source.results.utterances.map((u: any, i: number) => ({
  segment_id: uuid(manifest.input_sha256 + ':' + i),
  user_id: (800000000000000000n + BigInt(u.spk ?? 0)).toString(),
  display_name: '추정 화자 ' + String((u.spk ?? 0) + 1).padStart(2, '0'),
  start_ms: u.start_at,
  end_ms: u.start_at + u.duration,
  text: u.msg,
  is_final: true,
  revision: 1,
  corrected: false,
  quality_flags: ['OFFLINE_MIXED_AUDIO', 'UNVERIFIED_SPEAKER'],
  overlap_group_id: null,
  updated_at: manifest.completed_at,
}));
const participants: ParticipantDTO[] = [
  ...new Map(
    segments.map((s) => [
      s.user_id,
      { user_id: s.user_id, display_name: s.display_name, present: true, recording_eligible: true },
    ]),
  ).values(),
];
await writeFile(resolve(directory, 'segments.json'), JSON.stringify(segments, null, 2), {
  mode: 0o600,
});
const policy =
  '오프라인 단일 채널 녹음의 비공개 QA다. user_id는 실제 Discord 사용자가 아닌 임시 추정 화자 라벨이다. 모든 action_items.owner_user_id는 null로 두고 담당자가 명시되면 task 문장 안에만 원문 이름을 보존한다. 녹음 날짜가 미상이므로 모든 due_date는 null이고 원래 기한 표현만 due_date_text에 보존한다. 불명확하거나 깨진 인식 결과를 확정 수치나 사실로 만들지 않는다. 단순 제안과 선호를 확정 결정으로 바꾸지 않는다. 근거가 불충분한 항목은 미결로 남긴다.';
const metadata = {
  source_kind: 'OFFLINE_QA',
  recorded_at: manifest.recorded_at ?? null,
  date_context: 'UNKNOWN',
  verified_discord_ids: false,
  reported_participants_minimum: manifest.reported_participants_minimum,
  inferred_clusters: participants.length,
  identity_notice: '추정 화자는 실제 참석자와 1:1 대응이 검증되지 않음',
};
const solar = new Solar(loadConfig());
const chunks = chunkSegments(segments);
const coverage = chunks.flatMap((c) => c.primary.map((s) => s.segment_id));
if (new Set(coverage).size !== segments.length || coverage.length !== segments.length)
  throw new Error('Coverage invalid');
const usage: any[] = [];
const findings: any[] = [];
const started = Date.now();
const run = async (name: string, input: unknown, evidence: SegmentDTO[]): Promise<SummaryDTO> => {
  const path = resolve(directory, name + '.json');
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    return cached.result;
  } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = await solar.chat(input, name + ':' + attempt, async (u) => {
        usage.push(u);
        await writeFile(resolve(directory, 'summary-usage.json'), JSON.stringify(usage, null, 2), {
          mode: 0o600,
        });
      });
      await writeFile(
        resolve(directory, name + `-attempt-${attempt}.json`),
        JSON.stringify(output, null, 2),
        { mode: 0o600 },
      );
      const result = validateSummary(output.result, evidence, participants);
      if (result.action_items.some((a) => a.owner_user_id !== null || a.due_date !== null))
        throw new Error('UNVERIFIED_IDENTITY_OR_DATE');
      await writeFile(path, JSON.stringify(output, null, 2), { mode: 0o600 });
      process.stdout.write(name + ' passed\n');
      return result;
    } catch (e) {
      findings.push({ stage: name, attempt, error: (e as any).code ?? (e as Error).message });
      await writeFile(
        resolve(directory, 'summary-findings.json'),
        JSON.stringify(findings, null, 2),
        { mode: 0o600 },
      );
      if (attempt === 2) throw e;
    }
  }
  throw new Error('Summary attempt exhausted');
};
let level: SummaryDTO[] = [];
for (const [i, chunk] of chunks.entries())
  level.push(
    await run(
      'chunk-' + i,
      {
        metadata,
        participants,
        phase:
          policy + ' 시간순으로 primary_segments만 추출하고 context_segments는 문맥에만 사용한다.',
        primary_segments: chunk.primary,
        context_segments: chunk.context,
      },
      [...chunk.primary, ...chunk.context],
    ),
  );
let depth = 0;
while (level.length > 1) {
  const next: SummaryDTO[] = [];
  for (let i = 0; i < level.length; i += 4) {
    const extracts = level.slice(i, i + 4);
    const ids = new Set(
      extracts.flatMap((e) =>
        [
          ...e.topics,
          ...e.decisions,
          ...e.action_items,
          ...e.open_questions,
          ...e.blockers,
          ...e.next_agenda,
        ].flatMap((x) => x.evidence_segment_ids),
      ),
    );
    next.push(
      await run(
        `merge-${depth}-${i}`,
        {
          metadata,
          participants,
          phase: policy + ' 시간순 추출 결과를 통합하고 뒤의 번복을 반영한다.',
          extracts,
          evidence: segments.filter((s) => ids.has(s.segment_id)),
        },
        segments,
      ),
    );
  }
  level = next;
  depth++;
}
const final = level[0]!;
await writeFile(resolve(directory, 'summary.json'), JSON.stringify(final, null, 2), {
  mode: 0o600,
});
const report = {
  summary_seconds: (Date.now() - started) / 1000,
  chunks: chunks.length,
  coverage_utterances: coverage.length,
  coverage_unique: new Set(coverage).size,
  decisions: final.decisions.length,
  actions: final.action_items.length,
  all_evidence_ids_valid: true,
  unverified_owner_ids: final.action_items.filter((a) => a.owner_user_id !== null).length,
  unverified_dates: final.action_items.filter((a) => a.due_date !== null).length,
  validation_retries: findings.length,
  input_tokens: usage.reduce((n, u) => n + u.input_tokens, 0),
  output_tokens: usage.reduce((n, u) => n + u.output_tokens, 0),
  model: usage.at(-1)?.model ?? 'cached',
};
await writeFile(resolve(directory, 'summary-metrics.json'), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
process.stdout.write(JSON.stringify(report) + '\n');

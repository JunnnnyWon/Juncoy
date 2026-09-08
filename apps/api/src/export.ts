import type { MeetingViewDTO, SegmentDTO, SummaryDTO, GapDTO } from '@meeting/contracts';
const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const md = (s: string) => s.replace(/[\\`*_{}\[\]<>#]/g, '\\$&');
export function exportText(
  meeting: MeetingViewDTO,
  segments: SegmentDTO[],
  gaps: GapDTO[],
  version: number,
) {
  return [
    meeting.title,
    `전사 버전 ${version} · 내보낸 시각 ${new Date().toISOString()}`,
    !meeting.ended_at ? '작성 시점까지의 부분 기록' : '종료된 회의',
    ...gaps
      .filter((g) => !g.resolved)
      .map(
        (g) =>
          `[누락 ${time(g.start_ms)} ~ ${g.end_ms === null ? '진행 중' : time(g.end_ms)}: ${g.reason}]`,
      ),
    '',
    ...segments.map((s) => `[${time(s.start_ms)}] ${s.display_name}: ${s.text}`),
  ].join('\n');
}
export function exportMarkdown(
  meeting: MeetingViewDTO,
  segments: SegmentDTO[],
  summary: SummaryDTO | null,
  gaps: GapDTO[],
  base: string,
  version: number,
) {
  const evidence = (ids: string[]) =>
    ids
      .map(
        (id, i) =>
          `[근거 ${i + 1}](${base}/meetings/${meeting.meeting_id}?tab=transcript&segment=${id}&transcript_version=${version})`,
      )
      .join(' ');
  const lines = [
    `# ${md(meeting.title)}`,
    '',
    `자동 요약 · 검토 전 · 전사 버전 ${version}`,
    `내보낸 시각: ${new Date().toISOString()}`,
    !meeting.ended_at ? '작성 시점까지의 부분 기록' : '종료된 회의',
    '',
  ];
  if (summary) {
    lines.push(
      '## 핵심 요약',
      '',
      ...summary.summary.map((s) => '- ' + md(s)),
      '',
      '## 주제별 논의',
      '',
      ...summary.topics.map(
        (s) => `### ${md(s.title)}\n\n${md(s.discussion)} ${evidence(s.evidence_segment_ids)}`,
      ),
      '',
      '## 결정사항',
      '',
      ...summary.decisions.map(
        (s) =>
          `- ${md(s.decision)} ${s.reason ? md(s.reason) : ''} ${evidence(s.evidence_segment_ids)}`,
      ),
      '',
      '## 할 일',
      '',
      ...summary.action_items.map(
        (s) =>
          `- ${md(s.task)} · 담당: ${s.owner_user_id ?? '미정'} · 기한: ${md(s.due_date ?? s.due_date_text ?? '미정')} ${evidence(s.evidence_segment_ids)}`,
      ),
      '',
      '## 미결 질문',
      '',
      ...summary.open_questions.map(
        (s) => `- ${md(s.question)} ${evidence(s.evidence_segment_ids)}`,
      ),
      '',
      '## 장애 요인',
      '',
      ...summary.blockers.map(
        (s) =>
          `- ${md(s.issue)} ${s.impact ? md(s.impact) : ''} ${s.mentioned_solution ? md(s.mentioned_solution) : ''} ${evidence(s.evidence_segment_ids)}`,
      ),
      '',
      '## 다음 안건',
      '',
      ...summary.next_agenda.map(
        (s) =>
          `- ${md(s.agenda)} (${s.origin === 'EXPLICIT' ? '명시' : '도출'}) ${evidence(s.evidence_segment_ids)}`,
      ),
      '',
      '## 품질 주석',
      '',
      ...summary.quality_notes.map((s) => '- ' + md(s)),
    );
  }
  lines.push(
    '',
    '## 수집 누락',
    '',
    ...gaps
      .filter((g) => !g.resolved)
      .map(
        (g) =>
          `- ${time(g.start_ms)} ~ ${g.end_ms === null ? '진행 중' : time(g.end_ms)}: ${g.reason}`,
      ),
    '',
    '## 전체 전사',
    '',
    ...segments.map((s) => `**${time(s.start_ms)} · ${md(s.display_name)}**\n\n${md(s.text)}\n`),
  );
  return lines.join('\n');
}

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MeetingSummary, Segment } from '@meeting/contracts';
import type { SegmentDTO } from '@meeting/contracts';

const directory = resolve(process.argv[2] ?? '.data/qa/offline-20260907');
const revision = process.argv[3] ?? 'revised-v3';
const read = async (name: string) => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
const manifest = await read('manifest.json');
const segments: SegmentDTO[] = (await read('segments.json')).map((s: unknown) => Segment.parse(s));
const summary = MeetingSummary.parse(await read(revision + '/summary.json'));
const metrics = await read(revision + '/metrics.json');
const audit = await read(revision + '/audit.json');
const baseline = await read('summary-metrics.json');
const byId = new Map(segments.map((s) => [s.segment_id, s]));
const time = (ms: number) => {
  const n = Math.floor(ms / 1000);
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
    .map((x) => String(x).padStart(2, '0'))
    .join(':');
};
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const evidence = (ids: string[]) =>
  [...new Set(ids)]
    .map((id) => {
      const s = byId.get(id);
      if (!s) throw new Error('Unknown evidence in report');
      return `<a href="#s-${s.segment_id}" class="evidence">${time(s.start_ms)}</a>`;
    })
    .join(' ');
const group = (title: string, items: { text: string; ids: string[] }[]) =>
  items.length
    ? `<section><h2>${title}</h2><ul>${items.map((i) => `<li><p>${esc(i.text)}</p><div>${evidence(i.ids)}</div></li>`).join('')}</ul></section>`
    : '';
const summarySections = [
  group(
    '주요 논의',
    summary.topics.map((t) => ({
      text: t.title + ' — ' + t.discussion,
      ids: t.evidence_segment_ids,
    })),
  ),
  group(
    '결정 · 자동 추출, 검토 필요',
    summary.decisions.map((t) => ({
      text: t.decision + (t.reason ? ' / ' + t.reason : ''),
      ids: t.evidence_segment_ids,
    })),
  ),
  group(
    '할 일 · 담당자 신원 미확인',
    summary.action_items.map((t) => ({
      text: t.task + (t.due_date_text ? ' / 기한 원문: ' + t.due_date_text : ''),
      ids: t.evidence_segment_ids,
    })),
  ),
  group(
    '미결 쟁점',
    summary.open_questions.map((t) => ({ text: t.question, ids: t.evidence_segment_ids })),
  ),
  group(
    '장애 요소',
    summary.blockers.map((t) => ({ text: t.issue, ids: t.evidence_segment_ids })),
  ),
  group(
    '다음 안건',
    summary.next_agenda.map((t) => ({
      text: (t.origin === 'EXPLICIT' ? '[발언에 명시] ' : '[논의에서 도출] ') + t.agenda,
      ids: t.evidence_segment_ids,
    })),
  ),
].join('');
const people = [...new Map(segments.map((s) => [s.user_id, s.display_name])).entries()];
const transcript = segments
  .map(
    (s) =>
      `<article id="s-${s.segment_id}" data-speaker="${s.user_id}"><header><a href="#s-${s.segment_id}">${time(s.start_ms)}</a><span>${esc(s.display_name)}</span></header><p>${esc(s.text)}</p></article>`,
  )
  .join('');
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'"><title>실제 회의 녹음 QA · 비공개 검토본</title><style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#111416;color:#e5e9e6;line-height:1.75}body{margin:0 auto;max-width:1020px;padding:40px 24px}h1{font-size:30px;line-height:1.3}h2{font-size:21px;margin-top:34px}p{margin:8px 0}a{color:#acd0b4}.notice{border-left:3px solid #ccaf75;padding:12px 18px;background:#20221e;color:#dfd8c9}.stats{display:flex;flex-wrap:wrap;gap:28px;padding:22px 0;border-bottom:1px solid #38403b}.stats strong{display:block;font-size:24px}.muted,header{color:#a6afa8}li{margin:18px 0}.evidence{display:inline-block;font-size:12px;padding:1px 6px;background:#25342b;border-radius:4px;margin:2px}input,select,button{font:inherit;color:inherit;background:#22282a;border:1px solid #48534c;border-radius:5px;padding:9px 12px;min-width:0}input{flex:1}.toolbar{display:flex;flex-wrap:wrap;gap:10px;position:sticky;top:0;background:#111416;padding:14px 0;z-index:1}article{padding:18px 12px;border-top:1px solid #303733;scroll-margin-top:95px}article header{display:flex;gap:18px;font-size:13px}article:target{background:#26382b;outline:1px solid #acd0b4}article[hidden]{display:none}details{margin:24px 0}summary{cursor:pointer}footer{margin-top:36px;font-size:13px;color:#a6afa8}@media(max-width:480px){body{padding:24px 16px}h1{font-size:25px}.stats{gap:20px}.toolbar input{flex-basis:100%}li{margin-left:-12px}}
</style></head><body><p class="muted">JUNCOY / OFFLINE QA / PRIVATE</p><h1>실제 회의 녹음 검토본</h1><p class="notice">이 파일은 비공개 QA 산출물입니다. 단일 채널의 추정 화자를 표시하며 실제 참석자 신원을 확정하지 않습니다. 녹음 날짜 미상 · 정답 전사 없음 · 자동 전사와 요약은 원음 대조가 필요합니다. 초기 요약은 근거 불일치로 불합격 처리했으며 아래는 수정 후 재검증 결과입니다.</p>
<div class="stats"><div><strong>${time(manifest.duration_ms)}</strong>녹음 길이</div><div><strong>${segments.length}</strong>전사 발언</div><div><strong>${people.length}개</strong>추정 화자 그룹</div><div><strong>${metrics.summary_seconds.toFixed(1)}초</strong>수정 후 요약 1회</div></div>
<section class="notice"><h2>내용 검증: ${esc(audit.status)}</h2><ul>${audit.findings.map((s: string) => `<li>${esc(s)}</li>`).join('')}</ul><p>아래 자동 요약은 결함 재현과 근거 대조용이며 확정 회의록으로 사용할 수 없습니다.</p></section>
<details><summary>불합격 자동 요약과 연결된 근거 펼치기</summary>${summarySections}</details><details><summary>자동 요약의 품질 메모</summary><ul>${summary.quality_notes.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>
<h2 id="transcript">전체 전사</h2><p class="muted">요약의 시간 링크를 누르면 근거 발언으로 이동합니다. 검색은 전체 ${segments.length}개 발언을 대상으로 합니다.</p><div class="toolbar"><input id="search" type="search" aria-label="전체 전사 검색" placeholder="전체 전사 검색"><select id="speaker" aria-label="추정 화자 필터"><option value="">추정 화자 전체</option>${people.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('')}</select><button id="clear">검색 초기화</button></div><p id="count" class="muted" aria-live="polite">${segments.length}개 발언</p><div id="rows">${transcript}</div><footer>ReturnZero Sommers 실제 파일 전사 · Solar Pro 3 실제 요약 · 개인 정보와 녹음은 외부 게시하지 않았습니다. Discord 실시간 음성 수신 및 10개 슬롯 검증과 구분됩니다.</footer>
<script>const rows=[...document.querySelectorAll('article')],search=document.querySelector('#search'),speaker=document.querySelector('#speaker');const normal=s=>s.normalize('NFC').toLocaleLowerCase('ko');function filter(){let n=0;for(const row of rows){row.hidden=!(normal(row.querySelector('p').textContent).includes(normal(search.value))&&(!speaker.value||row.dataset.speaker===speaker.value));if(!row.hidden)n++}document.querySelector('#count').textContent=n+'개 발언'}search.addEventListener('input',filter);speaker.addEventListener('change',filter);document.querySelector('#clear').addEventListener('click',()=>{search.value='';speaker.value='';filter()});document.querySelectorAll('.evidence').forEach(link=>link.addEventListener('click',()=>{search.value='';speaker.value='';filter()}));</script></body></html>`;
await writeFile(resolve(directory, 'review.html'), html, { mode: 0o600 });
await writeFile(
  resolve(directory, 'transcript.txt'),
  segments.map((s) => `[${time(s.start_ms)}] ${s.display_name}\n${s.text}\n`).join('\n'),
  { mode: 0o600 },
);
const md = `# 실제 오프라인 회의 녹음 QA\n\n- 녹음: ${time(manifest.duration_ms)}, mono 16 kHz\n- 실제 파일 STT: ${manifest.processing_seconds}초, ${segments.length}개 발언, 추정 화자 ${people.length}개 그룹\n- 최초 요약: ${baseline.summary_seconds}초, 근거 ID 존재 검사는 통과했으나 의미 일치 수동 검사 불합격\n- 수정 후 요약: ${metrics.summary_seconds}초, 모델 ${metrics.model}, ${metrics.provider_requests}개 요청\n- 수정 후 토큰: 입력 ${metrics.input_tokens}, 출력 ${metrics.output_tokens}\n- 내용 검증: ${audit.status}\n${audit.findings.map((s: string) => '- ' + s).join('\n')}\n- 요약 변경 운영 배포: 보류\n- 날짜·신원 미상: 담당자 ID와 ISO 마감일 null\n- 수치는 각 1회 실측이며 p95 통계가 아닙니다.\n- 실제 참석자 수와 추정 화자 그룹 수를 동일하게 해석하지 않습니다.\n- 정답 전사·화자 라벨이 없어 CER/DER/용어 인식률 미산정.\n\n[검색 가능한 전사와 근거 검토](review.html) · [전체 전사 TXT](transcript.txt)\n`;
await writeFile(resolve(directory, 'QA_REPORT.md'), md, { mode: 0o600 });
process.stdout.write('Private report and searchable transcript written.\n');

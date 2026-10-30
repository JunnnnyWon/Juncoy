const escapeText = (text: unknown) => String(text ?? '').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export function isCommitRequest(text: string) { return /커밋|commit/i.test(text) && !/(?:커밋|commit).*(?:생성해|만들어|삭제해|수정해|푸시|push|revert|되돌려)/i.test(text); }
export function isShortFollowup(text:string) { return /^(?:[?？!！.\s]+|왜\??|다시|무슨 뜻이야\??)$/.test(text.trim()); }
export function commitRequestInput(text:string) {
  const repo=text.match(/github\.com\/([\w.-]+\/[\w.-]+)/i)?.[1];
  const ref=text.match(/(?:브랜치|branch)\s*[:=]?\s*([\w./-]+)/i)?.[1] ?? text.match(/([\w./-]+)\s*브랜치/)?.[1];
  return {...(repo?{repo}:{}),...(ref?{ref}:{})};
}
export function resolveFollowup(text: string, previous: string[]) {
  if (!isShortFollowup(text)) return text;
  const original = [...previous].reverse().find(value => !isShortFollowup(value));
  return original ? '이전 요청을 다시 확인해 주세요: ' + original + '\n후속 메시지: ' + text : '';
}
// ── 일반 항목 포맷터 (QA 10-12) ────────────────────────────────────
// 커넥터 결과는 필드명이 제각각(Notion은 '이름'·'작업명'·'날짜', 한글 키 포함)이다.
// 영문 키 몇 개만 보고 '조회 항목'으로 출력하면 화면이 빈 줄나열이 된다.
const TITLE_KEYS = ['이름', '작업명', '제목', 'title', 'Title', 'name', 'filename', 'stable_key', 'path'];
const META_KEYS = ['날짜', '기간', '마감', '마감일', '상태', '담당자', '파트', '우선순위', 'status', 'date', 'last_edited_time'];
const pickLabel = (item: any): string | null => {
  for (const k of TITLE_KEYS) {
    const v = item?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const [k, v] of Object.entries(item ?? {}))
    if (typeof v === 'string' && v.trim() && !/^(id|url|href|link)$/i.test(k)) return v;
  return null;
};
const fmtDate = (v: any): string | null => {
  const raw = v && typeof v === 'object' ? v.start : v; // Notion date {start,end}
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(+d) ? null : d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
};
const fmtMeta = (item: any) =>
  META_KEYS.map((k) => {
    const v = item?.[k];
    if (v == null) return null;
    const d = fmtDate(v);
    if (d) return `${k} ${d}`;
    if (typeof v === 'string' && v.trim()) return `${k} ${escapeText(v)}`;
    if (typeof v === 'number' || typeof v === 'boolean') return `${k} ${v}`;
    if (Array.isArray(v) && v.length)
      return `${k} ${escapeText(v.slice(0, 3).map((x: any) => (typeof x === 'string' ? x : (x?.name ?? ''))).filter(Boolean).join(', '))}`;
    if (typeof v === 'object' && typeof v.name === 'string') return `${k} ${escapeText(v.name)}`;
    return null;
  })
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');
function formatItem(item: any): string {
  const label = pickLabel(item);
  const url = typeof item?.url === 'string' && /^https?:\/\//.test(item.url) ? item.url : null;
  const meta = fmtMeta(item);
  const head = url ? `[${escapeText(label ?? url)}](${url})` : escapeText(label ?? '조회 항목');
  const body = item.content ?? item.quote;
  return '- ' + head + (meta ? ' · ' + meta : '') + (body ? '\n  ' + escapeText(String(body).slice(0, 1000)) : '');
}

export function formatReadResult(tool: string, result: any): string {
  if (tool === 'github.list_commits') {
    if (result.status === 'NOT_CONFIGURED') return '이 프로젝트에 조회 가능한 GitHub 저장소가 연결되어 있지 않습니다.';
    if (result.status === 'UNAVAILABLE') return 'GitHub 커밋을 실시간으로 확인하지 못했습니다. 연결 또는 접근 권한을 확인해 주세요.';
    if (result.status === 'NEEDS_CLARIFICATION') return '조회할 저장소를 지정해 주세요: ' + result.repositories.map(escapeText).join(', ');
    const heading = `${escapeText(result.repo)} · ${escapeText(result.ref)} 기준 최근 커밋`;
    if (!result.commits.length) return `${heading}\n\n해당 브랜치에서 커밋을 찾지 못했습니다. 조회 성공과 검색 결과 없음은 구분해 기록했습니다.`;
    return `**${heading} ${result.commits.length}건**\n\n` + result.commits.map((commit:any) => `- [${commit.sha.slice(0,7)}](${commit.url}) ${escapeText(commit.title)}\n  ${escapeText(commit.author || '작성자 미상')} · ${commit.date ? escapeText(new Date(commit.date).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})) + ' (한국 시간)' : '작성 시각 미상'}`).join('\n') + '\n\nGitHub에서 방금 조회한 기록입니다. 커밋 번호를 누르면 변경 내용을 볼 수 있습니다.' + (result.branches?.filter((ref:string)=>ref!==result.ref).length ? '\n\n다른 연결 브랜치: ' + result.branches.filter((ref:string)=>ref!==result.ref).map(escapeText).join(', ') + '. 브랜치 이름을 지정하면 해당 기록을 조회합니다.' : '');
  }
  if (Array.isArray(result)) return result.length ? result.map(formatItem).join('\n') : '검색 조건에 맞는 조회 결과가 없습니다. 검색어 또는 조회 범위를 바꿔 주세요.';
  if (result?.content) return `**${escapeText(result.path ?? '조회 자료')}**\n\n${String(result.content).slice(0,10000)}`;
  const scalar = Object.entries(result ?? {}).filter(([,value]) => ['string','number','boolean'].includes(typeof value));
  return scalar.length ? scalar.map(([key,value]) => `- ${escapeText(key)}: ${escapeText(value)}`).join('\n') : '조회는 완료했지만 표시할 항목이 없습니다.';
}

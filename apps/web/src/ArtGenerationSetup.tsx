import { useState } from 'react';
type Reference = { id: string; name: string; url: string; upload_id?: string; excluded?: boolean; usage: string };
export function ArtGenerationSetup({ request, manual, selected, refs, busy, onRequest, onManual, onSelected, onPreview }: {
  request: string; manual: boolean; selected: string[]; refs: Reference[]; busy: boolean;
  onRequest: (value: string) => void; onManual: (value: boolean) => void;
  onSelected: (value: string[]) => void; onPreview: () => void;
}) {
  const [query, setQuery] = useState('');
  return <section className="art-generation-setup" aria-label="이미지 생성 설정">
    <h2>이미지 만들기</h2><p className="panel-intro">원하는 장면을 설명하고, 참고 자료를 확인한 뒤 생성하세요.</p>
    <label htmlFor="art-generation-request">어떤 이미지를 만들까요?</label>
    <textarea id="art-generation-request" aria-label="만들고 싶은 이미지" rows={4} value={request} disabled={busy} placeholder="예: 인물 없이 비 오는 밤의 낡은 항구 창고. 지면 높이의 넓은 구도." onChange={event => onRequest(event.target.value)} />
    <fieldset className="reference-mode"><legend>참고 이미지 선택</legend>
      <div className="reference-mode-buttons"><button type="button" aria-pressed={!manual} disabled={busy} onClick={() => onManual(false)}>자동 선택</button><button type="button" aria-pressed={manual} disabled={busy} onClick={() => onManual(true)}>직접 선택</button></div>
      <p className="panel-help">{manual ? '선택한 순서대로 최대 16개를 사용합니다. 참고 제외·검토 필요 자료는 사용할 수 없습니다.' : '요청과 관련된 보드 이미지 최대 6개를 자동으로 고릅니다. 보드의 모든 이미지를 전달하지 않습니다.'}</p>
    </fieldset>
    {manual && <div className="reference-picker">
      <div className="reference-picker-heading"><strong>선택한 원본 {selected.length}/16</strong><button type="button" disabled={busy || !selected.length} onClick={() => onSelected([])}>선택 해제</button></div>
      <input type="search" aria-label="원본 이름 검색" placeholder="파일 이름으로 찾기" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="reference-picker-list">{refs.filter(ref => ref.upload_id && ref.name.toLowerCase().includes(query.toLowerCase())).map(ref => {
        const checked = selected.includes(ref.upload_id!); const unavailable = ref.excluded || ref.usage === 'REVIEW_REQUIRED';
        return <label className="reference-picker-row" key={ref.id}><input type="checkbox" aria-label={'생성 원본 ' + ref.name} checked={checked} disabled={busy || unavailable || (!checked && selected.length >= 16)} onChange={event => onSelected(event.target.checked ? [...new Set([...selected, ref.upload_id!])] : selected.filter(id => id !== ref.upload_id))} /><img src={ref.url} alt="" loading="lazy" /><span><strong>{ref.name}</strong><small>{unavailable ? '사용 전 검토 필요' : checked ? '입력 순서 ' + (selected.indexOf(ref.upload_id!) + 1) : '선택 가능'}</small></span></label>;
      })}</div>
      {!refs.some(ref => ref.upload_id && ref.name.toLowerCase().includes(query.toLowerCase())) && <p className="panel-help">일치하는 원본이 없습니다.</p>}
    </div>}
    <button className="primary-button prepare-image-button" disabled={busy || !request.trim() || (manual && !selected.length)} onClick={onPreview}>{busy ? '생성 조건 준비 중…' : '생성 조건 확인'}</button>
    <p className="panel-help">준비 단계에서는 이미지를 생성하지 않습니다. 다음 화면에서 확인 후 실행합니다.</p>
  </section>;
}
export function ArtGenerationReview({ brief, refs }: { brief: any; refs: Reference[] }) {
  const operations: Record<string,string> = { new:'새 이미지', edit:'부분 수정', variant:'다른 후보', recompose:'장면 변경' };
  const outputs: Record<string,string> = { character:'캐릭터', background:'배경', ui:'UI 시안', game_scene:'게임 화면', other:'기타 이미지' };
  return <div className="art-generation-review">
    {brief.review_notice && <p className="generation-notice" role="note">{brief.review_notice}</p>}
    <p className="brief-kind">{operations[brief.plan.operation]} · {outputs[brief.plan.output]}</p>
    <dl className="brief-decisions">{[['유지할 것',brief.plan.preserve],['바꿀 것',brief.plan.change],['자유롭게 구성',brief.plan.free]].map(([label,items]) => <div key={String(label)}><dt>{String(label)}</dt><dd>{(items as string[]).length ? (items as string[]).join(' · ') : '별도 지정 없음'}</dd></div>)}</dl>
    <details className="brief-reference-details"><summary>사용할 참고 이미지 {brief.references.length + (brief.plan.primary ? 1 : 0) + brief.plan.supporting.length}개</summary>
      {brief.references.map((ref: any,index:number) => { const original=refs.find(item=>item.upload_id===ref.upload_id); return <div className="brief-reference-row" key={ref.upload_id}>{original && <img src={original.url} alt="" />}<span><strong>{index+1}. {original?.name ?? '선택한 원본'}</strong><small>{ref.purpose?.replace(/material_surface/g,'재질').replace(/modeling_language/g,'모델링').replace(/mood/g,'분위기').replace(/texture/g,'텍스처').replace(/lighting/g,'조명') ?? '지정한 요소만 참고'}</small></span></div>; })}
      {brief.plan.primary && <p>주 원본: {brief.plan.primary.purpose}</p>}{brief.plan.supporting.map((ref:any)=> <p key={ref.id}>보조 원본: {ref.purpose}</p>)}
    </details>
    <details className="brief-source-details"><summary>프로젝트 참고 자료 {brief.evidence.length}건</summary>{brief.evidence.length ? brief.evidence.map((e:any)=><p key={e.id}>{({notion:'Notion',discord:'Discord',github:'GitHub',meeting:'회의록'} as Record<string,string>)[e.source] ?? '프로젝트 자료'} · {e.quote ?? e.stable_key}</p>) : <p>관련 자료가 없어 사용자 요청과 아트 방향을 기준으로 준비했습니다.</p>}</details>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import type { ArtCanvasNode, ArtCanvasEdge } from '@meeting/contracts';
import { changeCanvas, travelCanvas, type CanvasHistory } from './canvas-history.ts';

const openDraftDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('juncoy-art-drafts', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('drafts');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function getDraft(key: string) {
  const db = await openDraftDb();
  return new Promise<any>((resolve, reject) => {
    const request = db.transaction('drafts', 'readonly').objectStore('drafts').get(key);
    request.onsuccess = () => { db.close(); resolve(request.result ?? null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}
async function putDraft(key: string, value: unknown) {
  const db = await openDraftDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
async function clearDraft(key: string) {
  const db = await openDraftDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').delete(key);
    tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

type Role =
  'face_shape' | 'modeling_language' | 'material_surface' | 'texture' | 'lighting' | 'mood';
type Usage =
  'MUST_FOLLOW' | 'STRONG_REFERENCE' | 'MOOD_ONLY' | 'PARTIAL_REFERENCE' | 'REVIEW_REQUIRED';
interface RefCard {
  id: string;
  upload_id?: string;
  art_asset_id?: string;
  canonical_state?: string;
  rights_note?: string;
  name: string;
  url: string;
  role: Role;
  usage: Usage;
  note: string;
  roles?: Role[];
  roleUsage?: Partial<Record<Role, Usage>>;
  selected: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  crop?: { left: number; top: number; right: number; bottom: number } | null;
  group_id?: string;
  scale?: number;
  excluded?: boolean;
  local_blob?: Blob;
}
const roleLabels: Record<Role, string> = {
  face_shape: '얼굴 형태',
  modeling_language: '모델링 언어',
  material_surface: '재질 표면',
  texture: '텍스처',
  lighting: '조명',
  mood: '분위기',
};
const usageLabels: Record<Usage, string> = {
  MUST_FOLLOW: '반드시 반영',
  STRONG_REFERENCE: '강한 참고',
  MOOD_ONLY: '분위기만',
  PARTIAL_REFERENCE: '부분만 참고',
  REVIEW_REQUIRED: '검토 필요',
};
const assetStateLabels: Record<string, string> = { NONE: '아직 확인하지 않음', REVIEW: '확인 중', APPROVED_CANONICAL: '팀 기준으로 확정', REJECTED: '사용하지 않음', ARCHIVED: '보관 중' };
function Help({ text }: { text: string }) {
  const details = useRef<HTMLDetailsElement>(null);
  return <details ref={details} className="art-help"><summary aria-label="도움말">?</summary><div className="art-help-popup"><button type="button" aria-label="도움말 닫기" onClick={(event) => { event.preventDefault(); if (details.current) details.current.open = false; }}>×</button><p>{text}</p></div></details>;
}
const observationFields = { description: '이미지 설명', subjects: '보이는 대상', materials: '재질과 질감', lighting: '빛과 조명', palette: '주요 색', visible_text: '이미지 안의 글자', confidence_note: '분석할 때 주의할 점' };
function BoardDraftEditor({ analysis, refs, stale, onSave, onApply, onDiscard }: { analysis: any; refs: RefCard[]; stale: boolean; onSave: (result: any) => Promise<any>; onApply: (saved: any) => Promise<void>; onDiscard: () => Promise<void> }) {
  const prepareDraft = (result: any) => ({ ...structuredClone(result), appearance: result.appearance ?? { character: '', materials: '', overall: result.summary ?? '' } });
  const [draft, setDraft] = useState<any>(() => prepareDraft(analysis.result));
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(prepareDraft(analysis.result)); }, [analysis.id]);
  const editable = analysis.status === 'DRAFT';
  const categoryLabel = (value: string) => (roleLabels as Record<string, string>)[value] ?? ({ style: '그림체', composition: '구도', color: '색상', character: '캐릭터' } as Record<string,string>)[value] ?? value;
  const sourceNames = (ids: string[]) => [...new Set(ids.map(id => refs.find(ref => ref.id === id || ref.art_asset_id === id)?.name).filter(Boolean))].join(', ');
  const perform = async (apply: boolean) => { setBusy(true); setStatus('저장 중…'); try { const saved = await onSave(draft); if (apply) await onApply(saved); setStatus(apply ? '이 방향을 다음 이미지 생성에 적용했습니다.' : '수정한 초안을 저장했습니다.'); } catch (error) { setStatus(artActionError(error)); } finally { setBusy(false); } };
  return <section className="analysis-card board-draft-editor"><div className="art-field-heading"><h3>전체 참고 자료 정리</h3><Help text="여러 이미지에서 함께 지킬 방향을 정리한 초안입니다. 내용을 고쳐 저장하고, 생성에 적용을 누르면 다음 이미지 요청에서 이 기준을 참고합니다. 이미지 위치나 역할을 자동으로 바꾸지는 않습니다." /></div><p>{editable ? '내용을 읽고 필요한 부분을 고쳐 주세요.' : analysis.status === 'APPROVED' ? '이미지 생성에 적용 중인 기준입니다.' : '사용하지 않기로 한 초안입니다.'}</p>{stale && <p role="status">보드가 바뀌었습니다. 다시 자동 정리한 뒤 적용해 주세요.</p>}<section className="bible-appearance"><h4>우리가 만들고 싶은 모습</h4><p>캐릭터 모습, 옷과 소품, 최종 느낌을 나누어 확인하세요.</p>{Object.entries({ character: "캐릭터 모습", materials: "옷과 소품", overall: "최종 느낌" }).map(([key, label]) => <label key={key}>{label}<textarea rows={4} disabled={!editable || busy} value={draft.appearance[key] ?? ""} onChange={event => { const appearance = { ...draft.appearance, [key]: event.target.value }; setDraft({ ...draft, appearance, summary: Object.values(appearance).filter(Boolean).join("\n\n") }); }} /></label>)}</section>
    {(['common_rules', 'conflicts'] as const).map(key => <section key={key} className="draft-section"><h4>{key === 'common_rules' ? '함께 지킬 기준' : '서로 다른 방향 · 확인할 점'}</h4><p>{key === 'common_rules' ? '그림체, 재질, 분위기에서 공통으로 지킬 내용을 적습니다.' : '참고 이미지끼리 맞지 않는 부분을 확인합니다.'}</p>{(draft[key] ?? []).map((item: any, index: number) => <div className="draft-item" key={index}>{key === 'common_rules' && <label>어떤 기준인가요?<input disabled={!editable || busy} value={categoryLabel(item.category ?? '')} onChange={event => setDraft({ ...draft, [key]: draft[key].map((row: any, i: number) => i === index ? { ...row, category: event.target.value } : row) })} /></label>}<label>{key === 'common_rules' ? '기준 내용' : '확인할 내용'}<textarea rows={3} disabled={!editable || busy} value={item.statement ?? ''} onChange={event => setDraft({ ...draft, [key]: draft[key].map((row: any, i: number) => i === index ? { ...row, statement: event.target.value } : row) })} /></label>{sourceNames(item.evidence_ids ?? []) && <small>참고 이미지: {sourceNames(item.evidence_ids ?? [])}</small>}{editable && <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, [key]: draft[key].filter((_: any, i: number) => i !== index) })}>이 항목 빼기</button>}</div>)}{!draft[key]?.length && <p>등록된 항목이 없습니다.</p>}{editable && <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, [key]: [...(draft[key] ?? []), { ...(key === 'common_rules' ? { category: '그림체' } : {}), statement: '', evidence_ids: [] }] })}>{key === 'common_rules' ? '기준 추가' : '확인할 점 추가'}</button>}</section>)}
    <section className="draft-section"><h4>이미지별 참고 제안</h4><p>역할과 강도를 어떻게 쓰면 좋을지 제안합니다. 실제 설정은 각 이미지에서 바꿔 주세요.</p>{(draft.suggestions ?? []).map((item: any, index: number) => <div className="draft-item" key={index}><strong>{refs.find(ref => ref.id === item.asset_id || ref.art_asset_id === item.asset_id)?.name ?? '참고 이미지'}</strong><label>참고할 요소<select disabled={!editable || busy} value={item.role} onChange={event => setDraft({ ...draft, suggestions: draft.suggestions.map((row: any, i: number) => i === index ? { ...row, role: event.target.value } : row) })}>{!Object.keys(roleLabels).includes(item.role) && <option value={item.role}>{categoryLabel(item.role)}</option>}{Object.entries(roleLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>참고 강도<select disabled={!editable || busy} value={item.usage} onChange={event => setDraft({ ...draft, suggestions: draft.suggestions.map((row: any, i: number) => i === index ? { ...row, usage: event.target.value } : row) })}>{!Object.keys(usageLabels).includes(item.usage) && <option value={item.usage}>확인 필요</option>}{Object.entries(usageLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>제안 이유<textarea rows={3} disabled={!editable || busy} value={item.observation ?? ''} onChange={event => setDraft({ ...draft, suggestions: draft.suggestions.map((row: any, i: number) => i === index ? { ...row, observation: event.target.value } : row) })} /></label></div>)}{!draft.suggestions?.length && <p>이미지별 제안이 없습니다.</p>}</section>
    {editable && <div className="draft-actions"><button disabled={busy} onClick={() => void perform(false)}>초안 저장</button><button disabled={busy || stale} onClick={() => void perform(true)}>생성 기준으로 적용</button><button disabled={busy} onClick={async () => { setBusy(true); try { await onDiscard(); } catch(error) { setStatus(artActionError(error)); } finally { setBusy(false); } }}>이 초안 사용 안함</button></div>}<p role="status">{status}</p></section>;
}
function ObservationEditor({ analysis, onSave }: { analysis: any; onSave: (corrections: Record<string, unknown>) => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [status, setStatus] = useState('');
  useEffect(() => { setDraft({ ...analysis.observations, ...analysis.human_corrections }); setStatus(''); }, [analysis.asset_id, analysis.asset_revision, analysis.id]);
  return <div className="asset-observation-card"><div className="art-field-heading"><h3>AI가 읽은 AI 내용</h3><Help text="Gemini가 사진에서 보이는 내용을 정리했습니다. 틀리거나 빠진 내용을 고쳐 저장하면, 어시스턴트는 사람이 고친 내용을 먼저 참고합니다. 이미지 원본은 바뀌지 않습니다." /></div><p>내용을 확인하고 직접 고칠 수 있습니다.</p>{Object.entries(observationFields).map(([key, label]) => <label key={key}>{label}<textarea rows={key === 'description' ? 5 : 2} value={Array.isArray(draft[key]) ? draft[key].join(', ') : draft[key] ?? ''} onChange={(event) => setDraft((current) => ({ ...current, [key]: ['description', 'confidence_note'].includes(key) ? event.target.value : event.target.value.split(',').map((value) => value.trim()).filter(Boolean) }))} /></label>)}<button className="asset-review-button" disabled={status === '저장 중'} onClick={async () => { setStatus('저장 중'); try { await onSave(Object.fromEntries(Object.keys(observationFields).map((key) => [key, draft[key] ?? (['description', 'confidence_note'].includes(key) ? '' : [])]))); setStatus('수정한 내용을 저장했습니다.'); } catch { setStatus('저장하지 못했습니다. 다시 시도해 주세요.'); } }}>수정한 분석 저장</button><p role="status">{status}</p></div>;
}

function artActionError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === 'REVISION_CONFLICT') return '분석 후 보드가 변경되었습니다. 전체 레퍼런스를 다시 정리한 뒤 승인해 주세요.';
  if (code === 'MODEL_EVIDENCE_OUT_OF_SCOPE') return '분석 결과가 현재 이미지와 연결되지 않았습니다. 다시 분석해 주세요.';
  if (code === 'REFERENCE_RIGHTS_REQUIRED') return '참고 이미지의 출처와 사용 가능 여부를 권리 메모에 기록한 뒤 다시 생성 준비를 실행해 주세요.';
  return (error instanceof Error ? error.message : '요청을 처리하지 못했습니다.') + (code ? ' (' + code + ')' : '');
}
function inferRoleFromObservation(observation: any): Role {
  const text = [observation?.description, ...(observation?.subjects ?? []), ...(observation?.materials ?? []), ...(observation?.textures ?? []), ...(observation?.palette ?? [])].join(' ').toLowerCase();
  if (/face|portrait|얼굴|소녀|인물|피부/.test(text)) return 'face_shape';
  if (/texture|pattern|surface|텍스처|표면|재질|나무|금속/.test(text)) return 'texture';
  if (/light|lighting|shadow|조명|빛|그림자/.test(text)) return 'lighting';
  if (/material|재질|rough|metal|wood|벽/.test(text)) return 'material_surface';
  if (/camera|composition|view|구도|시점|카메라/.test(text)) return 'modeling_language';
  return 'mood';
}
export function ArtReferenceCanvas() {
  const [refs, setRefs] = useState<RefCard[]>([]);
  const [nodes, setNodes] = useState<ArtCanvasNode[]>([]);
  const [edges, setEdges] = useState<ArtCanvasEdge[]>([]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  useEffect(() => { zoomRef.current = zoom; panRef.current = pan; }, [zoom, pan]);
  const history = useRef<CanvasHistory<{ refs: RefCard[]; nodes: ArtCanvasNode[]; edges: ArtCanvasEdge[]; zoom: number; pan: { x: number; y: number } }> | null>(null);
  const restoring = useRef(false);
  const loadedBoard = useRef(false);
  const gestureDepth = useRef(0);
  const gestureBaseline = useRef<{ refs: RefCard[]; nodes: ArtCanvasNode[]; edges: ArtCanvasEdge[]; zoom: number; pan: { x: number; y: number } } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boardEl = useRef<HTMLElement | null>(null);
  const [, setHistoryVersion] = useState(0);
  const beginGesture = () => { if (!gestureDepth.current) gestureBaseline.current = history.current?.present ?? null; gestureDepth.current += 1; };
  const endGesture = () => {
    if (gestureDepth.current > 0) gestureDepth.current -= 1;
    if (gestureDepth.current > 0) return;
    const baseline = gestureBaseline.current;
    gestureBaseline.current = null;
    if (!baseline || !history.current) return;
    if (JSON.stringify(baseline) !== JSON.stringify(history.current.present)) {
      history.current = { past: [...history.current.past, baseline].slice(-100), present: history.current.present, future: [] };
      setHistoryVersion((v) => v + 1);
    }
  };
  useEffect(() => {
    if (!loadedBoard.current) return;
    const present = { refs, nodes, edges, zoom, pan };
    if (restoring.current) { restoring.current = false; return; }
    const changed = Boolean(history.current && JSON.stringify(history.current.present) !== JSON.stringify(present));
    if (changed) dirtyRef.current = true;
    if (history.current && gestureDepth.current > 0) {
      if (changed) history.current = { past: history.current.past, present, future: [] };
      return;
    }
    history.current = history.current ? changeCanvas(history.current, present) : { past: [], present, future: [] };
    setHistoryVersion((v) => v + 1);
  }, [refs, nodes, edges, zoom, pan]);
  const applyZoom = (nextZoom: number, cx?: number, cy?: number) => {
    const next = Math.min(1.8, Math.max(0.5, nextZoom));
    const rect = boardEl.current?.getBoundingClientRect();
    if (!rect) { setZoom(next); return; }
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;
    const bx = (px - currentPan.x) / currentZoom;
    const by = (py - currentPan.y) / currentZoom;
    const nextPan = { x: px - bx * next, y: py - by * next };
    zoomRef.current = next;
    panRef.current = nextPan;
    setZoom(next);
    setPan(nextPan);
  };
  useEffect(() => {
    const board = boardEl.current;
    if (!board) return;
    const onWheel = (event: WheelEvent) => {
      const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
      if (!(isMac ? event.metaKey : event.ctrlKey)) return;
      if ((event.target as HTMLElement).closest('textarea, input, select')) return;
      event.preventDefault();
      const rect = board.getBoundingClientRect();
      if (!wheelTimer.current) beginGesture();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      applyZoom(zoomRef.current * Math.exp(-delta * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => { wheelTimer.current = null; endGesture(); }, 350);
    };
    board.addEventListener('wheel', onWheel, { passive: false });
    return () => { board.removeEventListener('wheel', onWheel); if (wheelTimer.current) clearTimeout(wheelTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const travel = (direction: 'undo' | 'redo') => {
    if (!history.current) return;
    const next = travelCanvas(history.current, direction);
    if (next === history.current) return;
    history.current = next;
    restoring.current = true;
    setRefs(next.present.refs); setNodes(next.present.nodes); setEdges(next.present.edges);
    setZoom(next.present.zoom); setPan(next.present.pan);
    setActiveNodeId(null);
    setBrief(null); setAnalysis(null); setSyncState('미저장 변경');
    setHistoryVersion((v) => v + 1);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(event.key.toLowerCase())) return;
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) return;
      event.preventDefault();
      travel(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('ref-1');
  const [boardList, setBoardList] = useState<any[]>([]);
  const [boardName, setBoardName] = useState('비주얼 레퍼런스 보드');
  const [historyItems, setHistoryItems] = useState<any[]>([]);
  const [mobilePanel, setMobilePanel] = useState<'canvas' | 'inspector'>('canvas');
  const [boardId, setBoardId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [syncState, setSyncState] = useState('로컬 초안');
  const [brief, setBrief] = useState<any>(null);
  const [generated, setGenerated] = useState<any[]>([]);
  const [analysis, setAnalysis] = useState<any>(null);
  const [bibleOpen, setBibleOpen] = useState(false);
  const [bibleLoading, setBibleLoading] = useState(false);
  const openBible = async () => {
    setBibleOpen(true);
    if (analysis || !boardId) return;
    setBibleLoading(true);
    try { setAnalysis(await api<any>('/api/assistant/art-boards/' + boardId + '/analysis/' + revisionRef.current)); } catch { /* No saved draft yet. */ }
    finally { setBibleLoading(false); }
  };
  const [analysisEdit, setAnalysisEdit] = useState('');
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [generationBusy, setGenerationBusy] = useState(false);
  const [generationRequest, setGenerationRequest] = useState('');
  const [useSelectedReferences, setUseSelectedReferences] = useState(false);
  const [referenceUploadSelection, setReferenceUploadSelection] = useState<string[]>([]);
  const [actionError, setActionError] = useState('');
  const [assetAnalysis, setAssetAnalysis] = useState<any>(null);
  const [assetCorrections, setAssetCorrections] = useState('');
  const [canonicalNote, setCanonicalNote] = useState('');
  const [assetAnalysisBusy, setAssetAnalysisBusy] = useState(false);
  const assetAnalysisGeneration = useRef(0);
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const autosaveEnabled = useRef(false);
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);
  const draftKey = useRef('');
  useEffect(() => { revisionRef.current = revision; }, [revision]);
  const selected = refs.find((ref) => ref.id === selectedId) ?? refs[0];
  const selectedCount = useMemo(() => refs.filter((ref) => ref.selected).length, [refs]);
  const serverSnapshot = () => ({
    references: refs.filter((ref) => ref.upload_id).map(({ url: _url, local_blob: _blob, ...ref }) => ref),
    nodes, edges, viewport: { ...pan, zoom },
  });
  const localSnapshot = () => ({ references: refs.map(({ url: _url, ...ref }) => ref), nodes, edges, viewport: { ...pan, zoom } });
  useEffect(() => {
    const generation = ++assetAnalysisGeneration.current;
    setAssetAnalysis(null);
    const assetId = selected?.art_asset_id;
    if (assetId) {
      void api<any>('/api/assistant/art-assets/' + assetId + '/extraction').then((result) => {
        if (generation === assetAnalysisGeneration.current) {
          setAssetAnalysis(result);
          setAssetCorrections(JSON.stringify(result.human_corrections ?? {}, null, 2));
        }
      }).catch(() => {});
    }
    return () => { assetAnalysisGeneration.current++; };
  }, [selected?.art_asset_id]);
  useEffect(() => {
    void (async () => {
      let activeBoardId = '';
      try {
        const boards = await api<any[]>('/api/assistant/art-boards');
        setBoardList(boards);
        if (boards[0]) {
          activeBoardId = boards[0].id;
          setBoardId(boards[0].id);
          setBoardName(boards[0].name);
          setRevision(Number(boards[0].current_revision ?? 0));
          setHistoryItems(await api<any[]>('/api/assistant/art-boards/' + boards[0].id + '/history'));
          const detail = await api<any>('/api/assistant/art-boards/' + boards[0].id);
          const saved = detail.revision?.snapshot?.references;
          history.current = { past: [], present: { refs: Array.isArray(saved) ? saved : [], nodes: detail.revision?.snapshot?.nodes ?? [], edges: detail.revision?.snapshot?.edges ?? [], zoom: detail.revision?.snapshot?.viewport?.zoom ?? 1, pan: { x: detail.revision?.snapshot?.viewport?.x ?? 0, y: detail.revision?.snapshot?.viewport?.y ?? 0 } }, future: [] };
          if (Array.isArray(saved)) setRefs(saved.map((ref: RefCard) => ({ ...ref, url: ref.upload_id ? '/api/assistant/files/' + ref.upload_id + '/content' : ref.url ?? '' })));
          setNodes(detail.revision?.snapshot?.nodes ?? []);
          setEdges(detail.revision?.snapshot?.edges ?? []);
          const savedViewport = detail.revision?.snapshot?.viewport;
          if (savedViewport) {
            if (typeof savedViewport.zoom === 'number') setZoom(savedViewport.zoom);
            if (typeof savedViewport.x === 'number' && typeof savedViewport.y === 'number')
              setPan({ x: savedViewport.x, y: savedViewport.y });
          }
        } else {
          const created = await api<{ id: string }>('/api/assistant/art-boards', {
            method: 'POST',
            body: JSON.stringify({ name: '비주얼 레퍼런스 보드' }),
          });
          setBoardId(created.id);
          activeBoardId = created.id;
          history.current = { past: [], present: { refs: [], nodes: [], edges: [], zoom: 1, pan: { x: 0, y: 0 } }, future: [] };
        }
        const owner = await api<{ user_id: string }>('/api/me');
        draftKey.current = [owner.user_id, 'project', activeBoardId].join(':');
        const localDraft = await getDraft(draftKey.current).catch(() => null);
        if (localDraft?.snapshot && Number(localDraft.revision) === Number(boards[0]?.current_revision ?? 0)) {
          if (window.confirm('저장되지 않은 로컬 초안이 있습니다. 복구할까요?')) {
            setRefs((localDraft.snapshot.references ?? []).map((ref: RefCard) => ({ ...ref, url: ref.upload_id ? '/api/assistant/files/' + ref.upload_id + '/content' : ref.url ?? '' })));
            setNodes(localDraft.snapshot.nodes ?? []); setEdges(localDraft.snapshot.edges ?? []);
            setPan({ x: localDraft.snapshot.viewport?.x ?? 0, y: localDraft.snapshot.viewport?.y ?? 0 }); setZoom(localDraft.snapshot.viewport?.zoom ?? 1);
            dirtyRef.current = true; setSyncState('로컬 초안 복구됨');
          }
        }
        const storedBlobs = await getDraft(draftKey.current + ':blobs').catch(() => null);
        if (storedBlobs && Array.isArray(storedBlobs)) setRefs((current) => current.map((ref) => { const item=storedBlobs.find((entry: any) => entry.id===ref.id); return item?.blob ? { ...ref, local_blob:item.blob, url:URL.createObjectURL(item.blob) } : ref; }));
        loadedBoard.current = true;
        autosaveEnabled.current = true;
        setSyncState('서버에 연결됨');
        setGenerated(await api<any[]>('/api/assistant/images'));
      } catch {
        setSyncState('로컬 초안');
      }
    })();
  }, []);
  const saveRightsNotes = async (snapshot: ReturnType<typeof serverSnapshot>) => {
    const assets = new Map(snapshot.references.filter((ref) => ref.art_asset_id && ref.rights_note !== undefined).map((ref) => [ref.art_asset_id!, ref.rights_note!]));
    await Promise.all([...assets].map(([id, rights_note]) => api('/api/assistant/art-assets/' + id + '/rights-note', { method: 'PATCH', body: JSON.stringify({ rights_note }) })));
  };
  const flushBoard = async () => {
    if (!boardId) throw new Error('보드 연결을 확인해 주세요.');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = serverSnapshot();
    let savedRevision = revisionRef.current;
    const task = saveQueue.current.then(async () => {
      await saveRightsNotes(snapshot);
      const result = await api<{ revision: number }>('/api/assistant/art-boards/' + boardId + '/revisions', {
        method: 'POST', body: JSON.stringify({ base_revision: revisionRef.current, snapshot }),
      });
      savedRevision = Number(result.revision);
      revisionRef.current = savedRevision;
      setRevision(savedRevision);
      dirtyRef.current = false;
      setSyncState('변경 내용 저장됨');
    });
    saveQueue.current = task.catch(() => {});
    await task;
    return savedRevision;
  };
  const saveRevision = async () => {
    if (!boardId) return;
    setSyncState('저장 중');
    try {
      await flushBoard();
      setHistoryItems(await api<any[]>('/api/assistant/art-boards/' + boardId + '/history'));
      setSyncState('서버에 저장됨');
    } catch {
      setSyncState('충돌 확인 필요');
    }
  };
  useEffect(() => {
    if (!autosaveEnabled.current || !boardId || !dirtyRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = serverSnapshot();
    saveTimer.current = setTimeout(() => {
      saveQueue.current = saveQueue.current.then(async () => {
        await putDraft(draftKey.current, { revision: revisionRef.current, saved_at: Date.now(), snapshot: localSnapshot() }).catch(() => {});
        await putDraft(draftKey.current + ':blobs', refs.filter((ref) => ref.local_blob).map((ref) => ({ id: ref.id, blob: ref.local_blob, name: ref.name }))).catch(() => {});
        setSyncState('자동 저장 중');
        try {
          await saveRightsNotes(snapshot);
          const result = await api<{ revision: number }>('/api/assistant/art-boards/' + boardId + '/revisions', {
            method: 'POST', body: JSON.stringify({ base_revision: revisionRef.current, snapshot }),
          });
          setRevision(Number(result.revision));
          revisionRef.current = Number(result.revision);
          dirtyRef.current = false;
          await clearDraft(draftKey.current).catch(() => {});
          await clearDraft(draftKey.current + ':blobs').catch(() => {});
          setHistoryItems(await api<any[]>('/api/assistant/art-boards/' + boardId + '/history'));
          setSyncState('자동 저장됨');
        } catch { setSyncState('저장 충돌 - 최신 변경 확인 필요'); }
      });
    }, 1000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [refs, nodes, edges, zoom, pan, boardId]);
  const saveCorrections = async (corrections?: Record<string, unknown>) => {
    if (!selected?.art_asset_id) return;
    try {
      const edited = corrections ?? JSON.parse(assetCorrections || '{}');
      const saved = await api<any>('/api/assistant/art-assets/' + selected.art_asset_id + '/extraction', {
        method: 'PATCH', body: JSON.stringify({ corrections: edited }),
      });
      setAssetAnalysis((current: any) => current ? { ...current, human_corrections: saved.human_corrections } : current);
    } catch {
      throw new Error('분석 내용을 저장하지 못했습니다.');
    }
  };
  const previewBrief = async () => {
    if (!boardId || briefBusy || analysisBusy) return;
    if (!generationRequest.trim()) { setActionError('만들고 싶은 이미지를 먼저 설명해 주세요.'); return; }
    if (useSelectedReferences && (referenceUploadSelection.length === 0 || referenceUploadSelection.length > 16)) { setActionError('참고할 원본을 1~16개 선택해 주세요.'); return; }
    setBriefBusy(true);
    setActionError('');
    setSyncState('저장 중');
    let savedRevision = revision;
    try {
      savedRevision = await flushBoard();
      setRevision(savedRevision);
      setSyncState('서버에 저장됨');
    } catch (error) {
      setSyncState('저장 충돌');
      setActionError(artActionError(error));
      setBriefBusy(false);
      return;
    }
    try {
      const brief = await api<any>(
        '/api/assistant/art-boards/' + boardId + '/image-briefs/preview',
        {
          method: 'POST',
          body: JSON.stringify({
            request: generationRequest.trim(),
            reference_upload_ids: useSelectedReferences ? referenceUploadSelection : [],
            revision: savedRevision,
          }),
        },
      );
      setBrief(brief);
      setMobilePanel('inspector');
    } catch (error) { setActionError(artActionError(error)); }
    finally { setBriefBusy(false); }
  };
  const analyzeBoard = async () => {
    if (!boardId || analysisBusy || briefBusy) return;
    setAnalysisBusy(true);
    setActionError('');
    try {
      await flushBoard();
      const draft = await api<any>('/api/assistant/art-boards/' + boardId + '/analyze', { method: 'POST' });
      setAnalysis(draft); setAnalysisEdit(JSON.stringify(draft.result, null, 2));
      setBibleOpen(true);
    } catch (error) { setActionError(artActionError(error)); } finally {
      setAnalysisBusy(false);
    }
  };
  const analyzeSelectedAsset = async () => {
    if (!selected?.art_asset_id || assetAnalysisBusy) return;
    const assetId = selected.art_asset_id;
    const generation = ++assetAnalysisGeneration.current;
    setAssetAnalysisBusy(true);
    try {
      const result = await api<any>('/api/assistant/art-assets/' + assetId + '/analyze', { method: 'POST' });
      if (generation === assetAnalysisGeneration.current) setAssetAnalysis(result);
    } catch {
      window.alert('이미지 분석을 실행할 수 없습니다. Gemini Vision 설정을 확인해 주세요.');
    } finally {
      setAssetAnalysisBusy(false);
    }
  };
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const next = await Promise.all(
      Array.from(files)
        .filter((file) => file.type.startsWith('image/'))
        .map(async (file, index) => {
          const bytes = await file.arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const sha = [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          let upload_id: string | undefined;
          let art_asset_id: string | undefined;
          try {
            const init = await api<{ id: string; reused: boolean }>('/api/assistant/files/init', {
              method: 'POST',
              body: JSON.stringify({
                filename: file.name,
                mime: file.type,
                bytes: file.size,
                sha256: sha,
              }),
            });
            upload_id = init.id;
            if (!init.reused)
              await api('/api/assistant/files/' + init.id + '/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: bytes,
              });
            const asset = await api<{ id: string }>('/api/assistant/art-assets/init', {
              method: 'POST',
              body: JSON.stringify({ upload_id: init.id, source_label: file.name }),
            });
            art_asset_id = asset.id;
          } catch {
            /* local draft remains usable when API is unavailable */
          }
          return {
            id: file.name + '-' + file.lastModified + '-' + index,
            upload_id,
            art_asset_id,
            name: file.name,
            url: upload_id ? '/api/assistant/files/' + upload_id + '/content' : URL.createObjectURL(file),
            local_blob: upload_id ? undefined : file,
            role: 'mood' as Role, roles: ['mood' as Role], roleUsage: { mood: 'REVIEW_REQUIRED' as Usage },
            usage: 'REVIEW_REQUIRED' as Usage,
            note: '새 레퍼런스. 분석 전 검토 필요',
            selected: false,
          };
        }),
    );
    setRefs((current) => [...next.map((ref, index) => ({ ...ref, selected: true, x: 80 + (current.length + index) % 4 * 260, y: 120 + Math.floor((current.length + index) / 4) * 250 })), ...current]);
    if (next[0]) setSelectedId(next[0].id);
    await Promise.all(next.filter((ref) => ref.art_asset_id).map(async (ref) => {
      try {
        const result = await api<any>('/api/assistant/art-assets/' + ref.art_asset_id + '/analyze', { method: 'POST' });
        const observations = result.observations ?? {};
        const role = inferRoleFromObservation(observations);
        const note = '자동 분류: ' + roleLabels[role] + ' · ' + (observations.description ?? '이미지 분석 결과를 확인해 주세요.');
        setRefs((current) => current.map((item) => item.id === ref.id ? { ...item, selected: true, role, roles: [role], usage: 'STRONG_REFERENCE', roleUsage: { [role]: 'STRONG_REFERENCE' }, note } : item));
      } catch {
        setRefs((current) => current.map((item) => item.id === ref.id ? { ...item, selected: true, note: '자동 분류를 완료하지 못했습니다. 이 이미지는 직접 확인해 주세요.' } : item));
      }
    }));
  };
  const update = (patch: Partial<RefCard>) =>
    setRefs((current) =>
      current.map((ref) => (ref.id === selected?.id ? { ...ref, ...patch } : ref)),
    );
  const addNode = (node_type: ArtCanvasNode['node_type']) => {
    const id = crypto.randomUUID();
    setNodes((current) => [...current, { id, node_type, x: 60 + current.length * 30, y: 70 + current.length * 30, width: node_type === 'frame' ? 420 : 220, height: node_type === 'frame' ? 300 : 140, text: node_type === 'frame' ? '새 프레임' : '새 메모' }]);
    setActiveNodeId(id);
  };
  const deleteNode = (id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
    if (activeNodeId === id) setActiveNodeId(null);
  };
  const deleteActiveNode = () => { if (activeNodeId) deleteNode(activeNodeId); };
  const createBoard = async () => {
    const name = window.prompt('새 보드 이름', '새 아트 보드');
    if (!name?.trim()) return;
    const result = await api<{ id: string }>('/api/assistant/art-boards', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    const next = await api<any[]>('/api/assistant/art-boards'); setBoardList(next); setBoardId(result.id); setBoardName(name.trim()); setRevision(0);
    setRefs([]); setNodes([]); setEdges([]); setPan({ x: 0, y: 0 }); setZoom(1); setBrief(null); setAnalysis(null); dirtyRef.current = false;
  };
  const restoreRevision = async (target: number) => {
    if (!boardId) return;
    const result = await api<any>('/api/assistant/art-boards/' + boardId + '/restore-revision', { method: 'POST', body: JSON.stringify({ revision: target }) });
    setRevision(Number(result.revision)); revisionRef.current = Number(result.revision);
    const detail = await api<any>('/api/assistant/art-boards/' + boardId);
    const snap = detail.revision?.snapshot ?? {};
    setRefs((snap.references ?? []).map((ref: RefCard) => ({ ...ref, url: ref.upload_id ? '/api/assistant/files/' + ref.upload_id + '/content' : ref.url ?? '' })));
    setNodes(snap.nodes ?? []); setEdges(snap.edges ?? []);
    setHistoryItems(await api<any[]>('/api/assistant/art-boards/' + boardId + '/history'));
    dirtyRef.current = false; setBrief(null); setAnalysis(null);
  };
  const renameBoard = async () => {
    const name = window.prompt('보드 이름 변경', boardName);
    if (!name?.trim() || !boardId) return;
    const result = await api<any>('/api/assistant/art-boards/' + boardId, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
    setBoardName(result.name); setBoardList(await api<any[]>('/api/assistant/art-boards'));
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!['Delete', 'Backspace'].includes(event.key)) return;
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) return;
      if (!activeNodeId) return;
      event.preventDefault(); deleteNode(activeNodeId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeNodeId]);
  return (
    <div className={'art-workspace' + (bibleOpen ? ' art-bible-open' : '')}>
      <header className="art-header">
        <div>
          <span className="eyebrow">PROJECT ART REFERENCES</span>
          <div className="art-board-title-row"><h1>{boardName}</h1><button className="icon-button" title="이름 변경" onClick={() => void renameBoard()}>✎</button></div>
          <p>반실사 얼굴 · 오래된 PC 호러 게임의 모델링 언어 · 실사 기반 재질</p>
        </div>
        <div className="art-header-actions">
          <span className="save-state">
            <i /> {syncState}
          </span>
          <div className="art-header-buttons">
            <input aria-label="만들고 싶은 이미지" placeholder="예: 인물 없이 낡은 학교 복도 배경" value={generationRequest} onChange={event => setGenerationRequest(event.target.value)} />
            <label><input type="checkbox" checked={useSelectedReferences} onChange={event => setUseSelectedReferences(event.target.checked)} />원본 직접 선택 ({referenceUploadSelection.length}개 · 최대 16개)</label>
            {useSelectedReferences && <details open><summary>참고할 원본 선택</summary>{refs.filter(ref => ref.upload_id).map(ref => <label key={ref.id} style={{ display: 'block' }}><input aria-label={'생성 원본 ' + ref.name} type="checkbox" checked={referenceUploadSelection.includes(ref.upload_id!)} disabled={ref.excluded || ref.usage === 'REVIEW_REQUIRED' || (!referenceUploadSelection.includes(ref.upload_id!) && referenceUploadSelection.length >= 16)} onChange={event => setReferenceUploadSelection(current => event.target.checked ? [...new Set([...current, ref.upload_id!])] : current.filter(id => id !== ref.upload_id))} />{ref.name}{ref.excluded ? ' · 참고 제외' : ''}</label>)}</details>}
            <button className="primary-button" onClick={() => void previewBrief()} disabled={briefBusy || analysisBusy}>{briefBusy ? '생성 조건 준비 중…' : '이미지 생성 준비'}</button>
            <button className="secondary-button" onClick={() => void analyzeBoard()} disabled={analysisBusy || briefBusy}>
              {analysisBusy ? '자동 정리 중…' : '전체 레퍼런스 자동 정리'}
            </button>
            <a className="primary-button" href="/assistant">어시스턴트에서 이미지 요청 ↗</a>
            <button className="art-bible-button" onClick={() => void openBible()} aria-pressed={bibleOpen}>아트바이블</button>
          </div>
        </div>
      </header>
      {actionError && <p role="alert" className="brief-error">{actionError}</p>}
      <div className="art-toolbar">
        {bibleOpen && <button className="art-tool" onClick={() => setBibleOpen(false)}>← 캔버스로 돌아가기</button>}
        <button className="art-tool" aria-label="실행 취소" title="실행 취소" disabled={!history.current?.past.length} onClick={() => travel('undo')}>↶</button>
        <button className="art-tool" aria-label="다시 실행" title="다시 실행" disabled={!history.current?.future.length} onClick={() => travel('redo')}>↷</button>
        <button className="art-tool active">↖ 선택</button>
        <button className="art-tool" onClick={() => addNode('frame')}>▧ 프레임</button>
        <button className="art-tool" onClick={() => addNode('text_note')}>T 메모</button>
        <button className="art-tool" onClick={() => addNode('group')}>그룹</button>
        <button className="art-tool danger-tool" aria-label="선택 요소 삭제" disabled={!activeNodeId} onClick={deleteActiveNode}>⌫ 삭제</button>
        <button className="art-tool" disabled={!boardId} onClick={() => void saveRevision()}>변경 저장</button>
        <span className="toolbar-rule" />
        <button className="art-tool" onClick={() => inputRef.current?.click()}>
          ＋ 이미지 추가
        </button>
        <span className="toolbar-spacer" />
        <button className="art-tool viewport-button" aria-label="캔버스 축소" title="캔버스 축소 · 휠로도 조절할 수 있습니다" onClick={() => applyZoom(zoomRef.current - 0.1)}>−</button>
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
        <button className="art-tool viewport-button" aria-label="캔버스 확대" title="캔버스 확대 · 휠로도 조절할 수 있습니다" onClick={() => applyZoom(zoomRef.current + 0.1)}>＋</button>
        <button className="art-tool" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>맞춤 보기</button>
        <span className="save-history-label">{syncState === '서버에 저장됨' ? '최근 변경 저장됨' : '변경 내용 자동 저장'}</span>
        <input
          ref={inputRef}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(event) => {
            void addFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      <main className="art-layout">
        <nav className="art-mobile-tabs"><button className={mobilePanel === 'canvas' ? 'active' : ''} onClick={() => setMobilePanel('canvas')}>캔버스</button><button className={mobilePanel === 'inspector' ? 'active' : ''} onClick={() => setMobilePanel('inspector')}>검토 패널</button></nav>
        <section
          ref={boardEl}
          className={'art-board ' + (dragging ? 'dragging ' : '') + (mobilePanel === 'inspector' ? 'mobile-hidden' : '')}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('.reference-card, .canvas-node, button, input, select, textarea')) return;
            setDragging(true);
            beginGesture();
            dragOrigin.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!dragging) return;
            setPan({ x: dragOrigin.current.panX + event.clientX - dragOrigin.current.x, y: dragOrigin.current.panY + event.clientY - dragOrigin.current.y });
          }}
          onPointerUp={() => { setDragging(false); endGesture(); }}
          onPointerCancel={() => { setDragging(false); endGesture(); }}
        >
          <div className="board-grid" />
          <div className="board-label">
            <span>CHARACTER / ENVIRONMENT</span>
            <strong>{boardId ? '프로젝트 아트보드' : '서버 연결 중'}</strong>
          </div>
          <div className="board-stage" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {nodes.map((node) => <div key={node.id} className={'canvas-node ' + node.node_type + (activeNodeId === node.id ? ' active' : '')} style={{ left: node.x, top: node.y, width: node.width, height: node.height }} onClick={() => setActiveNodeId(node.id)}>
          <div className="canvas-node-handle" onPointerDown={(event) => {
              event.stopPropagation();
              if (event.button !== 0) return;
              beginGesture();
              const origin = { x: event.clientX, y: event.clientY };
              const container = node.node_type === 'frame' || node.node_type === 'group';
              const frameRect = event.currentTarget.parentElement!.getBoundingClientRect();
              const contained = (rect: DOMRect) => rect.left >= frameRect.left && rect.top >= frameRect.top && rect.right <= frameRect.right && rect.bottom <= frameRect.bottom;
              const movingRefs = new Map(refs.flatMap((ref, index) => {
                const card = Array.from(boardEl.current?.querySelectorAll<HTMLElement>('[data-reference-id]') ?? []).find((el) => el.dataset.referenceId === ref.id);
                return container && (ref.group_id === node.id || (card && contained(card.getBoundingClientRect())))
                  ? [[ref.id, { x: ref.x ?? 80 + (index % 4) * 280, y: ref.y ?? 110 + Math.floor(index / 4) * 260 }] as const] : [];
              }));
              const movingNodes = new Map(nodes.filter((n) => n.id === node.id || (container && n.x >= node.x && n.y >= node.y && n.x + n.width <= node.x + node.width && n.y + n.height <= node.y + node.height)).map((n) => [n.id, { x: n.x, y: n.y }]));
              const handle = event.currentTarget;
              handle.setPointerCapture(event.pointerId);
              handle.onpointermove = (move) => {
                const dx = (move.clientX - origin.x) / zoom;
                const dy = (move.clientY - origin.y) / zoom;
                setNodes((current) => current.map((n) => { const start = movingNodes.get(n.id); return start ? { ...n, x: start.x + dx, y: start.y + dy } : n; }));
                setRefs((current) => current.map((ref) => { const start = movingRefs.get(ref.id); return start ? { ...ref, x: start.x + dx, y: start.y + dy } : ref; }));
              };
              const finish = (end: PointerEvent) => { end.stopPropagation(); handle.onpointermove = null; handle.onpointerup = null; handle.onpointercancel = null; endGesture(); };
              handle.onpointerup = finish;
              handle.onpointercancel = finish;
            }}>{node.node_type === 'frame' ? '프레임' : node.node_type === 'group' ? '그룹' : '메모'}<span className="node-handle-hint">이동</span></div>
            <button className="node-delete" aria-label="노드 삭제" title="요소 삭제" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); deleteNode(node.id); }}>삭제</button>
            <textarea aria-label="노드 내용" value={node.text} onChange={(event) => setNodes((current) => current.map((n) => n.id === node.id ? { ...n, text: event.target.value } : n))} />
          </div>)}
          {refs.length === 0 && nodes.length === 0 && (
            <div className="art-empty-state">
              <span className="eyebrow">REFERENCE BOARD</span>
              <h2>팀의 시각 언어를 이곳에 모아보세요</h2>
              <p>PNG, JPEG, WEBP 원본은 그대로 보존됩니다. 업로드한 이미지는 자동으로 분석하고 생성 참고 자료로 정리합니다.</p>
              <button className="primary-button" onClick={() => inputRef.current?.click()}>첫 레퍼런스 추가</button>
            </div>
          )}
          {refs.map((ref, index) => (
                <ReferenceCard
                  key={ref.id}
                  refCard={ref}
                  zoom={zoom}
                  active={ref.id === selectedId}
                  onClick={() => setSelectedId(ref.id)}
                  onToggle={() => {}}
                  style={{ left: ref.x ?? 80 + (index % 4) * 280, top: ref.y ?? 110 + Math.floor(index / 4) * 260 }}
                  onMove={(x, y) => setRefs((current) => current.map((item) => item.id === ref.id ? { ...item, x, y } : item))}
                  onResize={(x, y, width, height, scale) => setRefs((current) => current.map((item) => item.id === ref.id ? { ...item, x, y, width, height, scale } : item))}
                  onGestureStart={beginGesture}
                  onGestureEnd={endGesture}
                />
          ))}
          </div>
        </section>
        <aside className={'art-inspector ' + (mobilePanel === 'canvas' ? 'mobile-hidden' : '')}>
          {brief && (
            <div className="brief-card">
              <span className="eyebrow">이미지 생성 준비</span>
              <strong>{brief.request}</strong>
              {brief.review_warnings?.map((warning: string) => <p key={warning} role="status">{warning}</p>)}
              {brief.brief?.plan && <div>{brief.brief.review_notice && <p role="note">{brief.brief.review_notice}</p>}<p>작업: {brief.brief.plan.operation} · {brief.brief.plan.output}</p><p>유지: {brief.brief.plan.preserve.join(', ') || '없음'}</p><p>변경: {brief.brief.plan.change.join(', ')}</p><p>자유 구성: {brief.brief.plan.free.join(', ')}</p>{brief.brief.references.map((ref: any) => <p key={ref.upload_id}>{ref.purpose} · {ref.reason}</p>)}<details><summary>프로젝트 근거</summary>{brief.brief.evidence.map((e: any) => <p key={e.id}>{e.source} · {e.stable_key}</p>)}</details></div>}
              <p>{brief.instructions || '자동으로 정리된 레퍼런스가 없습니다.'}</p>
              <small className="brief-meta">
                {brief.style_approved ? '승인된 아트 규칙 적용' : '승인된 아트 규칙 없음'}
                {' · '}참고 이미지 {brief.reference_upload_ids?.length ?? 0}개
              </small>
              {brief.approval_id ? (
                <button
                  className="primary-button"
                  disabled={generationBusy || brief.generated}
                  onClick={async () => {
                    setGenerationBusy(true);
                    try {
                      const result = await api<{ executed?: boolean }>('/api/assistant/images/generate', {
                        method: 'POST',
                        body: JSON.stringify({ approval_id: brief.approval_id }),
                      });
                      setBrief({ ...brief, generated: result.executed === true, generation_not_executed: result.executed !== true });
                      if (result.executed) setGenerated(await api<any[]>('/api/assistant/images'));
                    } catch (error) {
                      setActionError(artActionError(error));
                      setBrief({ ...brief, generation_error: true });
                    } finally { setGenerationBusy(false); }
                  }}
                >
                  {brief.generated ? '이미지 생성 완료' : generationBusy ? '이미지 생성 중…' : '확인하고 이미지 생성'}
                </button>
              ) : (
                <small>
                  이미지 provider가 꺼져 있거나 editor 권한이 없어 prompt-only 상태입니다.
                </small>
              )}
              {brief.generation_error && (
                <small className="brief-error">생성 요청을 처리하지 못했습니다.</small>
              )}
              {brief.generation_not_executed && (
                <small className="brief-error">생성 작업이 실행되지 않았습니다. provider와 권한 상태를 확인해 주세요.</small>
              )}
            </div>
          )}
          {bibleOpen && !analysis && <div className="art-bible-empty"><h2>아트바이블</h2><p>{bibleLoading ? '저장된 내용을 불러오는 중…' : '전체 레퍼런스 자동 정리를 누르면 참고 자료를 읽고 초안을 만듭니다.'}</p></div>}
          {bibleOpen && analysis && (
            <BoardDraftEditor analysis={analysis} refs={refs} stale={Number(analysis.revision) !== revision || dirtyRef.current} onSave={async (draft) => {
              const result = await api<any>('/api/assistant/art-boards/' + boardId + '/analysis/' + analysis.revision, { method: 'PATCH', body: JSON.stringify({ analysis_id: analysis.id, result: draft }) });
              setAnalysis(result); return result;
            }} onApply={async (saved) => {
              const approved = await api<any>('/api/assistant/art-boards/' + boardId + '/analysis/' + saved.revision + '/approve', { method: 'POST', body: JSON.stringify({ analysis_id: saved.id, expected_hash: saved.result_hash }) });
              setAnalysis({ ...saved, status: 'APPROVED', style_version: approved.version });
            }} onDiscard={async () => {
              await api('/api/assistant/art-boards/' + boardId + '/analysis/' + analysis.revision + '/reject', { method: 'POST', body: JSON.stringify({ analysis_id: analysis.id }) });
              setAnalysis({ ...analysis, status: 'REJECTED' });
            }} />
          )}
          <div className="inspector-title">
            <div>
              <span className="eyebrow">이미지 정보</span>
              <h2>{selected?.name ?? '선택 없음'}</h2>
            </div>
            <Help text="이미지에서 무엇을 참고할지 정하는 곳입니다. 역할은 참고할 요소, 강도는 얼마나 비슷하게 반영할지를 뜻합니다. 어시스턴트는 보드 전체를 읽고 이 설정을 따릅니다." />
          </div>
          {selected && (
            <>
              <img className="inspector-image" src={selected.url} alt="선택한 레퍼런스" />
              <label>
                <span className="art-field-heading">참고할 요소 <Help text="얼굴 형태는 얼굴 비율, 모델링 언어는 그림체와 3D 표현, 재질 표면은 옷과 물체의 질감, 조명은 빛, 분위기는 전체 느낌을 뜻합니다." /></span>
                <select
                  value={selected.excluded ? 'none' : selected.role}
                  onChange={(event) => { if (event.target.value === 'none') { update({ excluded: true }); return; } const role = event.target.value as Role; update({ excluded: false, role, roles: [role, ...(selected.roles ?? [selected.role]).filter((item) => item !== role)] }); }}
                >
                  <option value="none">참고 안함</option>
                  {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <fieldset className="role-usage-list"><legend>추가 역할 · 역할별 강도</legend>{Object.entries(roleLabels).filter(([value]) => value !== selected.role).map(([value, label]) => { const role=value as Role; const active=(selected.roles ?? [selected.role]).includes(role); return <div key={role}><label><input type="checkbox" checked={active} onChange={(event) => { const roles=event.target.checked ? [...new Set([...(selected.roles ?? [selected.role]), role])] : (selected.roles ?? [selected.role]).filter((item) => item!==role); update({ roles: roles.length ? roles : [selected.role] }); }} />{label}</label>{active && <select aria-label={label + ' 사용 강도'} value={selected.roleUsage?.[role] ?? selected.usage} onChange={(event) => update({ roleUsage: { ...selected.roleUsage, [role]: event.target.value as Usage } })}>{Object.entries(usageLabels).map(([v, title]) => <option key={v} value={v}>{title}</option>)}</select>}</div>; })}</fieldset>
              <label>
                <span className="art-field-heading">얼마나 반영할까요? <Help text="반드시 반영은 꼭 지킬 기준, 강한 참고는 비슷하게 반영, 분위기만은 느낌만 참고, 부분만 참고는 지정 영역만 사용합니다. 검토 필요는 확인 전까지 생성 원본으로 보내지 않습니다." /></span>
                <select
                  value={selected.usage}
                  onChange={(event) => update({ usage: event.target.value as Usage, roleUsage: { ...selected.roleUsage, [selected.role]: event.target.value as Usage } })}
                >
                  {Object.entries(usageLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {selected.usage === 'PARTIAL_REFERENCE' && <div className="crop-editor"><span>부분 채택 영역</span><div className="crop-preview"><img src={selected.url} alt="crop reference" /><div style={{ left: (selected.crop?.left ?? 0.1) * 100 + '%', top: (selected.crop?.top ?? 0.1) * 100 + '%', width: ((selected.crop?.right ?? 0.9) - (selected.crop?.left ?? 0.1)) * 100 + '%', height: ((selected.crop?.bottom ?? 0.9) - (selected.crop?.top ?? 0.1)) * 100 + '%' }} /></div><div className="crop-fields">{(['left', 'top', 'right', 'bottom'] as const).map((key) => <label key={key}>{key}<input type="number" min={0} max={1} step={0.05} value={selected.crop?.[key] ?? (key === 'right' || key === 'bottom' ? 0.9 : 0.1)} onChange={(event) => { const defaults = { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 }; update({ crop: { ...defaults, ...selected.crop, [key]: Number(event.target.value) } }); }} /></label>)}</div></div>}
              <label>
                <span className="art-field-heading">팀 메모 <Help text="이 이미지에서 무엇을 가져오고 무엇을 따라 하지 않을지 적어 주세요. 예: 옷의 질감만 참고하고 얼굴과 자세는 따라 하지 않기. 아래 AI 내용은 이미지 설명이며, 이 메모가 생성 지시입니다." /></span>
                <textarea
                  value={selected.note}
                  onChange={(event) => update({ note: event.target.value })}
                  rows={4}
                />
              </label>
              <button
                className="secondary-button asset-analyze-button"
                disabled={!selected.art_asset_id || assetAnalysisBusy}
                onClick={() => void analyzeSelectedAsset()}
              >
                {assetAnalysisBusy ? '이미지 자동 분류 중…' : selected.art_asset_id ? '이미지 다시 자동 분류' : '서버 업로드 후 자동 분류 가능'}
              </button>
              {assetAnalysis?.asset_id === selected.art_asset_id && selected.art_asset_id && (
                <ObservationEditor analysis={assetAnalysis} onSave={saveCorrections} />
              )}
            </>
          )}
          <div className="art-output-panel">
            <div className="output-heading">
              <div>
                <span className="eyebrow">GENERATED OUTPUTS</span>
                <h3>생성 결과</h3>
              </div>
              <span>{generated.length}개</span>
            </div>
            {generated.length ? (
              <div className="output-grid">
                {generated.slice(0, 6).map((image) => (
                  <div key={image.id} className="output-item">
                    <a href={'/api/assistant/images/' + image.id} target="_blank" rel="noreferrer">
                      <img src={'/api/assistant/images/' + image.id} alt="생성 결과" loading="lazy" />
                    </a>
                    <small>{image.review_status ?? 'DRAFT'} · {image.model}</small>
                    {image.review_status !== 'APPROVED_CANONICAL' && (
                      <div>
                      <input className="output-rights-note" placeholder="참고 자료로 사용할 수 있는 권리 메모" value={canonicalNote} onChange={(event) => setCanonicalNote(event.target.value)} />
                      <button className="output-review" disabled={!canonicalNote.trim()} onClick={async () => {
                        const result = await api<any>('/api/assistant/images/' + image.id + '/review', {
                          method: 'POST',
                          body: JSON.stringify({ status: 'APPROVED_CANONICAL', review_role: 'art_reference', note: canonicalNote }),
                        });
                        if (result.reviewed) setGenerated(await api<any[]>('/api/assistant/images'));
                      }}>참고 자료로 승인</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="output-empty">아직 생성된 결과가 없습니다. 이미지 생성 준비를 확인하면 결과가 표시됩니다.</p>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
const RESIZE_EDGES = ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'] as const;
function ReferenceCard({
  refCard,
  active,
  onClick,
  onToggle,
  style,
  onMove,
  onResize,
  zoom,
  onGestureStart,
  onGestureEnd,
}: {
  refCard: RefCard;
  active: boolean;
  onClick: () => void;
  onToggle: () => void;
  style: React.CSSProperties;
  onMove: (x: number, y: number) => void;
  onResize: (x: number, y: number, width: number, height: number, scale: number) => void;
  zoom: number;
  onGestureStart: () => void;
  onGestureEnd: () => void;
}) {
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  const scale = refCard.scale ?? 1;
  const imageWidth = base ? Math.max(80, Math.round(base.w * scale)) : 240;
  const beginResize = (event: React.PointerEvent<HTMLElement>, edge: typeof RESIZE_EDGES[number]) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const card = handle.closest('.reference-card') as HTMLElement | null;
    const image = card?.querySelector('img') as HTMLElement | null;
    if (!card || !image) return;
    const start = {
      w: image.clientWidth,
      h: image.clientHeight,
      x: Number(style.left),
      y: Number(style.top),
    };
    handle.setPointerCapture(event.pointerId);
    onGestureStart();
    const resize = (clientX: number, clientY: number) => {
      const dx = (clientX - event.clientX) / zoom;
      const dy = (clientY - event.clientY) / zoom;
      const horizontal = edge.includes('e') ? 1 : edge.includes('w') ? -1 : 0;
      const vertical = edge.includes('s') ? 1 : edge.includes('n') ? -1 : 0;
      const ratio = Math.min(4, Math.max(80 / start.w, 1 + (horizontal * dx * start.w + vertical * dy * start.h) / ((horizontal ? start.w ** 2 : 0) + (vertical ? start.h ** 2 : 0))));
      const width = start.w * ratio;
      const height = start.h * ratio;
      onResize(start.x - (width - start.w) * (horizontal < 0 ? 1 : horizontal === 0 ? 0.5 : 0), start.y - (height - start.h) * (vertical < 0 ? 1 : vertical === 0 ? 0.5 : 0), width, height, scale * ratio);
    };
    handle.onpointermove = (next) => resize(next.clientX, next.clientY);
    handle.onpointerup = (next) => {
      next.stopPropagation();
      handle.onpointermove = null; handle.onpointerup = null; handle.onpointercancel = null;
      onGestureEnd();
    };
    handle.onpointercancel = (next) => {
      next.stopPropagation();
      handle.onpointermove = null; handle.onpointerup = null; handle.onpointercancel = null;
      onGestureEnd();
    };
  };
  return (
    <article data-reference-id={refCard.id} className={'reference-card canvas-reference-card ' + (active ? 'active' : '')} style={{ ...style, opacity: refCard.excluded ? 0.3 : 1 }} onClick={onClick} onPointerDown={(event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, textarea, select, .reference-resize')) return;
      event.preventDefault(); event.stopPropagation(); onClick();
      const start = { x: event.clientX, y: event.clientY, left: Number(style.left), top: Number(style.top) };
      const card = event.currentTarget;
      card.setPointerCapture(event.pointerId); onGestureStart();
      card.onpointermove = (move) => onMove(start.left + (move.clientX - start.x) / zoom, start.top + (move.clientY - start.y) / zoom);
      const finish = (end: PointerEvent) => { end.stopPropagation(); card.onpointermove = null; card.onpointerup = null; card.onpointercancel = null; onGestureEnd(); };
      card.onpointerup = finish; card.onpointercancel = finish;
    }}>
      <img
        src={refCard.url}
        alt={refCard.name}
        draggable={false}
        style={{ width: imageWidth }}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (!image.naturalWidth || !image.naturalHeight) return;
          const fit = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
          setBase({ w: image.naturalWidth * fit, h: image.naturalHeight * fit });
        }}
      />
      <div className="reference-card-foot">
        <div>
          <strong>{refCard.name}</strong>
          <span>
            {refCard.excluded ? '참고 안함' : roleLabels[refCard.role] + ' · ' + usageLabels[refCard.usage]}
          </span>
        </div>
        <button
          className={refCard.selected ? 'checked' : ''}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          aria-label="전체 참조 이미지"
          hidden
          style={{ display: 'none' }}
        >
          {refCard.selected ? '✓' : '○'}
        </button>
      </div>
      {RESIZE_EDGES.map((edge) => (
        <span key={edge} className={'reference-resize resize-' + edge} onPointerDown={(event) => beginResize(event, edge)} />
      ))}
    </article>
  );
}

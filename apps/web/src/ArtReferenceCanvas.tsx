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
  const history = useRef<CanvasHistory<{ refs: RefCard[]; nodes: ArtCanvasNode[]; edges: ArtCanvasEdge[]; zoom: number; pan: { x: number; y: number } }> | null>(null);
  const restoring = useRef(false);
  const loadedBoard = useRef(false);
  const [, setHistoryVersion] = useState(0);
  useEffect(() => {
    if (!loadedBoard.current) return;
    const present = { refs, nodes, edges, zoom, pan };
    if (restoring.current) { restoring.current = false; return; }
    const changed = Boolean(history.current && JSON.stringify(history.current.present) !== JSON.stringify(present));
    if (changed) dirtyRef.current = true;
    history.current = history.current ? changeCanvas(history.current, present) : { past: [], present, future: [] };
    setHistoryVersion((v) => v + 1);
  }, [refs, nodes, edges, zoom, pan]);
  const travel = (direction: 'undo' | 'redo') => {
    if (!history.current) return;
    const next = travelCanvas(history.current, direction);
    if (next === history.current) return;
    history.current = next;
    restoring.current = true;
    setRefs(next.present.refs); setNodes(next.present.nodes); setEdges(next.present.edges);
    setZoom(next.present.zoom); setPan(next.present.pan);
    setActiveNodeId(null); setConnectSource(null);
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
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const [edgeType, setEdgeType] = useState<ArtCanvasEdge['edge_type']>('supports');
  const [selectedId, setSelectedId] = useState('ref-1');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
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
  const [analysisEdit, setAnalysisEdit] = useState('');
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
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
  const flushBoard = async () => {
    if (!boardId) throw new Error('보드 연결을 확인해 주세요.');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = serverSnapshot();
    let savedRevision = revisionRef.current;
    const task = saveQueue.current.then(async () => {
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
      const result = await api<{ revision: number }>(
        '/api/assistant/art-boards/' + boardId + '/revisions',
        {
          method: 'POST',
          body: JSON.stringify({ base_revision: revision, snapshot: serverSnapshot() }),
        },
      );
      setRevision(Number(result.revision));
      dirtyRef.current = false;
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
  const saveCorrections = async () => {
    if (!selected?.art_asset_id) return;
    try {
      const corrections = JSON.parse(assetCorrections || '{}');
      const saved = await api<any>('/api/assistant/art-assets/' + selected.art_asset_id + '/extraction', {
        method: 'PATCH', body: JSON.stringify({ corrections }),
      });
      setAssetAnalysis((current: any) => current ? { ...current, human_corrections: saved.human_corrections } : current);
    } catch {
      window.alert('수정값은 JSON 형식이어야 합니다.');
    }
  };
  const previewBrief = async () => {
    if (!boardId || briefBusy || analysisBusy) return;
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
            request: '현재 보드 기준 캐릭터 컨셉 아트',
            revision: savedRevision,
          }),
        },
      );
      setBrief(brief);
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
  const moveSelection = (dx: number, dy: number) => {
    if (!selectedIds.length) return;
    const snap = (value: number) => Math.round(value / 16) * 16;
    setRefs((current) => current.map((ref) => selectedIds.includes(ref.id) ? { ...ref, x: snap((ref.x ?? 80) + dx), y: snap((ref.y ?? 110) + dy) } : ref));
  };
  const groupSelection = () => {
    const items = refs.filter((ref) => selectedIds.includes(ref.id));
    if (items.length < 2) return;
    const id = crypto.randomUUID();
    const x = Math.min(...items.map((ref) => ref.x ?? 80)), y = Math.min(...items.map((ref) => ref.y ?? 110));
    setNodes((current) => [...current, { id, node_type: 'group', x, y, width: 260, height: 90, text: '그룹 · ' + items.map((item) => item.name).join(', ') }]);
    setRefs((current) => current.map((ref) => selectedIds.includes(ref.id) ? { ...ref, group_id: id } as RefCard : ref));
    setSelectedIds([]);
  };
  const chooseNode = (id: string) => {
    if (connectSource && connectSource !== id && nodes.some((node) => node.id === connectSource)) {
      setEdges((current) => current.some((e) => e.source === connectSource && e.target === id && e.edge_type === edgeType) ? current : [...current, { id: crypto.randomUUID(), source: connectSource, target: id, edge_type: edgeType }]);
      setConnectSource(null);
    }
    setActiveNodeId(id);
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
    <div className="art-workspace">
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
            <button className="secondary-button" onClick={() => void analyzeBoard()} disabled={analysisBusy || briefBusy}>
              {analysisBusy ? '자동 정리 중…' : '전체 레퍼런스 자동 정리'}
            </button>
            <button className="primary-button" disabled={briefBusy || analysisBusy} onClick={() => void previewBrief()}>
              {briefBusy ? '생성 준비 중…' : '이미지 생성 준비 ↗'}
            </button>
          </div>
        </div>
      </header>
      {actionError && <p role="alert" className="brief-error">{actionError}</p>}
      <div className="art-toolbar">
        <button className="art-tool" aria-label="실행 취소" title="실행 취소" disabled={!history.current?.past.length} onClick={() => travel('undo')}>↶</button>
        <button className="art-tool" aria-label="다시 실행" title="다시 실행" disabled={!history.current?.future.length} onClick={() => travel('redo')}>↷</button>
        <button className="art-tool active">↖ 선택</button>
        <button className="art-tool" onClick={() => addNode('frame')}>▧ 프레임</button>
        <button className="art-tool" onClick={() => addNode('text_note')}>T 메모</button>
        <button className="art-tool" onClick={() => addNode('group')}>그룹</button>
        <button className="art-tool" disabled={!selectedIds.length} onClick={() => moveSelection(-16, 0)}>←</button><button className="art-tool" disabled={!selectedIds.length} onClick={() => moveSelection(16, 0)}>→</button><button className="art-tool" disabled={!selectedIds.length} onClick={() => moveSelection(0, -16)}>↑</button><button className="art-tool" disabled={!selectedIds.length} onClick={() => moveSelection(0, 16)}>↓</button><button className="art-tool" disabled={selectedIds.length < 2} onClick={groupSelection}>선택 묶기</button>
        <button className={'art-tool ' + (connectSource ? 'active' : '')} disabled={!activeNodeId} onClick={() => setConnectSource(connectSource ? null : activeNodeId)}>↗ 연결</button>
        <button className="art-tool danger-tool" aria-label="선택 요소 삭제" disabled={!activeNodeId} onClick={deleteActiveNode}>⌫ 삭제</button>
        <select aria-label="연결 관계" value={edgeType} onChange={(event) => setEdgeType(event.target.value as ArtCanvasEdge['edge_type'])}>
          <option value="supports">뒷받침</option><option value="contradicts">충돌</option><option value="variant_of">변형</option><option value="uses_only">부분 채택</option><option value="derived_from">파생</option>
        </select>
        <button className="art-tool" disabled={!boardId} onClick={() => void saveRevision()}>변경 저장</button>
        <span className="toolbar-rule" />
        <button className="art-tool" onClick={() => inputRef.current?.click()}>
          ＋ 이미지 추가
        </button>
        <span className="toolbar-spacer" />
        <button className="art-tool viewport-button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>−</button>
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
        <button className="art-tool viewport-button" onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}>＋</button>
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
          className={'art-board ' + (mobilePanel === 'inspector' ? 'mobile-hidden' : '')}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }}
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            setZoom((value) => Math.min(1.8, Math.max(0.5, value - event.deltaY * 0.001)));
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest('.reference-card, .canvas-node, button, input, select, textarea')) return;
            setDragging(true);
            dragOrigin.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!dragging) return;
            setPan({ x: dragOrigin.current.panX + event.clientX - dragOrigin.current.x, y: dragOrigin.current.panY + event.clientY - dragOrigin.current.y });
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        >
          <div className="board-grid" />
          <div className="board-label">
            <span>CHARACTER / ENVIRONMENT</span>
            <strong>{boardId ? '프로젝트 아트보드' : '서버 연결 중'}</strong>
          </div>
          <div className="board-stage" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <svg className="canvas-edges">
            {edges.map((edge) => {
              const source = nodes.find((n) => n.id === edge.source);
              const target = nodes.find((n) => n.id === edge.target);
              if (!source || !target) return null;
              const x1 = source.x + source.width / 2, y1 = source.y + source.height / 2;
              const x2 = target.x + target.width / 2, y2 = target.y + target.height / 2;
              return <g key={edge.id}><line x1={x1} y1={y1} x2={x2} y2={y2} /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2}>{edge.edge_type}</text></g>;
            })}
          </svg>
          {nodes.map((node) => <div key={node.id} className={'canvas-node ' + node.node_type + (activeNodeId === node.id ? ' active' : '')} style={{ left: node.x, top: node.y, width: node.width, height: node.height }} onClick={() => chooseNode(node.id)}>
          <div className="canvas-node-handle" onPointerDown={(event) => {
              event.stopPropagation();
              const origin = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
              const handle = event.currentTarget;
              handle.setPointerCapture(event.pointerId);
              handle.onpointermove = (move) => setNodes((current) => current.map((n) => n.id === node.id ? { ...n, x: origin.nodeX + (move.clientX - origin.x) / zoom, y: origin.nodeY + (move.clientY - origin.y) / zoom } : n));
              handle.onpointerup = () => { handle.onpointermove = null; handle.onpointerup = null; };
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
                  active={ref.id === selectedId}
                  onClick={() => setSelectedId(ref.id)}
                  onToggle={() => setRefs((current) => current.map((item) => item.id === ref.id ? { ...item, selected: !item.selected } : item))}
                  style={{ left: ref.x ?? 80 + (index % 4) * 260, top: ref.y ?? 110 + Math.floor(index / 4) * 250, width: ref.width ?? 220, height: ref.height ?? 210 }}
                  onMove={(x, y) => setRefs((current) => current.map((item) => item.id === ref.id ? { ...item, x, y } : item))}
                  onResize={(width, height) => setRefs((current) => current.map((item) => item.id === ref.id ? { ...item, width, height } : item))}
                  selected={selectedIds.includes(ref.id)}
                  onSelect={(multi) => setSelectedIds((current) => multi ? current.includes(ref.id) ? current.filter((id) => id !== ref.id) : [...current, ref.id] : [ref.id])}
                />
          ))}
          </div>
        </section>
        <aside className={'art-inspector ' + (mobilePanel === 'canvas' ? 'mobile-hidden' : '')}>
          {brief && (
            <div className="brief-card">
              <span className="eyebrow">이미지 생성 준비</span>
              <strong>{brief.request}</strong>
              <p>{brief.instructions || '자동으로 정리된 레퍼런스가 없습니다.'}</p>
              <small className="brief-meta">
                {brief.style_approved ? '승인된 아트 규칙 적용' : '승인된 아트 규칙 없음'}
                {' · '}참고 이미지 {brief.reference_upload_ids?.length ?? 0}개
              </small>
              {brief.approval_id ? (
                <button
                  className="primary-button"
                  onClick={async () => {
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
                    }
                  }}
                >
                  {brief.generated ? '이미지 생성 완료' : '확인하고 이미지 생성'}
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
          {analysis && (
            <div className="analysis-card">
              <div className="analysis-card-head">
                <div>
                  <span className="eyebrow">아트 방향 / {analysis.status}</span>
                  <h3>자동 정리 결과</h3>
                </div>
                <span>{analysis.status}</span>
              </div>
              <p>{analysis.result?.summary}</p>
              {Number(analysis.revision) !== revision && <p role="status">보드가 변경되어 이 분석은 이전 결과입니다. 전체 레퍼런스를 다시 정리해 주세요.</p>}
              {analysis.status === 'DRAFT' && <><label>Art Bible 초안 수정(JSON)<textarea rows={8} value={analysisEdit} onChange={(event) => setAnalysisEdit(event.target.value)} /></label><button className="secondary-button" onClick={async () => { try { const result = await api<any>('/api/assistant/art-boards/' + boardId + '/analysis/' + analysis.revision, { method: 'PATCH', body: JSON.stringify({ analysis_id: analysis.id, result: JSON.parse(analysisEdit) }) }); setAnalysis(result); setAnalysisEdit(JSON.stringify(result.result, null, 2)); } catch { window.alert('수정된 JSON이 올바르지 않습니다.'); } }}>수정 초안 저장</button><button className="asset-review-button" onClick={async () => { await api('/api/assistant/art-boards/' + boardId + '/analysis/' + analysis.revision + '/reject', { method: 'POST', body: JSON.stringify({ analysis_id: analysis.id }) }); setAnalysis({ ...analysis, status: 'REJECTED' }); }}>초안 거부</button></>}
              {analysis.status === 'DRAFT' && (
                <button
                  className="secondary-button"
                  disabled={Number(analysis.revision) !== revision || dirtyRef.current}
                  onClick={async () => {
                    try {
                      const approved = await api<any>('/api/assistant/art-boards/' + boardId + '/analysis/' + analysis.revision + '/approve', {
                        method: 'POST',
                        body: JSON.stringify({ analysis_id: analysis.id, expected_hash: analysis.result_hash }),
                      });
                      setAnalysis({ ...analysis, status: 'APPROVED', style_version: approved.version });
                    } catch (error) {
                      setActionError(artActionError(error));
                    }
                  }}
                >
                  이 결과를 아트 방향으로 승인
                </button>
              )}
              {analysis.status === 'APPROVED' && (
                <small className="analysis-approved">Art Bible v{analysis.style_version}로 승인됨</small>
              )}
              <div className="analysis-rule-list">
                {(analysis.result?.common_rules ?? []).slice(0, 4).map((rule: any, index: number) => (
                  <div key={index}><strong>{rule.category}</strong><span>{rule.statement}</span></div>
                ))}
              </div>
              <small>AI 관찰은 초안입니다. 승인 전에는 생성 규칙이나 canonical reference로 사용되지 않습니다.</small>
            </div>
          )}
          <div className="inspector-title">
            <div>
              <span className="eyebrow">이미지 정보</span>
              <h2>{selected?.name ?? '선택 없음'}</h2>
            </div>
            <span className="review-badge">{selected?.selected ? '선택됨' : '보류'}</span>
          </div>
          {selected && (
            <>
              <img className="inspector-image" src={selected.url} alt="선택한 레퍼런스" />
              <label>
                사용 역할
                <select
                  value={selected.role}
                  onChange={(event) => update({ role: event.target.value as Role })}
                >
                  {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <fieldset className="role-usage-list"><legend>복수 역할 · 역할별 강도</legend>{Object.entries(roleLabels).map(([value, label]) => { const role=value as Role; const active=(selected.roles ?? [selected.role]).includes(role); return <div key={role}><label><input type="checkbox" checked={active} onChange={(event) => { const roles=event.target.checked ? [...new Set([...(selected.roles ?? [selected.role]), role])] : (selected.roles ?? [selected.role]).filter((item) => item!==role); update({ roles: roles.length ? roles : [selected.role] }); }} />{label}</label>{active && <select aria-label={label + ' 사용 강도'} value={selected.roleUsage?.[role] ?? selected.usage} onChange={(event) => update({ roleUsage: { ...selected.roleUsage, [role]: event.target.value as Usage } })}>{Object.entries(usageLabels).map(([v, title]) => <option key={v} value={v}>{title}</option>)}</select>}</div>; })}</fieldset>
              <label>
                사용 강도
                <select
                  value={selected.usage}
                  onChange={(event) => update({ usage: event.target.value as Usage })}
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
                팀 메모
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
              {selected.art_asset_id && (
                <>
                <label>사용 권리 메모
                  <textarea rows={2} value={selected.rights_note ?? ''} onChange={(event) => update({ rights_note: event.target.value })} />
                </label>
                <div className="asset-review-row">
                  <span>자산 상태: {selected.canonical_state ?? 'NONE'}</span>
                  {selected.canonical_state !== 'APPROVED_CANONICAL' && (
                    <button
                      className="asset-review-button"
                      disabled={!selected.rights_note?.trim()}
                      onClick={async () => {
                        const result = await api<any>('/api/assistant/art-assets/' + selected.art_asset_id + '/canonical-review', {
                          method: 'POST',
                          body: JSON.stringify({ state: 'APPROVED_CANONICAL', rights_note: selected.rights_note }),
                        });
                        if (result.reviewed) update({ canonical_state: result.canonical_state });
                      }}
                    >
                      canonical 승인
                    </button>
                  )}
                </div>
                </>
              )}
              {assetAnalysis?.asset_id === selected.art_asset_id && selected.art_asset_id && (
                <div className="asset-observation-card">
                  <span className="eyebrow">VISION OBSERVATION / DRAFT</span>
                  <p>{assetAnalysis.observations?.description}</p>
                  <div>
                    {(assetAnalysis.observations?.materials ?? []).slice(0, 4).map((item: string) => <span key={item}>{item}</span>)}
                    {(assetAnalysis.observations?.palette ?? []).slice(0, 4).map((item: string) => <span key={item}>{item}</span>)}
                  </div>
                  <small>자동 분류 결과입니다. 필요하면 아래에서 직접 수정할 수 있습니다.</small>
                  <label>사람 수정값(JSON)
                    <textarea rows={5} value={assetCorrections} onChange={(event) => setAssetCorrections(event.target.value)} />
                  </label>
                  <button className="asset-review-button" onClick={() => void saveCorrections()}>사람 수정 저장</button>
                </div>
              )}
              <div className="inspector-rule" />
              <div className="inspector-meta">
                <span>원본 픽셀</span>
                <strong>{selected.upload_id ? '원본 hash 검증 대상' : '로컬 초안'}</strong>
                <span>권리 상태</span>
                <strong>{selected.rights_note?.trim() ? '권리 메모 있음' : '권리 메모 없음'}</strong>
                <span>이미지 생성 참고</span>
                <strong>{selectedCount}개 선택</strong>
              </div>
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
                      <input className="output-rights-note" placeholder="canonical 권리 메모" value={canonicalNote} onChange={(event) => setCanonicalNote(event.target.value)} />
                      <button className="output-review" disabled={!canonicalNote.trim()} onClick={async () => {
                        const result = await api<any>('/api/assistant/images/' + image.id + '/review', {
                          method: 'POST',
                          body: JSON.stringify({ status: 'APPROVED_CANONICAL', review_role: 'art_reference', note: canonicalNote }),
                        });
                        if (result.reviewed) setGenerated(await api<any[]>('/api/assistant/images'));
                      }}>canonical 승인</button>
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
function ReferenceCard({
  refCard,
  active,
  onClick,
  onToggle,
  style,
  onMove,
  onResize,
  selected,
  onSelect,
}: {
  refCard: RefCard;
  active: boolean;
  onClick: () => void;
  onToggle: () => void;
  style: React.CSSProperties;
  onMove: (x: number, y: number) => void;
  onResize: (width: number, height: number) => void;
  selected: boolean;
  onSelect: (multi: boolean) => void;
}) {
  const origin = useRef({ x: 0, y: 0, left: 0, top: 0 });
  return (
    <article className={'reference-card canvas-reference-card ' + (active ? 'active' : '') + (selected ? ' multi-selected' : '')} style={style} onClick={(event) => { if (event.shiftKey || event.metaKey || event.ctrlKey) onSelect(true); else { onSelect(false); onClick(); } }}>
      <button className="reference-drag-handle" aria-label="레퍼런스 이동" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); origin.current = { x: event.clientX, y: event.clientY, left: Number(style.left), top: Number(style.top) }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!event.buttons) return; onMove(Math.round((origin.current.left + event.clientX - origin.current.x) / 16) * 16, Math.round((origin.current.top + event.clientY - origin.current.y) / 16) * 16); }}>⠿ 이동</button>
      <img src={refCard.url} alt={refCard.name} />
      <div className="reference-card-foot">
        <div>
          <strong>{refCard.name}</strong>
          <span>
            {roleLabels[refCard.role]} · {usageLabels[refCard.usage]}
          </span>
        </div>
        <button
          className={refCard.selected ? 'checked' : ''}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          aria-label="생성 레퍼런스 선택"
        >
          {refCard.selected ? '✓' : '○'}
        </button>
      </div>
      <button className="reference-select" aria-label="다중 선택" aria-pressed={selected} onClick={(event) => { event.stopPropagation(); onSelect(true); }}>□</button>
      <button className="reference-resize" aria-label="레퍼런스 크기 조절" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); const start = { x: event.clientX, width: Number(style.width), height: Number(style.height) }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.onpointermove = (next) => { const width = Math.max(160, start.width + next.clientX - start.x); const height = Math.max(140, start.height + next.clientX - start.x); const element = (next.currentTarget as HTMLElement).closest('.reference-card') as HTMLElement | null; if (element) { element.style.width = width + 'px'; element.style.height = height + 'px'; } }; event.currentTarget.onpointerup = (next) => { const width = Math.max(160, start.width + next.clientX - start.x); const height = Math.max(140, start.height + next.clientX - start.x); onResize(width, height); event.currentTarget.onpointermove = null; event.currentTarget.onpointerup = null; }; }}>↘</button>
    </article>
  );
}

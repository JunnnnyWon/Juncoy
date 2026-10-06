import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';

type Role =
  'face_shape' | 'modeling_language' | 'material_surface' | 'texture' | 'lighting' | 'mood';
type Usage =
  'MUST_FOLLOW' | 'STRONG_REFERENCE' | 'MOOD_ONLY' | 'PARTIAL_REFERENCE' | 'REVIEW_REQUIRED';
interface RefCard {
  id: string;
  upload_id?: string;
  art_asset_id?: string;
  canonical_state?: string;
  name: string;
  url: string;
  role: Role;
  usage: Usage;
  note: string;
  selected: boolean;
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
export function ArtReferenceCanvas() {
  const [refs, setRefs] = useState<RefCard[]>([]);
  const [selectedId, setSelectedId] = useState('ref-1');
  const [boardId, setBoardId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [syncState, setSyncState] = useState('로컬 초안');
  const [brief, setBrief] = useState<any>(null);
  const [generated, setGenerated] = useState<any[]>([]);
  const [analysis, setAnalysis] = useState<any>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [assetAnalysis, setAssetAnalysis] = useState<any>(null);
  const [assetAnalysisBusy, setAssetAnalysisBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = refs.find((ref) => ref.id === selectedId) ?? refs[0];
  const selectedCount = useMemo(() => refs.filter((ref) => ref.selected).length, [refs]);
  useEffect(() => {
    setAssetAnalysis(null);
  }, [selectedId]);
  useEffect(() => {
    void (async () => {
      try {
        const boards = await api<any[]>('/api/assistant/art-boards');
        if (boards[0]) {
          setBoardId(boards[0].id);
          setRevision(Number(boards[0].current_revision ?? 0));
          const detail = await api<any>('/api/assistant/art-boards/' + boards[0].id);
          const saved = detail.revision?.snapshot?.references;
          if (Array.isArray(saved)) setRefs(saved);
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
        }
        setSyncState('서버에 연결됨');
        setGenerated(await api<any[]>('/api/assistant/images'));
      } catch {
        setSyncState('로컬 초안');
      }
    })();
  }, []);
  const saveRevision = async () => {
    if (!boardId) return;
    setSyncState('저장 중');
    try {
      const result = await api<{ revision: number }>(
        '/api/assistant/art-boards/' + boardId + '/revisions',
        {
          method: 'POST',
          body: JSON.stringify({ base_revision: revision, snapshot: { references: refs, viewport: { ...pan, zoom } } }),
        },
      );
      setRevision(Number(result.revision));
      setSyncState('서버에 저장됨');
    } catch {
      setSyncState('충돌 확인 필요');
    }
  };
  const previewBrief = async () => {
    if (!boardId) return;
    setSyncState('저장 중');
    let savedRevision = revision;
    try {
      const saved = await api<{ revision: number }>(
        '/api/assistant/art-boards/' + boardId + '/revisions',
        { method: 'POST', body: JSON.stringify({ base_revision: revision, snapshot: { references: refs, viewport: { ...pan, zoom } } }) },
      );
      savedRevision = Number(saved.revision);
      setRevision(savedRevision);
      setSyncState('서버에 저장됨');
    } catch {
      setSyncState('저장 충돌');
      window.alert('보드가 저장되지 않았습니다. 최신 revision을 다시 불러온 뒤 시도해 주세요.');
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
    } catch {
      window.alert('ImageBrief 미리보기를 만들 수 없습니다.');
    }
  };
  const analyzeBoard = async () => {
    if (!boardId || !revision || analysisBusy) return;
    setAnalysisBusy(true);
    try {
      setAnalysis(await api<any>('/api/assistant/art-boards/' + boardId + '/analyze', { method: 'POST' }));
    } catch {
      window.alert('보드 분석을 시작할 수 없습니다.');
    } finally {
      setAnalysisBusy(false);
    }
  };
  const analyzeSelectedAsset = async () => {
    if (!selected?.art_asset_id || assetAnalysisBusy) return;
    setAssetAnalysisBusy(true);
    try {
      const result = await api<any>('/api/assistant/art-assets/' + selected.art_asset_id + '/analyze', { method: 'POST' });
      setAssetAnalysis(result);
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
            role: 'mood' as Role,
            usage: 'REVIEW_REQUIRED' as Usage,
            note: '새 레퍼런스. 분석 전 검토 필요',
            selected: false,
          };
        }),
    );
    setRefs((current) => [...next, ...current]);
    if (next[0]) setSelectedId(next[0].id);
  };
  const update = (patch: Partial<RefCard>) =>
    setRefs((current) =>
      current.map((ref) => (ref.id === selected?.id ? { ...ref, ...patch } : ref)),
    );
  return (
    <div className="art-workspace">
      <header className="art-header">
        <div>
          <span className="eyebrow">ART DIRECTION / BOARD 01</span>
          <h1>비주얼 레퍼런스 보드</h1>
          <p>반실사 얼굴 · 오래된 PC 호러 게임의 모델링 언어 · 실사 기반 재질</p>
        </div>
        <div className="art-header-actions">
          <span className="save-state">
            <i /> {syncState}
          </span>
          <div className="art-header-buttons">
            <button className="secondary-button" onClick={() => void analyzeBoard()} disabled={analysisBusy}>
              {analysisBusy ? '분석 중…' : '보드 분석'}
            </button>
            <button className="primary-button" onClick={() => void previewBrief()}>
              ImageBrief 미리보기 ↗
            </button>
          </div>
        </div>
      </header>
      <div className="art-toolbar">
        <button className="art-tool active">↖ 선택</button>
        <button className="art-tool">▧ 프레임</button>
        <button className="art-tool">T 메모</button>
        <button className="art-tool">↗ 연결</button>
        <span className="toolbar-rule" />
        <button className="art-tool" onClick={() => inputRef.current?.click()}>
          ＋ 이미지 추가
        </button>
        <span className="toolbar-spacer" />
        <button className="art-tool viewport-button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>−</button>
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
        <button className="art-tool viewport-button" onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}>＋</button>
        <button className="art-tool" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>맞춤 보기</button>
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
        <section
          className="art-board"
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
            if ((event.target as HTMLElement).closest('.reference-card, button, input, select, textarea')) return;
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
            <strong>{boardId ? '보드 revision ' + revision : '서버 연결 중'}</strong>
          </div>
          <div className="board-stage" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {refs.length === 0 && (
            <div className="art-empty-state">
              <span className="eyebrow">REFERENCE BOARD</span>
              <h2>팀의 시각 언어를 이곳에 모아보세요</h2>
              <p>PNG, JPEG, WEBP 원본은 그대로 보존되고, 검토한 레퍼런스만 ImageBrief에 포함됩니다.</p>
              <button className="primary-button" onClick={() => inputRef.current?.click()}>첫 레퍼런스 추가</button>
            </div>
          )}
          {refs.length > 0 && <div className="art-frame frame-character">
            <div className="frame-title">01 / CHARACTER LANGUAGE</div>
            <div className="ref-grid">
              {refs.slice(0, 2).map((ref) => (
                <ReferenceCard
                  key={ref.id}
                  refCard={ref}
                  active={ref.id === selectedId}
                  onClick={() => setSelectedId(ref.id)}
                  onToggle={() =>
                    setRefs((current) =>
                      current.map((item) =>
                        item.id === ref.id ? { ...item, selected: !item.selected } : item,
                      ),
                    )
                  }
                />
              ))}
            </div>
          </div>}
          {refs.length > 2 && <div className="art-frame frame-environment">
            <div className="frame-title">02 / SURFACE + ATMOSPHERE</div>
            <div className="ref-grid single">
              {refs.slice(2).map((ref) => (
                <ReferenceCard
                  key={ref.id}
                  refCard={ref}
                  active={ref.id === selectedId}
                  onClick={() => setSelectedId(ref.id)}
                  onToggle={() =>
                    setRefs((current) =>
                      current.map((item) =>
                        item.id === ref.id ? { ...item, selected: !item.selected } : item,
                      ),
                    )
                  }
                />
              ))}
            </div>
          </div>}
          </div>
        </section>
        <aside className="art-inspector">
          {brief && (
            <div className="brief-card">
              <span className="eyebrow">IMAGEBRIEF / DRAFT</span>
              <strong>{brief.request}</strong>
              <p>{brief.instructions || '선택된 레퍼런스가 없습니다.'}</p>
              <small className="brief-meta">
                {brief.style_approved ? 'Art Bible v' + brief.style_version + ' 적용' : '승인된 Art Bible 없음'}
                {' · '}레퍼런스 {brief.reference_upload_ids?.length ?? 0}개
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
                    } catch {
                      setBrief({ ...brief, generation_error: true });
                    }
                  }}
                >
                  {brief.generated ? '생성 작업 완료' : '승인하고 생성'}
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
                  <span className="eyebrow">ART BIBLE / DRAFT</span>
                  <h3>보드 분석 초안</h3>
                </div>
                <span>DRAFT</span>
              </div>
              <p>{analysis.result?.summary}</p>
              {analysis.status === 'DRAFT' && (
                <button
                  className="secondary-button"
                  onClick={async () => {
                    try {
                      const approved = await api<any>('/api/assistant/art-boards/' + boardId + '/analysis/' + revision + '/approve', {
                        method: 'POST',
                        body: JSON.stringify({ analysis_id: analysis.id }),
                      });
                      setAnalysis({ ...analysis, status: 'APPROVED', style_version: approved.version });
                    } catch {
                      window.alert('Art Bible 승인에 실패했습니다.');
                    }
                  }}
                >
                  이 분석을 Art Bible로 승인
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
              <span className="eyebrow">REFERENCE INSPECTOR</span>
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
                  {Object.entries(roleLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
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
                {assetAnalysisBusy ? 'Gemini 분석 중…' : selected.art_asset_id ? 'Gemini로 이미지 분석' : '서버 업로드 후 분석 가능'}
              </button>
              {selected.art_asset_id && (
                <div className="asset-review-row">
                  <span>자산 상태: {selected.canonical_state ?? 'NONE'}</span>
                  {selected.canonical_state !== 'APPROVED_CANONICAL' && (
                    <button
                      className="asset-review-button"
                      onClick={async () => {
                        const result = await api<any>('/api/assistant/art-assets/' + selected.art_asset_id + '/canonical-review', {
                          method: 'POST',
                          body: JSON.stringify({ state: 'APPROVED_CANONICAL' }),
                        });
                        if (result.reviewed) update({ canonical_state: result.canonical_state });
                      }}
                    >
                      canonical 승인
                    </button>
                  )}
                </div>
              )}
              {assetAnalysis && selected.art_asset_id && (
                <div className="asset-observation-card">
                  <span className="eyebrow">VISION OBSERVATION / DRAFT</span>
                  <p>{assetAnalysis.observations?.description}</p>
                  <div>
                    {(assetAnalysis.observations?.materials ?? []).slice(0, 4).map((item: string) => <span key={item}>{item}</span>)}
                    {(assetAnalysis.observations?.palette ?? []).slice(0, 4).map((item: string) => <span key={item}>{item}</span>)}
                  </div>
                  <small>AI 관찰은 초안이며 Art Bible 규칙이나 canonical 자산이 아닙니다.</small>
                </div>
              )}
              <div className="inspector-rule" />
              <div className="inspector-meta">
                <span>원본 픽셀</span>
                <strong>보존됨</strong>
                <span>권리 상태</span>
                <strong>팀 검토 필요</strong>
                <span>ImageBrief 포함</span>
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
                      <button className="output-review" onClick={async () => {
                        const result = await api<any>('/api/assistant/images/' + image.id + '/review', {
                          method: 'POST',
                          body: JSON.stringify({ status: 'APPROVED_CANONICAL', review_role: 'art_reference' }),
                        });
                        if (result.reviewed) setGenerated(await api<any[]>('/api/assistant/images'));
                      }}>canonical 승인</button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="output-empty">아직 생성된 결과가 없습니다. ImageBrief를 승인하면 이곳에 표시됩니다.</p>
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
}: {
  refCard: RefCard;
  active: boolean;
  onClick: () => void;
  onToggle: () => void;
}) {
  return (
    <article className={'reference-card ' + (active ? 'active' : '')} onClick={onClick}>
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
    </article>
  );
}

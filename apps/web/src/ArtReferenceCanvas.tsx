import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';

type Role =
  'face_shape' | 'modeling_language' | 'material_surface' | 'texture' | 'lighting' | 'mood';
type Usage =
  'MUST_FOLLOW' | 'STRONG_REFERENCE' | 'MOOD_ONLY' | 'PARTIAL_REFERENCE' | 'REVIEW_REQUIRED';
interface RefCard {
  id: string;
  upload_id?: string;
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
const demoRefs: RefCard[] = [
  {
    id: 'ref-1',
    name: '복도 / 습기 표면',
    url: '/generated/banli-image.png',
    role: 'material_surface',
    usage: 'STRONG_REFERENCE',
    note: '벽면의 습기와 페인트 손상만 참고',
    selected: true,
  },
  {
    id: 'ref-2',
    name: '인물 얼굴 비율',
    url: '/generated/banli-image.png',
    role: 'face_shape',
    usage: 'PARTIAL_REFERENCE',
    note: '얼굴 형태만. 의상과 배경은 제외',
    selected: true,
  },
  {
    id: 'ref-3',
    name: '구형 호러 게임 감성',
    url: '/generated/banli-image.png',
    role: 'modeling_language',
    usage: 'MOOD_ONLY',
    note: '기하학과 시대감만 참고',
    selected: false,
  },
];

export function ArtReferenceCanvas() {
  const [refs, setRefs] = useState<RefCard[]>(demoRefs);
  const [selectedId, setSelectedId] = useState('ref-1');
  const [boardId, setBoardId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [syncState, setSyncState] = useState('로컬 초안');
  const [brief, setBrief] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = refs.find((ref) => ref.id === selectedId) ?? refs[0];
  const selectedCount = useMemo(() => refs.filter((ref) => ref.selected).length, [refs]);
  useEffect(() => {
    void (async () => {
      try {
        const boards = await api<any[]>('/api/assistant/art-boards');
        if (boards[0]) {
          setBoardId(boards[0].id);
          setRevision(Number(boards[0].current_revision ?? 0));
          const detail = await api<any>('/api/assistant/art-boards/' + boards[0].id);
          const saved = detail.revision?.snapshot?.references;
          if (Array.isArray(saved) && saved.length) setRefs(saved);
        } else {
          const created = await api<{ id: string }>('/api/assistant/art-boards', {
            method: 'POST',
            body: JSON.stringify({ name: '비주얼 레퍼런스 보드' }),
          });
          setBoardId(created.id);
        }
        setSyncState('서버에 연결됨');
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
          body: JSON.stringify({ base_revision: revision, snapshot: { references: refs } }),
        },
      );
      setRevision(result.revision);
      setSyncState('자동 저장됨');
    } catch {
      setSyncState('충돌 확인 필요');
    }
  };
  const previewBrief = async () => {
    if (!boardId) return;
    await saveRevision();
    try {
      const brief = await api<any>(
        '/api/assistant/art-boards/' + boardId + '/image-briefs/preview',
        {
          method: 'POST',
          body: JSON.stringify({
            request: '현재 보드 기준 캐릭터 컨셉 아트',
            revision: revision + 1,
          }),
        },
      );
      setBrief(brief);
    } catch {
      window.alert('ImageBrief 미리보기를 만들 수 없습니다.');
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
          } catch {
            /* local draft remains usable when API is unavailable */
          }
          return {
            id: file.name + '-' + file.lastModified + '-' + index,
            upload_id,
            name: file.name,
            url: URL.createObjectURL(file),
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
          <button className="primary-button" onClick={() => void previewBrief()}>
            ImageBrief 미리보기 ↗
          </button>
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
        >
          <div className="board-grid" />
          <div className="board-label">
            <span>CHARACTER / ENVIRONMENT</span>
            <strong>Draft board · revision 04</strong>
          </div>
          <div className="art-frame frame-character">
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
          </div>
          <div className="art-frame frame-environment">
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
          </div>
        </section>
        <aside className="art-inspector">
          {brief && (
            <div className="brief-card">
              <span className="eyebrow">IMAGEBRIEF / DRAFT</span>
              <strong>{brief.request}</strong>
              <p>{brief.instructions || '선택된 레퍼런스가 없습니다.'}</p>
              {brief.approval_id ? (
                <button
                  className="primary-button"
                  onClick={async () => {
                    try {
                      await api('/api/assistant/images/generate', {
                        method: 'POST',
                        body: JSON.stringify({ approval_id: brief.approval_id }),
                      });
                      setBrief({ ...brief, generated: true });
                    } catch {
                      setBrief({ ...brief, generation_error: true });
                    }
                  }}
                >
                  {brief.generated ? '생성 요청 완료' : '승인하고 생성'}
                </button>
              ) : (
                <small>
                  이미지 provider가 꺼져 있거나 editor 권한이 없어 prompt-only 상태입니다.
                </small>
              )}
              {brief.generation_error && (
                <small className="brief-error">생성 요청을 처리하지 못했습니다.</small>
              )}
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

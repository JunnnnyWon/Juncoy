import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

// 웹 어시스턴트 — spec §7: 대화/메시지/SSE 스트림 + 승인 카드 + 우측 일정·작업 패널.

interface Conv {
  id: string;
  title: string;
  updated_at: string;
}
interface Msg {
  id: string;
  run_id: string | null;
  role: string;
  content: string;
  attachments: any[];
  citations: any[];
  created_at: string;
}
interface Approval {
  id: string;
  kind: string;
  target: any;
  after: any;
  status: string;
  expires_at: string;
}
interface LiveRun {
  phase: string;
  status?: string;
  coverage?: any[];
  evidence: any[];
}

const STATUS_KO: Record<string, string> = {
  COMPLETE: '전체 확인 완료',
  PARTIAL: '부분 확인',
  NEEDS_CLARIFICATION: '추가 확인 필요',
  FAILED: '실패',
};
const PHASE_KO: Record<string, string> = {
  idle: '대기 중',
  planning_tool_call: '요청을 구조화하는 중',
  retrieving: '프로젝트 자료를 확인하는 중',
  checking_sources: '최신성을 확인하는 중',
  awaiting_approval: '승인을 기다리는 중',
  executing_tool: '작업을 실행하는 중',
  generating_image: '이미지를 생성하는 중',
  ingesting_file: '파일을 색인하는 중',
  completed: '완료',
  partial: '부분 완료',
  failed: '확인 필요',
};

export function Assistant() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [schedule, setSchedule] = useState<any[] | null>(null);
  const [tasks, setTasks] = useState<any[] | null>(null);
  const [panelTab, setPanelTab] = useState<'schedule' | 'tasks' | 'files' | 'images'>('schedule');
  const [files, setFiles] = useState<any[] | null>(null);
  const [images, setImages] = useState<any[] | null>(null);
  const [mobileSideOpen, setMobileSideOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const selectedFile = (files ?? []).find((file: any) => file.id === selectedFileId) ?? null;
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConvs = async () => {
    try {
      setConvs(await api<Conv[]>('/api/assistant/conversations'));
    } catch (e: any) {
      setError(
        e?.status === 503
          ? '어시스턴트가 비활성화되어 있습니다.'
          : '대화 목록을 불러오지 못했습니다.',
      );
    }
  };
  useEffect(() => void loadConvs(), []);

  const openConv = async (id: string) => {
    esRef.current?.close();
    setConvId(id);
    setLive(null);
    const r = await api<{ conversation: Conv; messages: Msg[]; pending_approvals: Approval[] }>(
      `/api/assistant/conversations/${id}`,
    );
    setMessages(r.messages);
    setApprovals(r.pending_approvals ?? []);
  };

  const newConv = async () => {
    const { id } = await api<{ id: string }>('/api/assistant/conversations', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadConvs();
    setMessages([]);
    setConvId(id);
  };

  const streamRun = (runId: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/assistant/runs/${runId}/stream`);
    esRef.current = es;
    const liveRun: LiveRun = { phase: 'idle', evidence: [] };
    setLive({ ...liveRun });
    es.onmessage = () => {};
    for (const kind of [
      'phase',
      'evidence',
      'coverage',
      'tool_call',
      'result',
      'error',
      'done',
      'approval',
    ]) {
      es.addEventListener(kind, (ev) => {
        const data = JSON.parse((ev as MessageEvent).data || '{}');
        if (kind === 'phase') liveRun.phase = data.phase;
        else if (kind === 'evidence') liveRun.evidence.push(data);
        else if (kind === 'coverage') liveRun.coverage = data.source_coverage;
        else if (kind === 'result') liveRun.status = data.status;
        else if (kind === 'error') liveRun.status = 'FAILED';
        else if (kind === 'approval' && convId)
          void api<{ pending_approvals: Approval[] }>(
            `/api/assistant/conversations/${convId}`,
          ).then((r) => setApprovals(r.pending_approvals ?? []));
        setLive({ ...liveRun, evidence: [...liveRun.evidence] });
        if (kind === 'done' || kind === 'result' || kind === 'error') {
          es.close();
          if (convId) void openConv(convId);
        }
      });
    }
    es.onerror = () => {
      es.close();
    };
  };

  const send = async () => {
    if (!input.trim() || !convId || busy) return;
    setBusy(true);
    try {
      const content = input.trim();
      const r = await api<{ run_id: string; message_id: string }>(
        `/api/assistant/conversations/${convId}/messages`,
        { method: 'POST', body: JSON.stringify({ content }) },
      );
      setInput('');
      setMessages((m) => [
        ...m,
        {
          id: r.message_id,
          run_id: r.run_id,
          role: 'user',
          content,
          attachments: [],
          citations: [],
          created_at: new Date().toISOString(),
        },
      ]);
      streamRun(r.run_id);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, approve: boolean) => {
    await api(`/api/assistant/approvals/${id}/${approve ? 'approve' : 'reject'}`, {
      method: 'POST',
    });
    setApprovals((a) => a.filter((x) => x.id !== id));
  };

  useEffect(() => {
    const path =
      panelTab === 'schedule'
        ? '/api/assistant/schedule'
        : panelTab === 'tasks'
          ? '/api/assistant/tasks'
          : panelTab === 'files'
            ? '/api/assistant/files'
            : '/api/assistant/images';
    const set =
      panelTab === 'schedule'
        ? setSchedule
        : panelTab === 'tasks'
          ? setTasks
          : panelTab === 'files'
            ? setFiles
            : setImages;
    api<any[]>(path)
      .then(set)
      .catch(() => set([]));
  }, [panelTab]);

  const uploadFile = async (f: File) => {
    const buf = await f.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    const sha = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const init = await api<{ id: string; storage_key: string; reused: boolean }>(
      '/api/assistant/files/init',
      {
        method: 'POST',
        body: JSON.stringify({ filename: f.name, mime: f.type, bytes: f.size, sha256: sha }),
      },
    );
    if (!init.reused) {
      await api(`/api/assistant/files/${init.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
    }
    setPanelTab('files');
    api<any[]>('/api/assistant/files')
      .then(setFiles)
      .catch(() => {});
  };

  const deleteFile = async (id: string) => {
    await api(`/api/assistant/files/${id}/delete-preview`, { method: 'POST' });
    const r = await api<{ pending_approvals: Approval[] }>(
      `/api/assistant/conversations/${convId}`,
    );
    setApprovals(r.pending_approvals ?? []);
  };
  const reparseFile = async (id: string) => {
    await api('/api/assistant/files/' + id + '/reparse', { method: 'POST' });
    const r = await api<any[]>('/api/assistant/files');
    setFiles(r);
  };
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, live]);
  useEffect(() => () => esRef.current?.close(), []);

  return (
    <div className="assistant workspace-assistant">
      <aside className="assistant-convs">
        <div className="assistant-rail-head">
          <div>
            <span className="eyebrow">JUNCOY / WORKSPACE</span>
            <h1>프로젝트 어시스턴트</h1>
          </div>
          <span className="live-dot" title="지식 연결 상태" />
        </div>
        <button className="primary-button assistant-new" onClick={() => void newConv()}>
          <span>+</span> 새 대화
        </button>
        <div className="assistant-nav-label">대화 기록</div>
        {convs.map((c) => (
          <button
            key={c.id}
            className={`conv-item ${c.id === convId ? 'active' : ''}`}
            onClick={() => void openConv(c.id)}
          >
            {c.title}
          </button>
        ))}
        {!convs.length && <p className="dim">대화가 없습니다.</p>}
      </aside>

      <section className="assistant-main">
        <div className="assistant-topbar">
          <div>
            <span className="eyebrow">PROJECT KNOWLEDGE / LIVE</span>
            <h2>
              {convId
                ? (convs.find((c) => c.id === convId)?.title ?? '새 대화')
                : '작업을 시작하세요'}
            </h2>
          </div>
          <div className="source-health">
            <span className="health-dot" /> 최신 소스 상태는 질문 결과에서 확인
          </div>
          <button className="assistant-mobile-panel-button" onClick={() => setMobileSideOpen((open) => !open)} aria-expanded={mobileSideOpen}>작업 패널</button>
        </div>
        {!convId ? (
          <div className="assistant-empty assistant-empty-rich">
            <div className="empty-orbit">AI</div>
            <span className="eyebrow">ASK THE PROJECT</span>
            <h2>
              프로젝트의 맥락을
              <br />한 곳에서 탐색하세요.
            </h2>
            <p>회의록, Discord, GitHub, Notion, 업로드 파일을 근거와 함께 확인합니다.</p>
            <div className="prompt-starters">
              <button
                onClick={() => {
                  setInput('최근 회의와 Discord에서 아트 방향에 합의된 내용을 정리해 줘.');
                  void newConv();
                }}
              >
                최근 아트 결정 요약
              </button>
              <button
                onClick={() => {
                  setInput('이번 주 작업 중 마감이 임박한 항목을 보여 줘.');
                  void newConv();
                }}
              >
                이번 주 작업 확인
              </button>
              <button
                onClick={() => {
                  setInput('이 프로젝트의 현재 비주얼 방향을 설명해 줘.');
                  void newConv();
                }}
              >
                비주얼 방향 탐색
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="assistant-msgs">
              {messages.map((m) => (
                <div key={m.id} className={`msg msg-${m.role}`}>
                  <div className="msg-body">{m.content}</div>
                </div>
              ))}
              {live && (
                <div className="msg msg-assistant">
                  <div className="run-phase">
                    상태: {PHASE_KO[live.phase] ?? live.phase}
                    {live.status && <strong> · {STATUS_KO[live.status] ?? live.status}</strong>}
                  </div>
                  {!!live.coverage?.length && (
                    <div className="coverage">
                      {live.coverage.map((c: any) => (
                        <span
                          key={c.source}
                          className={`chip ${c.read_status === 'LIVE_READ' ? 'ok' : 'warn'}`}
                        >
                          {c.source}{' '}
                          {c.read_status === 'LIVE_READ'
                            ? '✓'
                            : c.read_status === 'FAILED'
                              ? '✗'
                              : '–'}
                        </span>
                      ))}
                    </div>
                  )}
                  {!!live.evidence.length && (
                    <details className="evidence">
                      <summary>근거 {live.evidence.length}건</summary>
                      {live.evidence.map((e: any, i: number) => (
                        <a key={i} href={e.url} target="_blank" rel="noreferrer">
                          [{e.id}] {e.source} — {e.stable_key}
                        </a>
                      ))}
                    </details>
                  )}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
            {!!approvals.length && (
              <div className="approvals">
                {approvals.map((a) => (
                  <div key={a.id} className="approval-card">
                    <div className="approval-head">
                      {a.kind} · 만료 {new Date(a.expires_at).toLocaleTimeString('ko-KR')}
                    </div>
                    <pre>{JSON.stringify(a.after, null, 2)}</pre>
                    <div className="approval-actions">
                      <button className="primary-button" onClick={() => void decide(a.id, true)}>
                        승인
                      </button>
                      <button className="ghost-button" onClick={() => void decide(a.id, false)}>
                        거부
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="assistant-input">
              <button
                className="input-tool"
                onClick={() => {
                  setPanelTab('files');
                  fileInput.current?.click();
                }}
                aria-label="파일 추가"
                title="파일 추가"
              >
                +
              </button>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send()}
                placeholder="질문하거나 작업을 요청하세요…"
                aria-label="어시스턴트 입력"
              />
              <button
                className="primary-button"
                disabled={busy || !input.trim()}
                onClick={() => void send()}
              >
                보내기 <span>↗</span>
              </button>
            </div>
          </>
        )}
      </section>

      <aside className={`assistant-side ${mobileSideOpen ? 'mobile-open' : ''}`}>
        <div className="assistant-inspector-head">
          <div>
            <span className="eyebrow">PROJECT SIGNALS</span>
            <h2>작업 패널</h2>
          </div>
          <button className="inspector-more" aria-label="패널 설정">
            •••
          </button>
        </div>
        <div className="side-tabs">
          <button
            className={panelTab === 'schedule' ? 'active' : ''}
            onClick={() => setPanelTab('schedule')}
          >
            일정
          </button>
          <button
            className={panelTab === 'tasks' ? 'active' : ''}
            onClick={() => setPanelTab('tasks')}
          >
            작업
          </button>
          <button
            className={panelTab === 'files' ? 'active' : ''}
            onClick={() => setPanelTab('files')}
          >
            파일
          </button>
          <button
            className={panelTab === 'images' ? 'active' : ''}
            onClick={() => setPanelTab('images')}
          >
            이미지
          </button>
        </div>
        {panelTab === 'files' && (
          <>
            <button className="primary-button" onClick={() => fileInput.current?.click()}>
              레퍼런스 / 파일 추가
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".pdf,.docx,.csv,.md,.txt,.png,.jpg,.jpeg,.webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadFile(f);
                e.target.value = '';
              }}
            />
            <div className="drop-zone" onClick={() => fileInput.current?.click()}>
              <strong>파일을 놓거나 클릭해서 추가</strong>
              <span>PDF · DOCX · PNG · JPG · WEBP</span>
            </div>
            {(files ?? []).map((f: any) => (
            <div key={f.id} className={`file-row ${selectedFileId === f.id ? 'active' : ''}`} onClick={() => setSelectedFileId(f.id)}>
              <div className="file-row-main"><strong>{f.filename}</strong><span>{(f.bytes / 1024).toFixed(0)}KB · {f.mime}</span></div>
              <div className="file-state-stack"><span className={`state-badge state-${String(f.state ?? '').toLowerCase()}`}>업로드 {f.state}</span><span className={`state-badge state-${String(f.parse_status ?? 'NOT_REQUESTED').toLowerCase()}`}>Parse {f.parse_status ?? '미요청'}</span><span className={`state-badge state-${String(f.document_state ?? '').toLowerCase()}`}>색인 {f.document_state ?? f.state}</span></div>
              <span className="file-chevron">›</span>
            </div>
            ))}
            {selectedFile && <div className="file-detail"><div className="file-detail-head"><div><span className="eyebrow">FILE INSPECTOR</span><h3>{selectedFile.filename}</h3></div><button className="icon-button" aria-label="파일 상세 닫기" onClick={() => setSelectedFileId(null)}>×</button></div><dl><dt>원본 SHA-256</dt><dd>{selectedFile.sha256}</dd><dt>Parser</dt><dd>{selectedFile.parser_kind ?? '미요청'} · {selectedFile.parser_version ?? '-'}</dd><dt>처리 상태</dt><dd>{selectedFile.parse_status ?? 'NOT_REQUESTED'} · {selectedFile.document_state ?? selectedFile.state}</dd><dt>Cache</dt><dd>{selectedFile.cache_hit ? 'HIT' : 'MISS / 없음'}</dd><dt>원본 검증</dt><dd>{selectedFile.original_verified_at ? new Date(selectedFile.original_verified_at).toLocaleString('ko-KR') : '아직 검증되지 않음'}</dd></dl><div className="file-detail-actions">{selectedFile.mime === 'application/pdf' && selectedFile.document_id && <button className="secondary-button" onClick={() => void reparseFile(selectedFile.id)}>Parse 재처리</button>}<button className="ghost-button" onClick={() => void deleteFile(selectedFile.id)}>삭제 승인 만들기</button></div></div>}
          </>
        )}
        {panelTab === 'images' && (
          <div className="gallery">
            {(images ?? []).map((im: any) => (
              <div key={im.id} className="image-result-row"><a
                href={`/api/assistant/images/${im.id}`}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={`/api/assistant/images/${im.id}`}
                  alt={im.prompt?.slice(0, 80)}
                  loading="lazy"
                />
              </a><div className="image-result-meta"><strong>{im.review_status ?? 'DRAFT'}</strong><span>{im.model} · {im.mime ?? 'image/png'}</span><span>{im.bytes ? `${Math.round(im.bytes / 1024)}KB` : 'size unknown'} · hash {im.sha256 ? im.sha256.slice(0, 12) : 'unknown'}</span><span>{im.review_status === 'APPROVED_CANONICAL' ? 'canonical 재사용 가능' : 'canonical 승인 전 · 자동 검색 제외'}</span></div></div>
            ))}
            {images && !images.length && <p className="dim">생성된 이미지가 없습니다.</p>}
          </div>
        )}
        {(panelTab === 'schedule' || panelTab === 'tasks') &&
          ((panelTab === 'schedule' ? schedule : tasks)?.map((row: any) => (
            <div key={row.id} className="side-row">
              <div className="side-row-title">{row['이름'] ?? row['작업명'] ?? row.id}</div>
              <div className="dim">
                {row['날짜']?.start ?? '날짜 없음'} · {row['상태'] ?? '-'} ·{' '}
                {(row['담당자'] ?? []).join(', ') || '-'}
              </div>
            </div>
          )) ?? <p className="dim">항목이 없습니다.</p>)}
      </aside>
      {error && (
        <div className="toast" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

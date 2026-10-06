import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react';
import {
  Routes,
  Route,
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  Waveform,
  Notebook,
  Users,
  LockSimple,
  ArrowUpRight,
  ArrowLeft,
  ArrowDown,
  DownloadSimple,
  MagnifyingGlass,
  Hash,
  CheckCircle,
  LinkSimple,
  CaretRight,
  Microphone,
  SignOut,
  FileText,
  Clock,
  WarningCircle,
  ArrowsClockwise,
  ChatCircleText,
  List,
  X,
} from '@phosphor-icons/react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { compareSegments } from '@meeting/domain';
import type {
  MeetingViewDTO,
  SegmentDTO,
  ParticipantDTO,
  GapDTO,
  SummaryResultDTO,
} from '@meeting/contracts';
import { api, ApiError } from './api';
import { Assistant } from './Assistant.tsx';
import { useMeeting } from './use-meeting';
import { AudioText } from './AudioText';
interface Me {
  user_id: string;
  display_name: string;
  mode: 'mock' | 'real';
}
const statuses: Record<string, string> = {
  STARTING: '시작 준비',
  RECORDING: '기록 중',
  PAUSED: '일시정지',
  DEGRADED: '수신 장애',
  STOPPING: '전사 마감',
  FINALIZING: '요약 중',
  COMPLETED: '완료',
  PARTIAL: '부분 기록',
  FAILED: '확인 필요',
};
const ongoing = (status: string) =>
  ['STARTING', 'RECORDING', 'PAUSED', 'DEGRADED', 'STOPPING'].includes(status);
const clock = (ms: number) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 3600)
    .toString()
    .padStart(
      2,
      '0',
    )}:${Math.floor(seconds / 60) % 60 < 10 ? '0' : ''}${Math.floor(seconds / 60) % 60}:${(seconds % 60).toString().padStart(2, '0')}`;
};
const date = (at: string | null) =>
  at
    ? new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        month: 'long',
        day: 'numeric',
        weekday: 'short',
      }).format(new Date(at))
    : '시작 준비 중';
const palette = ['sage', 'blue', 'rose', 'sand', 'lavender', 'teal'];
function Avatar({ name, id, size = '' }: { name: string; id: string; size?: string }) {
  return (
    <span aria-hidden className={`avatar ${palette[Number(BigInt(id) % 6n)]} ${size}`}>
      {name.slice(0, 1)}
    </span>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status.toLowerCase()}`}>
      <span className="status-dot" />
      {statuses[status] ?? status}
    </span>
  );
}
function Empty({
  title,
  children,
  icon = <Notebook size={32} />,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}
export function App() {
  const [me, setMe] = useState<Me | null>(null),
    [loaded, setLoaded] = useState(false),
    [accessError, setAccessError] = useState('');
  const location = useLocation();
  useEffect(() => {
    let active = true,
      busy = false;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await api<Me>('/api/me', { signal: AbortSignal.timeout(8000) });
        if (active) {
          setMe(value);
          setAccessError('');
        }
      } catch (error) {
        if (active) {
          setMe(null);
          setAccessError(
            error instanceof ApiError && error.status === 401
              ? ''
              : error instanceof ApiError && error.status === 403
                ? '23시 정시퇴근에 연결된 Discord 서버 구성원만 이용할 수 있습니다.'
                : 'Discord 멤버십을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
          );
        }
      } finally {
        busy = false;
        if (active) setLoaded(true);
      }
    };
    void check();
    const timer = setInterval(() => void check(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [location.pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        const input = document.querySelector<HTMLInputElement>('input[aria-label*=검색]');
        if (input) {
          event.preventDefault();
          input.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    setMe(null);
    window.location.assign('/login');
  };
  if (!loaded)
    return (
      <div className="boot">
        <Waveform size={36} />
        <p>회의 기록을 불러오고 있어요.</p>
      </div>
    );
  if (!me) return <Login error={accessError} />;
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/meetings" className="brand" aria-label="23시 정시퇴근 회의록">
          <span className="brand-icon">
            <Waveform size={21} weight="bold" />
          </span>
          <span>23시 정시퇴근 회의록</span>
        </Link>
        <nav className="app-nav">
          <Link to="/meetings">회의</Link>
          <Link to="/ask">질문</Link>
          <Link to="/assistant">어시스턴트</Link>
        </nav>
        <div className="account">
          <Avatar name={me.display_name} id={me.user_id} />
          <div>
            {me.display_name}
            <small>{me.mode === 'mock' ? '데모' : '23시 정시퇴근 구성원'}</small>
          </div>
          <button className="icon-button" aria-label="로그아웃" onClick={() => void logout()}>
            <SignOut />
          </button>
        </div>
      </header>
      <main className="main-shell">
        {me.mode === 'mock' && (
          <div className="demo-banner">
            <span>데모</span>예시 데이터로 작동하는 데모입니다. 실제 회의나 API 사용량이 아닙니다.
          </div>
        )}
        <Routes>
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/meetings/:id" element={<Meeting />} />
          <Route path="/ask" element={<KnowledgeAsk />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="*" element={<Navigate to="/meetings" replace />} />
        </Routes>
      </main>
    </div>
  );
}
function Login({ error = '' }: { error?: string }) {
  const location = useLocation();
  const back = location.pathname.startsWith('/meetings')
    ? location.pathname + location.search
    : '/meetings';
  return (
    <main className="login">
      <div className="login-inner">
        <div className="brand">
          <span className="brand-icon">
            <Waveform size={24} weight="bold" />
          </span>
          23시 정시퇴근
        </div>
        {(error || location.search.includes('access=')) && (
          <p role="alert">
            {error ||
              (location.search.includes('access=denied')
                ? '23시 정시퇴근에 연결된 Discord 서버 구성원만 이용할 수 있습니다.'
                : 'Discord 멤버십을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.')}
          </p>
        )}
        <h1>23시 정시퇴근 회의록</h1>
        <p>팀의 회의 내용과 결정사항을 확인하세요.</p>
        <a className="primary-button" href={'/auth/discord?return_to=' + encodeURIComponent(back)}>
          <ChatCircleText weight="fill" />
          Discord로 계속하기
          <ArrowUpRight size={17} />
        </a>
        <div className="login-privacy">
          <LockSimple size={15} />
          23시 정시퇴근에 연결된 Discord 서버 구성원만 이용할 수 있습니다.
        </div>
      </div>
      <div className="login-visual" aria-hidden>
        <div className="visual-label">
          <Waveform />
          대화의 흐름을 그대로
        </div>
        <div className="soundline">
          {Array.from({ length: 42 }, (_, i) => (
            <span
              key={i}
              style={{ height: 20 + Math.abs(Math.sin(i * 1.9) * Math.cos(i * 0.37)) * 130 }}
            />
          ))}
        </div>
        <div className="visual-caption">
          발언을 기록하고
          <br />
          <strong>맥락을 연결합니다.</strong>
        </div>
        <div className="visual-bottom">전사 · 결정사항 · 다음 할 일</div>
      </div>
    </main>
  );
}
function Meetings() {
  const [meetings, setMeetings] = useState<MeetingViewDTO[]>([]),
    [q, setQ] = useState(''),
    [filter, setFilter] = useState('all'),
    [dateFilter, setDateFilter] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [cursor, setCursor] = useState<string | null>(null);
  const generation = useRef(0);
  const load = async (more = false) => {
    const g = more ? generation.current : ++generation.current;
    setLoading(true);
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (dateFilter) query.set('date', dateFilter);
    if (filter === 'completed') query.set('status', 'COMPLETED');
    if (more && cursor) query.set('cursor', cursor);
    try {
      const result = await api<{ meetings: MeetingViewDTO[]; next_cursor: string | null }>(
        '/api/meetings?' + query,
      );
      if (g !== generation.current) return;
      setMeetings((xs) => (more ? [...xs, ...result.meetings] : result.meetings));
      setCursor(result.next_cursor);
      setError(null);
    } catch (e) {
      if (g === generation.current)
        setError(e instanceof ApiError ? e.message : '기록을 불러오지 못했습니다.');
    } finally {
      if (g === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [q, dateFilter, filter]);
  const active = meetings.filter((m) => ongoing(m.status));
  return (
    <>
      <div className="topbar">
        <span>
          <Notebook size={17} />
          23시 정시퇴근 회의록
        </span>
        <span className="private-label">
          <LockSimple size={14} />팀 전용
        </span>
      </div>
      <div className="list-page">
        <header className="page-heading">
          <div>
            <h1>모든 회의</h1>
            <p>회의 내용과 결정사항을 찾아보세요.</p>
          </div>
          <span className="small-note">
            <Microphone size={17} />
            회의 시작은 Discord에서
          </span>
        </header>
        {active.length > 0 && (
          <Link to={'/meetings/' + active[0]!.meeting_id} className="live-meeting">
            <div className="live-symbol">
              <Waveform size={26} />
            </div>
            <div>
              <Status status={active[0]!.status} />
              <h2>{active[0]!.title}</h2>
              <span>
                <Hash size={14} />
                {active[0]!.voice_channel_name} · 지금 진행 중인 회의
              </span>
            </div>
            <span className="join-record">
              실시간 기록 보기 <ArrowUpRight size={20} />
            </span>
          </Link>
        )}
        <div className="list-toolbar">
          <div className="filter-tabs">
            <button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>
              전체 기록
            </button>
            <button
              className={filter === 'completed' ? 'selected' : ''}
              onClick={() => setFilter('completed')}
            >
              완료된 회의
            </button>
          </div>
          <div className="list-tools">
            <label className="search-box">
              <MagnifyingGlass size={18} />
              <input
                aria-label="회의 검색"
                placeholder="회의 제목 검색"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <input
              type="date"
              aria-label="회의 날짜"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
            />
          </div>
        </div>
        {error ? (
          <Empty title="기록을 불러오지 못했습니다" icon={<WarningCircle size={30} />}>
            <p>{error}</p>
            <button onClick={() => void load()}>다시 시도</button>
          </Empty>
        ) : !meetings.length && !loading ? (
          <Empty
            title={
              q || dateFilter || filter !== 'all'
                ? '검색 결과가 없습니다.'
                : '아직 회의록이 없습니다.'
            }
          >
            <p>
              {q || dateFilter || filter !== 'all'
                ? '검색어나 날짜·상태 필터를 변경해 보세요.'
                : 'Discord에서 /회의 시작을 사용하면 이곳에 기록됩니다.'}
            </p>
          </Empty>
        ) : (
          <div className="meeting-list">
            <div className="list-columns">
              <span>회의</span>
              <span>상태</span>
              <span>날짜</span>
              <span />
            </div>
            {meetings.map((m) => (
              <Link
                className="meeting-list-row"
                key={m.meeting_id}
                to={'/meetings/' + m.meeting_id}
              >
                <span className="meeting-list-title">
                  <span className="document-icon">
                    <FileText size={21} />
                  </span>
                  <span>
                    <strong>{m.title}</strong>
                    <small>
                      <Hash size={12} />
                      {m.voice_channel_name}
                    </small>
                  </span>
                </span>
                <Status status={m.status} />
                <span className="row-date">{date(m.started_at)}</span>
                <ArrowUpRight size={18} />
              </Link>
            ))}
          </div>
        )}
        {loading && <p className="loading-line">기록을 불러오는 중…</p>}
        {cursor && (
          <button className="load-more" onClick={() => void load(true)}>
            이전 회의 더 보기
          </button>
        )}
      </div>
    </>
  );
}
function Meeting() {
  const { id = '' } = useParams(),
    [params, setParams] = useSearchParams();
  const data = useMeeting(id);
  const [speaker, setSpeaker] = useState(''),
    [query, setQuery] = useState(''),
    [searchResults, setSearchResults] = useState<SegmentDTO[] | null>(null),
    [searchCursor, setSearchCursor] = useState<string | null>(null),
    [searchBusy, setSearchBusy] = useState(false),
    [filteredPrepended, setFilteredPrepended] = useState(0),
    [evidence, setEvidence] = useState<{
      segment: SegmentDTO;
      context: SegmentDTO[];
      replacement_ids: string[];
      transcript_version: number;
    } | null>(null),
    [toast, setToast] = useState(''),
    [atBottom, setAtBottom] = useState(true),
    [now, setNow] = useState(Date.now());
  const virtuoso = useRef<VirtuosoHandle>(null);
  const searchGeneration = useRef(0);
  const m = data.state?.snapshot.meeting;
  const selectedTab =
    params.get('tab') === 'summary'
      ? 'summary'
      : params.get('tab') === 'transcript'
        ? 'transcript'
        : m && ongoing(m.status)
          ? 'transcript'
          : 'summary';
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    setEvidence(null);
    setQuery('');
    setSpeaker('');
    setSearchResults(null);
  }, [id]);
  useEffect(() => {
    const segment = params.get('segment');
    if (!segment || !m) return;
    let active = true;
    const q = new URLSearchParams();
    const v = params.get('transcript_version');
    if (v) q.set('transcript_version', v);
    void api<any>(`/api/meetings/${id}/segments/${segment}?${q}`)
      .then((result) => {
        if (active) setEvidence(result);
      })
      .catch(() => {
        if (active) setToast('근거 발언을 불러오지 못했습니다.');
      });
    return () => {
      active = false;
    };
  }, [id, params.get('segment'), params.get('transcript_version'), !!m]);
  useEffect(() => {
    if (!data.state) {
      setSearchResults(null);
      setEvidence(null);
    }
  }, [data.state === null]);
  useEffect(() => {
    const g = ++searchGeneration.current;
    setSearchResults(null);
    setFilteredPrepended(0);
    if ((query.trim().length < 2 && !speaker) || !data.state) {
      setSearchResults(null);
      setSearchCursor(null);
      setSearchBusy(false);
      return;
    }
    const controller = new AbortController();
    setSearchBusy(true);
    const timer = setTimeout(() => {
      const q = new URLSearchParams();
      if (speaker) q.set('speaker', speaker);
      if (query.trim().length >= 2) q.set('q', query);
      void api<any>(
        `/api/meetings/${id}/${query.trim().length >= 2 ? 'search' : 'transcript'}?${q}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (g === searchGeneration.current) {
            setSearchResults(result.segments);
            setSearchCursor(result.has_older ? result.older_cursor : null);
          }
        })
        .catch((e) => {
          if (e.name !== 'AbortError' && g === searchGeneration.current)
            setToast('검색을 완료하지 못했습니다.');
        })
        .finally(() => {
          if (g === searchGeneration.current) setSearchBusy(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, query, speaker, data.state?.generation]);
  const all = useMemo(
    () => (data.state ? [...data.state.segments.values()].sort(compareSegments) : []),
    [data.state],
  );
  const visible = useMemo(() => {
    const merged = new Map<string, SegmentDTO>();
    for (const item of searchResults ?? []) {
      if ((data.state?.tombstones.get(item.segment_id) ?? 0) >= item.revision) continue;
      const current = data.state?.segments.get(item.segment_id);
      merged.set(item.segment_id, current && current.revision > item.revision ? current : item);
    }
    for (const item of all) merged.set(item.segment_id, item);
    return [...merged.values()]
      .filter(
        (item) =>
          (!speaker || item.user_id === speaker) &&
          (query.trim().length < 2 ||
            (item.is_final && item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))),
      )
      .sort(compareSegments);
  }, [all, speaker, query, searchResults, data.state]);
  const unseen = data.newFinals.filter((s) => !speaker || s.user_id === speaker).length;
  useEffect(() => {
    if (atBottom && data.newFinals.length) data.clearNew();
  }, [atBottom, data.newFinals.length]);
  if (data.error || !data.state || !m)
    return (
      <div className="meeting-unavailable">
        <Link to="/meetings" className="back-link">
          <ArrowLeft />
          모든 회의
        </Link>
        <Empty
          title={data.error ?? '회의 기록을 불러오고 있어요'}
          icon={data.error ? <WarningCircle size={32} /> : <Waveform size={32} />}
        >
          <button className="secondary-button" onClick={data.reload}>
            <ArrowsClockwise />
            다시 연결
          </button>
          <a
            className="text-link"
            href={
              '/auth/discord?return_to=' +
              encodeURIComponent('/meetings/' + id + window.location.search)
            }
          >
            Discord 로그인
          </a>
        </Empty>
      </div>
    );
  const participants = data.state.snapshot.participants;
  const present = participants.filter((p) => p.present);
  const moreFiltered = () => {
    if (!searchCursor) return;
    const g = searchGeneration.current;
    const q = new URLSearchParams();
    if (speaker) q.set('speaker', speaker);
    const isSearch = query.trim().length >= 2;
    if (isSearch) {
      q.set('q', query);
      q.set('cursor', searchCursor);
    } else q.set('before', searchCursor);
    const known = new Set(visible.map((s) => s.segment_id));
    void api<{ segments: SegmentDTO[]; has_older: boolean; older_cursor: string | null }>(
      `/api/meetings/${id}/${isSearch ? 'search' : 'transcript'}?${q}`,
    )
      .then((result) => {
        if (g !== searchGeneration.current) return;
        setFilteredPrepended(
          (n) => n + result.segments.filter((s) => !known.has(s.segment_id)).length,
        );
        setSearchResults((xs) => [...(xs ?? []), ...result.segments]);
        setSearchCursor(result.has_older ? result.older_cursor : null);
      })
      .catch(() => setToast('이전 기록을 불러오지 못했습니다.'));
  };
  const exportFile = async (format: string) => {
    try {
      const res = await fetch(`/api/meetings/${id}/export?format=${format}`, { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const blob = await res.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = `meeting-${id}.${format}`;
      a.hidden = true;
      document.body.append(a);
      a.click();
      // Some browsers resolve the download asynchronously after the click task.
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    } catch {
      setToast('23시 정시퇴근 멤버십 확인 또는 다운로드 연결에 실패했습니다. 다시 시도해 주세요.');
    }
  };
  const copy = async (s: SegmentDTO) => {
    const u = new URL(window.location.href);
    u.search = '';
    u.searchParams.set('tab', 'transcript');
    u.searchParams.set('segment', s.segment_id);
    u.searchParams.set('transcript_version', String(m.transcript_version));
    try {
      await navigator.clipboard.writeText(u.toString());
      setToast('근거 발언 링크를 복사했습니다.');
    } catch {
      setToast('링크 복사를 지원하지 않는 환경입니다.');
    }
  };
  const showEvidence = (segment: string, version: number) =>
    setParams({ tab: 'transcript', segment, transcript_version: String(version) });
  return (
    <>
      <div className="topbar">
        <span>
          <Link to="/meetings">모든 회의</Link>
          <CaretRight size={13} />
          <span className="breadcrumb-title">{m.title}</span>
        </span>
        <span className="private-label">
          <LockSimple size={14} />팀 전용
        </span>
      </div>
      <header className="meeting-header">
        <div>
          <div className="meeting-kicker">
            <Hash size={15} />
            {m.voice_channel_name}
            <span className="tiny-separator" />
            <span>{date(m.started_at)}</span>
          </div>
          <h1>{m.title}</h1>
          <div className="meeting-meta">
            <Status status={m.status} />
            <span>
              <Clock size={15} />
              {clock(
                (m.ended_at ? Date.parse(m.ended_at) : now) -
                  (m.started_at ? Date.parse(m.started_at) : now),
              )}
            </span>
            <span>
              <Users size={16} />
              {present.length}명 참여 · {present.filter((p) => p.recording_eligible).length}명 기록
            </span>
          </div>
        </div>
        <details className="export-menu">
          <summary className="secondary-button">
            <DownloadSimple />
            내보내기
          </summary>
          <div>
            <button onClick={() => void exportFile('md')}>Markdown (.md)</button>
            <button onClick={() => void exportFile('txt')}>텍스트 (.txt)</button>
          </div>
        </details>
      </header>
      <div className="meeting-tabs" role="tablist" aria-label="회의 보기">
        <button
          role="tab"
          aria-selected={selectedTab === 'transcript'}
          className={selectedTab === 'transcript' ? 'selected' : ''}
          onClick={() => {
            setParams({ tab: 'transcript' });
            setEvidence(null);
          }}
        >
          <ChatCircleText />
          {ongoing(m.status) ? '실시간 전사' : '전체 전사'}
        </button>
        <button
          role="tab"
          aria-selected={selectedTab === 'summary'}
          className={selectedTab === 'summary' ? 'selected' : ''}
          onClick={() => setParams({ tab: 'summary' })}
        >
          <Notebook />
          회의 요약{m.summary_status === 'STALE' && <span className="tab-note">갱신 대기</span>}
        </button>
        <div className={`connection ${data.connection}`} role="status">
          <span />
          {
            {
              connecting: '연결 중',
              live: '실시간 연결됨',
              reconnecting: '재연결 중',
              disconnected: '연결 끊김',
            }[data.connection]
          }
        </div>
      </div>
      <div className="meeting-body">
        <section className="meeting-content">
          {selectedTab === 'summary' ? (
            <Summary
              result={data.summary}
              participants={participants}
              currentVersion={m.transcript_version}
              showEvidence={showEvidence}
            />
          ) : (
            <>
              <div className="transcript-toolbar">
                <label className="search-box">
                  <MagnifyingGlass size={18} />
                  <input
                    aria-label="전체 전사 검색"
                    placeholder="전체 기록에서 검색"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    maxLength={100}
                  />
                  {query && (
                    <button
                      aria-label="검색 지우기"
                      className="icon-button"
                      onClick={() => setQuery('')}
                    >
                      <X size={15} />
                    </button>
                  )}
                </label>
                <label className="speaker-select">
                  <Users size={16} />
                  <select
                    aria-label="화자 필터"
                    value={speaker}
                    onChange={(e) => setSpeaker(e.target.value)}
                  >
                    <option value="">모든 화자</option>
                    {participants.map((p) => (
                      <option value={p.user_id} key={p.user_id}>
                        {p.display_name} · {p.user_id.slice(-4)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {query.length === 1 && (
                <div className="search-note">
                  두 글자 이상 입력하면 전체 확정 전사에서 검색합니다.
                </div>
              )}
              {searchBusy && <div className="search-note">전체 기록을 조회하고 있어요…</div>}
              <GapNotice gaps={data.state.snapshot.gaps} />
              {evidence ? (
                <div className="evidence-panel">
                  <div className="evidence-top">
                    <span>
                      <LinkSimple size={16} />
                      근거 발언 · 전사 버전 {evidence.transcript_version}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="근거 닫기"
                      onClick={() => {
                        setEvidence(null);
                        setParams({ tab: 'transcript' });
                      }}
                    >
                      <X />
                    </button>
                  </div>
                  {evidence.transcript_version !== m.transcript_version && (
                    <div className="info-line">
                      요약 생성 당시의 발언입니다. 현재 전사와 내용이 다를 수 있습니다.
                    </div>
                  )}
                  {evidence.replacement_ids.length > 0 && (
                    <div className="info-line">재전사로 갱신된 발언과 앞뒤 문맥을 표시합니다.</div>
                  )}
                  {(evidence.context.length ? evidence.context : [evidence.segment]).map((s) => (
                    <TranscriptRow
                      key={s.segment_id}
                      segment={s}
                      highlighted={
                        s.segment_id === evidence.segment.segment_id ||
                        evidence.replacement_ids.includes(s.segment_id)
                      }
                      onCopy={() => void copy(s)}
                    />
                  ))}
                </div>
              ) : visible.length ? (
                <div className="transcript-viewport">
                  <Virtuoso
                    key={
                      speaker +
                      ':' +
                      (query.trim().length >= 2 ? query : '') +
                      ':' +
                      data.state.generation
                    }
                    ref={virtuoso}
                    data={visible}
                    firstItemIndex={
                      1000000 -
                      (speaker || query.trim().length >= 2 ? filteredPrepended : data.prepended)
                    }
                    initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
                    computeItemKey={(_i, s) => s.segment_id}
                    followOutput={(isBottom) => (isBottom && !searchResults ? 'auto' : false)}
                    atBottomStateChange={setAtBottom}
                    atBottomThreshold={80}
                    startReached={() => {
                      if (!speaker && !searchResults) void data.loadOlder();
                    }}
                    components={timelineComponents}
                    context={{
                      olderLoading: data.olderLoading,
                      hasOlder: data.state.snapshot.has_older,
                      filtered: Boolean(speaker) || query.trim().length >= 2,
                      canMoreFiltered: Boolean(searchCursor),
                      recording: ongoing(m.status),
                      onOlder: () => void data.loadOlder(),
                      onMoreFiltered: moreFiltered,
                    }}
                    itemContent={(_i, s) => (
                      <TranscriptRow segment={s} onCopy={() => void copy(s)} />
                    )}
                  />
                  {!atBottom && !searchResults && (
                    <button
                      className="latest-button"
                      onClick={() => {
                        virtuoso.current?.scrollToIndex({
                          index: 'LAST',
                          align: 'end',
                          behavior: 'smooth',
                        });
                        data.clearNew();
                      }}
                    >
                      <ArrowDown size={15} />
                      {unseen > 0 ? `새 발언 ${unseen}개 · ` : ''}최신으로 이동
                    </button>
                  )}
                </div>
              ) : (
                <Empty
                  title={
                    searchResults
                      ? '검색 결과가 없습니다.'
                      : speaker
                        ? '이 화자의 발언이 없습니다.'
                        : '첫 발언을 기다리고 있어요.'
                  }
                  icon={<Waveform size={32} />}
                >
                  <p>
                    {searchResults
                      ? '다른 단어로 검색해 보세요.'
                      : '참가자의 확정 발언과 인식 중인 발언이 표시됩니다.'}
                  </p>
                </Empty>
              )}
            </>
          )}
        </section>
        <aside className="meeting-aside">
          <section>
            <div className="aside-heading">
              <h2>참가자</h2>
              <span>{present.length}</span>
            </div>
            <div className="participant-list">
              {participants.map((p) => (
                <button
                  className={`participant ${speaker === p.user_id ? 'selected' : ''}`}
                  key={p.user_id}
                  onClick={() => {
                    setSpeaker(speaker === p.user_id ? '' : p.user_id);
                    setParams({ tab: 'transcript' });
                  }}
                >
                  <Avatar name={p.display_name} id={p.user_id} size="small" />
                  <span>
                    {p.display_name}
                    <small>
                      {p.present ? (p.recording_eligible ? '기록 대상' : '기록 제외') : '퇴장'}
                    </small>
                  </span>
                  <span
                    className={`eligibility ${p.present && p.recording_eligible ? 'yes' : ''}`}
                    aria-label={p.recording_eligible ? '기록 대상' : '기록 제외'}
                  />
                </button>
              ))}
            </div>
          </section>
          {data.state.snapshot.markers.length > 0 && (
            <section className="markers">
              <h2>중요 지점</h2>
              {data.state.snapshot.markers.map((mark) => (
                <div key={mark.marker_id}>
                  <span>{clock(mark.at_ms)}</span>
                  {mark.label ?? '중요 지점 표시'}
                </div>
              ))}
            </section>
          )}
          {data.state.snapshot.gaps.length > 0 && (
            <section className="gaps">
              <h2>누락과 일시정지</h2>
              {data.state.snapshot.gaps.map((g) => (
                <div key={g.gap_id}>
                  <WarningCircle size={15} />
                  <p>
                    {
                      {
                        PAUSED: '일시정지',
                        VOICE_LOST: '음성 연결 단절',
                        STT_PENDING: '전사 복구 필요',
                        STORAGE_ERROR: '저장 오류',
                      }[g.reason]
                    }
                    {g.resolution === 'NO_SPEECH_OR_NOISE'
                      ? ' · 음성 없음/잡음 (전사 결과 없음)'
                      : g.resolved
                        ? ' · 복구됨'
                        : !g.recoverable && g.reason === 'STT_PENDING'
                          ? ' · 복구 불가'
                          : ''}
                    <small>
                      {clock(g.start_ms)} ~ {g.end_ms === null ? '진행 중' : clock(g.end_ms)}
                    </small>
                  </p>
                </div>
              ))}
            </section>
          )}
        </aside>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
function TranscriptRow({
  segment: s,
  highlighted,
  onCopy,
}: {
  segment: SegmentDTO;
  highlighted?: boolean;
  onCopy: () => void;
}) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const version = params.get('transcript_version');
  return (
    <article
      className={`transcript-row ${s.is_final ? 'final' : 'partial'} ${highlighted ? 'highlighted' : ''}`}
      data-segment-id={s.segment_id}
      data-revision={s.revision}
      data-user-id={s.user_id}
    >
      <time>{clock(s.start_ms).replace(/^00:/, '')}</time>
      <Avatar name={s.display_name} id={s.user_id} />
      <div className="utterance">
        <div className="utterance-heading">
          <strong>{s.display_name}</strong>
          {!s.is_final ? (
            <span className="recognizing">
              인식 중
              <span aria-hidden="true" className="thinking-dots">
                ···
              </span>
            </span>
          ) : s.corrected ? (
            <span className="corrected">정정됨</span>
          ) : null}
          {s.quality_flags.includes('OVERLAPPING_SPEECH') && (
            <span className="overlap">겹친 발언</span>
          )}
          <button
            className="copy-segment icon-button"
            aria-label={`${s.display_name} 발언 링크 복사`}
            disabled={!s.is_final}
            title={s.is_final ? '근거 발언 링크 복사' : '전사 확정 후 링크를 복사할 수 있습니다.'}
            onClick={onCopy}
          >
            <LinkSimple size={16} />
          </button>
        </div>
        <AudioText
          text={s.text}
          enabled={s.is_final}
          url={`/api/meetings/${id}/segments/${s.segment_id}/audio${version ? `?transcript_version=${encodeURIComponent(version)}` : ''}`}
        />
      </div>
    </article>
  );
}
function Summary({
  result,
  participants,
  currentVersion,
  showEvidence,
}: {
  result: SummaryResultDTO | null;
  participants: ParticipantDTO[];
  currentVersion: number;
  showEvidence: (id: string, version: number) => void;
}) {
  if (!result?.result)
    return (
      <Empty
        title={
          result?.summary_status === 'FAILED'
            ? '요약을 마무리하지 못했습니다.'
            : '회의가 끝나면 여기에 정리할게요.'
        }
        icon={<Notebook size={32} />}
      >
        <p>
          확정된 발언을 바탕으로 회의의 핵심 내용과 주요 주제를 정리합니다.
          <br />
          전체 전사는 계속 열람할 수 있습니다.
        </p>
      </Empty>
    );
  const s = result.result;
  const evidence = (ids: string[]) => (
    <span className="evidence-links">
      {ids.slice(0, 2).map((id, i) => (
        <button key={id} onClick={() => showEvidence(id, result.transcript_version)}>
          <LinkSimple size={13} />
          {ids.length === 1 ? '근거 보기' : `근거 ${i + 1}`}
        </button>
      ))}
      {ids.length > 2 && (
        <details className="more-evidence">
          <summary>근거 {ids.length - 2}개 더 보기</summary>
          <div>
            {ids.slice(2).map((id, i) => (
              <button key={id} onClick={() => showEvidence(id, result.transcript_version)}>
                <LinkSimple size={13} />
                근거 {i + 3}
              </button>
            ))}
          </div>
        </details>
      )}
    </span>
  );
  return (
    <div className="summary-content">
      <div className="summary-disclosure">
        <span>
          <Notebook size={17} />
          자동 요약 · 검토 전
        </span>
        <span>전사 v{result.transcript_version}</span>
      </div>
      {(currentVersion !== result.transcript_version || result.summary_status === 'STALE') && (
        <div className="summary-warning">
          <ArrowsClockwise size={17} />
          {result.summary_status === 'FAILED'
            ? '새 요약 생성에 실패했습니다. 아래는 이전 버전입니다.'
            : '전사가 변경되어 요약을 갱신하고 있습니다. 아래는 이전 버전입니다.'}
        </div>
      )}
      {result.partial && (
        <div className="summary-warning">
          <WarningCircle size={17} />
          수집 누락이나 복구 대기 구간이 포함된 부분 회의록입니다.
        </div>
      )}
      <section className="summary-overview">
        <div className="section-label">핵심 요약</div>
        <h2>이번 회의에서 나눈 이야기</h2>
        <ul>
          {s.summary.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </section>
      <section className="summary-extra">
        <h2>
          결정사항 <span>{s.decisions.length}</span>
        </h2>
        {s.decisions.length ? (
          s.decisions.map((d, i) => (
            <div className="decision" key={i}>
              <CheckCircle size={19} />
              <div>
                <h3>{d.decision}</h3>
                {d.reason && <p>{d.reason}</p>}
                {evidence(d.evidence_segment_ids)}
              </div>
            </div>
          ))
        ) : (
          <p className="muted">명시적으로 확정된 결정사항이 없습니다.</p>
        )}
      </section>
      <section className="summary-extra">
        <h2>
          다음 할 일 <span>{s.action_items.length}</span>
        </h2>
        {s.action_items.length ? (
          s.action_items.map((a, i) => (
            <div className="action-item" key={i}>
              <span className="task-square" />
              <div>
                <h3>{a.task}</h3>
                <div className="task-meta">
                  <span>
                    <Users size={13} />
                    {participants.find((p) => p.user_id === a.owner_user_id)?.display_name ??
                      '담당자 미정'}
                  </span>
                  <span>
                    <Clock size={13} />
                    {a.due_date ?? a.due_date_text ?? '기한 미정'}
                  </span>
                </div>
                {evidence(a.evidence_segment_ids)}
              </div>
            </div>
          ))
        ) : (
          <p className="muted">명시적으로 합의된 할 일이 없습니다.</p>
        )}
      </section>
      <section>
        <h2>주제별 요약</h2>
        {s.topics.map((t, i) => (
          <div className="topic" key={i}>
            <span className="topic-category">{t.category}</span>
            <h3>{t.title}</h3>
            <p>{t.discussion}</p>
            {evidence(t.evidence_segment_ids)}
          </div>
        ))}
      </section>
      {s.open_questions.length > 0 && (
        <section className="summary-extra">
          <h2>미결 질문</h2>
          {s.open_questions.map((q, i) => (
            <div className="topic" key={i}>
              <p>{q.question}</p>
              {evidence(q.evidence_segment_ids)}
            </div>
          ))}
        </section>
      )}
      {s.blockers.length > 0 && (
        <section className="summary-extra">
          <h2>장애 요인</h2>
          {s.blockers.map((b, i) => (
            <div className="topic" key={i}>
              <h3>{b.issue}</h3>
              <p>{b.impact}</p>
              {b.mentioned_solution && <p>논의된 해결책: {b.mentioned_solution}</p>}
              {evidence(b.evidence_segment_ids)}
            </div>
          ))}
        </section>
      )}
      {s.next_agenda.length > 0 && (
        <section className="summary-extra">
          <h2>다음 안건</h2>
          {s.next_agenda.map((a, i) => (
            <div className="topic" key={i}>
              <p>
                {a.agenda}{' '}
                <span className="topic-category">
                  {a.origin === 'EXPLICIT' ? '명시된 안건' : '미결 쟁점에서 도출'}
                </span>
              </p>
              {evidence(a.evidence_segment_ids)}
            </div>
          ))}
        </section>
      )}
      {s.quality_notes.length > 0 && (
        <section className="quality-notes summary-extra">
          <h2>기록 품질 안내</h2>
          {s.quality_notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </section>
      )}
    </div>
  );
}

interface TimelineContext {
  olderLoading: boolean;
  hasOlder: boolean;
  filtered: boolean;
  canMoreFiltered: boolean;
  recording: boolean;
  onOlder: () => void;
  onMoreFiltered: () => void;
}
function TimelineHeader({ context: c }: { context?: TimelineContext }) {
  if (!c) return null;
  return c.olderLoading ? (
    <div className="loading-line">이전 발언을 불러오는 중…</div>
  ) : c.hasOlder && !c.filtered ? (
    <button className="load-history" onClick={c.onOlder}>
      이전 발언 불러오기
    </button>
  ) : (
    <div className="transcript-start">
      <LockSimple size={13} />
      기록 시작 전 대화는 저장되지 않았습니다.
    </div>
  );
}
function TimelineFooter({ context: c }: { context?: TimelineContext }) {
  if (!c) return null;
  return c.canMoreFiltered ? (
    <button className="load-history" onClick={c.onMoreFiltered}>
      이전 결과 더 보기
    </button>
  ) : (
    <div className="timeline-end">
      {c.recording ? '다음 이야기를 기다리고 있어요.' : '확정된 전사는 여기까지입니다.'}
    </div>
  );
}
const timelineComponents = { Header: TimelineHeader, Footer: TimelineFooter };
function GapNotice({ gaps }: { gaps: GapDTO[] }) {
  const unresolved = gaps.filter((g) => !g.resolved);
  if (!unresolved.length) return null;
  return (
    <details className="coverage-notice">
      <summary>
        <WarningCircle size={16} />
        일시정지·누락·복구 안내 <span>{unresolved.length}개 구간</span>
      </summary>
      <ul>
        {unresolved.map((g) => (
          <li key={g.gap_id}>
            <span>
              {clock(g.start_ms)} ~ {g.end_ms === null ? '진행 중' : clock(g.end_ms)}
            </span>
            {g.reason === 'PAUSED'
              ? '일시정지로 기록되지 않은 구간'
              : g.reason === 'STT_PENDING'
                ? g.recoverable
                  ? '전사 대기 · 저장된 원음 복구 대상'
                  : '전사 누락 · 복구할 원음이 없음'
                : g.reason === 'VOICE_LOST'
                  ? '음성 연결 단절로 기록되지 않은 구간'
                  : '저장 오류로 기록이 중단된 구간'}
          </li>
        ))}
      </ul>
    </details>
  );
}

interface KnowledgeEvidence {
  id: string;
  source: string;
  document_id: string;
  url: string;
  quote: string;
}
interface KnowledgeAnswer {
  answer_id: string;
  status: 'COMPLETE' | 'PARTIAL' | 'NEEDS_CLARIFICATION' | 'FAILED';
  answer: string;
  checked_at: string;
  claims: { text: string; state: string; evidence_ids: string[] }[];
  evidence: KnowledgeEvidence[];
  source_coverage: {
    source: string;
    read_status: string;
    search_status: string;
    scope_complete: boolean;
    gaps: string[];
  }[];
  conflicts: { text: string; evidence_ids: string[] }[];
  warnings: string[];
  model: string;
}
const knowledgeStatus: Record<string, string> = {
  COMPLETE: '전체 확인 완료',
  PARTIAL: '일부 확인',
  NEEDS_CLARIFICATION: '자료 부족',
  FAILED: '실패',
};
const sourceLabels: Record<string, string> = {
  notion: 'Notion',
  github: 'GitHub',
  discord: 'Discord',
  meeting: '회의',
};
function KnowledgeAsk() {
  const [question, setQuestion] = useState(''),
    [busy, setBusy] = useState(false),
    [answer, setAnswer] = useState<KnowledgeAnswer | null>(null),
    [error, setError] = useState<string | null>(null);
  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(
        await api<KnowledgeAnswer>('/api/knowledge/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q }),
        }),
      );
    } catch (e) {
      setAnswer(null);
      setError(
        e instanceof ApiError && e.code === 'KNOWLEDGE_DISABLED'
          ? '지식 검색이 아직 서버에 설정되지 않았습니다.'
          : e instanceof ApiError
            ? e.message
            : '답변을 가져오지 못했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="list-page ask-page">
      <header className="page-heading">
        <div>
          <h1>프로젝트에 질문</h1>
          <p>회의록·문서·코드·Discord를 함께 찾아 답합니다.</p>
        </div>
      </header>
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          aria-label="질문 입력"
          placeholder="예: 스크롤 구현은 어디서 확인해?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={4000}
        />
        <button className="primary-button" type="submit" disabled={busy || !question.trim()}>
          {busy ? '확인 중…' : '질문'}
        </button>
      </form>
      {error && <div className="summary-warning">{error}</div>}
      {answer && (
        <section className="ask-result">
          <div className={`ask-status ask-${answer.status.toLowerCase()}`}>
            {knowledgeStatus[answer.status] ?? answer.status}
            <span className="muted">
              {new Intl.DateTimeFormat('ko-KR', {
                timeZone: 'Asia/Seoul',
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date(answer.checked_at))}
              에 확인
            </span>
          </div>
          <p className="ask-answer">{answer.answer}</p>
          {answer.warnings.length > 0 && (
            <div className="summary-warning">
              {answer.warnings.map((w, i) => (
                <div key={i}>
                  <WarningCircle size={14} /> {w}
                </div>
              ))}
            </div>
          )}
          {answer.conflicts.length > 0 && (
            <div className="summary-warning">
              {answer.conflicts.map((c, i) => (
                <div key={i}>
                  <WarningCircle size={14} /> 자료 간 충돌: {c.text}
                </div>
              ))}
            </div>
          )}
          <div className="ask-coverage">
            {answer.source_coverage.map((c) => (
              <span
                key={c.source}
                className={`coverage-chip ${c.search_status === 'MATCH' ? 'hit' : ''}`}
                title={c.gaps.join(', ')}
              >
                {sourceLabels[c.source] ?? c.source}
                {c.search_status === 'MATCH' ? ' ✓' : c.search_status === 'NO_MATCH' ? ' –' : ' ·'}
              </span>
            ))}
          </div>
          {answer.claims.length > 0 && (
            <ul className="ask-claims">
              {answer.claims.map((c, i) => (
                <li key={i}>
                  {c.text}
                  <span className="claim-refs">
                    {c.evidence_ids.map((id) => (
                      <a key={id} href={'#ev-' + id}>
                        [{id}]
                      </a>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {answer.evidence.length > 0 && (
            <div className="ask-evidence">
              <h3>근거</h3>
              {answer.evidence.map((e) => (
                <div key={e.id} id={'ev-' + e.id} className="evidence-item">
                  <div className="evidence-head">
                    <span className="coverage-chip">{e.id}</span>
                    <span>{sourceLabels[e.source] ?? e.source}</span>
                    {e.url && (
                      <a href={e.url} target="_blank" rel="noreferrer">
                        원문 ↗
                      </a>
                    )}
                  </div>
                  <p>{e.quote}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Snapshot,
  SummaryResult,
  eventTypes,
  type SegmentDTO,
  type MeetingEvent,
  type SummaryResultDTO,
} from '@meeting/contracts';
import { initialView, applyEvent, mergePage, type ViewState, DomainError } from '@meeting/domain';
import { api, ApiError } from './api';
export type Connection = 'connecting' | 'live' | 'reconnecting' | 'disconnected';
export function useMeeting(id: string) {
  const [state, setState] = useState<ViewState | null>(null),
    [connection, setConnection] = useState<Connection>('connecting'),
    [error, setError] = useState<string | null>(null),
    [summary, setSummary] = useState<SummaryResultDTO | null>(null),
    [olderLoading, setOlderLoading] = useState(false),
    [prepended, setPrepended] = useState(0),
    [newFinals, setNewFinals] = useState<SegmentDTO[]>([]);
  const ref = useRef<ViewState | null>(null),
    generation = useRef(0),
    reloadRef = useRef<() => void>(() => {}),
    olderBusy = useRef(false);
  const commit = useCallback((value: ViewState | null) => {
    ref.current = value;
    setState(value);
  }, []);
  useEffect(() => {
    let active = true,
      source: EventSource | null = null,
      retry: ReturnType<typeof setTimeout> | null = null;
    let probePending = false;
    let incompatible = 0;
    const controller = new AbortController();
    const progressTimer = setInterval(() => {
      if (!active || ref.current?.snapshot.transcription_mode !== "after_meeting" || ref.current.snapshot.meeting.status !== "FINALIZING") return;
      void api(`/api/meetings/${id}/snapshot`, { signal: controller.signal }).then(value => {
        if (!active || !ref.current) return;
        const snapshot = Snapshot.parse(value);
        commit({ ...ref.current, snapshot: { ...ref.current.snapshot, transcription_progress: snapshot.transcription_progress } });
      }).catch(() => {});
    }, 5000);
    generation.current++;
    commit(null);
    setSummary(null);
    setPrepended(0);
    setNewFinals([]);
    setError(null);
    const revoke = (message: string) => {
      source?.close();
      if (retry) clearTimeout(retry);
      generation.current++;
      commit(null);
      setSummary(null);
      setNewFinals([]);
      setError(message);
      setConnection('disconnected');
    };
    const load = async () => {
      source?.close();
      if (retry) clearTimeout(retry);
      const g = ++generation.current;
      setConnection('connecting');
      try {
        const snapshot = Snapshot.parse(
          await api(`/api/meetings/${id}/snapshot`, { signal: controller.signal }),
        );
        if (!active || g !== generation.current) return;
        commit(initialView(snapshot, g));
        setPrepended(0);
        setNewFinals([]);
        setError(null);
        source = new EventSource(`/api/meetings/${id}/events?after=${snapshot.cursor}`);
        source.onopen = () => {
          if (active && g === generation.current) setConnection('live');
        };
        for (const type of eventTypes)
          source.addEventListener(type, (event) => {
            if (!active || g !== generation.current || !ref.current) return;
            try {
              const value = JSON.parse((event as MessageEvent).data) as MeetingEvent;
              const previous = ref.current;
              const next = applyEvent(previous, value);
              if (
                value.type === 'segment.upsert' &&
                value.data.segment.is_final &&
                !previous.segments.get(value.data.segment.segment_id)?.is_final &&
                next !== previous
              )
                setNewFinals((xs) => [...xs, value.data.segment].slice(-1000));
              commit(next);
            } catch (e) {
              source?.close();
              if (
                e instanceof DomainError &&
                e.code === 'INCOMPATIBLE_EVENT' &&
                ++incompatible > 1
              ) {
                revoke('기록 형식이 변경되었습니다. 페이지를 새로고침해 주세요.');
                return;
              }
              void load();
            }
          });
        source.addEventListener('sync.required', () => {
          source?.close();
          if (active) void load();
        });
        source.addEventListener('access.revoked', () =>
          revoke('회의를 찾을 수 없거나 열람 권한이 없습니다.'),
        );
        source.addEventListener('service.unavailable', () => {
          source?.close();
          setConnection('reconnecting');
          retry = setTimeout(() => void load(), 3000);
        });
        source.onerror = () => {
          if (!active || g !== generation.current) return;
          setConnection('reconnecting');
          if (probePending) return;
          probePending = true;
          void api(`/api/meetings/${id}/snapshot`, { signal: controller.signal })
            .catch((e) => {
              if (e instanceof ApiError && [401, 403, 404].includes(e.status))
                revoke(
                  e.status === 401
                    ? 'Discord 로그인이 필요합니다.'
                    : '회의를 찾을 수 없거나 열람 권한이 없습니다.',
                );
            })
            .finally(() => {
              probePending = false;
            });
        };
      } catch (e) {
        if (!active || g !== generation.current) return;
        setConnection('disconnected');
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          revoke(e.status === 401 ? 'Discord 로그인이 필요합니다.' : e.message);
        else {
          setError('기록을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.');
          if (
            e instanceof TypeError ||
            (e instanceof ApiError && (e.status === 429 || e.status >= 500))
          ) {
            setConnection('reconnecting');
            retry = setTimeout(
              () => {
                if (active) void load();
              },
              Math.max(3000, e instanceof ApiError ? e.retryAfterMs : 0),
            );
          }
        }
      }
    };
    reloadRef.current = () => void load();
    void load();
    return () => {
      active = false;
      clearInterval(progressTimer);
      generation.current++;
      controller.abort();
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, [id, commit]);
  useEffect(() => {
    if (!state) return;
    const g = state.generation,
      expected = state.snapshot.meeting.summary_version;
    let active = true;
    const controller = new AbortController();
    void api(`/api/meetings/${id}/summary`, { signal: controller.signal })
      .then((raw) => {
        const result = SummaryResult.parse(raw);
        if (
          active &&
          ref.current?.generation === g &&
          (ref.current.snapshot.meeting.summary_version ?? 0) <= (result.summary_version ?? 0)
        )
          setSummary(result);
      })
      .catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, state?.snapshot.meeting.summary_version, state?.snapshot.meeting.summary_status]);
  const loadOlder = useCallback(async () => {
    const current = ref.current;
    if (!current || !current.snapshot.has_older || olderBusy.current) return;
    olderBusy.current = true;
    setOlderLoading(true);
    try {
      const page = await api<{
        segments: SegmentDTO[];
        has_older: boolean;
        older_cursor: string | null;
      }>(
        `/api/meetings/${id}/transcript?before=${encodeURIComponent(current.snapshot.older_cursor!)}`,
      );
      if (ref.current?.generation !== current.generation) return;
      const previous = ref.current;
      const next = mergePage(previous, page.segments, current.generation);
      const added = next.segments.size - previous.segments.size;
      next.snapshot = {
        ...next.snapshot,
        has_older: page.has_older,
        older_cursor: page.older_cursor,
      };
      commit(next);
      setPrepended((n) => n + added);
    } finally {
      olderBusy.current = false;
      setOlderLoading(false);
    }
  }, [id, commit]);
  return {
    state,
    connection,
    error,
    summary,
    loadOlder,
    olderLoading,
    prepended,
    newFinals,
    clearNew: () => setNewFinals([]),
    reload: () => reloadRef.current(),
  };
}

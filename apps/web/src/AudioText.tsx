import { useEffect, useRef, useState } from 'react';

const exclusiveEvent = 'meeting-audio-selected';
const time = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(s % 60)
    .toString()
    .padStart(2, '0')}`;

export function AudioText({ text, url, enabled }: { text: string; url: string; enabled: boolean }) {
  const identity = useRef({});
  const pointer = useRef({ x: 0, y: 0, dragged: false });
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const context = useRef<AudioContext | null>(null);
  const blobUrl = useRef<string | null>(null);
  const generation = useRef(0);
  const collapse = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle');
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const hide = () => {
    setExpanded(false);
    if (collapse.current) clearTimeout(collapse.current);
    collapse.current = setTimeout(
      () => setMounted(false),
      matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200,
    );
  };
  const release = () => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    audio.current?.pause();
    if (audio.current) {
      audio.current.onended = null;
      audio.current.onerror = null;
      audio.current.removeAttribute('src');
      audio.current.load();
    }
    audio.current = null;
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
    if (context.current) void context.current.close().catch(() => {});
    context.current = null;
  };
  useEffect(() => {
    setPhase('idle');
    setMounted(false);
    setExpanded(false);
    setPosition(0);
    setError('');
    setNote('');
    const stop = (e: Event) => {
      if ((e as CustomEvent).detail === identity.current) return;
      release();
      setPhase('idle');
      setPosition(0);
      hide();
    };
    window.addEventListener(exclusiveEvent, stop);
    return () => {
      window.removeEventListener(exclusiveEvent, stop);
      release();
      if (collapse.current) clearTimeout(collapse.current);
    };
  }, [url, enabled]);
  useEffect(() => {
    if (phase !== 'playing') return;
    let frame = 0;
    const tick = () => {
      setPosition(audio.current?.currentTime ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const toggle = async () => {
    if (!enabled || window.getSelection()?.toString()) return;
    if (phase === 'loading') {
      release();
      setPhase('idle');
      hide();
      return;
    }
    if (audio.current && !audio.current.paused) {
      audio.current.pause();
      setPhase('paused');
      hide();
      return;
    }
    window.dispatchEvent(new CustomEvent(exclusiveEvent, { detail: identity.current }));
    const current = ++generation.current;
    setError('');
    if (collapse.current) clearTimeout(collapse.current);
    setMounted(true);
    setExpanded(false);
    requestAnimationFrame(() => {
      if (generation.current === current) setExpanded(true);
    });
    try {
      if (!audio.current) {
        setPhase('loading');
        const controller = new AbortController();
        request.current = controller;
        const response = await fetch(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error?.message ?? '원음을 불러오지 못했습니다. 다시 클릭해 주세요.');
        }
        const bytes = await response.arrayBuffer();
        if (generation.current !== current) return;
        const ctx = new AudioContext();
        context.current = ctx;
        const decoded = await ctx.decodeAudioData(bytes.slice(0));
        if (generation.current !== current) return;
        await ctx.close();
        context.current = null;
        const samples = decoded.getChannelData(0),
          values: number[] = [];
        for (let i = 0; i < 56; i++) {
          const start = Math.floor((i * samples.length) / 56),
            end = Math.floor(((i + 1) * samples.length) / 56);
          let sum = 0;
          for (let j = start; j < end; j++) sum += samples[j]! ** 2;
          values.push(Math.sqrt(sum / Math.max(1, end - start)));
        }
        const max = Math.max(...values, 0.00001);
        setPeaks(values.map((v) => v / max));
        setDuration(decoded.duration);
        setNote(
          Number(response.headers.get('X-Audio-Missing-Ms')) > 0
            ? '저장되지 않은 구간은 무음으로 재생됩니다.'
            : '',
        );
        const src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        blobUrl.current = src;
        const player = new Audio(src);
        audio.current = player;
        player.onended = () => {
          setPhase('idle');
          setPosition(player.duration);
          hide();
        };
        player.onerror = () => {
          release();
          setPhase('idle');
          setError('원음 재생에 실패했습니다. 다시 클릭해 주세요.');
          hide();
        };
      }
      const player = audio.current!;
      if (player.ended) player.currentTime = 0;
      await player.play();
      if (generation.current !== current) {
        player.pause();
        return;
      }
      setPhase('playing');
    } catch (e) {
      if (generation.current !== current) return;
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        setPhase('paused');
        hide();
        setError('브라우저가 재생을 보류했습니다. 문장을 다시 눌러 주세요.');
        return;
      }
      release();
      setPhase('idle');
      hide();
      setError(e instanceof Error ? e.message : '원음을 불러오지 못했습니다.');
    }
  };
  return (
    <>
      {enabled ? (
        <div
          role="button"
          tabIndex={0}
          onPointerDown={(e) => {
            pointer.current = { x: e.clientX, y: e.clientY, dragged: false };
          }}
          onPointerMove={(e) => {
            if (
              e.buttons &&
              Math.hypot(e.clientX - pointer.current.x, e.clientY - pointer.current.y) > 5
            )
              pointer.current.dragged = true;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void toggle();
            }
          }}
          className={`utterance-text ${phase === 'playing' ? 'is-playing' : ''}`}
          onClick={() => {
            if (!pointer.current.dragged) void toggle();
          }}
          aria-label={`발언 ${phase === 'playing' ? '일시정지' : '재생'}: ${text}`}
          aria-pressed={phase === 'playing'}
        >
          {text}
        </div>
      ) : (
        <p>{text}</p>
      )}
      {mounted && (
        <div className={`audio-reveal ${expanded ? 'expanded' : ''}`}>
          <div className="audio-reveal-inner">
            {phase === 'loading' ? (
              <div role="status" className="audio-loading">
                원음 불러오는 중…
              </div>
            ) : (
              <div className="audio-wave-player">
                <div className="audio-wave">
                  <svg viewBox="0 0 280 40" preserveAspectRatio="none" aria-hidden="true">
                    {peaks.map((v, i) => (
                      <rect
                        key={i}
                        x={i * 5}
                        y={20 - Math.max(2, v * 18)}
                        width="3"
                        height={Math.max(4, v * 36)}
                        rx="1.5"
                        className={i / peaks.length < position / duration ? 'played' : ''}
                      />
                    ))}
                  </svg>
                  <input
                    type="range"
                    min={0}
                    max={duration || 1}
                    step="0.01"
                    value={Math.min(position, duration)}
                    aria-label="발언 재생 위치"
                    aria-valuetext={`${time(position)} / ${time(duration)}`}
                    onChange={(e) => {
                      if (audio.current) audio.current.currentTime = Number(e.target.value);
                      setPosition(Number(e.target.value));
                    }}
                  />
                </div>
                <span className="audio-time">
                  {time(position)} / {time(duration)}
                </span>
              </div>
            )}
            {note && <small>{note}</small>}
          </div>
        </div>
      )}
      {error && (
        <small role="alert" className="audio-error">
          {error}
        </small>
      )}
    </>
  );
}

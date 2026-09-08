import { Worker } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
  type VoiceConnection,
  type AudioReceiveStream,
} from '@discordjs/voice';
import type { Guild } from 'discord.js';
import { Store, sql, json, first, type MeetingRow } from '@meeting/db';
import {
  StreamPool,
  ReturnZero,
  pcmToFlac,
  writeEncrypted,
  safeAudioPath,
  hash,
  type SpeechStream,
  type SttMessage,
  type AppConfig,
} from '@meeting/providers';
import type { ParticipantDTO, GapDTO } from '@meeting/contracts';
import { captureFrameStart } from '@meeting/domain';
interface Frame {
  start: number;
  pcm: Buffer;
}
interface Track {
  id: string;
  name: string;
  gate: number;
  eligible: boolean;
  worker: Worker | null;
  subscription: AudioReceiveStream | null;
  inflight: number;
  packets: number;
  decodedBytes: number;
  decodeErrors: number;
  decoder: string;
  ring: Frame[];
  frames: Frame[];
  lastSpeech: number;
  lastFinalEnd: number;
  resumeAfter: number;
  finalsByEpoch: Map<string, number>;
  stream: SpeechStream | null;
  opening: boolean;
  queued: boolean;
  queueAbort: AbortController | null;
  lastFrame: number;
  epoch: string | null;
  offset: number;
  nextAt: number;
  finalized: boolean;
  archive: Buffer[];
  archiveStart: number;
  archiveBytes: number;
  persist: Promise<void>;
  pendingArchiveBytes: number;
  usageAt: number;
  gap: GapDTO | null;
  counters: {
    archived_pcm_bytes: number;
    sent_pcm_bytes: number;
    accepted_pcm_bytes: number;
    blocked_pcm_bytes: number;
  };
  failures: number;
  retryAt: number;
  pendingPartial: { message: SttMessage; epoch: string; offset: number } | null;
  partialAt: number;
  mutation: Promise<void>;
}
export interface CaptureTestAdapter {
  stream(userId: string, keywords: { spoken: string; weight: number }[]): SpeechStream;
  beforeArchive?: () => Promise<void>;
  committed?: (segment: import('@meeting/contracts').SegmentDTO, at: number) => void;
  streamEvent?: (
    userId: string,
    phase: 'queued' | 'opening' | 'open' | 'closed',
    at: number,
  ) => void;
  mockUsage?: boolean;
}
export class Capture {
  private connection: VoiceConnection | null = null;
  private tracks = new Map<string, Track>();
  private timer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private origin = performance.now();
  private initialOffset = 0;
  private running = false;
  private accepting = false;
  private paused = false;
  private pool: StreamPool;
  private releases = new WeakMap<SpeechStream, () => void>();
  private flushing = false;
  private failed = false;
  private stopped = false;
  private lastPacketAt: number | null = null;
  private replayMode = false;
  private peakReservations = 0;
  private leaseDeadline = 0;
  readonly provider: ReturnZero;
  constructor(
    readonly store: Store,
    readonly config: AppConfig,
    public meeting: MeetingRow,
    private guild: Guild,
    private owner: string,
    private testAdapter?: CaptureTestAdapter,
  ) {
    if (testAdapter && config.NODE_ENV !== 'test') throw new Error('TEST_ADAPTER_NOT_ALLOWED');
    this.provider = new ReturnZero(config);
    this.pool = new StreamPool(config.RTZR_STREAM_CONCURRENCY_LIMIT);
  }
  now() {
    return Math.max(0, this.initialOffset + performance.now() - this.origin);
  }
  async startReplay(participants: ParticipantDTO[]) {
    if (
      this.config.NODE_ENV !== 'test' ||
      !this.testAdapter ||
      this.meeting.runtime.mode !== 'mock'
    )
      throw new Error('REPLAY_NOT_ALLOWED');
    const schema = await first(
      sql<{ name: string }>`SELECT current_schema() AS name`,
      this.store.db,
    );
    if (!schema?.name.startsWith('test_')) throw new Error('REPLAY_REQUIRES_ISOLATED_SCHEMA');
    this.replayMode = true;
    this.initialOffset = Math.max(0, Date.now() - Date.parse(this.meeting.view.started_at!));
    this.origin = performance.now();
    this.running = true;
    this.accepting = true;
    this.leaseDeadline = Date.now() + 14000;
    this.leaseTimer = setInterval(() => void this.renewLease(), 4000);
    for (const p of participants)
      if (
        p.present &&
        p.recording_eligible &&
        (await this.store.consented(this.guild.id, p.user_id))
      )
        this.add(p);
    this.timer = setInterval(() => void this.tick().catch(() => this.storageFailure()), 100);
    await this.store.audit(
      this.store.db,
      this.guild.id,
      this.meeting.id,
      this.owner,
      'REPLAY_READY',
      { source: 'TEST_PCM', dave_protocol: null },
    );
  }
  ingestReplay(userId: string, pcm: Buffer, at = this.now()) {
    if (!this.replayMode) throw new Error('REPLAY_NOT_STARTED');
    if (!pcm.length || pcm.length % 2) throw new Error('INVALID_PCM');
    const t = this.tracks.get(userId);
    if (!t) throw new Error('UNKNOWN_REPLAY_TRACK');
    if (
      !t.eligible ||
      !this.running ||
      !this.accepting ||
      this.paused ||
      Date.now() >= this.leaseDeadline
    ) {
      t.counters.blocked_pcm_bytes += pcm.length;
      return;
    }
    t.decodedBytes += pcm.length;
    t.counters.accepted_pcm_bytes += pcm.length;
    this.pcm(t, pcm, Math.max(0, Math.round(at)));
  }
  async settled() {
    await Promise.all([...this.tracks.values()].flatMap((t) => [t.persist, t.mutation]));
  }
  async start(participants: ParticipantDTO[], resume = false) {
    this.leaseDeadline = Date.now() + 14000;
    this.leaseTimer = setInterval(() => void this.renewLease(), 4000);
    this.connection = joinVoiceChannel({
      channelId: this.meeting.voice_channel_id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this.connection.on('error', () => void this.voiceLost());
    this.connection.on(VoiceConnectionStatus.Disconnected, () => void this.voiceLost());
    for (let attempt = 0; ; attempt++) {
      try {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 10000);
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        this.connection.rejoin();
      }
    }
    if (!resume) {
      let noticeAt = 0;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const notice = await first(
          sql<{
            updated_at: Date;
          }>`SELECT updated_at FROM outbox WHERE entity_id=${this.meeting.id}::uuid AND kind='RECORDING' AND status='SENT' ORDER BY revision DESC LIMIT 1`,
          this.store.db,
        );
        if (notice) {
          noticeAt = notice.updated_at.getTime();
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!noticeAt) throw new Error('RECORDING_NOTICE_NOT_DELIVERED');
      await new Promise((r) => setTimeout(r, Math.max(0, noticeAt + 5000 - Date.now())));
      this.meeting = await this.store.transition(
        this.guild.id,
        this.meeting.id,
        'RECORDING',
        this.meeting.fencing,
      );
    }
    this.initialOffset = this.meeting.view.started_at
      ? Date.now() - Date.parse(this.meeting.view.started_at)
      : 0;
    this.origin = performance.now();
    this.running = true;
    this.accepting = true;
    this.paused = this.meeting.status === 'PAUSED';
    this.leaseDeadline = Date.now() + 14000;
    if (resume) await this.store.recoverPendingAudio(this.guild.id, this.meeting.id, this.now());
    const latest = (await this.store.snapshot(this.guild.id, this.meeting.id)).participants;
    if (!this.paused)
      for (const p of latest)
        if (
          p.present &&
          p.recording_eligible &&
          (await this.store.consented(this.guild.id, p.user_id))
        )
          this.add(p);
    this.timer = setInterval(() => void this.tick().catch(() => this.storageFailure()), 100);
    await this.store.audit(
      this.store.db,
      this.guild.id,
      this.meeting.id,
      this.owner,
      'VOICE_READY',
      { dave_protocol: this.daveProtocol(), node: process.version, voice_version: '0.19.2' },
    );
  }
  private async renewLease() {
    try {
      if (!(await this.store.heartbeat(this.meeting.id, this.owner, this.meeting.fencing)))
        throw new Error();
      this.leaseDeadline = Date.now() + 14000;
    } catch {
      this.running = false;
      for (const t of this.tracks.values()) this.disable(t);
      this.disconnect();
    }
  }
  update(participants: ParticipantDTO[]) {
    for (const p of participants) {
      const track = this.tracks.get(p.user_id);
      if (!p.present || !p.recording_eligible || this.paused) {
        if (track) this.disable(track);
      } else if (!track || !track.eligible) this.add(p);
      else track.name = p.display_name;
    }
  }
  private add(p: ParticipantDTO) {
    if ((!this.connection && !this.replayMode) || !this.running || this.paused) return;
    const previous = this.tracks.get(p.user_id);
    if (previous) this.disable(previous);
    const worker = this.replayMode
      ? null
      : new Worker(new URL('./audio-worker.mjs', import.meta.url));
    const subscription = this.replayMode
      ? null
      : this.connection!.receiver.subscribe(p.user_id, {
          end: { behavior: EndBehaviorType.Manual },
        });
    const t: Track = {
      id: p.user_id,
      name: p.display_name,
      gate: Date.now(),
      eligible: true,
      worker,
      subscription,
      inflight: 0,
      packets: 0,
      decodedBytes: 0,
      decodeErrors: 0,
      decoder: 'initializing',
      ring: [],
      frames: [],
      lastSpeech: -Infinity,
      lastFinalEnd: 0,
      resumeAfter: 0,
      finalsByEpoch: new Map(),
      stream: null,
      opening: false,
      queued: false,
      queueAbort: null,
      lastFrame: 0,
      epoch: null,
      offset: 0,
      nextAt: 0,
      finalized: false,
      archive: [],
      archiveStart: 0,
      archiveBytes: 0,
      persist: Promise.resolve(),
      pendingArchiveBytes: 0,
      usageAt: 0,
      gap: null,
      counters: previous?.counters ?? {
        archived_pcm_bytes: 0,
        sent_pcm_bytes: 0,
        accepted_pcm_bytes: 0,
        blocked_pcm_bytes: 0,
      },
      failures: 0,
      retryAt: 0,
      pendingPartial: null,
      partialAt: 0,
      mutation: Promise.resolve(),
    };
    this.tracks.set(p.user_id, t);
    if (!worker || !subscription) {
      t.decoder = 'replay-pcm';
      return;
    }
    subscription.on('data', (packet: Buffer) => {
      if (
        !t.eligible ||
        !this.running ||
        !this.accepting ||
        this.paused ||
        Date.now() >= this.leaseDeadline
      )
        return;
      if (t.inflight >= 250) {
        void this.trackFailure(t, 'DECODE_BACKPRESSURE');
        return;
      }
      t.inflight++;
      t.packets++;
      this.lastPacketAt = Date.now();
      worker.postMessage({ packet: Uint8Array.from(packet), capture_ms: this.now(), gate: t.gate });
    });
    subscription.on('error', () => void this.trackFailure(t, 'VOICE_RECEIVE_ERROR'));
    worker.on('message', (m) => {
      if (m.type === 'ready') {
        t.decoder = m.decoder;
        return;
      }
      t.inflight = Math.max(0, t.inflight - 1);
      if (!t.eligible || !this.running || this.paused || m.gate !== t.gate) return;
      if (m.type === 'decode_error') {
        t.decodeErrors++;
        void this.trackFailure(t, 'DECODE_ERROR');
        return;
      }
      const pcm = Buffer.from(m.pcm);
      t.decodedBytes += pcm.length;
      t.counters.accepted_pcm_bytes += pcm.length;
      this.pcm(t, pcm, Math.max(0, Math.round(m.capture_ms - pcm.length / 32)));
    });
    worker.on('error', () => void this.trackFailure(t, 'DECODE_WORKER_ERROR'));
  }
  private pcm(t: Track, pcm: Buffer, start: number) {
    start = captureFrameStart(start, t.lastFrame || null);
    t.lastFrame = start + pcm.length / 32;
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
    const speech = Math.sqrt(sum / (pcm.length / 2)) > 120;
    if (speech) {
      t.lastSpeech = start + pcm.length / 32;
      t.finalized = false;
    }
    this.archive(t, pcm, start);
    const frame = { start, pcm };
    t.ring.push(frame);
    t.ring = t.ring.filter((f) => f.start + f.pcm.length / 32 > start - 500);
    if (t.stream || t.opening || t.queued) {
      t.frames.push(frame);
      if (t.frames.reduce((n, f) => n + f.pcm.length, 0) > 160000) {
        if (t.queued || t.opening) {
          while (t.frames.reduce((n, f) => n + f.pcm.length, 0) > 160000) t.frames.shift();
        } else void this.trackFailure(t, 'STT_BUFFER_OVERFLOW');
      }
    } else if (speech && Date.now() >= t.retryAt) void this.open(t);
  }
  private archive(t: Track, pcm: Buffer, start: number) {
    const expected = t.archiveStart + t.archiveBytes / 32;
    if (t.archiveBytes && (start - expected > 2000 || start < expected - 100)) {
      void this.flushArchive(t);
    }
    if (!t.archiveBytes) t.archiveStart = start;
    const gap = Math.max(0, Math.round(start - (t.archiveStart + t.archiveBytes / 32)));
    if (gap > 0 && gap <= 2000) {
      const silence = Buffer.alloc(gap * 32);
      t.archive.push(silence);
      t.archiveBytes += silence.length;
    }
    t.archive.push(pcm);
    t.archiveBytes += pcm.length;
    if (t.archiveBytes >= 960000) void this.flushArchive(t);
  }
  private async flushArchive(t: Track) {
    if (!t.archiveBytes) return;
    const pcm = Buffer.concat(t.archive),
      start = t.archiveStart,
      end = Math.round(start + pcm.length / 32),
      gate = t.gate;
    t.archive = [];
    t.archiveBytes = 0;
    t.pendingArchiveBytes += pcm.length;
    if (t.pendingArchiveBytes > 1920000) {
      void this.storageFailure();
      return;
    }
    t.persist = t.persist
      .then(async () => {
        if (gate !== t.gate) return;
        await this.testAdapter?.beforeArchive?.();
        if (gate !== t.gate) return;
        const id = randomUUID(),
          flac = await pcmToFlac(pcm),
          ref = `${this.meeting.id}/${t.id}/${id}.flac.enc`;
        const current = await this.store.meeting(this.guild.id, this.meeting.id);
        this.store.assertFence(current, this.meeting.fencing);
        if (gate !== t.gate) return;
        const checksum = await writeEncrypted(
          this.config.RECORDING_STORAGE_PATH,
          ref,
          flac,
          this.config.AUDIO_ENCRYPTION_KEY,
          id,
        );
        try {
          await this.store.withMeeting(this.guild.id, this.meeting.id, async (tx, m) => {
            this.store.assertFence(m, this.meeting.fencing);
            if (gate !== t.gate)
              throw Object.assign(new Error('CAPTURE_CANCELLED'), { code: 'CAPTURE_CANCELLED' });
            await sql`INSERT INTO audio_chunks(id,meeting_id,user_id,start_ms,end_ms,storage_ref,checksum) VALUES(${id},${this.meeting.id},${t.id},${start},${end},${ref},${checksum})`.execute(
              tx,
            );
          });
          t.counters.archived_pcm_bytes += pcm.length;
        } catch (e) {
          await rm(safeAudioPath(this.config.RECORDING_STORAGE_PATH, ref), { force: true });
          throw e;
        }
      })
      .catch((e) => {
        if (e?.code !== 'CAPTURE_CANCELLED') void this.storageFailure();
      })
      .finally(() => {
        t.pendingArchiveBytes -= pcm.length;
      });
    await t.persist;
  }
  private async open(t: Track) {
    if (t.opening || t.stream || t.queued || !t.eligible || !this.accepting) return;
    t.queued = true;
    t.queueAbort = new AbortController();
    t.frames = t.ring
      .filter((f) => f.start + f.pcm.length / 32 > t.resumeAfter)
      .map((f) => {
        const start = Math.max(f.start, t.resumeAfter);
        return { start, pcm: f.pcm.subarray(Math.round((start - f.start) * 16) * 2) };
      });
    const waitingStart = t.frames[0]?.start ?? this.now(),
      gate = t.gate;
    let release: (() => void) | null = null;
    let stream: SpeechStream | null = null;
    try {
      const reservation = this.pool.acquire(t.id, t.queueAbort.signal);
      this.peakReservations = Math.max(this.peakReservations, this.pool.activeCount);
      this.testAdapter?.streamEvent?.(t.id, 'queued', this.now());
      let gapWrite: Promise<void> = Promise.resolve();
      if (this.pool.waitingCount && !t.gap) {
        t.gap = {
          gap_id: randomUUID(),
          user_id: t.id,
          start_ms: Math.round(waitingStart),
          end_ms: null,
          reason: 'STT_PENDING',
          recoverable: true,
          resolved: false,
        };
        gapWrite = this.store.gap(this.guild.id, this.meeting.id, t.gap);
        void gapWrite.catch(() => this.storageFailure());
      }
      release = await reservation;
      await gapWrite;
      t.queued = false;
      if (!t.eligible || !this.running || !this.accepting || this.paused || gate !== t.gate) return;
      t.opening = true;
      const epoch = randomUUID();
      t.epoch = epoch;
      t.offset = t.frames[0]?.start ?? waitingStart;
      t.nextAt = t.offset;
      t.lastFinalEnd = Math.max(t.lastFinalEnd, t.offset);
      let streamOffset = t.offset;
      this.testAdapter?.streamEvent?.(t.id, 'opening', this.now());
      stream = this.testAdapter
        ? this.testAdapter.stream(t.id, this.meeting.settings.glossary)
        : this.provider.stream(this.meeting.settings.glossary);
      const ownedStream = stream;
      stream.on('closed', () => {
        this.releases.get(ownedStream)?.();
        this.releases.delete(ownedStream);
        this.testAdapter?.streamEvent?.(t.id, 'closed', this.now());
      });
      this.releases.set(stream, release);
      release = null;
      stream.on('transcript', (message: SttMessage) => {
        if (gate !== t.gate) return;
        if (message.final) {
          if (t.pendingPartial?.epoch === epoch) t.pendingPartial = null;
          t.mutation = t.mutation
            .then(() => this.persistTranscript(t, message, epoch, streamOffset))
            .catch(() => this.storageFailure());
        } else {
          if (t.epoch !== epoch) return;
          t.pendingPartial = { message, epoch, offset: streamOffset };
          if (Date.now() - t.partialAt >= 500) this.flushPartial(t);
        }
      });
      stream.on('failure', () => {
        if (t.epoch === epoch) void this.trackFailure(t, 'STT_DISCONNECTED');
      });
      await stream.open();
      if (!t.eligible || !this.running || !this.accepting || this.paused || gate !== t.gate) {
        stream.abort();
        return;
      }
      // Leave one tick of headroom when a full queue becomes a live stream.
      // Any older audio remains archived and the gap below schedules its recovery.
      while (t.frames.reduce((n, f) => n + f.pcm.length, 0) > 144000) t.frames.shift();
      t.offset = t.frames[0]?.start ?? waitingStart;
      t.nextAt = t.offset;
      streamOffset = t.offset;
      if (!t.gap && t.offset > waitingStart + 100)
        t.gap = {
          gap_id: randomUUID(),
          user_id: t.id,
          start_ms: Math.round(waitingStart),
          end_ms: null,
          reason: 'STT_PENDING',
          recoverable: true,
          resolved: false,
        };
      t.opening = false;
      t.stream = stream;
      this.testAdapter?.streamEvent?.(t.id, 'open', this.now());
      t.failures = 0;
      await sql`INSERT INTO stt_streams(id,meeting_id,user_id,offset_ms,fencing,status) VALUES(${epoch},${this.meeting.id},${t.id},${Math.round(t.offset)},${this.meeting.fencing}::bigint,'OPEN')`.execute(
        this.store.db,
      );
      if (t.gap) {
        const gap = {
          ...t.gap,
          end_ms: Math.max(t.gap.start_ms, Math.round(t.offset)),
          resolved: t.offset <= t.gap.start_ms,
        };
        await this.store.gap(this.guild.id, this.meeting.id, gap);
        if (!gap.resolved) await this.queueRecovery(t, gap);
        t.gap = null;
      }
    } catch (e) {
      stream?.abort();
      if (
        t.eligible &&
        this.running &&
        this.accepting &&
        (e as any)?.code !== 'STREAM_QUEUE_CANCELLED'
      )
        await this.trackFailure(t, 'STT_CONNECT_FAILED');
    } finally {
      release?.();
      t.queued = false;
      t.opening = false;
    }
  }
  private async persistTranscript(t: Track, message: SttMessage, epoch: string, offset = t.offset) {
    const saved = await this.store.upsertTranscript({
      guildId: this.guild.id,
      meetingId: this.meeting.id,
      userId: t.id,
      displayName: t.name,
      sourceKey: `${t.id}:${epoch}:${message.seq}`,
      start: offset + message.start_at,
      end: offset + message.start_at + message.duration,
      text: message.text,
      final: message.final,
      fencing: this.meeting.fencing,
    });
    if (saved) this.testAdapter?.committed?.(saved, Date.now());
    if (message.final)
      t.lastFinalEnd = Math.max(t.lastFinalEnd, offset + message.start_at + message.duration);
    if (message.final)
      t.finalsByEpoch.set(
        epoch,
        Math.max(
          t.finalsByEpoch.get(epoch) ?? offset,
          offset + message.start_at + message.duration,
        ),
      );
  }
  private flushPartial(t: Track) {
    const message = t.pendingPartial;
    if (!message) return;
    t.pendingPartial = null;
    t.partialAt = Date.now();
    t.mutation = t.mutation
      .then(() => this.persistTranscript(t, message.message, message.epoch, message.offset))
      .catch(() => this.storageFailure());
  }
  private async tick() {
    if (this.flushing || !this.running) return;
    this.flushing = true;
    try {
      for (const t of this.tracks.values()) {
        if (!t.eligible || this.paused || Date.now() >= this.leaseDeadline) continue;
        if (t.pendingPartial && Date.now() - t.partialAt >= 500 && t.epoch) this.flushPartial(t);
        if (t.archiveBytes && this.now() - t.lastFrame > 2000) void this.flushArchive(t);
        if (t.queued && this.now() - t.lastSpeech > 2000) {
          t.queueAbort?.abort();
          t.frames = [];
          if (t.gap) {
            const gap = { ...t.gap, end_ms: Math.max(t.gap.start_ms, Math.round(t.lastFrame)) };
            t.gap = null;
            await this.store.gap(this.guild.id, this.meeting.id, gap);
            await this.queueRecovery(t, gap);
          }
          continue;
        }
        if (!t.stream) {
          if (
            !t.queued &&
            !t.opening &&
            t.ring.length &&
            this.now() - t.lastSpeech < 1000 &&
            Date.now() >= t.retryAt
          )
            void this.open(t);
          continue;
        }
        let n = 0;
        while (t.nextAt + 100 <= this.now() && n++ < 50) {
          const pcm = Buffer.alloc(3200),
            end = t.nextAt + 100;
          for (const frame of t.frames) {
            const from = Math.max(t.nextAt, frame.start),
              to = Math.min(end, frame.start + frame.pcm.length / 32);
            if (to <= from) continue;
            const src = Math.max(0, Math.round(((from - frame.start) * 32) / 2) * 2),
              dest = Math.max(0, Math.round(((from - t.nextAt) * 32) / 2) * 2),
              length = Math.min(
                Math.round(((to - from) * 32) / 2) * 2,
                pcm.length - dest,
                frame.pcm.length - src,
              );
            if (length > 0) frame.pcm.copy(pcm, dest, src, src + length);
          }
          try {
            if (!t.eligible || !this.accepting || this.paused) break;
            t.stream.send(pcm);
            t.counters.sent_pcm_bytes += pcm.length;
          } catch {
            await this.trackFailure(t, 'STT_SEND_FAILED');
            break;
          }
          t.nextAt = end;
          t.frames = t.frames.filter((f) => f.start + f.pcm.length / 32 > end);
        }
        if (t.stream && Date.now() - t.usageAt >= 5000) {
          t.usageAt = Date.now();
          await this.store.usage(
            this.guild.id,
            this.meeting.id,
            `stream:${t.epoch}`,
            'returnzero',
            (Math.max(10000, t.stream.sentMs) / 3600000) * 1000,
            {
              audio_ms: Math.round(t.stream.sentMs),
              is_mock: this.testAdapter?.mockUsage ?? false,
            },
          );
        }
        if (
          t.stream &&
          this.now() - t.lastSpeech >= 800 &&
          !t.finalized &&
          t.nextAt >= t.lastSpeech
        ) {
          t.stream.finalize();
          t.finalized = true;
        }
        if (
          t.stream &&
          (this.now() - t.lastSpeech >= 15000 ||
            (this.pool.waitingCount > 0 &&
              (this.now() - t.lastSpeech >= 800 || t.stream.sentMs >= 60000)))
        )
          void this.closeStream(t).catch(() => this.storageFailure());
      }
    } finally {
      this.flushing = false;
    }
  }
  private async closeStream(t: Track) {
    const stream = t.stream,
      epoch = t.epoch;
    if (!stream) return;
    const sourceOffset = t.offset,
      sentUntil = t.nextAt,
      lastSpeech = t.lastSpeech;
    t.resumeAfter = Math.max(t.resumeAfter, sentUntil);
    t.stream = null;
    await stream.end();
    await t.mutation;
    const finalEnd = t.finalsByEpoch.get(epoch!) ?? sourceOffset;
    if (lastSpeech > finalEnd + 100 && this.running && t.eligible && !this.paused) {
      const gap: GapDTO = {
        gap_id: randomUUID(),
        user_id: t.id,
        start_ms: Math.round(finalEnd),
        end_ms: Math.round(Math.min(lastSpeech, sentUntil)),
        reason: 'STT_PENDING',
        recoverable: true,
        resolved: false,
      };
      if (gap.end_ms! > gap.start_ms) {
        await this.store.gap(this.guild.id, this.meeting.id, gap);
        await this.queueRecovery(t, gap);
      }
    }
    t.finalsByEpoch.delete(epoch!);
    await this.store.usage(
      this.guild.id,
      this.meeting.id,
      `stream:${epoch}`,
      'returnzero',
      (Math.max(10000, stream.sentMs) / 3600000) * 1000,
      { audio_ms: Math.round(stream.sentMs), is_mock: this.testAdapter?.mockUsage ?? false },
    );
    await sql`UPDATE stt_streams SET status='CLOSED',closed_at=now() WHERE id=${epoch}::uuid`.execute(
      this.store.db,
    );
  }
  private async trackFailure(t: Track, reason: string) {
    if (!this.running || this.paused || !t.eligible) return;
    if (t.stream) {
      const failed = t.stream;
      void this.store
        .usage(
          this.guild.id,
          this.meeting.id,
          `stream:${t.epoch}`,
          'returnzero',
          (Math.max(10000, failed.sentMs) / 3600000) * 1000,
          { audio_ms: Math.round(failed.sentMs), is_mock: this.testAdapter?.mockUsage ?? false },
        )
        .catch(() => {});
      t.stream.abort();
      t.stream = null;
      t.resumeAfter = t.lastFinalEnd;
    }
    t.frames = [];
    t.pendingPartial = null;
    t.failures++;
    t.retryAt =
      Date.now() +
      Math.min(30000, 1000 * 2 ** Math.min(t.failures, 5)) * (0.75 + Math.random() * 0.5);
    if (!t.gap) {
      t.gap = {
        gap_id: randomUUID(),
        user_id: t.id,
        start_ms: Math.round(t.lastFinalEnd || t.offset || this.now()),
        end_ms: null,
        reason:
          reason.startsWith('DECODE') || reason === 'VOICE_RECEIVE_ERROR'
            ? 'VOICE_LOST'
            : 'STT_PENDING',
        recoverable: !reason.startsWith('DECODE') && reason !== 'VOICE_RECEIVE_ERROR',
        resolved: false,
      };
      await this.store
        .gap(this.guild.id, this.meeting.id, t.gap)
        .catch(() => this.storageFailure());
    }
    if (this.meeting.status === 'RECORDING') {
      this.meeting = await this.store
        .transition(this.guild.id, this.meeting.id, 'DEGRADED', this.meeting.fencing)
        .catch(() => this.meeting);
    }
  }
  private async queueRecovery(t: Track, gap: GapDTO) {
    if (
      !t.eligible ||
      this.paused ||
      !gap.recoverable ||
      gap.end_ms === null ||
      gap.end_ms <= gap.start_ms
    )
      return;
    const gate = t.gate;
    await this.flushArchive(t);
    if (gate !== t.gate || !t.eligible) return;
    const key = `recover:${this.meeting.id}:${t.id}:${hash(JSON.stringify([gap.start_ms, gap.end_ms, this.meeting.settings.glossary_version]))}`;
    await this.store.enqueueRecovery(
      this.guild.id,
      this.meeting.id,
      key,
      {
        guild_id: this.guild.id,
        user_id: t.id,
        start_ms: gap.start_ms,
        end_ms: gap.end_ms,
        gap_id: gap.gap_id,
      },
      new Date(Date.now() + 1000),
    );
  }
  private disable(t: Track) {
    t.eligible = false;
    t.queueAbort?.abort();
    t.gate++;
    t.subscription?.destroy();
    void t.worker?.terminate();
    t.frames = [];
    t.ring = [];
    t.archive = [];
    t.archiveBytes = 0;
    t.pendingPartial = null;
    void this.closeStream(t).catch(() => {});
  }
  async revoke(userId: string) {
    const t = this.tracks.get(userId);
    if (t) {
      this.disable(t);
      await t.persist;
      await t.mutation;
    }
  }
  async pause() {
    this.accepting = false;
    this.paused = true;
    for (const t of this.tracks.values()) this.disable(t);
    await this.settled();
  }
  async resume(participants: ParticipantDTO[]) {
    this.accepting = true;
    this.paused = false;
    this.update(participants);
  }
  private async storageFailure() {
    if (this.failed) return;
    this.failed = true;
    this.running = false;
    for (const t of this.tracks.values()) this.disable(t);
    this.disconnect();
    await this.store
      .gap(this.guild.id, this.meeting.id, {
        gap_id: randomUUID(),
        user_id: null,
        start_ms: Math.round(this.now()),
        end_ms: null,
        reason: 'STORAGE_ERROR',
        recoverable: false,
        resolved: false,
      })
      .catch(() => {});
    setTimeout(() => void this.stop().catch(() => this.abort()), 0);
  }
  private recoveringVoice = false;
  private async voiceLost() {
    if (this.stopped || this.recoveringVoice || !this.connection) return;
    this.recoveringVoice = true;
    const start = Math.round(this.now());
    const gap: GapDTO = {
      gap_id: randomUUID(),
      user_id: null,
      start_ms: start,
      end_ms: null,
      reason: 'VOICE_LOST',
      recoverable: false,
      resolved: false,
    };
    await this.store.gap(this.guild.id, this.meeting.id, gap).catch(() => {});
    for (const t of this.tracks.values()) this.disable(t);
    if (this.meeting.status === 'RECORDING')
      this.meeting = await this.store
        .transition(this.guild.id, this.meeting.id, 'DEGRADED', this.meeting.fencing)
        .catch(() => this.meeting);
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 120000);
      await this.store.gap(this.guild.id, this.meeting.id, {
        ...gap,
        end_ms: Math.round(this.now()),
      });
      const snapshot = await this.store.snapshot(this.guild.id, this.meeting.id);
      this.update(snapshot.participants);
      if (!this.paused && this.meeting.status === 'DEGRADED')
        this.meeting = await this.store.transition(
          this.guild.id,
          this.meeting.id,
          'RECORDING',
          this.meeting.fencing,
        );
    } catch {
      await this.stop();
    } finally {
      this.recoveringVoice = false;
    }
  }
  private disconnect() {
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed)
      this.connection.destroy();
  }
  abort() {
    this.stopped = true;
    this.running = false;
    this.accepting = false;
    if (this.timer) clearInterval(this.timer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    for (const t of this.tracks.values()) this.disable(t);
    this.disconnect();
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.accepting = false;
    const all = [...this.tracks.values()];
    try {
      this.meeting = await this.store.transition(
        this.guild.id,
        this.meeting.id,
        'STOPPING',
        this.meeting.fencing,
      );
      const drainDeadline = Date.now() + 1000;
      while (all.some((t) => t.inflight > 0) && Date.now() < drainDeadline)
        await new Promise((r) => setTimeout(r, 10));
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      for (const t of all) {
        t.eligible = false;
        t.queueAbort?.abort();
        t.subscription?.destroy();
        void t.worker?.terminate();
        if (t.stream && t.frames.length) {
          const end = Math.max(...t.frames.map((f) => f.start + f.pcm.length / 32));
          while (t.nextAt < end) {
            const length = Math.min(6400, Math.max(2, Math.ceil((end - t.nextAt) * 16) * 2)),
              pcm = Buffer.alloc(length);
            for (const f of t.frames) {
              const from = Math.max(t.nextAt, f.start),
                to = Math.min(t.nextAt + length / 32, f.start + f.pcm.length / 32);
              if (to > from)
                f.pcm.copy(
                  pcm,
                  Math.round((from - t.nextAt) * 16) * 2,
                  Math.round((from - f.start) * 16) * 2,
                  Math.round((to - f.start) * 16) * 2,
                );
            }
            try {
              t.stream.send(pcm);
              t.counters.sent_pcm_bytes += pcm.length;
            } catch {
              break;
            }
            t.nextAt += length / 32;
          }
        }
        t.frames = [];
        t.ring = [];
      }
      await Promise.all(
        all.map(async (t) => {
          await this.flushArchive(t);
          if (t.gap) {
            const gap = { ...t.gap, end_ms: Math.round(this.now()) };
            await this.store.gap(this.guild.id, this.meeting.id, gap);
            await this.queueRecovery(t, gap);
          }
          await this.closeStream(t);
          await t.mutation;
        }),
      );
      const snapshot = await this.store.snapshot(this.guild.id, this.meeting.id);
      for (const d of snapshot.segments.filter((s) => !s.is_final)) {
        const t = this.tracks.get(d.user_id);
        if (t) {
          const gap: GapDTO = {
            gap_id: randomUUID(),
            user_id: d.user_id,
            start_ms: d.start_ms,
            end_ms: Math.round(this.now()),
            reason: 'STT_PENDING',
            recoverable: true,
            resolved: false,
          };
          await this.store.gap(this.guild.id, this.meeting.id, gap);
          await this.queueRecovery(t, gap);
        }
      }
      await this.store.clearDrafts(this.guild.id, this.meeting.id);
      await this.store.audit(
        this.store.db,
        this.guild.id,
        this.meeting.id,
        this.owner,
        'VOICE_CAPTURE_STATS',
        this.metrics(),
      );
      this.disconnect();
      await this.store.transition(
        this.guild.id,
        this.meeting.id,
        'FINALIZING',
        this.meeting.fencing,
      );
    } finally {
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      for (const t of all) {
        t.eligible = false;
        t.queueAbort?.abort();
        t.subscription?.destroy();
        void t.worker?.terminate();
        t.stream?.abort();
      }
      this.disconnect();
    }
  }
  private daveProtocol() {
    return (this.connection?.state as any)?.networking?.state?.dave?.protocolVersion ?? null;
  }
  metrics() {
    return {
      source: this.replayMode ? 'TEST_PCM_REPLAY' : 'DISCORD',
      peak_reservations: this.peakReservations,
      dave_protocol: this.daveProtocol(),
      users: [...this.tracks.values()].map((t) => ({
        user_id: t.id,
        packets: t.packets,
        decoded_bytes: t.decodedBytes,
        decode_errors: t.decodeErrors,
        decoder: t.decoder,
        ...t.counters,
        buffered_pcm_bytes: t.frames.reduce((n, f) => n + f.pcm.length, 0),
        pending_archive_bytes: t.pendingArchiveBytes,
        ssrc: this.connection?.receiver.ssrcMap.get(t.id)?.audioSSRC ?? null,
      })),
      tracks: this.tracks.size,
      open_streams: this.pool.activeCount,
      queued_streams: this.pool.waitingCount,
      queued_users: this.pool.waitingKeys,
      last_packet_at: this.lastPacketAt,
      status: this.meeting.status,
      storage_failed: this.failed,
      decoder_workers: [...this.tracks.values()].filter((t) => t.eligible).length,
    };
  }
}

import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, first } from "@meeting/db";
import { Capture } from "../../apps/bot/src/capture.ts";
import { fixture, guild, user } from "./helpers.ts";
it("after-meeting capture saves audio without opening ReturnZero and queues only at stop", async () => {
  const f = await fixture(); const directory = await mkdtemp(join(tmpdir(), "soniox-capture-"));
  const stream = vi.fn(() => { throw new Error("ReturnZero must not open"); });
  let capture: Capture | undefined;
  try {
    const meeting = await f.begin();
    capture = new Capture(f.store, { ...f.config, STT_PROVIDER: "soniox", TRANSCRIPTION_MODE: "after_meeting", AUDIO_RETENTION: "forever", RECORDING_STORAGE_PATH: directory }, meeting, { id: guild } as any, "test", { stream });
    await capture.startReplay((await f.store.snapshot(guild, meeting.id)).participants);
    const pcm = Buffer.alloc(32000); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
    capture.ingestReplay(user, pcm, 0);
    await capture.pause();
    expect(stream).not.toHaveBeenCalled();
    expect((await first<any>(sql`SELECT count(*) AS n FROM jobs WHERE meeting_id=${meeting.id}::uuid AND kind='RETRANSCRIBE'`, f.store.db))?.n).toBe("0");
    await capture.stop();
    expect(stream).not.toHaveBeenCalled();
    expect(Number((await first<any>(sql`SELECT count(*) AS n FROM jobs WHERE meeting_id=${meeting.id}::uuid AND kind='RETRANSCRIBE'`, f.store.db))?.n)).toBeGreaterThan(0);
    expect(Number((await first<any>(sql`SELECT count(*) AS n FROM audio_chunks WHERE meeting_id=${meeting.id}::uuid AND expires_at='infinity'`, f.store.db))?.n)).toBeGreaterThan(0);
  } finally { capture?.abort(); await f.dispose(); await rm(directory, { recursive: true, force: true }); }
});

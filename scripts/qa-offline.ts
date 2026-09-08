import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ReturnZero, loadConfig } from '@meeting/providers';
const directory = resolve(process.argv[2] ?? '.data/qa/offline-20260907');
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const manifestPath = resolve(directory, 'manifest.json');
let manifest: any;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
  manifest = {
    source_kind: 'offline_mixed_audio',
    duration_ms: 3849835,
    reported_participants_minimum: 10,
    recorded_at: null,
    identity_mapping: 'unverified automatic speaker clusters',
    publication: 'private local QA files only',
  };
}
const save = () =>
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
const provider = new ReturnZero(loadConfig());
if (!manifest.transcribe_id) {
  if (manifest.request_started_at)
    throw new Error('An earlier upload is uncertain; do not resubmit without reconciling it.');
  const audio = await readFile(resolve(directory, 'input.flac'));
  manifest.input_sha256 = createHash('sha256').update(audio).digest('hex');
  manifest.request_config ??= {
    model_name: 'sommers',
    use_diarization: true,
    diarization: {},
    use_word_timestamp: true,
    use_paragraph_splitter: false,
    use_itn: true,
    use_disfluency_filter: false,
    use_profanity_filter: false,
    use_punctuation: true,
  };
  manifest.request_started_at = new Date().toISOString();
  await save();
  const form = new FormData();
  form.set('config', JSON.stringify(manifest.request_config));
  form.set(
    'file',
    new Blob([new Uint8Array(audio)], { type: 'audio/flac' }),
    'offline-meeting-qa.flac',
  );
  const response = await fetch('https://openapi.vito.ai/v1/transcribe', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (await provider.authenticate()) },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    manifest.submission_http_status = response.status;
    await save();
    throw new Error('Offline STT upload failed: HTTP ' + response.status);
  }
  const result = (await response.json()) as { id?: string };
  if (!result.id) throw new Error('No transcription job ID returned');
  manifest.transcribe_id = result.id;
  manifest.submitted_at = new Date().toISOString();
  await save();
  process.stdout.write('Offline file STT submitted (private QA).\n');
}
if (manifest.completed_at) {
  process.stdout.write('Previously completed transcription reused.\n');
  process.exit(0);
}
let lastStatus = '';
const deadline = Date.now() + 3600000;
while (Date.now() < deadline) {
  const response = await fetch(
    'https://openapi.vito.ai/v1/transcribe/' + encodeURIComponent(manifest.transcribe_id),
    {
      headers: { Authorization: 'Bearer ' + (await provider.authenticate()) },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (response.status === 429 || response.status >= 500) {
    await new Promise((r) => setTimeout(r, 15000));
    continue;
  }
  if (!response.ok) throw new Error('Offline STT status: HTTP ' + response.status);
  const result = (await response.json()) as any;
  if (result.status !== lastStatus) {
    lastStatus = result.status;
    process.stdout.write('Offline file STT status: ' + lastStatus + '\n');
  }
  if (result.status === 'failed') {
    manifest.failure = result.error?.code ?? 'FAILED';
    await save();
    throw new Error('Offline STT failed: ' + manifest.failure);
  }
  if (result.status === 'completed') {
    await writeFile(resolve(directory, 'provider-result.json'), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    const utterances = result.results?.utterances ?? [];
    const speakers = [...new Set(utterances.map((u: any) => u.spk))];
    manifest.completed_at = new Date().toISOString();
    manifest.processing_seconds =
      (Date.parse(manifest.completed_at) - Date.parse(manifest.submitted_at)) / 1000;
    manifest.utterance_count = utterances.length;
    manifest.inferred_speaker_clusters = speakers.length;
    await save();
    process.stdout.write(
      JSON.stringify({
        completed: true,
        processing_seconds: manifest.processing_seconds,
        utterances: utterances.length,
        inferred_speaker_clusters: speakers.length,
        output: 'private QA folder',
      }) + '\n',
    );
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 10000));
}
process.stdout.write(
  'Provider still processing; manifest can resume this job without another upload.\n',
);

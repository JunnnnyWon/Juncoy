import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const outputOption = process.argv.indexOf('--output');
const directory = resolve(
  outputOption >= 0
    ? process.argv[outputOption + 1]!
    : (process.argv[2] ?? '.data/qa/replay-clips'),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const names = [
  '가람',
  '나래',
  '다솜',
  '라온',
  '마루',
  '보람',
  '소담',
  '아라',
  '여울',
  '온유',
  '이든',
  '하람',
];
const run = (cmd: string, args: string[]) =>
  new Promise<void>((done, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (b) => (err += b));
    p.on('error', fail);
    p.on('close', (code) =>
      code === 0 ? done() : fail(new Error(cmd + ' failed: ' + err.slice(-500))),
    );
  });
const clips = [];
for (const [i, name] of names.entries()) {
  const text = `저는 ${name}입니다. 유니티 셰이더 테스트를 진행합니다. 사운드 점검을 마쳤습니다.`;
  const input = resolve(directory, `track-${i}.txt`),
    aiff = resolve(directory, `track-${i}.aiff`),
    pcm = resolve(directory, `track-${i}.pcm`);
  await writeFile(input, text + '\n', { mode: 0o600 });
  await run('/usr/bin/say', ['-v', 'Yuna', '-r', '170', '-f', input, '-o', aiff]);
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    aiff,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    's16le',
    pcm,
  ]);
  const bytes = await readFile(pcm);
  if (bytes.length < 32000 || bytes.length % 2) throw new Error('Invalid synthesized PCM');
  clips.push({
    index: i,
    user_id: (900000000000000010n + BigInt(i)).toString(),
    name,
    text,
    pcm_bytes: bytes.length,
    duration_ms: bytes.length / 32,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  resolve(directory, 'reference.json'),
  JSON.stringify(
    {
      source: 'AUTHORED_LOCAL_TTS',
      voice: 'Yuna',
      sample_rate: 16000,
      channels: 1,
      encoding: 's16le',
      clips,
      terms: ['유니티', '셰이더', '사운드'],
      normalization: {
        nfc: true,
        ignore_space_and_punctuation: true,
        lowercase: true,
        aliases: { Unity: '유니티' },
      },
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    tracks: clips.length,
    total_seconds: clips.reduce((n, c) => n + c.duration_ms / 1000, 0),
    output: directory,
  }) + '\n',
);

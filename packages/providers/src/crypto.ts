import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function encrypt(data: Buffer, key: string, aad = '') {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}
export function decrypt(data: Buffer, key: string, aad = '') {
  if (data[0] !== 1 || data.length < 29) throw new Error('INVALID_ENCRYPTED_PAYLOAD');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), data.subarray(1, 13));
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(data.subarray(13, 29));
  return Buffer.concat([cipher.update(data.subarray(29)), cipher.final()]);
}
export function sealJson(value: unknown, key: string, aad: string) {
  return encrypt(Buffer.from(JSON.stringify(value)), key, aad).toString('base64');
}
export function openJson<T>(value: string, key: string, aad: string): T {
  return JSON.parse(decrypt(Buffer.from(value, 'base64'), key, aad).toString());
}
export function safeAudioPath(base: string, ref: string) {
  const root = resolve(base),
    path = resolve(base, ref);
  if (!path.startsWith(root + sep)) throw new Error('INVALID_AUDIO_PATH');
  return path;
}
export async function writeEncrypted(
  base: string,
  ref: string,
  data: Buffer,
  key: string,
  aad: string,
) {
  const path = safeAudioPath(base, ref);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  const fd = await open(temp, 'wx', 0o600);
  try {
    await fd.writeFile(encrypt(data, key, aad));
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(temp, path);
  return hash(data);
}
export async function readEncrypted(base: string, ref: string, key: string, aad: string) {
  return decrypt(await readFile(safeAudioPath(base, ref)), key, aad);
}
export function ffmpeg(input: Buffer, args: string[], maxBytes = 20_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const buffers: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      process.kill('SIGKILL');
      reject(new Error('AUDIO_CONVERSION_TIMEOUT'));
    }, 60000);
    process.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > maxBytes) {
        process.kill('SIGKILL');
        reject(new Error('AUDIO_CONVERSION_TOO_LARGE'));
      } else buffers.push(b);
    });
    process.stderr.resume();
    process.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    process.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(buffers));
      else reject(new Error('AUDIO_CONVERSION_FAILED'));
    });
    process.stdin.on('error', () => {});
    process.stdin.end(input);
  });
}
export const pcmToFlac = (pcm: Buffer) =>
  ffmpeg(pcm, [
    '-f',
    's16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-i',
    'pipe:0',
    '-c:a',
    'flac',
    '-f',
    'flac',
    'pipe:1',
  ]);
export const flacToPcm = (flac: Buffer) =>
  ffmpeg(flac, ['-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1']);

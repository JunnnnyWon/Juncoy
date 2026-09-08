import 'dotenv/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, mkdir, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
const [mode, path, out] = process.argv.slice(2);
const key = Buffer.from(process.env.AUDIO_ENCRYPTION_KEY ?? '', 'hex');
if (key.length !== 32 || !path) throw new Error('Backup key and path are required');
if (mode === 'encrypt') {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('meeting-backup-v1'));
  const file = await open(path, 'wx', 0o600);
  try {
    await file.write(Buffer.concat([Buffer.from('JMBACKUP1'), nonce]));
    for await (const data of process.stdin) await file.write(cipher.update(data));
    await file.write(cipher.final());
    await file.write(cipher.getAuthTag());
    await file.sync();
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  } finally {
    await file.close();
  }
  process.stdout.write('Encrypted backup saved.\n');
} else if (mode === 'decrypt' && out) {
  const file = await open(path, 'r'),
    size = (await file.stat()).size,
    header = Buffer.alloc(21),
    tag = Buffer.alloc(16);
  await file.read(header, 0, 21, 0);
  await file.read(tag, 0, 16, size - 16);
  await file.close();
  if (size < 37 || header.subarray(0, 9).toString() !== 'JMBACKUP1')
    throw new Error('Invalid backup');
  const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(9));
  cipher.setAAD(Buffer.from('meeting-backup-v1'));
  cipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(path, { start: 21, end: size - 17 }),
      cipher,
      createWriteStream(out, { mode: 0o600, flags: 'wx' }),
    );
  } catch (e) {
    await rm(out, { force: true });
    throw e;
  }
  process.stdout.write('Backup authentication and decryption passed.\n');
} else throw new Error('Use encrypt <backup> or decrypt <backup> <new temporary file>');

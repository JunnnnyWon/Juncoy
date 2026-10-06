import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadStorage } from '@meeting/knowledge';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function storage() {
  const dir = await mkdtemp(join(tmpdir(), 'juncoy-storage-test-'));
  directories.push(dir);
  return new UploadStorage(dir);
}
describe('immutable upload storage', () => {
  it('preserves original bytes and permits identical retries', async () => {
    const store = await storage();
    const original = Buffer.from([0, 255, 128, 4]);
    await store.put('original.png', original);
    await store.put('original.png', original);
    await expect(store.put('original.png', Buffer.from('replacement'))).rejects.toThrow('immutable_storage_conflict');
    expect(await store.read('original.png')).toEqual(original);
    expect(await readdir(store.dir)).toEqual(['original.png']);
  });
  it('does not overwrite a concurrent writer', async () => {
    const store = await storage();
    const results = await Promise.allSettled([store.put('same-key', Buffer.from('a')), store.put('same-key', Buffer.from('b'))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(['a', 'b']).toContain((await store.read('same-key')).toString());
  });
  it('rejects keys escaping the private storage directory', async () => {
    const store = await storage();
    await expect(store.read('../secret')).rejects.toThrow('invalid_storage_key');
    await expect(store.put('/absolute', Buffer.from('x'))).rejects.toThrow('invalid_storage_key');
    await expect(store.remove('../secret')).rejects.toThrow('invalid_storage_key');
  });
});

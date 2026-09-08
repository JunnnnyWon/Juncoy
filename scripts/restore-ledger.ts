import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Store, sql, json } from '@meeting/db';
import { Id, Snowflake } from '@meeting/contracts';
const target = process.argv[2],
  path = process.argv[3];
if (!target || !/^meeting_restore_[a-z0-9_]+$/.test(target) || !path)
  throw new Error('Restore drill requires a dedicated database name and deletion ledger');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + target;
const store = new Store(url.toString());
try {
  let data = '';
  try {
    data = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  for (const line of data.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line),
      id = Id.parse(entry.meeting_id),
      guild = Snowflake.parse(entry.guild_id);
    await store.db.transaction().execute(async (tx) => {
      await sql`INSERT INTO deletion_tombstones(meeting_id,guild_id) VALUES(${id},${guild}) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      await sql`UPDATE meetings SET deleted_at=coalesce(deleted_at,now()),fencing=fencing+1 WHERE id=${id} AND guild_id=${guild}`.execute(
        tx,
      );
      await sql`UPDATE jobs SET status='CANCELLED',generation=generation+1 WHERE meeting_id=${id} AND status IN ('PENDING','RUNNING')`.execute(
        tx,
      );
    });
  }
  process.stdout.write('Current deletion ledger applied to restored database.\n');
} finally {
  await store.close();
}

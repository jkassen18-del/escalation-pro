import fs from 'node:fs';
import path from 'node:path';
import { dbConfig, paths } from '../config.ts';
import { db, initDatabase } from '../db/index.ts';
import { APP_VERSION } from '../../shared/version.ts';
import { createZip, type ZipEntry } from './zip.ts';

/**
 * `InfraTicket.exe export`: packs a tested workspace so it can be carried into
 * an on-prem or cloud install.
 *
 * The database is copied with VACUUM INTO rather than read off disk: the live
 * file may have pages still sitting in the WAL, and a plain copy of it would
 * be missing whatever was written last.
 */
export async function exportWorkspace(target?: string): Promise<string> {
  if (dbConfig.driver !== 'sqlite') {
    throw new Error('Export packs the embedded SQLite workspace. This install uses an external database; back that up with its own tools.');
  }
  await initDatabase();

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const snapshot = path.join(paths.exports, `snapshot-${stamp}.db`);
  fs.mkdirSync(paths.exports, { recursive: true });
  await db.run(`VACUUM INTO ?`, [snapshot]);

  const entries: ZipEntry[] = [
    { name: 'infraticket.db', data: fs.readFileSync(snapshot) },
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify({ app: 'InfraTicket', version: APP_VERSION, exportedAt: new Date().toISOString() }, null, 2)),
    },
  ];
  if (fs.existsSync(paths.uploads)) {
    for (const file of fs.readdirSync(paths.uploads)) {
      const full = path.join(paths.uploads, file);
      if (fs.statSync(full).isFile()) entries.push({ name: `uploads/${file}`, data: fs.readFileSync(full) });
    }
  }
  fs.rmSync(snapshot, { force: true });

  const output = path.resolve(target || path.join(paths.exports, `infraticket-workspace-${stamp}.zip`));
  fs.writeFileSync(output, createZip(entries));
  await db.close();
  return output;
}

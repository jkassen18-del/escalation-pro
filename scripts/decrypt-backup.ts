/**
 * Decrypts an InfraTicket backup without the server or its database:
 *
 *   npm run decrypt-backup -- <backup.sql.gz.enc> [output] [--key-file path]
 *
 * The key comes from BACKUP_KEY, SECRET_KEY or SESSION_SECRET (environment or
 * .env), --key-file, or DATA_DIR/.session-secret. See OPERATIONS.md, Backups.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { decryptBackupCommand } from '../server/ops/backup-format.ts';

dotenv.config();
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
decryptBackupCommand(process.argv.slice(2), [dataDir]).catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});

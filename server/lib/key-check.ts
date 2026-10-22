import { config, IS_PRODUCTION } from '../config.ts';
import { keyFingerprint } from '../ops/backup-format.ts';
import { getOpsSetting, setOpsSetting } from '../repositories/settings.ts';

/**
 * Notices when the encryption key differs from the one this database was
 * written with.
 *
 * Integration tokens, SSO certificates, database connection strings and
 * backup keys are all encrypted with SECRET_KEY (or the session secret). If
 * that key changes - SESSION_SECRET added later, the .session-secret file
 * lost, a copy of the database moved to a new server - every one of them
 * silently reads as "not configured". Recording a fingerprint of the key turns
 * that into one clear error at startup.
 */
export type KeyCheck = 'recorded' | 'match' | 'mismatch-allowed' | 'mismatch';

export async function checkEncryptionKey(options: { key?: Buffer; strict?: boolean } = {}): Promise<KeyCheck> {
  const current = keyFingerprint(options.key ?? config.secretKey);
  const stored = (await getOpsSetting<{ fingerprint: string }>('key_fingerprint', { fingerprint: '' })).fingerprint;
  if (!stored) {
    await setOpsSetting('key_fingerprint', { fingerprint: current, recordedAt: new Date().toISOString() });
    return 'recorded';
  }
  if (stored === current) return 'match';

  if (process.env.ALLOW_KEY_CHANGE === '1') {
    console.warn(
      `[security] The encryption key changed (was ${stored}, now ${current}) and ALLOW_KEY_CHANGE=1 accepts it. ` +
        'Secrets saved with the old key must be entered again. Remove ALLOW_KEY_CHANGE once the server is up.',
    );
    await setOpsSetting('key_fingerprint', { fingerprint: current, recordedAt: new Date().toISOString() });
    return 'mismatch-allowed';
  }

  const message = [
    '',
    '  ============================================================================',
    '  ENCRYPTION KEY MISMATCH',
    `  This database was written with key ${stored}; this server is using ${current}.`,
    '  Saved integration tokens, SSO settings, database connections and backup keys',
    '  cannot be decrypted, so those integrations will look unconfigured.',
    '',
    '  To fix: restore the SECRET_KEY (or SESSION_SECRET, or the data folder\'s',
    '  .session-secret file) this database was used with, then restart.',
    '  To accept the new key and re-enter the secrets instead, start once with',
    '  ALLOW_KEY_CHANGE=1.',
    '  ============================================================================',
    '',
  ].join('\n');
  console.error(message);
  // A laptop copy should still open so its owner can read tickets; a shared
  // server refusing to start is the safer failure.
  const strict = options.strict ?? (IS_PRODUCTION && !process.env.INFRATICKET_PORTABLE);
  if (strict) throw new Error(`Encryption key mismatch (database ${stored}, server ${current}). See the message above.`);
  return 'mismatch';
}

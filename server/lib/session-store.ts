import { Store, type SessionData } from 'express-session';
import { db } from '../db/index.ts';

/**
 * Sessions live in the application database rather than in process memory, so
 * they survive restarts and work when more than one instance is running.
 * express-session's default MemoryStore does neither.
 */
export class DatabaseSessionStore extends Store {
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly sweepIntervalMs = 10 * 60 * 1000) {
    super();
  }

  startSweeper() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void db
        .run(`DELETE FROM sessions WHERE expires_at < ?`, [new Date().toISOString()])
        .catch((error) => console.error('[sessions] sweep failed', error));
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private expiryOf(session: SessionData): string {
    const cookieExpires = session.cookie?.expires;
    if (cookieExpires) return new Date(cookieExpires).toISOString();
    const maxAge = session.cookie?.originalMaxAge ?? 12 * 60 * 60 * 1000;
    return new Date(Date.now() + maxAge).toISOString();
  }

  get(sid: string, callback: (err?: unknown, session?: SessionData | null) => void): void {
    void (async () => {
      try {
        const row = await db.get<{ data: string; expires_at: string }>(
          `SELECT data, expires_at FROM sessions WHERE sid = ?`,
          [sid],
        );
        if (!row) return callback(null, null);
        if (new Date(row.expires_at).getTime() < Date.now()) {
          await db.run(`DELETE FROM sessions WHERE sid = ?`, [sid]);
          return callback(null, null);
        }
        return callback(null, JSON.parse(row.data) as SessionData);
      } catch (error) {
        return callback(error);
      }
    })();
  }

  set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    void (async () => {
      try {
        await db.run(
          `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
          [sid, JSON.stringify(session), this.expiryOf(session)],
        );
        callback?.();
      } catch (error) {
        callback?.(error);
      }
    })();
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    void db
      .run(`DELETE FROM sessions WHERE sid = ?`, [sid])
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  touch(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    void db
      .run(`UPDATE sessions SET expires_at = ? WHERE sid = ?`, [this.expiryOf(session), sid])
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  /**
   * Invalidates every session belonging to a user, e.g. after a password reset
   * or a suspension.
   *
   * `exceptSid` keeps one session alive. Pass the caller's own session id when
   * someone changes their own password: signing them out of the device they
   * are actively using is not what they asked for, and because the session
   * payload is unchanged express-session would not re-create the deleted row.
   */
  async destroyForUser(userId: string, exceptSid?: string): Promise<void> {
    const rows = await db.all<{ sid: string; data: string }>(`SELECT sid, data FROM sessions`);
    const stale = rows.filter((row) => {
      if (row.sid === exceptSid) return false;
      try {
        return (JSON.parse(row.data) as { userId?: string }).userId === userId;
      } catch {
        return false;
      }
    });
    for (const row of stale) {
      await db.run(`DELETE FROM sessions WHERE sid = ?`, [row.sid]);
    }
  }
}

export const sessionStore = new DatabaseSessionStore();

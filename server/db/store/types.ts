/**
 * The seam that lets one set of repositories talk to either a SQL engine or
 * MongoDB.
 *
 * The app was written against raw SQL, which a document store cannot answer.
 * Rather than keep two copies of every repository, data access is expressed
 * once against this narrow interface and implemented twice: once by
 * generating SQL for the existing driver, once by calling the Mongo driver.
 *
 * It is deliberately small. Anything that needs a join or a grouped
 * aggregate does not belong here - those are few enough to be written per
 * backend and read honestly, and hiding them behind a generic query language
 * would mean building a worse SQL that still could not express them.
 */

export type Scalar = string | number | null;

/**
 * Comparisons, in Mongo's spelling because it is the more restrictive of the
 * two: every operator here has an obvious SQL equivalent, which is not true
 * in the other direction.
 */
export interface Comparison {
  $eq?: Scalar;
  $ne?: Scalar;
  $in?: Scalar[];
  $nin?: Scalar[];
  $lt?: Scalar;
  $lte?: Scalar;
  $gt?: Scalar;
  $gte?: Scalar;
  /** SQL LIKE semantics, with % and _ as the wildcards. */
  $like?: string;
  /** True matches IS NULL, false matches IS NOT NULL. */
  $null?: boolean;
}

/**
 * A bare value is an equality test, so the common case stays short:
 * `{ status: 'open' }` rather than `{ status: { $eq: 'open' } }`.
 */
export type Filter = {
  [field: string]: Scalar | Comparison | Filter[] | undefined;
} & {
  $or?: Filter[];
  $and?: Filter[];
};

export type SortDirection = 'asc' | 'desc';

export interface FindOptions {
  /** Ordered, because a multi-key sort is not commutative. */
  sort?: Array<[field: string, direction: SortDirection]>;
  limit?: number;
  skip?: number;
  /** Field names to return. Omit for the whole document. */
  project?: string[];
}

/** A partial document. `null` clears a field; `undefined` leaves it alone. */
export type Patch = Record<string, Scalar | undefined>;

export type Document = Record<string, unknown>;

export interface Store {
  readonly kind: 'sql' | 'mongo';

  find<T = Document>(collection: string, filter?: Filter, options?: FindOptions): Promise<T[]>;
  findOne<T = Document>(collection: string, filter?: Filter, options?: FindOptions): Promise<T | undefined>;
  count(collection: string, filter?: Filter): Promise<number>;

  insert(collection: string, doc: Document): Promise<void>;
  /** Returns the number of documents changed. */
  update(collection: string, filter: Filter, patch: Patch): Promise<number>;
  /** Insert, or overwrite the document that shares this one's key. */
  replace(collection: string, doc: Document): Promise<void>;
  /** Insert, and silently keep the existing document on a key collision. */
  insertIfAbsent(collection: string, doc: Document): Promise<void>;
  /** Returns the number of documents removed. */
  remove(collection: string, filter: Filter): Promise<number>;

  /** Rolls back if `fn` throws. See the note on Mongo's requirements below. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
  describe(): string;
}

/**
 * How each collection identifies a document.
 *
 * SQL gets this from PRIMARY KEY declarations in the schema. Mongo has no
 * schema to read it from, so it is stated once here and used to build `_id`,
 * which makes Mongo's own unique index do the work that the SQL primary key
 * does. Without it a retried insert would quietly duplicate a row that SQL
 * would have rejected.
 *
 * Kept in the same order as `schema.ts` so the two can be diffed by eye.
 */
export const COLLECTION_KEYS: Record<string, string[]> = {
  users: ['id'],
  user_permissions: ['user_id', 'permission'],
  teams: ['id'],
  team_members: ['team_id', 'user_id'],
  tickets: ['id'],
  ticket_comments: ['id'],
  ticket_events: ['id'],
  ticket_attachments: ['id'],
  ticket_watchers: ['ticket_id', 'user_id'],
  ticket_links: ['id'],
  notifications: ['id'],
  audit_log: ['id'],
  integrations: ['provider'],
  integration_deliveries: ['id'],
  settings: ['key'],
  counters: ['name'],
  login_attempts: ['id'],
  data_sources: ['id'],
  team_routing: ['team_id', 'provider'],
  team_form_fields: ['id'],
  ticket_field_values: ['id'],
  branding_assets: ['id'],
  teams_conversations: ['id'],
  api_keys: ['id'],
  alert_sources: ['id'],
  alerts: ['id'],
  heartbeats: ['id'],
  probes: ['id'],
  sessions: ['sid'],
};

export function keyFor(collection: string): string[] {
  const key = COLLECTION_KEYS[collection];
  if (!key) throw new Error(`No key declared for collection "${collection}". Add it to COLLECTION_KEYS.`);
  return key;
}

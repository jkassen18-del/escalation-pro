import type { ClientSession, Db, Filter as MongoFilter, MongoClient, Sort } from 'mongodb';
import { withDefaults } from './mongo-schema.ts';
import {
  keyFor,
  type Comparison,
  type Document,
  type Filter,
  type FindOptions,
  type Patch,
  type Store,
} from './types.ts';

/**
 * The Store, implemented against MongoDB.
 *
 * Documents are stored with the same snake_case field names, ISO-8601 string
 * timestamps and 0/1 integer booleans that the SQL schema uses. That is on
 * purpose: repositories then see byte-identical shapes whichever backend is
 * underneath, no mapping layer is needed, and a document exported from Mongo
 * can be loaded straight into a SQL table. Sorting agrees too, because
 * ISO-8601 UTC sorts lexicographically in the same order it sorts
 * chronologically.
 */

/**
 * What actually sits in a collection: the document, plus the `_id` built from
 * the declared key. Spelling it out keeps the driver's types from defaulting
 * `_id` to an ObjectId, which is the one thing it is never going to be here.
 */
type Stored = { _id: string } & Record<string, unknown>;

/** Escapes everything regex-special, then restores SQL LIKE's two wildcards. */
function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 's');
}

function translateComparison(comparison: Comparison): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [operator, value] of Object.entries(comparison)) {
    switch (operator) {
      case '$like':
        out.$regex = likeToRegex(value as string);
        break;
      case '$null':
        // `$eq: null` in Mongo also matches a missing field, which is what a
        // nullable SQL column with no value amounts to.
        out.$eq = value ? null : undefined;
        if (!value) {
          delete out.$eq;
          out.$ne = null;
        }
        break;
      case '$eq':
      case '$ne':
      case '$in':
      case '$nin':
      case '$lt':
      case '$lte':
      case '$gt':
      case '$gte':
        out[operator] = value;
        break;
      default:
        throw new Error(`Unsupported filter operator "${operator}".`);
    }
  }

  return out;
}

export function translateFilter(filter: Filter = {}): MongoFilter<Stored> {
  const out: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    if (field === '$or' || field === '$and') {
      const branches = (value as Filter[]).map(translateFilter).filter((branch) => Object.keys(branch).length);
      if (branches.length) out[field] = branches;
      continue;
    }

    out[field] =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? translateComparison(value as Comparison)
        : value;
  }

  return out as MongoFilter<Stored>;
}

/**
 * What `_id` a document gets.
 *
 * SQL's PRIMARY KEY is what stops a retried insert becoming a duplicate row.
 * Mongo would happily generate a fresh ObjectId and accept the second copy,
 * so the declared key is folded into `_id` and Mongo's own unique index
 * enforces it instead. A single-column key is used as-is, which keeps
 * `_id` readable and lookups by id a primary-key hit.
 */
export function idFor(collection: string, doc: Document): string {
  const key = keyFor(collection);
  if (key.length === 1) return String(doc[key[0]]);
  return key
    .map((field) => {
      const value = doc[field];
      if (value === undefined || value === null) {
        throw new Error(`Cannot store a ${collection} document: key field "${field}" is missing.`);
      }
      // Separator is escaped so ("a|b", "c") and ("a", "b|c") stay distinct.
      return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    })
    .join('|');
}

function sortFor(options: FindOptions): Sort | undefined {
  if (!options.sort?.length) return undefined;
  // The tuple form rather than an object: a multi-key sort is not commutative
  // and an object's key order is not part of its type.
  return options.sort.map(([field, direction]) => [field, direction === 'desc' ? -1 : 1] as const);
}

/**
 * `_id` is synthetic - it exists to carry the primary key, and every field in
 * it is already present as a real field. Repositories would not know what to
 * do with it, so it never leaves this layer.
 */
function projectionFor(options: FindOptions): Record<string, 0 | 1> {
  if (!options.project?.length) return { _id: 0 };
  const projection: Record<string, 0 | 1> = { _id: 0 };
  for (const field of options.project) projection[field] = 1;
  return projection;
}

const DUPLICATE_KEY = 11000;

export function createMongoStore(client: MongoClient, db: Db, description: string): Store {
  /*
   * Mongo runs a transaction on a session, and nested calls must join the
   * outer one rather than starting their own - the same problem the Postgres
   * driver solves by pinning a client for the duration of the block.
   */
  let session: ClientSession | null = null;
  const withSession = () => (session ? { session } : {});
  const collection = (name: string) => db.collection<Stored>(name);

  return {
    kind: 'mongo',

    async find<T>(name: string, filter: Filter = {}, options: FindOptions = {}) {
      let cursor = collection(name)
        .find(translateFilter(filter), { ...withSession(), projection: projectionFor(options) });

      const sort = sortFor(options);
      if (sort) cursor = cursor.sort(sort);
      if (options.skip !== undefined) cursor = cursor.skip(options.skip);
      if (options.limit !== undefined) cursor = cursor.limit(options.limit);

      return (await cursor.toArray()) as T[];
    },

    async findOne<T>(name: string, filter: Filter = {}, options: FindOptions = {}) {
      const rows = await this.find<T>(name, filter, { ...options, limit: 1 });
      return rows[0];
    },

    async count(name: string, filter: Filter = {}) {
      return collection(name).countDocuments(translateFilter(filter), withSession());
    },

    async insert(name: string, doc: Document) {
      const full = withDefaults(name, doc);
      await collection(name).insertOne({ ...full, _id: idFor(name, full) } as Stored, withSession());
    },

    async insertIfAbsent(name: string, doc: Document) {
      try {
        await this.insert(name, doc);
      } catch (error) {
        // The SQL side spells this ON CONFLICT DO NOTHING, which is not an
        // error there, so it must not be one here either.
        if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
      }
    },

    async replace(name: string, doc: Document) {
      const full = withDefaults(name, doc);
      const id = idFor(name, full);
      await collection(name).replaceOne({ _id: id }, { ...full, _id: id } as Stored, {
        ...withSession(),
        upsert: true,
      });
    },

    async update(name: string, filter: Filter, patch: Patch) {
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (!entries.length) return 0;

      const result = await collection(name).updateMany(
        translateFilter(filter),
        { $set: Object.fromEntries(entries) },
        withSession(),
      );
      // Matched rather than modified, to agree with the SQL engines: a write
      // of a column's existing value still counts as a row found.
      return result.matchedCount;
    },

    async remove(name: string, filter: Filter) {
      const result = await collection(name).deleteMany(translateFilter(filter), withSession());
      return result.deletedCount ?? 0;
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (session) return fn();

      const started = client.startSession();
      session = started;
      try {
        let result: T;
        // withTransaction retries on the transient errors Mongo expects
        // callers to retry, which a bare start/commit pair would surface as
        // a failed ticket update.
        await started.withTransaction(async () => {
          result = await fn();
        });
        return result!;
      } finally {
        session = null;
        await started.endSession();
      }
    },

    async close() {
      await client.close();
    },

    describe() {
      return description;
    },
  };
}

/**
 * Transactions need a replica set or a sharded cluster; a bare `mongod`
 * started for a quick trial is neither, and would accept every write
 * individually while silently dropping the atomicity the app is relying on.
 *
 * A ticket that half-saves is worse than one that refuses to save, so this is
 * checked once at startup and refused loudly. Atlas is always a replica set,
 * so this only ever fires against a hand-started local server.
 */
export async function assertTransactionsSupported(db: Db): Promise<void> {
  const hello = (await db.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
  if (hello.setName || hello.msg === 'isdbgrid') return;

  throw new Error(
    'This MongoDB deployment is a standalone server, which does not support transactions. ' +
      'InfraTicket needs them to keep a ticket and its events consistent. Use MongoDB Atlas, ' +
      'or start mongod as a single-node replica set: mongod --replSet rs0, then rs.initiate().',
  );
}

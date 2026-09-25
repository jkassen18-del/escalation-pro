import { dbConfig } from '../../config.ts';
import { initDatabase, getDriver } from '../index.ts';
import { createSqlStore } from './sql.ts';
import { assertTransactionsSupported, createMongoStore } from './mongo.ts';
import { ensureIndexes } from './mongo-schema.ts';
import type { Document, Filter, FindOptions, Patch, Store } from './types.ts';

export * from './types.ts';

let store: Store | null = null;

async function createMongo(): Promise<Store> {
  const { MongoClient } = await import('mongodb');

  const client = new MongoClient(dbConfig.mongoUri, {
    // A serverless invocation is discarded between requests, so a large pool
    // is wasted sockets against the cluster's connection limit.
    maxPoolSize: dbConfig.driver === 'mongodb' && process.env.VERCEL ? 1 : 10,
    // Fail fast rather than hanging the request for the 30s default when the
    // cluster is unreachable or the IP is not on the access list.
    serverSelectionTimeoutMS: 8000,
  });

  await client.connect();
  const db = client.db(dbConfig.mongoDatabase);
  await assertTransactionsSupported(db);
  await ensureIndexes(db);

  const redacted = dbConfig.mongoUri.replace(/:[^:@/]+@/, ':****@');
  return createMongoStore(client, db, `MongoDB (${redacted}/${dbConfig.mongoDatabase})`);
}

export async function initStore(): Promise<Store> {
  if (store) return store;

  if (dbConfig.driver === 'mongodb') {
    try {
      store = await createMongo();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not connect to MongoDB: ${reason}\n` +
          'Check MONGODB_URI, and that this deployment\'s address is on the cluster\'s access list.',
      );
    }
  } else {
    // The SQL engines already have a driver and a migrated schema; the store
    // is a second way of talking to the same connection, not another one.
    await initDatabase();
    store = createSqlStore(getDriver());
  }

  console.log(`[db] store ready: ${store.describe()}`);
  return store;
}

export function getStore(): Store {
  if (!store) throw new Error('Store has not been initialised. Call initStore() first.');
  return store;
}

/** Mirrors the `db` helper, so call sites read the same either way. */
export const documents = {
  get kind() {
    return getStore().kind;
  },
  find<T = Document>(collection: string, filter?: Filter, options?: FindOptions) {
    return getStore().find<T>(collection, filter, options);
  },
  findOne<T = Document>(collection: string, filter?: Filter, options?: FindOptions) {
    return getStore().findOne<T>(collection, filter, options);
  },
  count(collection: string, filter?: Filter) {
    return getStore().count(collection, filter);
  },
  insert(collection: string, doc: Document) {
    return getStore().insert(collection, doc);
  },
  insertIfAbsent(collection: string, doc: Document) {
    return getStore().insertIfAbsent(collection, doc);
  },
  replace(collection: string, doc: Document) {
    return getStore().replace(collection, doc);
  },
  update(collection: string, filter: Filter, patch: Patch) {
    return getStore().update(collection, filter, patch);
  },
  remove(collection: string, filter: Filter) {
    return getStore().remove(collection, filter);
  },
  transaction<T>(fn: () => Promise<T>) {
    return getStore().transaction(fn);
  },
  close() {
    const current = store;
    store = null;
    return current ? current.close() : Promise.resolve();
  },
};

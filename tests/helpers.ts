import {
  connectDatabases,
  disconnectDatabases,
  mongoClients,
  redisConn,
  typesense,
} from "../src/lib/db.ts";
import { syncQueue } from "../src/lib/queue.ts";
import { createWorker } from "../src/lib/worker.ts";
import { CONFIG } from "../config.ts";

export { mongoClients, typesense } from "../src/lib/db.ts";
export { syncQueue } from "../src/lib/queue.ts";

export async function connect() {
  await connectDatabases();
}

export async function disconnect() {
  await disconnectDatabases();
}

export async function cleanCollections(dbs: string[], collections: string[]) {
  for (const [uri, client] of mongoClients) {
    for (const db of dbs) {
      for (const coll of collections) {
        try {
          await client.db(db).collection(coll).drop();
        } catch {
          // ignore
        }
      }
    }
  }
}

export async function findInTypesense(
  collection: string,
  field: string,
  value: string,
  retries = 10,
  interval = 1000,
): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < retries; i++) {
    try {
      // Try direct retrieval by ID first (exact match)
      const doc = await typesense
        .collections(collection)
        .documents(value)
        .retrieve();
      return doc as unknown as Record<string, unknown>;
    } catch {
      // not found by ID, try search
    }
    try {
      const result = await typesense
        .collections(collection)
        .documents()
        .search({
          q: value,
          query_by: field,
          per_page: 1,
        });
      if (result.hits && result.hits.length > 0) {
        return result.hits[0].document as unknown as Record<string, unknown>;
      }
    } catch {
      // collection might not exist yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

export async function ensureTypesenseCollection(
  name: string,
  fields: Array<{ name: string; type: string; sort?: boolean }>,
) {
  try {
    await typesense.collections(name).retrieve();
  } catch {
    const sortable = fields.find((field) => field.sort)?.name;
    await typesense.collections().create({
      name,
      fields: fields as any,
      ...(sortable ? { default_sorting_field: sortable } : {}),
    });
  }
}

export function getWorker() {
  return createWorker();
}

export async function cleanQueue() {
  await cleanCheckpoint();
  await syncQueue.obliterate({ force: true });
}

export async function cleanCheckpoint() {
  if (redisConn) {
    for (const dbConfig of CONFIG.mongodb) {
      for (const mapping of dbConfig.collections) {
        const key = `checkpoint:${mapping.mongoDb}:${mapping.mongoCollection}`;
        await redisConn.del(key);
        for (const dependency of mapping.dependencies || []) {
          await redisConn.del(`${key}:dep:${dependency.mongoCollection}`);
        }
      }
    }
  }
}

export function getFirstClient() {
  const dbConfig = CONFIG.mongodb[0];
  return mongoClients.get(dbConfig.uri)!;
}

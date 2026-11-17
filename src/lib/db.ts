import { MongoClient, ResumeToken } from "mongodb";
import { Client as TypesenseClient } from "typesense";
import { Redis } from "ioredis";
import { CONFIG } from "../../config.ts";
import { CollectionMapping } from "../types.ts";

export const redisOptions = CONFIG.valkey?.host
  ? {
    host: CONFIG.valkey.host,
    port: CONFIG.valkey.port,
    password: CONFIG.valkey.password,
  }
  : null;

export const redisConn = redisOptions ? new Redis(redisOptions) : null;
export const typesense = new TypesenseClient({
  ...CONFIG.typesense,
  connectionTimeoutSeconds: CONFIG.typesense.connectionTimeoutSeconds ?? 30,
  numRetries: CONFIG.typesense.numRetries ?? 3,
  retryIntervalSeconds: CONFIG.typesense.retryIntervalSeconds ?? 2,
});

export const mongoClients = new Map<string, MongoClient>();

export async function connectDatabases() {
  for (const dbConfig of CONFIG.mongodb) {
    if (!mongoClients.has(dbConfig.uri)) {
      const client = new MongoClient(dbConfig.uri);
      await client.connect();
      mongoClients.set(dbConfig.uri, client);
      console.log(`Connected to MongoDB: ${dbConfig.uri}`);
    }
  }
}

export async function disconnectDatabases() {
  for (const [uri, client] of mongoClients.entries()) {
    try {
      await client.close();
      console.log(`Disconnected from MongoDB: ${uri}`);
    } catch (err) {
      console.error(`Error disconnecting from MongoDB: ${uri}`, err);
    }
  }
  mongoClients.clear();
}

export function getCheckpointKey(mapping: CollectionMapping) {
  return `checkpoint:${mapping.mongoDb}:${mapping.mongoCollection}`;
}

export function getDependencyCheckpointKey(
  mapping: CollectionMapping,
  dependencyCollection: string,
) {
  return `${getCheckpointKey(mapping)}:dep:${dependencyCollection}`;
}

export async function saveCheckpoint(
  mapping: CollectionMapping,
  token: ResumeToken,
) {
  if (redisConn) {
    await redisConn.set(getCheckpointKey(mapping), JSON.stringify(token));
  }
}

export async function getCheckpoint(
  mapping: CollectionMapping,
): Promise<ResumeToken | null> {
  if (redisConn) {
    const data = await redisConn.get(getCheckpointKey(mapping));
    return data ? JSON.parse(data) : null;
  }
  return null;
}

export async function saveDependencyCheckpoint(
  mapping: CollectionMapping,
  dependencyCollection: string,
  token: ResumeToken,
) {
  if (redisConn) {
    await redisConn.set(
      getDependencyCheckpointKey(mapping, dependencyCollection),
      JSON.stringify(token),
    );
  }
}

export async function getDependencyCheckpoint(
  mapping: CollectionMapping,
  dependencyCollection: string,
): Promise<ResumeToken | null> {
  if (redisConn) {
    const data = await redisConn.get(
      getDependencyCheckpointKey(mapping, dependencyCollection),
    );
    return data ? JSON.parse(data) : null;
  }
  return null;
}

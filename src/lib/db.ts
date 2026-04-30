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
export const typesense = new TypesenseClient(CONFIG.typesense);
export const mongoClient = new MongoClient(CONFIG.mongodb.uri);

export function getCheckpointKey(mapping: CollectionMapping) {
  return `checkpoint:${mapping.mongoDb}:${mapping.mongoCollection}`;
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

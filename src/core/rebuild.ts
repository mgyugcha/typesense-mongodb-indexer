import {
  getCheckpointKey,
  mongoClient,
  redisConn,
  typesense,
} from "../lib/db.ts";
import { syncQueue } from "../lib/queue.ts";
import { applyTransform } from "../utils/transform.ts";
import { CollectionMapping } from "../types.ts";
import { ObjectId } from "mongodb";

export async function runRebuild(mapping: CollectionMapping) {
  console.log(`🚀 [${mapping.mongoCollection}] Iniciando Rebuild Masivo...`);

  try {
    await typesense.collections(mapping.typesenseCollection).delete();
  } catch {
    /* ignore */
  }
  await typesense.collections().create(mapping.schema);

  const db = mongoClient.db(mapping.mongoDb);
  const collection = db.collection(mapping.mongoCollection);

  // Usamos proyección de MongoDB si se definieron campos para optimizar la lectura
  const projection = mapping.fields
    ? mapping.fields.reduce((acc, f) => ({ ...acc, [f]: 1 }), { _id: 1 })
    : {};
  const cursor = collection.find({
    business: new ObjectId("642c8d4104bf336820c6cbb7"),
  }).project(projection);

  let count = 0;
  let batch: unknown[] = [];
  const BATCH_SIZE = 500;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const transformed = applyTransform(mapping, doc!);
    batch.push(transformed);
    count++;

    if (batch.length >= BATCH_SIZE) {
      await syncQueue.add("bulk-sync", {
        action: "upsert-bulk",
        data: batch,
        mappingName: mapping.typesenseCollection,
      });
      batch = [];
      console.log(
        `[${mapping.mongoCollection}] ${count} documentos encolados...`,
      );
    }
  }

  if (batch.length > 0) {
    await syncQueue.add("bulk-sync", {
      action: "upsert-bulk",
      data: batch,
      mappingName: mapping.typesenseCollection,
    });
  }

  if (redisConn) await redisConn.del(getCheckpointKey(mapping));
  console.log(
    `✅ [${mapping.mongoCollection}] Finalizado. ${count} docs encolados.`,
  );
}

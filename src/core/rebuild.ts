import { typesense } from "../lib/db.ts";
import { syncQueue } from "../lib/queue.ts";
import { CollectionMapping } from "../types.ts";
import { BSON, MongoClient } from "mongodb";

export async function runRebuild(
  mapping: CollectionMapping,
  client: MongoClient,
) {
  console.log(`🚀 [${mapping.mongoCollection}] Iniciando Rebuild Masivo...`);

  try {
    await typesense.collections(mapping.schema.name).delete();
  } catch {
    /* ignore */
  }
  await typesense.collections().create(mapping.schema);

  const db = client.db(mapping.mongoDb);
  const collection = db.collection(mapping.mongoCollection);

  const cursor = collection.find({}, { readConcern: { level: "majority" } })
    .project({ _id: 1 });

  let count = 0;
  let batch: string[] = [];
  const BATCH_SIZE = 500;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    batch.push(BSON.EJSON.stringify(doc!._id, { relaxed: false }));
    count++;

    if (batch.length >= BATCH_SIZE) {
      await syncQueue.add("bulk-sync", {
        action: "upsert-bulk",
        sourceIds: batch,
        mappingName: mapping.schema.name,
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
      sourceIds: batch,
      mappingName: mapping.schema.name,
    });
  }

  console.log(
    `✅ [${mapping.mongoCollection}] Finalizado. ${count} docs encolados al worker.`,
  );
}

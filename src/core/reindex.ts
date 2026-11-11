import { BSON, MongoClient, ObjectId } from "mongodb";
import { syncQueue } from "../lib/queue.ts";
import { CollectionMapping } from "../types.ts";

export interface ReindexOptions {
  fromDate?: string;
  toDate?: string;
  from?: string;
  to?: string;
}

function parseEcuadorDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 5, 0, 0));
}

export async function runReindex(
  mapping: CollectionMapping,
  client: MongoClient,
  options: ReindexOptions,
): Promise<{ count: number }> {
  const db = client.db(mapping.mongoDb);
  const collection = db.collection(mapping.mongoCollection);

  const query: Record<string, unknown> = {};

  if (options.from) {
    query._id = { $gte: new ObjectId(options.from) };
    if (options.to) {
      (query._id as Record<string, unknown>).$lte = new ObjectId(options.to);
    }
  } else if (options.fromDate) {
    const from = parseEcuadorDate(options.fromDate);
    query.issueDate = { $gte: from };
    if (options.toDate) {
      (query.issueDate as Record<string, unknown>).$lte = parseEcuadorDate(
        options.toDate,
      );
    }
  }

  console.log(
    `[Reindex] ${mapping.mongoCollection}: leyendo documentos con filtro`,
    JSON.stringify(query),
  );

  const cursor = collection.find(query, { readConcern: { level: "majority" } })
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
        `[Reindex] ${mapping.mongoCollection}: ${count} documentos encolados...`,
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
    `[Reindex] ${mapping.mongoCollection}: finalizado. ${count} docs encolados.`,
  );
  return { count };
}

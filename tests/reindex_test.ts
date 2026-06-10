import { assert } from "@std/assert";
import { runReindex } from "../src/core/reindex.ts";
import { connect, getWorker, cleanQueue, cleanCollections, findInTypesense, ensureTypesenseCollection, getFirstClient } from "./helpers.ts";
import { CONFIG } from "../config.ts";

Deno.test({
  name: "Reindex: indexa documentos desde una fecha específica",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const worker = getWorker();

    const dbConfig = CONFIG.mongodb[0];
    const mapping = dbConfig.collections[0];
    const client = getFirstClient();
    const db = client.db(mapping.mongoDb);
    const collection = db.collection(mapping.mongoCollection);

    await cleanCollections([mapping.mongoDb], [mapping.mongoCollection]);
    await ensureTypesenseCollection(mapping.schema.name, [
      { name: "doc_id", type: "string", sort: true },
      { name: "title", type: "string" },
      { name: "content", type: "string" },
    ]);

    const pastDocs = [
      { title: "Pasado 1", content: "Antiguo", issueDate: new Date("2024-01-15T00:00:00.000Z") },
      { title: "Pasado 2", content: "Antiguo", issueDate: new Date("2024-06-20T00:00:00.000Z") },
    ];
    const recentDocs = [
      { title: "Reciente 1", content: "Nuevo", issueDate: new Date("2025-03-10T00:00:00.000Z") },
      { title: "Reciente 2", content: "Nuevo", issueDate: new Date("2025-07-05T00:00:00.000Z") },
    ];
    const allDocs = [...pastDocs, ...recentDocs];

    const insertResult = await collection.insertMany(allDocs);
    const allIds = Object.values(insertResult.insertedIds).map((id) => id.toString());
    const recentStartIdx = pastDocs.length;
    const recentIds = allIds.slice(recentStartIdx);

    const result = await runReindex(mapping, client, {
      fromDate: "2025-01-01",
    });

    assert(result.count === 2, `Deberían ser 2 docs, se encontraron ${result.count}`);

    // Wait for jobs to be processed
    await new Promise((r) => setTimeout(r, 2000));

    for (const docId of recentIds) {
      const found = await findInTypesense(mapping.schema.name, "doc_id", docId, 5, 1500);
      assert(found, `El documento reciente ${docId} debería existir en Typesense`);
    }

    await worker.close();
  },
});

Deno.test({
  name: "Reindex: indexa por rango de ObjectId",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const worker = getWorker();

    const dbConfig = CONFIG.mongodb[0];
    const mapping = dbConfig.collections[0];
    const client = getFirstClient();
    const db = client.db(mapping.mongoDb);
    const collection = db.collection(mapping.mongoCollection);

    await cleanCollections([mapping.mongoDb], [mapping.mongoCollection]);
    await ensureTypesenseCollection(mapping.schema.name, [
      { name: "doc_id", type: "string", sort: true },
      { name: "title", type: "string" },
      { name: "content", type: "string" },
    ]);

    const insertResult = await collection.insertMany([
      { title: "Alpha", content: "Uno" },
      { title: "Beta", content: "Dos" },
      { title: "Gamma", content: "Tres" },
    ]);
    const ids = Object.values(insertResult.insertedIds).map((id) => id.toString());
    const startId = ids[1];

    const result = await runReindex(mapping, client, {
      from: startId,
    });

    assert(result.count === 2, `Deberían ser 2 docs (desde ${startId}), se encontraron ${result.count}`);

    await new Promise((r) => setTimeout(r, 2000));

    const secondDoc = await findInTypesense(mapping.schema.name, "doc_id", ids[1], 5, 1500);
    assert(secondDoc, `El documento ${ids[1]} debería existir en Typesense`);

    const thirdDoc = await findInTypesense(mapping.schema.name, "doc_id", ids[2], 5, 1500);
    assert(thirdDoc, `El documento ${ids[2]} debería existir en Typesense`);

    await worker.close();
  },
});

import { assert } from "@std/assert";
import type { ChangeStream } from "mongodb";
import { startCDC } from "../src/core/cdc.ts";
import { syncQueue } from "../src/lib/queue.ts";
import { connect, getWorker, cleanCollections, findInTypesense, ensureTypesenseCollection, cleanQueue, getFirstClient, typesense } from "./helpers.ts";
import { CONFIG } from "../config.ts";

let lastChangeStream: ChangeStream | null = null;

function closeChangeStream() {
  if (lastChangeStream) {
    try { lastChangeStream.close(); } catch { /* ignore */ }
    lastChangeStream = null;
  }
}

Deno.test({
  name: "CDC: inserta un documento y aparece en Typesense",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    closeChangeStream();
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

    lastChangeStream = await startCDC(mapping, client);

    await new Promise((r) => setTimeout(r, 2000));

    const insertResult = await collection.insertOne({
      title: "Test CDC",
      content: "Este documento debería indexarse",
    });
    const docId = insertResult.insertedId.toString();

    const found = await findInTypesense(mapping.schema.name, "doc_id", docId, 20, 1500);
    assert(found, "El documento no apareció en Typesense después de 30s");
    assert(found.title === "Test CDC", `Título incorrecto: ${found.title}`);
    assert(found.content === "Este documento debería indexarse", `Contenido incorrecto: ${found.content}`);

    await worker.close();
  },
});

Deno.test({
  name: "CDC: actualiza un documento y se refleja en Typesense",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    closeChangeStream();
    await cleanQueue();
    const worker = getWorker();

    const dbConfig = CONFIG.mongodb[0];
    const mapping = dbConfig.collections[0];
    const client = getFirstClient();
    const db = client.db(mapping.mongoDb);
    const collection = db.collection(mapping.mongoCollection);

    await collection.deleteMany({});
    await ensureTypesenseCollection(mapping.schema.name, [
      { name: "doc_id", type: "string", sort: true },
      { name: "title", type: "string" },
      { name: "content", type: "string" },
    ]);

    lastChangeStream = await startCDC(mapping, client);

    await new Promise((r) => setTimeout(r, 2000));

    const insertResult = await collection.insertOne({
      title: "Original",
      content: "Contenido original",
    });
    const docId = insertResult.insertedId.toString();

    const insertCheck = await findInTypesense(mapping.schema.name, "doc_id", docId, 20, 1500);
    assert(insertCheck, "El documento insertado no apareció en Typesense");

    await collection.updateOne(
      { _id: insertResult.insertedId },
      { $set: { title: "Actualizado" } },
    );

    await new Promise((r) => setTimeout(r, 3000));

    const found = await findInTypesense(mapping.schema.name, "doc_id", docId, 20, 1500);
    assert(found, "El documento actualizado no apareció en Typesense");
    assert(found.title === "Actualizado", `El título no se actualizó: ${found.title}`);

    await worker.close();
  },
});

Deno.test({
  name: "CDC: elimina un documento de Typesense vía queue",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    closeChangeStream();
    await cleanQueue();
    const worker = getWorker();

    const dbConfig = CONFIG.mongodb[0];
    const mapping = dbConfig.collections[0];
    const client = getFirstClient();
    const db = client.db(mapping.mongoDb);
    const collection = db.collection(mapping.mongoCollection);

    await collection.deleteMany({});
    await ensureTypesenseCollection(mapping.schema.name, [
      { name: "doc_id", type: "string", sort: true },
      { name: "title", type: "string" },
      { name: "content", type: "string" },
    ]);

    // Insert directly to Typesense and queue a delete via worker
    const docId = "manual-delete-test";
    await typesense.collections(mapping.schema.name).documents().upsert({
      id: docId,
      doc_id: docId,
      title: "Para borrar directo",
      content: "Test",
    });

    // Queue a delete via the worker directly
    await syncQueue.add("test-delete", {
      action: "delete",
      data: { id: docId },
      mappingName: mapping.schema.name,
    });

    // Poll until the document returns 404 (deleted by worker)
    let deleted = false;
    for (let i = 0; i < 20; i++) {
      try {
        await typesense.collections(mapping.schema.name).documents(docId).retrieve();
        // doc still exists, wait and retry
        await new Promise((r) => setTimeout(r, 1500));
      } catch {
        deleted = true;
        break;
      }
    }
    assert(deleted, "El documento debería haber sido eliminado de Typesense");

    await worker.close();
  },
});

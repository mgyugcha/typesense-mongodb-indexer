import {
  deepStrictEqual as assertEquals,
  ok as assert,
  rejects as assertRejects,
} from "node:assert/strict";
import { QueueEvents, Worker } from "bullmq";
import { BSON, type ChangeStream } from "mongodb";
import { CONFIG } from "../config.ts";
import { startCDC } from "../src/core/cdc.ts";
import { runRebuild } from "../src/core/rebuild.ts";
import { runReindex } from "../src/core/reindex.ts";
import { redisOptions } from "../src/lib/db.ts";
import {
  cleanCollections,
  cleanQueue,
  connect,
  ensureTypesenseCollection,
  getFirstClient,
  getWorker,
  syncQueue,
  typesense,
} from "./helpers.ts";

async function setup() {
  await connect();
  await cleanQueue();
  const mapping = CONFIG.mongodb[0].collections[0];
  await cleanCollections([mapping.mongoDb], [mapping.mongoCollection]);
  await ensureTypesenseCollection(mapping.schema.name, [
    { name: "doc_id", type: "string", sort: true },
    { name: "title", type: "string" },
    { name: "content", type: "string" },
  ]);
  const events = new QueueEvents("typesense-sync", {
    connection: redisOptions!,
  });
  await events.waitUntilReady();
  const collection = getFirstClient().db(mapping.mongoDb).collection(
    mapping.mongoCollection,
  );
  return { mapping, collection, events };
}

Deno.test({
  name: "Worker: un upsert usa el documento actual de MongoDB",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mapping, collection, events } = await setup();
    const worker = await getWorker();
    try {
      const { insertedId } = await collection.insertOne({
        title: "issued",
        content: "Actual",
      });
      const id = insertedId.toString();
      const job = await syncQueue.add("stale-upsert", {
        action: "upsert",
        sourceIds: [BSON.EJSON.stringify(insertedId, { relaxed: false })],
        data: { id, doc_id: id, title: "sent", content: "Antiguo" },
        mappingName: mapping.schema.name,
      });
      await job.waitUntilFinished(events, 5000);
      const indexed = await typesense.collections<
        { title: string; content: string }
      >(mapping.schema.name)
        .documents(id).retrieve();
      assertEquals(indexed.title, "issued");
      assertEquals(indexed.content, "Actual");
    } finally {
      await worker.close();
      await events.close();
    }
  },
});

Deno.test({
  name: "Worker: un lote antiguo no sobrescribe una versión reciente",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mapping, collection, events } = await setup();
    const worker = await getWorker();
    try {
      const { insertedId } = await collection.insertOne({
        title: "issued",
        content: "Actual",
      });
      const id = insertedId.toString();
      for (const title of ["issued", "sent"]) {
        const job = await syncQueue.add("out-of-order-bulk", {
          action: "upsert-bulk",
          sourceIds: [BSON.EJSON.stringify(insertedId, { relaxed: false })],
          data: [{ id, doc_id: id, title, content: "Payload" }],
          mappingName: mapping.schema.name,
        });
        await job.waitUntilFinished(events, 5000);
      }
      const indexed = await typesense.collections<
        { title: string; content: string }
      >(mapping.schema.name)
        .documents(id).retrieve();
      assertEquals(indexed.title, "issued");
      assertEquals(indexed.content, "Actual");
    } finally {
      await worker.close();
      await events.close();
    }
  },
});

Deno.test({
  name: "Worker: un reintento vuelve a leer MongoDB tras un fallo temporal",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mapping, collection, events } = await setup();
    const worker = await getWorker();
    const documents = typesense.collections(mapping.schema.name).documents();
    const originalUpsert = documents.upsert;
    let attempts = 0;
    try {
      const { insertedId } = await collection.insertOne({
        title: "sent",
        content: "Actual",
      });
      const id = insertedId.toString();
      documents.upsert = async (document, options) => {
        attempts++;
        if (attempts === 1) {
          await collection.updateOne({ _id: insertedId }, {
            $set: { title: "issued" },
          });
          throw new Error("Fallo temporal de conexión simulado");
        }
        return await originalUpsert.call(documents, document, options);
      };
      const job = await syncQueue.add("retry-upsert", {
        action: "upsert",
        sourceIds: [BSON.EJSON.stringify(insertedId, { relaxed: false })],
        data: { id, doc_id: id, title: "sent", content: "Antiguo" },
        mappingName: mapping.schema.name,
      }, { attempts: 2, backoff: { type: "fixed", delay: 100 } });
      await job.waitUntilFinished(events, 10000);
      const indexed = await typesense.collections<
        { title: string; content: string }
      >(mapping.schema.name)
        .documents(id).retrieve();
      assertEquals(attempts, 2);
      assertEquals(indexed.title, "issued");
    } finally {
      await worker.close();
      documents.upsert = originalUpsert;
      await events.close();
    }
  },
});

Deno.test({
  name: "Worker: un upsert pendiente no recrea un documento eliminado",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mapping, collection, events } = await setup();
    const worker = await getWorker();
    try {
      const { insertedId } = await collection.insertOne({ title: "sent" });
      const id = insertedId.toString();
      await collection.deleteOne({ _id: insertedId });
      const job = await syncQueue.add("deleted-upsert", {
        action: "upsert-bulk",
        sourceIds: [BSON.EJSON.stringify(insertedId, { relaxed: false })],
        data: [{ id, doc_id: id, title: "sent", content: "Antiguo" }],
        mappingName: mapping.schema.name,
      });
      await job.waitUntilFinished(events, 5000);
      await assertRejects(
        () =>
          typesense.collections(mapping.schema.name).documents(id).retrieve(),
        (error) => {
          assertEquals((error as { httpStatus: number }).httpStatus, 404);
          return true;
        },
      );
    } finally {
      await worker.close();
      await events.close();
    }
  },
});

Deno.test({
  name: "Origen: conserva la diferencia entre un _id string y un ObjectId",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mapping, events } = await setup();
    const worker = await getWorker();
    try {
      const objectId = new BSON.ObjectId();
      const stringId = objectId.toHexString();
      const collection = getFirstClient().db(mapping.mongoDb).collection<{
        _id: string | BSON.ObjectId;
        title: string;
        content: string;
      }>(mapping.mongoCollection);
      await collection.insertMany([
        { _id: stringId, title: "String", content: "Actual" },
        { _id: objectId, title: "ObjectId", content: "Actual" },
      ]);
      for (
        const [sourceId, title] of [[stringId, "String"], [
          objectId,
          "ObjectId",
        ]]
      ) {
        const job = await syncQueue.add("typed-source-id", {
          action: "upsert",
          sourceIds: [BSON.EJSON.stringify(sourceId, { relaxed: false })],
          mappingName: mapping.schema.name,
        });
        await job.waitUntilFinished(events, 5000);
        const indexed = await typesense.collections<{ title: string }>(
          mapping.schema.name,
        ).documents(stringId).retrieve();
        assertEquals(indexed.title, title);
      }
    } finally {
      await worker.close();
      await events.close();
    }
  },
});

Deno.test({
  name: "Origen: rechaza jobs sin identificadores de MongoDB",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mapping, events } = await setup();
    const worker = await getWorker();
    try {
      const job = await syncQueue.add("missing-source-id", {
        action: "upsert",
        data: { id: "001-001-000123" },
        mappingName: mapping.schema.name,
      }, { attempts: 1 });
      await assertRejects(
        () => job.waitUntilFinished(events, 5000),
        /sourceIds/,
      );
    } finally {
      await worker.close();
      await events.close();
    }
  },
});

for (const producer of ["upsert", "upsert-bulk", "rebuild", "reindex", "cdc"]) {
  Deno.test({
    name: `Origen: ${producer} admite un id transformado distinto del _id`,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const { mapping, collection, events } = await setup();
      const originalTransform = mapping.transform!;
      const customMapping = {
        ...mapping,
        schema: { ...mapping.schema, name: `custom-${crypto.randomUUID()}` },
        transform: (document: unknown) => ({
          ...originalTransform(document),
          id: (document as { numeroFactura: string }).numeroFactura,
        }),
      };
      const mappings = CONFIG.mongodb[0].collections;
      mappings.push(customMapping);
      await typesense.collections().create(customMapping.schema);
      const worker = await getWorker();
      let stream: ChangeStream | undefined;
      try {
        if (producer === "cdc") {
          stream = await startCDC(customMapping, getFirstClient());
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const document = {
          numeroFactura: "001-001-000123",
          title: "issued",
          content: "Actual",
        };
        const { insertedId } = await collection.insertOne(document);
        const sourceId = BSON.EJSON.stringify(insertedId, { relaxed: false });
        if (producer === "rebuild") {
          await runRebuild(customMapping, getFirstClient());
        } else if (producer === "reindex") {
          await runReindex(customMapping, getFirstClient(), {});
        } else if (producer !== "cdc") {
          const transformed = customMapping.transform({
            ...document,
            _id: insertedId,
          });
          await syncQueue.add("custom-id", {
            action: producer,
            sourceIds: [sourceId],
            data: producer === "upsert" ? transformed : [transformed],
            mappingName: customMapping.schema.name,
          });
        }
        let jobs = await syncQueue.getJobs();
        for (let attempt = 0; jobs.length === 0 && attempt < 50; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          jobs = await syncQueue.getJobs();
        }
        assert(jobs.length > 0, "El productor no encoló el documento");
        await Promise.all(
          jobs.map((job) => job.waitUntilFinished(events, 5000)),
        );
        assertEquals(jobs[0].data.sourceIds, [sourceId]);
        const indexed = await typesense.collections<
          { id: string; doc_id: string; title: string }
        >(customMapping.schema.name).documents(document.numeroFactura)
          .retrieve();
        assertEquals(indexed.id, document.numeroFactura);
        assertEquals(indexed.doc_id, insertedId.toString());
        assertEquals(indexed.title, "issued");
      } finally {
        await stream?.close();
        await worker.close();
        await events.close();
        mappings.splice(mappings.indexOf(customMapping), 1);
      }
    },
  });
}

Deno.test({
  name: "Worker: el límite de concurrencia se comparte entre workers",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { events } = await setup();
    const indexerWorker = await getWorker();
    await indexerWorker.close();
    let active = 0;
    let maxActive = 0;
    let processed = 0;
    const workers = Array.from(
      { length: 2 },
      () =>
        new Worker("typesense-sync", async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 100));
          active--;
          processed++;
        }, { connection: redisOptions!, concurrency: 5 }),
    );
    try {
      await Promise.all(workers.map((worker) => worker.waitUntilReady()));
      const jobs = await syncQueue.addBulk(
        Array.from({ length: 6 }, () => ({ name: "concurrency", data: {} })),
      );
      await Promise.all(
        jobs.map((job) => job.waitUntilFinished(events, 10000)),
      );
      assertEquals(processed, 6);
      assert(maxActive > 0);
      assertEquals(maxActive, 1);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await events.close();
    }
  },
});

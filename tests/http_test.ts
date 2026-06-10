import { assert } from "@std/assert";
import { connect, getWorker, cleanQueue, cleanCollections, ensureTypesenseCollection, getFirstClient } from "./helpers.ts";
import { CONFIG } from "../config.ts";
import { startHttpServer, closeHttpServer } from "../src/lib/http.ts";

const BASE = `http://localhost:${CONFIG.http?.port || 3132}`;

let serverReady = false;
function ensureServer() {
  if (!serverReady) {
    startHttpServer();
    serverReady = true;
  }
}

Deno.test({
  name: "HTTP: GET /health retorna servicios",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const worker = getWorker();
    ensureServer();

    const res = await fetch(`${BASE}/health`);
    const body = await res.json();

    assert(res.status === 200, `Status esperado 200, recibido ${res.status}`);
    assert(typeof body.ok === "boolean", "Body debe tener campo 'ok'");
    assert(body.services, "Body debe tener campo 'services'");
    assert(typeof body.services.typesense === "string", "Debe reportar typesense");
    assert(typeof body.services.mongodb === "string", "Debe reportar mongodb");

    await worker.close();
  },
});

Deno.test({
  name: "HTTP: GET /ready retorna estado de la cola",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const worker = getWorker();
    ensureServer();

    const res = await fetch(`${BASE}/ready`);
    const body = await res.json();

    assert(res.status === 200, `Status esperado 200, recibido ${res.status}`);
    assert(typeof body.ready === "boolean", "Body debe tener campo 'ready'");
    assert(body.queue, "Body debe tener campo 'queue'");

    await worker.close();
  },
});

Deno.test({
  name: "HTTP: GET /queue retorna conteos",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const worker = getWorker();
    ensureServer();

    const res = await fetch(`${BASE}/queue`);
    const body = await res.json();

    assert(res.status === 200, `Status esperado 200, recibido ${res.status}`);
    assert(typeof body.waiting === "number", "Body debe tener campo 'waiting'");
    assert(typeof body.active === "number", "Body debe tener campo 'active'");

    await worker.close();
  },
});

Deno.test({
  name: "HTTP: POST /rebuild",
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

    await collection.insertOne({ title: "HTTP Rebuild", content: "Test" });

    ensureServer();

    const res = await fetch(`${BASE}/rebuild`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const body = await res.json();

    assert(res.status === 200, `Status esperado 200, recibido ${res.status}`);
    assert(body.ok === true, "Rebuild debe retornar ok");

    await new Promise((r) => setTimeout(r, 2000));

    await worker.close();
  },
});

Deno.test({
  name: "HTTP: POST /reindex con from_date",
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

    await collection.insertOne({ title: "Recient", content: "Data", issueDate: new Date("2025-06-01") });
    await collection.insertOne({ title: "Viejo", content: "Data", issueDate: new Date("2024-01-01") });

    ensureServer();

    const res = await fetch(`${BASE}/reindex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collection: mapping.mongoCollection,
        from_date: "2025-01-01",
      }),
    });
    const body = await res.json();

    assert(res.status === 200, `Status esperado 200, recibido ${res.status}`);
    assert(body.ok === true, "Reindex debe retornar ok");
    assert(body.queued === 1, `Debería indexar 1 doc, reportó ${body.queued}`);

    await new Promise((r) => setTimeout(r, 2000));

    await worker.close();
  },
});

Deno.test({
  name: "HTTP: rutas inexistentes retornan 404",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const worker = getWorker();
    ensureServer();

    const res = await fetch(`${BASE}/nonexistent`);
    assert(res.status === 404, `Status esperado 404, recibido ${res.status}`);

    await worker.close();
  },
});

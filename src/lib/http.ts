import { CONFIG } from "../../config.ts";
import { mongoClients, redisConn, typesense } from "./db.ts";
import { syncQueue } from "./queue.ts";
import { runRebuild } from "../core/rebuild.ts";
import { runReindex } from "../core/reindex.ts";
import { CollectionMapping } from "../types.ts";
import type { MongoClient } from "mongodb";

let httpServer: Deno.HttpServer | null = null;

export function startHttpServer() {
  const config = CONFIG.http;
  if (!config) return null;

  const port = config.port;
  const hostname = config.host ?? "0.0.0.0";

  httpServer = Deno.serve({ port, hostname }, handler);

  console.log(`🌐 Servidor HTTP iniciado en puerto ${port}`);
  return httpServer;
}

export function closeHttpServer() {
  if (httpServer) {
    httpServer.shutdown();
    httpServer = null;
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  try {
    if (method === "GET" && url.pathname === "/health") {
      return handleHealth();
    }
    if (method === "GET" && url.pathname === "/ready") {
      return handleReady();
    }
    if (method === "GET" && url.pathname === "/queue") {
      return handleQueue();
    }
    if (method === "POST" && url.pathname === "/rebuild") {
      return handleRebuild(req);
    }
    if (method === "POST" && url.pathname === "/reindex") {
      return handleReindex(req);
    }

    return json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return json({ error: (error as Error).message }, { status: 500 });
  }
}

async function handleHealth(): Promise<Response> {
  const checks: Record<string, string> = {};

  try {
    await typesense.health.retrieve();
    checks.typesense = "ok";
  } catch {
    checks.typesense = "error";
  }

  for (const dbConfig of CONFIG.mongodb) {
    const client = mongoClients.get(dbConfig.uri);
    if (client) {
      try {
        await client.db("admin").command({ ping: 1 });
        checks.mongodb = "ok";
      } catch {
        checks.mongodb = "error";
      }
    } else {
      checks.mongodb = "disconnected";
    }
  }

  if (redisConn) {
    try {
      await redisConn.ping();
      checks.valkey = "ok";
    } catch {
      checks.valkey = "error";
    }
  } else {
    checks.valkey = "not_configured";
  }

  const allOk = Object.values(checks).every((v) => v === "ok" || v === "not_configured");
  return json({ ok: allOk, services: checks });
}

async function handleReady(): Promise<Response> {
  const counts = await syncQueue.getJobCounts();
  const isReady = counts.waiting === 0 && counts.active === 0;

  return json({
    ready: isReady,
    queue: counts,
  });
}

async function handleQueue(): Promise<Response> {
  const counts = await syncQueue.getJobCounts();
  return json(counts);
}

async function handleRebuild(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const collectionName = body.collection as string | undefined;

  const results: Array<{ collection: string; status: string }> = [];

  for (const dbConfig of CONFIG.mongodb) {
    const client = mongoClients.get(dbConfig.uri) as MongoClient | undefined;
    if (!client) continue;

    const targets = collectionName
      ? dbConfig.collections.filter((c) => c.mongoCollection === collectionName)
      : dbConfig.collections;

    for (const mapping of targets) {
      await runRebuild(mapping, client);
      results.push({ collection: mapping.mongoCollection, status: "ok" });
    }
  }

  if (results.length === 0) {
    return json({ error: "Colección no encontrada" }, { status: 404 });
  }

  return json({ ok: true, collections: results });
}

async function handleReindex(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body inválido. Enviar JSON." }, { status: 400 });
  }

  const collection = body.collection as string | undefined;
  if (!collection) {
    return json({ error: "El campo 'collection' es requerido" }, { status: 400 });
  }

  let foundMapping: CollectionMapping | null = null;
  let foundClient: MongoClient | null = null;

  for (const dbConfig of CONFIG.mongodb) {
    const client = mongoClients.get(dbConfig.uri) as MongoClient | undefined;
    if (!client) continue;
    const mapping = dbConfig.collections.find((c) => c.mongoCollection === collection);
    if (mapping) {
      foundMapping = mapping;
      foundClient = client;
      break;
    }
  }

  if (!foundMapping || !foundClient) {
    return json({ error: `Colección '${collection}' no encontrada en configuración` }, { status: 404 });
  }

  const result = await runReindex(foundMapping, foundClient, {
    fromDate: body.from_date as string | undefined,
    toDate: body.to_date as string | undefined,
    from: body.from as string | undefined,
    to: body.to as string | undefined,
  });

  return json({
    ok: true,
    collection,
    queued: result.count,
    filter: {
      from_date: body.from_date ?? null,
      to_date: body.to_date ?? null,
      from: body.from ?? null,
      to: body.to ?? null,
    },
  });
}

import { assertEquals } from "@std/assert";
import { ObjectId } from "mongodb";
import { CONFIG } from "../config.ts";
import { startCDC } from "../src/core/cdc.ts";
import { startDependencyCDC } from "../src/core/dependencies.ts";
import { runRebuild } from "../src/core/rebuild.ts";
import {
  cleanCollections,
  cleanQueue,
  connect,
  ensureTypesenseCollection,
  getFirstClient,
  getWorker,
  typesense,
} from "./helpers.ts";

const mapping = CONFIG.mongodb[0].collections.find(
  (collection) => collection.mongoCollection === "dependentdocs",
)!;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  attempts = 30,
  interval = 1000,
): Promise<T> {
  for (let index = 0; index < attempts; index++) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error("Se agotó el tiempo de espera");
}

async function documentoIndice(id: ObjectId) {
  try {
    return (await typesense
      .collections(mapping.schema.name)
      .documents(id.toString())
      .retrieve()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

Deno.test({
  name: "Dependencias: renombrar un documento reindexa los que lo referencian",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const db = getFirstClient().db(mapping.mongoDb);
    await cleanCollections(
      [mapping.mongoDb],
      [mapping.mongoCollection, "testtags"],
    );
    await ensureTypesenseCollection(mapping.schema.name, [
      { name: "tag", type: "string" },
    ]);

    const worker = await getWorker();
    const client = getFirstClient();
    const streams = [
      await startCDC(mapping, client),
      ...(mapping.dependencies || []).map((dependency) =>
        startDependencyCDC(mapping, dependency, client)
      ),
    ];

    try {
      const tagId = new ObjectId();
      const docId = new ObjectId();
      await db.collection("testtags").insertOne({
        _id: tagId,
        name: "inicial",
      } as never);
      await db.collection(mapping.mongoCollection).insertOne({
        _id: docId,
        tagId,
      });
      await runRebuild(mapping, client);

      const inicial = await waitFor(async () => {
        const documento = await documentoIndice(docId);
        return documento?.tag === "inicial" ? documento : null;
      });
      assertEquals(inicial.tag, "inicial");

      await db
        .collection("testtags")
        .updateOne({ _id: tagId }, { $set: { name: "renombrado" } });

      const actualizado = await waitFor(
        async () => {
          const documento = await documentoIndice(docId);
          return documento?.tag === "renombrado" ? documento : null;
        },
        20,
        500,
      );
      assertEquals(actualizado.tag, "renombrado");
    } finally {
      for (const stream of await Promise.all(streams)) {
        await stream.close();
      }
      await worker.close();
    }
  },
});

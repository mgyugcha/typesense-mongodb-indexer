import { assert } from "@std/assert";
import { runRebuild } from "../src/core/rebuild.ts";
import { connect, getWorker, cleanQueue, cleanCollections, findInTypesense, ensureTypesenseCollection, getFirstClient, typesense } from "./helpers.ts";
import { CONFIG } from "../config.ts";

Deno.test({
  name: "Rebuild: indexa todos los documentos existentes",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const worker = await getWorker();

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

    const docs = [];
    for (let i = 0; i < 10; i++) {
      docs.push({ title: `Doc ${i}`, content: `Contenido ${i}` });
    }
    const insertResult = await collection.insertMany(docs);
    const ids = Object.values(insertResult.insertedIds).map((id) => id.toString());

    await runRebuild(mapping, client);

    // Wait for jobs to be processed
    await new Promise((r) => setTimeout(r, 2000));

    for (const docId of ids) {
      const found = await findInTypesense(mapping.schema.name, "doc_id", docId, 5, 1500);
      assert(found, `El documento ${docId} no se encontró en Typesense después del rebuild`);
    }

    // Verify search works
    const searchResult = await typesense
      .collections(mapping.schema.name)
      .documents()
      .search({ q: "Doc 5", query_by: "title" });
    assert(searchResult.hits && searchResult.hits.length > 0, "La búsqueda no encontró resultados");

    await worker.close();
  },
});

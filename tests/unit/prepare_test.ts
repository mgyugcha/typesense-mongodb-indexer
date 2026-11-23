import { assertEquals } from "@std/assert";
import { Document, ObjectId } from "mongodb";
import { CollectionMapping, TransformContext } from "../../src/types.ts";
import { applyTransform } from "../../src/utils/transform.ts";

Deno.test("prepare: una consulta por lote y transform reutiliza ctx.cache", async () => {
  const etiquetaUno = new ObjectId();
  const etiquetaDos = new ObjectId();
  const faltante = new ObjectId();
  let consultas = 0;
  const filas = [
    { _id: etiquetaUno, name: "uno" },
    { _id: etiquetaDos, name: "dos" },
  ];
  const db = {
    collection: (nombre: string) => ({
      find: (filtro: Document) => {
        assertEquals(nombre, "tags");
        assertEquals(Array.isArray(filtro._id?.$in), true);
        consultas++;
        return {
          project: () => ({ toArray: () => Promise.resolve(filas) }),
        };
      },
    }),
  };

  const mapping: CollectionMapping = {
    mongoDb: "testdb",
    mongoCollection: "items",
    schema: { name: "items", fields: [] } as CollectionMapping["schema"],
    prepare: async (docs: Document[], ctx: TransformContext) => {
      const ids = [
        ...new Set(docs.flatMap((doc) => doc.tagIds as ObjectId[]).map(String)),
      ];
      const tags = await ctx.db.collection("tags").find({
        _id: { $in: ids.map((id) => new ObjectId(id)) },
      }).project({ name: 1 }).toArray();
      for (const tag of tags) ctx.cache.set(`tag:${tag._id}`, tag.name);
      for (const id of ids) {
        if (!ctx.cache.has(`tag:${id}`)) ctx.cache.set(`tag:${id}`, null);
      }
    },
    transform: (doc: Document, ctx: TransformContext) => ({
      id: doc._id.toString(),
      tags: (doc.tagIds as ObjectId[]).map((id) =>
        ctx.cache.get(`tag:${id}`) ?? null
      ),
    }),
  };

  const docs = [
    { _id: new ObjectId(), tagIds: [etiquetaUno, etiquetaDos] },
    { _id: new ObjectId(), tagIds: [etiquetaDos, faltante] },
  ];
  const ctx = {
    db,
    cache: new Map<string, unknown>(),
  } as unknown as TransformContext;

  await mapping.prepare?.(docs, ctx);
  const transformados = await Promise.all(
    docs.map((doc) => applyTransform(mapping, doc, ctx)),
  );

  assertEquals(consultas, 1);
  assertEquals(transformados[0].tags, ["uno", "dos"]);
  assertEquals(transformados[1].tags, ["dos", null]);
});

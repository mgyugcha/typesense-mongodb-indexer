import { Job, Worker } from "bullmq";
import { BSON, type Document } from "mongodb";
import { mongoClients, redisOptions, typesense } from "./db.ts";
import { CONFIG } from "../../config.ts";
import { debugLog } from "../utils/logger.ts";
import { applyTransform } from "../utils/transform.ts";
import { syncQueue } from "./queue.ts";

export async function createWorker(): Promise<Worker> {
  await syncQueue.setGlobalConcurrency(1);

  return new Worker(
    "typesense-sync",
    async (job: Job) => {
      const { action, data, mappingName, sourceIds } = job.data;
      const dbConfig = CONFIG.mongodb.find((db) =>
        db.collections.some((c) => c.schema.name === mappingName)
      );
      const mapping = dbConfig?.collections.find(
        (c) => c.schema.name === mappingName,
      );

      if (!mapping || !dbConfig) {
        throw new Error(`Mapping no encontrado para: ${mappingName}`);
      }

      try {
        if (action === "upsert" || action === "upsert-bulk") {
          const client = mongoClients.get(dbConfig.uri);
          if (!client) {
            throw new Error(`MongoDB no conectado para: ${mappingName}`);
          }
          if (
            !Array.isArray(sourceIds) ||
            sourceIds.length === 0 ||
            sourceIds.some((id) => typeof id !== "string" || !id) ||
            (action === "upsert" && sourceIds.length !== 1)
          ) {
            throw new Error(`Job sin sourceIds válidos para: ${mappingName}`);
          }
          const mongoIds = [...new Set<string>(sourceIds)].map((id) =>
            BSON.EJSON.parse(id, { relaxed: false })
          );
          const db = client.db(mapping.mongoDb);
          const documents = await client
            .db(mapping.mongoDb)
            .collection<Document>(mapping.mongoCollection)
            .find(
              { _id: { $in: mongoIds } },
              {
                readPreference: "primary",
                readConcern: { level: "majority" },
              },
            )
            .toArray();
          const ctx = { db, cache: new Map<string, unknown>() };
          const currentData = await Promise.all(
            documents.map((document) => applyTransform(mapping, document, ctx)),
          );
          if (currentData.length === 0) return;

          debugLog(
            `Worker ejecutando ${action} en ${mapping.schema.name}. Cantidad: ${currentData.length}`,
          );
          const target = typesense.collections(mapping.schema.name).documents();
          if (action === "upsert-bulk") {
            await target.import(currentData, { action: "upsert" });
          } else {
            await target.upsert(currentData[0]);
          }
        } else if (action === "delete") {
          debugLog(`Worker ejecutando delete en ${mapping.schema.name}`, data);
          await typesense
            .collections(mapping.schema.name)
            .documents(data.id)
            .delete();
        }
      } catch (error: any) {
        console.error(`[Worker] Error en ${mappingName}:`, error.message);
        if (error.importResults) {
          const failedDocs = error.importResults.filter((r: any) => !r.success);
          console.error(
            "Primeros 5 documentos fallidos:",
            JSON.stringify(failedDocs.slice(0, 5), null, 2),
          );
        }
        throw error;
      }
    },
    {
      connection: redisOptions || { host: "localhost", port: 6379 },
      concurrency: 1,
    },
  );
}

import { Job, Worker } from "bullmq";
import { redisOptions, typesense } from "./db.ts";
import { CONFIG } from "../../config.ts";
import { debugLog } from "../utils/logger.ts";

export const worker = new Worker(
  "typesense-sync",
  async (job: Job) => {
    const { action, data, mappingName } = job.data;
    const mapping = CONFIG.collections.find(
      (c) => c.typesenseCollection === mappingName,
    );

    if (!mapping) throw new Error(`Mapping no encontrado para: ${mappingName}`);

    try {
      if (action === "upsert") {
        debugLog(
          `Worker ejecutando upsert en ${mapping.typesenseCollection}`,
          data,
        );
        await typesense
          .collections(mapping.typesenseCollection)
          .documents()
          .upsert(data);
      } else if (action === "upsert-bulk") {
        debugLog(
          `Worker ejecutando upsert-bulk en ${mapping.typesenseCollection}. Cantidad: ${data.length}`,
        );
        await typesense
          .collections(mapping.typesenseCollection)
          .documents()
          .import(data, { action: "upsert" });
      } else if (action === "delete") {
        debugLog(
          `Worker ejecutando delete en ${mapping.typesenseCollection}`,
          data,
        );
        await typesense
          .collections(mapping.typesenseCollection)
          .documents(data.id)
          .delete();
      }
    } catch (error) {
      console.error(
        `[Worker] Error en ${mappingName}:`,
        (error as Error).message,
      );
      throw error;
    }
  },
  {
    connection: redisOptions || { host: "localhost", port: 6379 },
    concurrency: 5,
  },
);

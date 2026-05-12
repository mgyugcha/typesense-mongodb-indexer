import { Job, Worker } from "bullmq";
import { redisOptions, typesense } from "./db.ts";
import { CONFIG } from "../../config.ts";
import { debugLog } from "../utils/logger.ts";

export const worker = new Worker(
  "typesense-sync",
  async (job: Job) => {
    const { action, data, mappingName } = job.data;
    const mapping = CONFIG.mongodb
      .flatMap((db) => db.collections)
      .find((c) => c.schema.name === mappingName);

    if (!mapping) throw new Error(`Mapping no encontrado para: ${mappingName}`);

    try {
      if (action === "upsert") {
        debugLog(
          `Worker ejecutando upsert en ${mapping.schema.name}`,
          data,
        );
        await typesense
          .collections(mapping.schema.name)
          .documents()
          .upsert(data);
      } else if (action === "upsert-bulk") {
        debugLog(
          `Worker ejecutando upsert-bulk en ${mapping.schema.name}. Cantidad: ${data.length}`,
        );
        await typesense
          .collections(mapping.schema.name)
          .documents()
          .import(data, { action: "upsert" });
      } else if (action === "delete") {
        debugLog(
          `Worker ejecutando delete en ${mapping.schema.name}`,
          data,
        );
        await typesense
          .collections(mapping.schema.name)
          .documents(data.id)
          .delete();
      }
    } catch (error: any) {
      console.error(
        `[Worker] Error en ${mappingName}:`,
        error.message,
      );
      if (error.importResults) {
        const failedDocs = error.importResults.filter((r: any) => !r.success);
        console.error("Primeros 5 documentos fallidos:", JSON.stringify(failedDocs.slice(0, 5), null, 2));
      }
      throw error;
    }
  },
  {
    connection: redisOptions || { host: "localhost", port: 6379 },
    concurrency: 5,
  },
);

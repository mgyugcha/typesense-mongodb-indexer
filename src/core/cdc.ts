import {
  ChangeStreamDeleteDocument,
  ChangeStreamUpdateDocument,
  MongoClient,
} from "mongodb";
import {
  getCheckpoint,
  getCheckpointKey,
  redisConn,
  saveCheckpoint,
} from "../lib/db.ts";
import { syncQueue } from "../lib/queue.ts";
import { applyTransform } from "../utils/transform.ts";
import { debugLog } from "../utils/logger.ts";
import { CollectionMapping } from "../types.ts";

export async function startCDC(
  mapping: CollectionMapping,
  client: MongoClient,
) {
  console.log(`📡 [${mapping.mongoCollection}] Iniciando Change Stream...`);

  const db = client.db(mapping.mongoDb);
  const collection = db.collection(mapping.mongoCollection);

  const resumeToken = await getCheckpoint(mapping);
  const options = resumeToken
    ? { resumeAfter: resumeToken, fullDocument: "updateLookup" as const }
    : { fullDocument: "updateLookup" as const };

  const changeStream = collection.watch([], options);

  changeStream.on("change", async (change) => {
    const resumeToken = change._id;

    try {
      if (["insert", "update", "replace"].includes(change.operationType)) {
        if (change.operationType === "update") {
          debugLog(
            `CDC detectó UPDATE en ${mapping.mongoCollection}. Campos modificados:`,
            (change as ChangeStreamUpdateDocument).updateDescription,
          );
        }
        const fullDoc = (change as ChangeStreamUpdateDocument).fullDocument;
        const transformed = applyTransform(mapping, fullDoc!);
        debugLog(`CDC transformó documento. Encolando a BullMQ:`, transformed);
        await syncQueue.add("cdc-upsert", {
          action: "upsert",
          data: transformed,
          mappingName: mapping.schema.name,
        });
      } else if (change.operationType === "delete") {
        await syncQueue.add("cdc-delete", {
          action: "delete",
          data: {
            id: (
              change as ChangeStreamDeleteDocument
            ).documentKey._id.toString(),
          },
          mappingName: mapping.schema.name,
        });
      }

      await saveCheckpoint(mapping, resumeToken);
    } catch (error) {
      console.error(
        `[CDC] Error en ${mapping.mongoCollection}:`,
        (error as Error).message,
      );
    }
  });

  changeStream.on("error", (error: Error & { code: number }) => {
    console.error(`[CDC] Error en ${mapping.mongoCollection}:`, error);

    // Errores comunes si el oplog ha rotado y el resumeToken es muy antiguo o la historia se perdió
    const isHistoryLost = error.code === 136 ||
      error.message?.includes("resume") ||
      error.message?.includes("ChangeStreamHistoryLost");

    if (isHistoryLost) {
      console.error(
        `❌ [ALERTA] El token de reanudación de MongoDB ha expirado porque el indexador estuvo apagado demasiado tiempo o el oplog rotó.`,
      );
      console.error(
        `💡 Solución: Debes ejecutar el indexador con la bandera --rebuild para resincronizar la base de datos completa.`,
      );

      // Limpiamos el checkpoint dañado y salimos para no entrar en un bucle infinito
      if (redisConn) {
        redisConn.del(getCheckpointKey(mapping)).then(() => Deno.exit(1));
      } else {
        Deno.exit(1);
      }
    } else {
      setTimeout(() => startCDC(mapping, client), 5000);
    }
  });
}

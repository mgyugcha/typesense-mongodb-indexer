import {
  BSON,
  ChangeStream,
  MongoClient,
  ResumeToken,
  UpdateDescription,
} from "mongodb";
import {
  getCheckpoint,
  getCheckpointKey,
  redisConn,
  saveCheckpoint,
} from "../lib/db.ts";
import { syncQueue } from "../lib/queue.ts";
import { debugLog } from "../utils/logger.ts";
import { CollectionMapping } from "../types.ts";

export async function startCDC(
  mapping: CollectionMapping,
  client: MongoClient,
): Promise<ChangeStream> {
  console.log(`📡 [${mapping.mongoCollection}] Iniciando Change Stream...`);

  const db = client.db(mapping.mongoDb);
  const collection = db.collection(mapping.mongoCollection);

  const resumeToken = await getCheckpoint(mapping);
  const options = resumeToken
    ? { resumeAfter: resumeToken, fullDocument: "updateLookup" as const }
    : { fullDocument: "updateLookup" as const };

  const changeStream = collection.watch([], options);

  const batchBuffer: string[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let lastResumeToken: ResumeToken | null = null;

  async function flushBuffer() {
    const batch = batchBuffer.splice(0);
    batchTimer = null;
    if (batch.length === 0) return;

    try {
      debugLog(
        `CDC flush: ${batch.length} documentos en lote para ${mapping.mongoCollection}`,
      );
      await syncQueue.add("bulk-sync", {
        action: "upsert-bulk",
        sourceIds: batch,
        mappingName: mapping.schema.name,
      });
      if (lastResumeToken) {
        await saveCheckpoint(mapping, lastResumeToken);
      }
    } catch (error) {
      console.error(
        `[CDC] Error al encolar lote en ${mapping.mongoCollection}:`,
        (error as Error).message,
      );
    }
  }

  function scheduleFlush() {
    if (batchBuffer.length >= 50) {
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = null;
      flushBuffer();
    } else if (!batchTimer) {
      batchTimer = setTimeout(() => flushBuffer(), 500);
    }
  }

  changeStream.on("change", (change) => {
    lastResumeToken = change._id;

    try {
      if (
        change.operationType === "insert" || change.operationType === "replace"
      ) {
        batchBuffer.push(
          BSON.EJSON.stringify(change.documentKey._id, { relaxed: false }),
        );
        scheduleFlush();
      } else if (change.operationType === "update") {
        const updateDescription = change.updateDescription as
          | UpdateDescription
          | undefined;
        if (
          updateDescription && mapping.skipUpdate &&
          mapping.skipUpdate(updateDescription)
        ) {
          if (batchBuffer.length === 0) {
            saveCheckpoint(mapping, change._id);
          }
          return;
        }
        if (change.fullDocument) {
          batchBuffer.push(
            BSON.EJSON.stringify(change.documentKey._id, { relaxed: false }),
          );
          scheduleFlush();
        }
      } else if (change.operationType === "delete") {
        if (batchBuffer.length > 0) {
          if (batchTimer) clearTimeout(batchTimer);
          batchTimer = null;
          flushBuffer();
        }
        syncQueue.add("cdc-delete", {
          action: "delete",
          data: {
            id: change.documentKey._id.toString(),
          },
          mappingName: mapping.schema.name,
        });
        saveCheckpoint(mapping, lastResumeToken);
      }
    } catch (error) {
      console.error(
        `[CDC] Error en ${mapping.mongoCollection}:`,
        (error as Error).message,
      );
    }
  });

  changeStream.on("error", (error: Error & { code: number }) => {
    console.error(`[CDC] Error en ${mapping.mongoCollection}:`, error);

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

      if (redisConn) {
        redisConn.del(getCheckpointKey(mapping)).then(() => Deno.exit(1));
      } else {
        Deno.exit(1);
      }
    } else {
      setTimeout(() => startCDC(mapping, client), 5000);
    }
  });

  return changeStream;
}

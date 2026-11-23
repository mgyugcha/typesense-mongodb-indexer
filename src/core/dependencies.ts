import {
  BSON,
  ChangeStream,
  Document,
  MongoClient,
  ResumeToken,
} from "mongodb";
import {
  getDependencyCheckpoint,
  getDependencyCheckpointKey,
  redisConn,
  saveDependencyCheckpoint,
} from "../lib/db.ts";
import { syncQueue } from "../lib/queue.ts";
import { debugLog } from "../utils/logger.ts";
import { CollectionDependency, CollectionMapping } from "../types.ts";

interface CambioDependencia {
  operationType: string;
  fullDocument?: Document | null;
}

/**
 * Observa una colección de la que dependen los documentos de un mapping: un
 * cambio en ella reencola los documentos que guardan su `_id` en `localField`.
 */
export async function startDependencyCDC(
  mapping: CollectionMapping,
  dependency: CollectionDependency,
  client: MongoClient,
): Promise<ChangeStream> {
  const db = client.db(mapping.mongoDb);
  const collection = db.collection(dependency.mongoCollection);
  console.log(
    `📡 [${mapping.mongoCollection}] Dependencia de ${dependency.mongoCollection}...`,
  );

  const resumeToken = await getDependencyCheckpoint(
    mapping,
    dependency.mongoCollection,
  );
  const options = resumeToken
    ? { resumeAfter: resumeToken, fullDocument: "updateLookup" as const }
    : { fullDocument: "updateLookup" as const };

  const changeStream = collection.watch([], options);
  const pendientes: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ultimoToken: ResumeToken | null = null;

  function guardarCheckpoint() {
    if (!ultimoToken) return;
    return saveDependencyCheckpoint(
      mapping,
      dependency.mongoCollection,
      ultimoToken,
    );
  }

  async function flush() {
    const ids = pendientes.splice(0);
    timer = null;
    if (ids.length === 0) return;

    try {
      await syncQueue.add("dependency-sync", {
        action: "upsert-bulk",
        sourceIds: ids.map((id) =>
          BSON.EJSON.stringify(id, { relaxed: false })
        ),
        mappingName: mapping.schema.name,
      });
      debugLog(
        `[Dependencia ${dependency.mongoCollection}] ${ids.length} documentos de ${mapping.mongoCollection} reencolados`,
      );
      await guardarCheckpoint();
    } catch (error) {
      console.error(
        `[Dependencia ${dependency.mongoCollection}] Error al encolar:`,
        (error as Error).message,
      );
    }
  }

  changeStream.on("change", (change) => {
    ultimoToken = change._id;
    const cambio = change as unknown as CambioDependencia;

    try {
      if (
        cambio.operationType !== "update" &&
        cambio.operationType !== "replace"
      ) {
        guardarCheckpoint();
        return;
      }

      const documento = cambio.fullDocument;
      if (!documento) return;

      db.collection(mapping.mongoCollection)
        .find(
          { [dependency.localField]: documento._id },
          {
            readPreference: "primary",
            readConcern: { level: "majority" },
          },
        )
        .project({ _id: 1 })
        .toArray()
        .then((afectados) => {
          if (afectados.length === 0) {
            guardarCheckpoint();
            return;
          }
          for (const afectado of afectados) {
            pendientes.push(afectado._id);
          }
          if (!timer) timer = setTimeout(flush, 100);
        })
        .catch((error) =>
          console.error(
            `[Dependencia ${dependency.mongoCollection}] Error buscando afectados:`,
            (error as Error).message,
          )
        );
    } catch (error) {
      console.error(
        `[Dependencia ${dependency.mongoCollection}] Error:`,
        (error as Error).message,
      );
    }
  });

  changeStream.on("error", (error: Error & { code: number }) => {
    console.error(`[Dependencia ${dependency.mongoCollection}] Error:`, error);

    const historialPerdido = error.code === 136 ||
      error.message?.includes("resume") ||
      error.message?.includes("ChangeStreamHistoryLost");

    if (historialPerdido) {
      console.error(
        `❌ [ALERTA] Se perdió el token de la dependencia ${dependency.mongoCollection}. Ejecutar --rebuild.`,
      );
      if (redisConn) {
        redisConn
          .del(getDependencyCheckpointKey(mapping, dependency.mongoCollection))
          .then(() => Deno.exit(1));
      } else {
        Deno.exit(1);
      }
    } else {
      setTimeout(() => startDependencyCDC(mapping, dependency, client), 5000);
    }
  });

  return changeStream;
}

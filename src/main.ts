import { parseArgs } from "@std/cli/parse-args";
import { CONFIG } from "../config.ts";
import {
  connectDatabases,
  disconnectDatabases,
  mongoClients,
  redisConn,
  typesense,
} from "./lib/db.ts";
import { syncQueue } from "./lib/queue.ts";
import { worker } from "./lib/worker.ts";
import { runRebuild } from "./core/rebuild.ts";
import { startCDC } from "./core/cdc.ts";

const flags = parseArgs(Deno.args, {
  boolean: ["rebuild"],
  string: ["collection"],
});

async function main() {
  try {
    await connectDatabases();

    let foundCollections = 0;

    for (const dbConfig of CONFIG.mongodb) {
      const client = mongoClients.get(dbConfig.uri);
      if (!client) continue;

      const targetCollections = flags.collection
        ? dbConfig.collections.filter((c) =>
          c.mongoCollection === flags.collection
        )
        : dbConfig.collections;

      if (targetCollections.length === 0) continue;
      foundCollections += targetCollections.length;

      for (const mapping of targetCollections) {
        let isNew = false;
        try {
          await typesense.collections(mapping.schema.name).retrieve();
        } catch (error: any) {
          if (error.httpStatus === 404) {
            console.log(
              `[Typesense] Colección ${mapping.schema.name} no existe. Se creará y sincronizará por primera vez...`,
            );
            isNew = true;
          } else {
            console.error(
              `Error verificando colección en Typesense: ${mapping.schema.name}`,
              error,
            );
          }
        }

        if (flags.rebuild || isNew) {
          await runRebuild(mapping, client);
        }

        if (!flags.rebuild) {
          startCDC(mapping, client);
        }
      }
    }

    if (foundCollections === 0) {
      console.error("No se encontraron colecciones para procesar.");
      Deno.exit(1);
    }

    console.log("✅ Sistema en ejecución.");
  } catch (error) {
    console.error("❌ Error fatal:", error);
    Deno.exit(1);
  }
}

let isShuttingDown = false;
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("\n🛑 Iniciando apagado seguro...");

  try {
    await worker.close();
    await syncQueue.close();
    if (redisConn) await redisConn.quit();
    await disconnectDatabases();
    console.log("✅ Apagado seguro completado. Saliendo...");
    Deno.exit(0);
  } catch (err) {
    console.error("❌ Error durante apagado seguro:", err);
    Deno.exit(1);
  }
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

if (import.meta.main) {
  main();
}

import { parseArgs } from "@std/cli/parse-args";
import { CONFIG } from "../config.ts";
import { mongoClient, redisConn } from "./lib/db.ts";
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
    await mongoClient.connect();
    console.log("Connected to MongoDB");

    const targetCollections = flags.collection
      ? CONFIG.collections.filter((c) => c.mongoCollection === flags.collection)
      : CONFIG.collections;

    if (targetCollections.length === 0) {
      console.error("No se encontraron colecciones para procesar.");
      Deno.exit(1);
    }

    if (flags.rebuild) {
      for (const mapping of targetCollections) {
        await runRebuild(mapping);
      }
    } else {
      for (const mapping of targetCollections) {
        startCDC(mapping);
      }
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
    await mongoClient.close();
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

import { assertEquals } from "@std/assert";
import { BSON } from "mongodb";
import { CollectionMapping } from "../src/types.ts";
import { startCDC } from "../src/core/cdc.ts";
import { getCheckpointKey, redisConn } from "../src/lib/db.ts";
import { skipUnindexedUpdates } from "../src/utils/transform.ts";
import {
  cleanCollections,
  cleanQueue,
  connect,
  getFirstClient,
  syncQueue,
} from "./helpers.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test({
  name: "CDC: un update fuera de los campos indexados no encola trabajo",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await connect();
    await cleanQueue();
    const mapping: CollectionMapping = {
      mongoDb: "testdb",
      mongoCollection: "skipitems",
      schema: {
        name: "skipitems",
        fields: [{ name: "code", type: "string" }],
      } as CollectionMapping["schema"],
      skipUpdate: skipUnindexedUpdates([/^code$/]),
    };
    const client = getFirstClient();
    const collection = client
      .db(mapping.mongoDb)
      .collection(mapping.mongoCollection);
    await cleanCollections([mapping.mongoDb], [mapping.mongoCollection]);
    await redisConn?.del(getCheckpointKey(mapping));

    const { insertedId } = await collection.insertOne({
      code: "ITEM-001",
      stock: 1,
      parts: [{ part: "p1", qty: 1 }],
    });
    const stream = await startCDC(mapping, client);
    try {
      await sleep(1000);
      const jobsAntes = (await syncQueue.getJobs()).length;

      await collection.updateOne(
        { _id: insertedId },
        {
          $set: {
            stock: 2,
            "parts.0.qty": 9,
            updatedAt: new Date(),
          },
        },
      );
      await sleep(1500);
      assertEquals((await syncQueue.getJobs()).length, jobsAntes);

      await collection.updateOne(
        { _id: insertedId },
        { $set: { code: "ITEM-002" } },
      );
      let jobsDespues = jobsAntes;
      for (let intento = 0; intento < 30; intento++) {
        jobsDespues = (await syncQueue.getJobs()).length;
        if (jobsDespues > jobsAntes) break;
        await sleep(250);
      }
      assertEquals(jobsDespues > jobsAntes, true);
      const jobs = await syncQueue.getJobs();
      assertEquals(
        jobs.some((job) =>
          (job.data.sourceIds ?? []).includes(
            BSON.EJSON.stringify(insertedId, { relaxed: false }),
          )
        ),
        true,
      );
    } finally {
      await stream.close();
      await redisConn?.del(getCheckpointKey(mapping));
      await cleanQueue();
    }
  },
});

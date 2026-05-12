import { Queue } from "bullmq";
import { redisOptions } from "./db.ts";

export const syncQueue = new Queue("typesense-sync", {
  connection: redisOptions || { host: "localhost", port: 6379 },
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 10,
  },
});

import { Queue } from "bullmq";
import { redisOptions } from "./db.ts";

export const syncQueue = new Queue("typesense-sync", {
  connection: redisOptions || { host: "localhost", port: 6379 },
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

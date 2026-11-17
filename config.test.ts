import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections.ts";
import {
  CollectionMapping,
  IndexerConfig,
  TransformContext,
} from "./src/types.ts";
import { Document, ObjectId } from "mongodb";

export const CONFIG: IndexerConfig = {
  valkey: {
    host: "localhost",
    port: 6380,
  },
  typesense: {
    apiKey: "testkey",
    nodes: [
      {
        host: "localhost",
        port: 8109,
        protocol: "http",
      },
    ],
    connectionTimeoutSeconds: 10,
    numRetries: 1,
    retryIntervalSeconds: 1,
  },
  mongodb: [
    {
      uri: "mongodb://localhost:27018/testdb?replicaSet=rs0",
      collections: [
        {
          mongoDb: "testdb",
          mongoCollection: "testdocs",
          schema: {
            name: "testdocs",
            fields: [
              { name: "doc_id", type: "string", sort: true },
              { name: "title", type: "string" },
              { name: "content", type: "string" },
            ],
            default_sorting_field: "doc_id",
          } as CollectionCreateSchema,
          transform: (doc: {
            _id: ObjectId;
            title?: string;
            content?: string;
            issueDate?: Date;
          }) => ({
            id: doc._id.toString(),
            doc_id: doc._id.toString(),
            title: doc.title || "",
            content: doc.content || "",
          }),
        },
        {
          mongoDb: "testdb",
          mongoCollection: "dependentdocs",
          schema: {
            name: "dependentdocs",
            fields: [{ name: "tag", type: "string" }],
          } as CollectionCreateSchema,
          dependencies: [{ mongoCollection: "testtags", localField: "tagId" }],
          transform: async (doc: Document, ctx: TransformContext) => {
            const tagId = doc.tagId as ObjectId | undefined;
            const cacheKey = tagId?.toString() ?? "";
            let tag = cacheKey
              ? (ctx.cache.get(cacheKey) as string | undefined)
              : "";
            if (tag === undefined) {
              const tagDoc = tagId
                ? await ctx.db.collection("testtags").findOne({ _id: tagId })
                : null;
              tag = String(tagDoc?.name ?? "");
              if (cacheKey) ctx.cache.set(cacheKey, tag);
            }
            return { id: doc._id.toString(), tag };
          },
        },
      ] as CollectionMapping[],
    },
  ],
  http: {
    port: 3132,
  },
};

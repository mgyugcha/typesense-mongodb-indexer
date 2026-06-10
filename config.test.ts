import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections.ts";
import { CollectionMapping, IndexerConfig } from "./src/types.ts";
import { ObjectId } from "mongodb";

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
      ] as CollectionMapping[],
    },
  ],
  http: {
    port: 3132,
  },
};

import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections.ts";
import { Document } from "mongodb";

export interface CollectionMapping {
  /** The MongoDB database name */
  mongoDb: string;
  /** The MongoDB collection name */
  mongoCollection: string;
  /** The Typesense collection name */
  typesenseCollection: string;
  /** The Typesense collection schema */
  schema: CollectionCreateSchema;
  /** Direct fields to project and sync (optional) */
  fields?: string[];
  /** Custom transformation function (optional, overrides fields) */
  transform?: (doc: Document) => Record<string, unknown>;
}

export interface IndexerConfig {
  mongodb: {
    uri: string;
  };
  valkey: {
    host: string;
    port: number;
    password?: string;
  };
  typesense: {
    apiKey: string;
    nodes: Array<{
      host: string;
      port: number;
      protocol: string;
    }>;
  };
  collections: CollectionMapping[];
}

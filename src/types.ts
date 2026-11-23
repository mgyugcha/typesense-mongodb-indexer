import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections.ts";
import { Db, Document, UpdateDescription } from "mongodb";

/**
 * Contexto que reciben `prepare` y `transform`. `db` permite leer otras
 * colecciones. `prepare` deja en `cache` los datos del lote que `transform`
 * consulta después. El contexto dura un job: cada lote arranca con un `cache`
 * vacío.
 */
export interface TransformContext {
  db: Db;
  cache: Map<string, unknown>;
}

/**
 * Dependencia entre colecciones: un cambio en `mongoCollection` reencola los
 * documentos del mapping que referencian ese `_id` en `localField`.
 */
export interface CollectionDependency {
  /** Colección de MongoDB que se observa. */
  mongoCollection: string;
  /** Campo del documento del mapping que guarda el `_id` observado. */
  localField: string;
}

export interface CollectionMapping {
  /** The MongoDB database name */
  mongoDb: string;
  /** The MongoDB collection name */
  mongoCollection: string;
  /** The Typesense collection schema */
  schema: CollectionCreateSchema;
  /** Direct fields to project and sync (optional) */
  fields?: string[];
  /**
   * Custom transformation function (optional, overrides fields). Se declara
   * como método para aceptar configs con un tipo de documento propio.
   */
  transform?(
    doc: Document,
    ctx: TransformContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Precarga datos compartidos por el lote antes de transformar. Se ejecuta una
   * sola vez por job, en lugar de una consulta por documento.
   */
  prepare?(docs: Document[], ctx: TransformContext): Promise<void> | void;
  /**
   * `true` cuando un update no toca campos indexados: solo se avanza el
   * checkpoint, sin encolar trabajo.
   */
  skipUpdate?(updateDescription: UpdateDescription): boolean;
  /** Colecciones cuyos cambios reindexan documentos de este mapping. */
  dependencies?: CollectionDependency[];
}

export interface IndexerConfig {
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
    connectionTimeoutSeconds?: number;
    numRetries?: number;
    retryIntervalSeconds?: number;
    /** Nivel de logs del cliente de Typesense. Por defecto `"error"`. */
    logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "silent";
  };
  mongodb: Array<{
    uri: string;
    collections: CollectionMapping[];
  }>;
  http?: {
    port: number;
    host?: string;
  };
}

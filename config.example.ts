import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections.ts";
import { CollectionMapping, IndexerConfig } from "./src/types.ts";

export const CONFIG: IndexerConfig = {
  mongodb: {
    uri: "mongodb://localhost/mysistem?replicaSet=rs0",
  },
  valkey: {
    host: "localhost",
    port: 6379,
  },
  typesense: {
    apiKey: "uqtqsvtqsvqehzhw",
    nodes: [
      {
        host: "localhost",
        port: 8108,
        protocol: "http",
      },
    ],
  },
  collections: [
    {
      mongoDb: "facturacion",
      mongoCollection: "invoices",
      typesenseCollection: "invoices",
      schema: {
        name: "invoices",
        fields: [
          { name: "id", type: "string" },
          { name: "business", type: "string" },
          { name: "serial_number", type: "string" },
          { name: "clave_acceso", type: "string", optional: true },
          { name: "identificacion", type: "string", facet: true },
          { name: "razon_social", type: "string" },
          { name: "fecha_emision", type: "int64" },
          { name: "status", type: "string", facet: true },
          { name: "detalles_descripcion", type: "string[]" },
          { name: "detalles_codigo", type: "string[]" },
          { name: "total", type: "float", optional: true },
        ],
        default_sorting_field: "fecha_emision",
      } as CollectionCreateSchema,
      transform: (doc: any) => {
        const info = doc.infoTributaria || {};
        const infoFactura = doc.infoFactura || {};

        return {
          id: doc._id.toString(),
          business: doc.business?.toString(),
          serial_number: [info.estab, info.ptoEmi, info.secuencial].join("-"),
          clave_acceso: info.claveAcceso,
          identificacion: infoFactura.identificacionComprador,
          razon_social: infoFactura.razonSocialComprador,
          fecha_emision: doc.issueDate ? new Date(doc.issueDate).getTime() : 0,
          status: doc.status,
          detalles_descripcion: doc.detalles?.map((d: any) => d.descripcion) ||
            [],
          detalles_codigo: doc.detalles?.map((d: any) => d.codigoPrincipal) ||
            [],
          total: infoFactura.importeTotal,
        };
      },
    },
  ] as CollectionMapping[],
};

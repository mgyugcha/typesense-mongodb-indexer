import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections.ts";
import { IndexerConfig } from "./src/types.ts";

export const CONFIG: IndexerConfig = {
  valkey: {
    host: "localhost",
    port: 6379,
  },
  typesense: {
    apiKey: "123test123",
    nodes: [
      {
        host: "localhost",
        port: 8108,
        protocol: "http",
      },
    ],
  },
  mongodb: [
    {
      uri: "mongodb://localhost/mysistem?replicaSet=rs0",
      collections: [
        {
          mongoDb: "facturacion",
          mongoCollection: "invoices",
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
          transform: (doc: unknown) => {
            const info = (doc as any).infoTributaria || {};
            const infoFactura = (doc as any).infoFactura || {};

            return {
              id: (doc as any)._id.toString(),
              business: (doc as any).business?.toString(),
              serial_number: [info.estab, info.ptoEmi, info.secuencial].join(
                "-",
              ),
              clave_acceso: info.claveAcceso,
              identificacion: infoFactura.identificacionComprador,
              razon_social: infoFactura.razonSocialComprador,
              fecha_emision: (doc as any).issueDate
                ? new Date((doc as any).issueDate).getTime()
                : 0,
              status: (doc as any).status,
              detalles_descripcion:
                (doc as any).detalles?.map((d: any) => d.descripcion) ||
                [],
              detalles_codigo:
                (doc as any).detalles?.map((d: any) => d.codigoPrincipal) ||
                [],
              total: infoFactura.importeTotal,
            };
          },
        },
      ],
    },
  ],
};

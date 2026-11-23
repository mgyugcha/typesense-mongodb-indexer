import { Document, UpdateDescription } from "mongodb";
import { CollectionMapping, TransformContext } from "../types.ts";

export async function applyTransform(
  mapping: CollectionMapping,
  doc: Document,
  ctx: TransformContext,
): Promise<Record<string, unknown>> {
  if (mapping.transform) {
    return await mapping.transform(doc, ctx);
  }

  // Proyección por campos
  const result: Record<string, unknown> = { _id: doc._id.toString() };
  if (mapping.fields) {
    for (const field of mapping.fields) {
      if (doc[field] !== undefined) {
        result[field] = doc[field];
      }
    }
  } else {
    // Si no hay campos ni transform, enviamos todo excepto _id
    const { _id, ...rest } = doc;
    Object.assign(result, rest);
  }
  return result;
}

const ACENTOS = /[\u0300-\u036f]/g;

/** Minúsculas, sin tildes, solo letras y números, espacios colapsados. */
export function normalizeText(value?: string | null): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(ACENTOS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Codifica el valor como hex UTF-8 de `trim().toLowerCase()`. Typesense
 * tokeniza y quita símbolos también en `:=`, así que el valor debe ser opaco
 * (`sku-001` y `sku001` no pueden empatar).
 */
export function encodeExactCode(value?: string | null): string {
  const normalizado = value?.trim().toLowerCase() ?? "";
  if (!normalizado) return "";
  return [...new TextEncoder().encode(normalizado)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hook de `cdc.ts`: `true` cuando el update solo tocó rutas fuera de
 * `camposIndexados`, probadas contra las rutas que reporta MongoDB.
 */
export function skipUnindexedUpdates(
  camposIndexados: RegExp[],
): (update: UpdateDescription) => boolean {
  return (update) => {
    const rutas = [
      ...Object.keys(update.updatedFields ?? {}),
      ...(update.removedFields ?? []),
      ...(update.truncatedArrays ?? []).map((truncado) => truncado.field),
    ];
    return rutas.length > 0 &&
      rutas.every((ruta) =>
        !camposIndexados.some((patron) => patron.test(ruta))
      );
  };
}

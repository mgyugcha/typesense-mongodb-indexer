import { Document } from "mongodb";
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

/** Sin separadores: `A-001` y `A001` producen `a001`. */
export function normalizeCode(value?: string | null): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(ACENTOS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function decodeSegmento(segmento: string): string {
  try {
    return decodeURIComponent(segmento);
  } catch {
    return segmento;
  }
}

/**
 * Nombre crudo de una categoría a texto buscable. Se parte por `/` antes de
 * decodificar: un `/` literal se guarda como `%2F`.
 * `Bandas%20y%20transmisi%C3%B3n/DAYKO%2FCUMMINS` →
 * `bandas y transmision dayko cummins`.
 */
export function categorySearchText(nombre?: string | null): string {
  if (!nombre) return "";
  return normalizeText(nombre.split("/").map(decodeSegmento).join(" "));
}

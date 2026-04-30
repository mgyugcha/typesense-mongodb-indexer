import { Document } from "mongodb";
import { CollectionMapping } from "../types.ts";

export function applyTransform(mapping: CollectionMapping, doc: Document) {
  if (mapping.transform) {
    return mapping.transform(doc);
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

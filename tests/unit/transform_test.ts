import { assertEquals } from "@std/assert";
import { ObjectId } from "mongodb";
import type { UpdateDescription } from "mongodb";
import {
  encodeExactCode,
  normalizeText,
  skipUnindexedUpdates,
  tokensSeparadosPorLetraDigito,
} from "../../src/utils/transform.ts";

const update = (datos: Partial<UpdateDescription>): UpdateDescription => ({
  updatedFields: {},
  removedFields: [],
  ...datos,
});

Deno.test("normalizeText: tildes, mayúsculas y separadores", () => {
  assertEquals(normalizeText("inyección"), "inyeccion");
  assertEquals(
    normalizeText("  Hola   MUNDO grande  "),
    "hola mundo grande",
  );
  assertEquals(normalizeText("6C 8.3/6CT"), "6c 8 3 6ct");
  assertEquals(normalizeText("A-001"), "a 001");
  assertEquals(normalizeText("50%"), "50");
  assertEquals(normalizeText(undefined), "");
});

Deno.test("tokensSeparadosPorLetraDigito: parte solo tokens mixtos de la descripción", () => {
  assertEquals(
    tokensSeparadosPorLetraDigito("P. AUTOMOTRIZ CHEV SWIFT M12X1.25 X 40"),
    ["m", "12", "x", "1"],
  );
  assertEquals(tokensSeparadosPorLetraDigito("PERNO 40 MM"), []);
  assertEquals(tokensSeparadosPorLetraDigito("CHASIS #21 / 40 PIES"), []);
  assertEquals(
    tokensSeparadosPorLetraDigito("REEMPLAZA A (PAE20069) Y PAE40015"),
    [],
  );
  assertEquals(tokensSeparadosPorLetraDigito(undefined), []);
});

Deno.test("tokensSeparadosPorLetraDigito: casos borde de tildes, dígitos y repetición", () => {
  assertEquals(tokensSeparadosPorLetraDigito("ÁB12"), ["ab", "12"]);
  assertEquals(tokensSeparadosPorLetraDigito("M123"), ["m", "123"]);
  assertEquals(tokensSeparadosPorLetraDigito("M1234"), []);
  assertEquals(
    tokensSeparadosPorLetraDigito("M12X1 M12X1"),
    ["m", "12", "x", "1", "m", "12", "x", "1"],
  );
});

Deno.test("encodeExactCode: hex UTF-8 opaco para Typesense", () => {
  assertEquals(encodeExactCode("SKU-001"), "736b752d303031");
  assertEquals(encodeExactCode("SKU001"), "736b75303031");
  assertEquals(encodeExactCode("SKU-001") === encodeExactCode("SKU001"), false);
  assertEquals(encodeExactCode(undefined), "");
});

Deno.test("skipUnindexedUpdates: solo omite updates fuera del índice", () => {
  const skip = skipUnindexedUpdates([
    /^code$/,
    /^tags(\.|$)/,
    /^parts(\.\d+(\.part)?)?$/,
  ]);

  assertEquals(
    skip(update({
      updatedFields: {
        "parts.0.qty": 5,
        stock: 10,
        updatedAt: new Date(),
        "prices.0.value": 1,
        "history.2.note": "Editado",
      },
    })),
    true,
  );
  assertEquals(skip(update({ updatedFields: { parts: [] } })), false);
  assertEquals(
    skip(update({
      updatedFields: { "parts.0": { part: new ObjectId(), qty: 1 } },
    })),
    false,
  );
  assertEquals(
    skip(update({
      updatedFields: { "parts.1": { part: new ObjectId(), qty: 1 } },
    })),
    false,
  );
  assertEquals(
    skip(update({ updatedFields: { "parts.0.part": new ObjectId() } })),
    false,
  );
  assertEquals(skip(update({ updatedFields: { "parts.1.qty": 9 } })), true);
  assertEquals(skip(update({ updatedFields: { code: "SKU-002" } })), false);
  assertEquals(skip(update({ updatedFields: { tags: ["x"] } })), false);
  assertEquals(skip(update({ removedFields: ["tags.0"] })), false);
  assertEquals(
    skip(update({ truncatedArrays: [{ field: "parts", newSize: 0 }] })),
    false,
  );
  assertEquals(skip(update({ updatedFields: {}, removedFields: [] })), false);
});

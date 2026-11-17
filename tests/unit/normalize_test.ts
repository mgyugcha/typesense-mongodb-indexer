import { assertEquals } from "@std/assert";
import {
  categorySearchText,
  normalizeCode,
  normalizeText,
} from "../../src/utils/transform.ts";

Deno.test("normalizeText: tildes, mayúsculas y separadores", () => {
  assertEquals(normalizeText("inyección"), "inyeccion");
  assertEquals(
    normalizeText("  Camisas   MANGA larga  "),
    "camisas manga larga",
  );
  assertEquals(normalizeText("6C 8.3/6CT"), "6c 8 3 6ct");
  assertEquals(normalizeText("A-001"), "a 001");
  assertEquals(normalizeText("50%"), "50");
  assertEquals(normalizeText(undefined), "");
});

Deno.test("normalizeCode: sin separadores", () => {
  assertEquals(normalizeCode("A-001"), "a001");
  assertEquals(normalizeCode("a 001"), "a001");
  assertEquals(normalizeCode(undefined), "");
});

Deno.test("categorySearchText: parte por / antes de decodificar", () => {
  assertEquals(
    categorySearchText("Bandas%20y%20transmisi%C3%B3n/DAYKO%2FCUMMINS"),
    "bandas y transmision dayko cummins",
  );
  assertEquals(
    categorySearchText("CAPUCHONES%203%2F4%20/CAPUCHONES%203%2F4%202%20"),
    "capuchones 3 4 capuchones 3 4 2",
  );
  assertEquals(categorySearchText("Camisas/Deutz%20"), "camisas deutz");
  assertEquals(categorySearchText("50%/Repuestos"), "50 repuestos");
  assertEquals(categorySearchText(undefined), "");
});

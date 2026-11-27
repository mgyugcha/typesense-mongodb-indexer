import { assert, assertEquals } from "@std/assert";
import { typesense } from "./helpers.ts";
import {
  encodeExactCode,
  normalizeText,
  tokensSeparadosPorLetraDigito,
} from "../src/utils/transform.ts";

const COLECCION = "test_productos_infix";
const EMPRESA = "negocio-test";
const FILTRO = `business:=${EMPRESA} && type:=producto && tipoProducto:=bien`;

const PARAMS_API = {
  query_by: "codes,searchText",
  query_by_weights: "4,1",
  num_typos: "0,2",
  prefix: "true,true",
  drop_tokens_threshold: 0,
  min_len_1typo: 4,
  min_len_2typo: 7,
  enable_typos_for_numerical_tokens: false,
  per_page: 20,
  filter_by: FILTRO,
};

type Infix = "always" | "fallback" | "off";

const INFIX_API: Infix[] = ["always", "off"];
const SIN_INFIX: Infix[] = ["off", "off"];

const sortApi = (q: string) =>
  `_eval(codesExact:=[${encodeExactCode(q)}]):desc,_text_match:desc,code:asc`;

type Doc = {
  id: string;
  business: string;
  type: string;
  tipoProducto: string;
  code: string;
  codes: string[];
  codesExact: string[];
  searchText: string;
  idTs: number;
};

// Mismo cálculo que documentoProducto: codes en minúsculas, codesExact en hex
// del valor original y searchText con los tokens partidos de la descripción.
function doc(
  id: string,
  codigos: string[],
  description: string,
  idTs: number,
  extra: Partial<Doc> = {},
): Doc {
  const tokens = tokensSeparadosPorLetraDigito(description).join(" ");
  return {
    id,
    business: EMPRESA,
    type: "producto",
    tipoProducto: "bien",
    code: codigos[0],
    codes: codigos.map((c) => c.toLowerCase()),
    codesExact: codigos.map((c) => encodeExactCode(c)),
    searchText: [
      normalizeText([...codigos, description].join(" ")),
      tokens,
    ].filter(Boolean).join(" "),
    idTs,
    ...extra,
  };
}

const documentos: Doc[] = [
  doc("e", ["20069"], "producto exacto", 1),
  doc("p", ["200690"], "producto prefijo", 2),
  // Empieza por 20069 (prefijo) y contiene 20069 más adelante (infix).
  doc("pi", ["2006920069"], "producto mixto", 3),
  doc("i", ["PAE20069"], "tornillo hexagonal", 4),
  // El fragmento está solo en el código auxiliar.
  doc("m", ["AB1", "ZZ20069"], "producto auxiliar", 5),
  doc("tornillo", ["TOR01"], "tornillo corto", 6),
  // Otra empresa, mismos fragmentos: nunca debe aparecer con el filtro de la API.
  doc("ajeno", ["PAE20069"], "tornillo hexagonal", 7, {
    business: "otra-empresa",
  }),
  // Misma empresa, otro tipo: tampoco debe aparecer.
  doc("srv", ["SRV20069"], "servicio torneado", 8, { type: "servicio" }),
  // Pernos: la descripción mezcla letras y dígitos (M12X1.25 X 40).
  doc("perno1", ["PRN-001"], "P. AUTOMOTRIZ CHEV SWIFT M12X1.25 X 40", 9),
  doc("perno2", ["PRN-002"], "PERNO AUTOMOTRIZ M12X1.25 X 40 ACERO", 10),
  doc("perno3", ["PRN-003"], "PERNO AUTOMOTRIZ M12 X 30", 11),
  // Código con 40 dentro: no debe aparecer para la búsqueda `40`.
  doc("pae40", ["PAE40001"], "ARANDELA PLANA", 12),
  doc("chasis", ["CHS-021"], "CHASIS #21 / 40 PIES", 13),
  doc("tuerca", ["TRC-001"], "TUERCA HEXAGONAL M10", 14),
  // Solo cita PAE20069 en la descripción: no debe competir con el código real.
  doc("cita", ["CIT-001"], "REEMPLAZA A (PAE20069)", 15),
];

async function prepararColeccion() {
  try {
    await typesense.collections(COLECCION).delete();
  } catch {
    // no existía
  }
  await typesense.collections().create({
    name: COLECCION,
    fields: [
      { name: "business", type: "string" },
      { name: "type", type: "string" },
      { name: "tipoProducto", type: "string", optional: true },
      { name: "code", type: "string", sort: true },
      { name: "codes", type: "string[]", infix: true },
      { name: "codesExact", type: "string[]" },
      { name: "searchText", type: "string" },
      { name: "idTs", type: "int64", sort: true },
    ],
    default_sorting_field: "idTs",
  });
  const resultados = await typesense
    .collections(COLECCION)
    .documents()
    .import(documentos, { action: "create" });
  const fallidos = resultados.filter((r) => !r.success);
  assertEquals(
    fallidos,
    [],
    "No se pudieron importar los documentos de prueba",
  );
}

async function eliminarColeccion() {
  try {
    await typesense.collections(COLECCION).delete();
  } catch {
    // ya eliminada
  }
}

type Hit = { id: string; tm: number };

async function buscar(
  q: string,
  infix: Infix[],
  extra: Record<string, unknown> = {},
): Promise<Hit[]> {
  const res = await typesense.collections(COLECCION).documents().search({
    ...PARAMS_API,
    q,
    infix,
    ...extra,
  });
  return (res.hits ?? []).map((hit) => ({
    id: (hit.document as { id: string }).id,
    tm: hit.text_match ?? 0,
  }));
}

const ids = (hits: Hit[]) => hits.map((h) => h.id);
const resumen = (hits: Hit[]) =>
  hits.map((h) => `${h.id}(text_match=${h.tm})`).join(" ");

async function conColeccion(fn: () => Promise<void>) {
  await prepararColeccion();
  try {
    await fn();
  } finally {
    await eliminarColeccion();
  }
}

Deno.test({
  name: "Infix: q=20069 con infix encuentra codes pae20069; sin infix no",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const con = await buscar("20069", INFIX_API);
      assert(
        ids(con).includes("i"),
        `Con infix no apareció 'pae20069': ${resumen(con)}`,
      );

      const sin = await buscar("20069", SIN_INFIX);
      assert(
        !ids(sin).includes("i"),
        `Sin infix apareció 'pae20069': ${resumen(sin)}`,
      );
    }),
});

Deno.test({
  name:
    "Citas: 20069 no trae el producto que solo cita PAE20069 en la descripción",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("20069", INFIX_API, {
        sort_by: sortApi("20069"),
      });
      assert(
        !ids(hits).includes("cita"),
        `'20069' trajo el producto que solo cita el código: ${resumen(hits)}`,
      );
      assert(
        ids(hits).includes("i"),
        `'20069' no encontró PAE20069: ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name: "Infix: q=0069 encuentra PAE20069 por infix de codes",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("0069", INFIX_API);
      assert(
        ids(hits).includes("i") && ids(hits).includes("e"),
        `'0069' no encontró PAE20069: ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name:
    "Infix: fragmento solo en el código auxiliar (codes[1]) encuentra el producto",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const con = await buscar("20069", INFIX_API);
      assert(
        ids(con).includes("m"),
        `Con infix no apareció el auxiliar 'zz20069': ${resumen(con)}`,
      );

      const sin = await buscar("20069", SIN_INFIX);
      assert(
        !ids(sin).includes("m"),
        `Sin infix apareció el auxiliar 'zz20069': ${resumen(sin)}`,
      );
    }),
});

Deno.test({
  name:
    "Infix: no aplica a la descripción; 'agona' no encuentra 'tornillo hexagonal'",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("agona", INFIX_API);
      assert(
        !ids(hits).includes("i"),
        `Infix sobre searchText encontró 'hexagonal': ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name:
    "Infix: orden exacto > prefijo > solo infix, sin que prefijo+infix caiga al final",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("20069", INFIX_API, {
        sort_by: sortApi("20069"),
      });
      const orden = ids(hits);
      assertEquals(
        orden.length,
        5,
        `Se esperaban 5 resultados: ${resumen(hits)}`,
      );
      assertEquals(
        orden[0],
        "e",
        `El código exacto debe ir primero: ${resumen(hits)}`,
      );
      assertEquals(
        new Set(orden.slice(1, 3)),
        new Set(["p", "pi"]),
        `Prefijo y prefijo+infix deben ir antes de solo infix: ${
          resumen(hits)
        }`,
      );
      assertEquals(
        new Set(orden.slice(3)),
        new Set(["i", "m"]),
        `Las coincidencias solo por infix deben ir al final: ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name: "Tolerancia a errores de tipeo sobre searchText (tornilo -> tornillo)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("tornilo", INFIX_API);
      assert(
        ids(hits).includes("tornillo"),
        `'tornilo' no encontró 'tornillo corto': ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name:
    "Partición de descripción: 'automotriz 12 40' encuentra los pernos M12X1.25 X 40",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("automotriz 12 40", SIN_INFIX);
      const encontrados = ids(hits);
      assert(
        encontrados.includes("perno1") && encontrados.includes("perno2"),
        `'automotriz 12 40' no encontró los pernos M12X1.25 X 40: ${
          resumen(hits)
        }`,
      );
      assert(
        !encontrados.includes("perno3"),
        `'automotriz 12 40' no debería traer 'M12 X 30': ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name: "Partición de descripción: 'm12x1 25' sigue encontrando el perno",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("m12x1 25", SIN_INFIX);
      assert(
        ids(hits).includes("perno1") && ids(hits).includes("perno2"),
        `'m12x1 25' no encontró los pernos: ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name: "Partición: '40' no trae PAE40xxx por partición de códigos",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("40", SIN_INFIX);
      assert(
        !ids(hits).includes("pae40"),
        `'40' trajo PAE40001 por partición de códigos: ${resumen(hits)}`,
      );
      assert(
        ids(hits).includes("perno1") && ids(hits).includes("chasis"),
        `'40' no encontró las descripciones con 40: ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name:
    "Descripción con símbolos: 'chasis 21 40 pies' coincide con 'CHASIS #21 / 40 PIES'",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("chasis 21 40 pies", SIN_INFIX);
      assertEquals(
        ids(hits),
        ["chasis"],
        `'chasis 21 40 pies' no encontró solo el chasis: ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name:
    "Partición de descripción: 'tuerca m10' encuentra 'TUERCA HEXAGONAL M10'",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("tuerca m10", SIN_INFIX);
      assertEquals(
        ids(hits),
        ["tuerca"],
        `'tuerca m10' no encontró la tuerca: ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name: "Búsqueda exacta por código: primero el exacto vía codesExact",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("prn 002", SIN_INFIX, {
        sort_by: sortApi("PRN-002"),
      });
      assertEquals(
        ids(hits)[0],
        "perno2",
        `El código exacto no fue primero: ${resumen(hits)}`,
      );
    }),
});

Deno.test({
  name: "Filtros: el filtro de la API excluye otra empresa y otro tipo",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      for (const q of ["20069", "torn", "tornilo"]) {
        const hits = await buscar(q, INFIX_API, { sort_by: sortApi(q) });
        assert(
          !ids(hits).includes("ajeno"),
          `'${q}' devolvió el producto de otra empresa: ${resumen(hits)}`,
        );
        assert(
          !ids(hits).includes("srv"),
          `'${q}' devolvió un producto de otro tipo: ${resumen(hits)}`,
        );
      }

      // Controles: sin el filtro de la API esos documentos sí coinciden.
      const otraEmpresa = await buscar("20069", INFIX_API, {
        filter_by: "business:=otra-empresa",
      });
      assert(
        ids(otraEmpresa).includes("ajeno"),
        `El control de otra empresa no coincidió: ${resumen(otraEmpresa)}`,
      );

      const otroTipo = await buscar("20069", INFIX_API, {
        filter_by: `business:=${EMPRESA} && type:=servicio`,
      });
      assert(
        ids(otroTipo).includes("srv"),
        `El control de otro tipo no coincidió: ${resumen(otroTipo)}`,
      );
    }),
});

Deno.test({
  name: "Infix: usar infix sobre un campo sin infix responde 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      let error: unknown;
      try {
        await buscar("exag", ["always", "always"], {
          query_by: "codes,searchText",
          query_by_weights: "4,1",
          num_typos: "0,2",
          prefix: "true,true",
        });
      } catch (e) {
        error = e;
      }
      assert(
        error,
        "Typesense aceptó infix sobre searchText, que no declara infix",
      );
      assertEquals((error as { httpStatus?: number }).httpStatus, 400);
    }),
});

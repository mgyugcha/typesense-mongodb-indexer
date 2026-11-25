import { assert, assertEquals } from "@std/assert";
import { typesense } from "./helpers.ts";
import { encodeExactCode, normalizeText } from "../src/utils/transform.ts";

const COLECCION = "test_productos_infix";
const EMPRESA = "negocio-test";
const FILTRO = `business:=${EMPRESA} && type:=producto && tipoProducto:=bien`;

const PARAMS_API = {
  query_by: "codes,description,categoriasTexto,searchText",
  query_by_weights: "4,3,2,1",
  num_typos: "0,2,2,2",
  prefix: "true,true,true,true",
  drop_tokens_threshold: 0,
  min_len_1typo: 4,
  min_len_2typo: 7,
  enable_typos_for_numerical_tokens: false,
  per_page: 20,
  filter_by: FILTRO,
};

type Infix = "always" | "fallback" | "off";

const INFIX_API: Infix[] = ["always", "always", "off", "off"];
const SIN_INFIX: Infix[] = ["off", "off", "off", "off"];

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
  description: string;
  searchText: string;
  idTs: number;
};

// Mismo cálculo que documentoProducto: codes en minúsculas, codesExact en hex
// del valor original y searchText normalizado.
function doc(
  id: string,
  codigos: string[],
  description: string,
  idTs: number,
  extra: Partial<Doc> = {},
): Doc {
  return {
    id,
    business: EMPRESA,
    type: "producto",
    tipoProducto: "bien",
    code: codigos[0],
    codes: codigos.map((c) => c.toLowerCase()),
    codesExact: codigos.map((c) => encodeExactCode(c)),
    description,
    searchText: normalizeText([...codigos, description].join(" ")),
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
  // Cruce de campos, dirección 1: A por prefijo en description (peso 3)
  // frente a B solo por infix en codes (peso 4). Consulta: torn.
  doc("x1", ["ZZ9"], "tornillo corto", 6),
  doc("x2", ["XTORN9"], "producto b", 7),
  // Cruce de campos, dirección 2: A por prefijo en codes (peso 4) frente a
  // B solo por infix en description (peso 3). Consulta: torn.
  doc("a1", ["TORN01"], "producto a", 8),
  doc("b1", ["B9"], "destornillador", 9),
  // Otra empresa, mismos fragmentos: nunca debe aparecer con el filtro de la API.
  doc("ajeno", ["PAE20069"], "tornillo hexagonal", 10, {
    business: "otra-empresa",
  }),
  // Misma empresa, otro tipo: tampoco debe aparecer.
  doc("srv", ["SRV20069"], "servicio torneado", 11, { type: "servicio" }),
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
      { name: "business", type: "string", facet: true },
      { name: "type", type: "string", facet: true },
      { name: "tipoProducto", type: "string", facet: true, optional: true },
      { name: "code", type: "string", sort: true },
      { name: "codes", type: "string[]", infix: true },
      { name: "codesExact", type: "string[]" },
      { name: "description", type: "string", infix: true },
      { name: "categoriasTexto", type: "string[]", optional: true },
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
    "Infix: q=exag con infix encuentra description 'tornillo hexagonal'; agona solo con infix",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const con = await buscar("exag", INFIX_API);
      assert(
        ids(con).includes("i"),
        `Con infix no apareció 'tornillo hexagonal': ${resumen(con)}`,
      );

      // 'exag' sin infix también llega por typo-prefix ('hexag'), así que el
      // control que aísla infix usa 'agona', que solo existe dentro de 'hexagonal'.
      const conAgona = await buscar("agona", INFIX_API);
      assert(
        ids(conAgona).includes("i"),
        `Con infix 'agona' no encontró 'hexagonal': ${resumen(conAgona)}`,
      );

      const sinAgona = await buscar("agona", SIN_INFIX);
      assert(
        !ids(sinAgona).includes("i"),
        `Sin infix apareció 'agona' en 'hexagonal': ${resumen(sinAgona)}`,
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
  name:
    "Infix cruzado (dirección 1): A por prefijo en description supera a B solo infix en codes",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("torn", INFIX_API, {
        sort_by: sortApi("torn"),
      });
      const orden = ids(hits);
      assert(
        orden.includes("x1") && orden.includes("x2"),
        `Faltan x1 o x2: ${resumen(hits)}`,
      );
      assert(
        orden.indexOf("x1") < orden.indexOf("x2"),
        `Se esperaba x1 (prefijo en description) antes que x2 (solo infix en codes): ${
          resumen(hits)
        }`,
      );
    }),
});

Deno.test({
  name:
    "Infix cruzado (dirección 2): A por prefijo en codes supera a B solo infix en description",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("torn", INFIX_API, {
        sort_by: sortApi("torn"),
      });
      const orden = ids(hits);
      assert(
        orden.includes("a1") && orden.includes("b1"),
        `Faltan a1 o b1: ${resumen(hits)}`,
      );
      assert(
        orden.indexOf("a1") < orden.indexOf("b1"),
        `Se esperaba a1 (prefijo en codes) antes que b1 (solo infix en description): ${
          resumen(hits)
        }`,
      );
    }),
});

Deno.test({
  name:
    "Infix: la tolerancia a errores en description se conserva (tornilo -> tornillo)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("tornilo", INFIX_API);
      assert(
        ids(hits).includes("i"),
        `'tornilo' no encontró 'tornillo hexagonal': ${resumen(hits)}`,
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

Deno.test({
  name:
    "Filtros: el filtro de la API excluye otra empresa y otro tipo, sin tocar a los de la empresa",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      for (const q of ["20069", "exag", "torn", "tornilo"]) {
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
  name: "Infix: la API declara el mismo filter_by en todas las búsquedas",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    conColeccion(async () => {
      const hits = await buscar("20069", INFIX_API);
      assertEquals(
        ids(hits).sort(),
        ["e", "i", "m", "p", "pi"],
        `Resultados inesperados con el filtro de la API: ${resumen(hits)}`,
      );
    }),
});

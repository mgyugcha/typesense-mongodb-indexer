import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  causaIndisponibilidad,
  crearControlDisponibilidad,
  ejecutarConDisponibilidad,
  ServicioNoDisponibleError,
} from "../../src/lib/disponibilidad.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function esperarHasta(condicion: () => boolean, limiteMs = 2000) {
  const inicio = Date.now();
  while (!condicion()) {
    if (Date.now() - inicio > limiteMs) throw new Error("tiempo agotado");
    await sleep(2);
  }
}

function jobFalso() {
  const movidos: number[] = [];
  return {
    movidos,
    moveToDelayed(timestamp: number) {
      movidos.push(timestamp);
      return Promise.resolve();
    },
  };
}

function controlFalso(sondaSana = false) {
  const pausas: string[] = [];
  let sondas = 0;
  return {
    pausas,
    get sondas() {
      return sondas;
    },
    control: {
      sondear() {
        sondas++;
        return Promise.resolve(sondaSana);
      },
      pausar(causa: string) {
        pausas.push(causa);
        return Promise.resolve();
      },
      detener() {},
    },
  };
}

Deno.test("causaIndisponibilidad: red y HTTP 502/503/504 son indisponibilidad", () => {
  assertEquals(causaIndisponibilidad({ code: "ECONNREFUSED" }), "ECONNREFUSED");
  assertEquals(causaIndisponibilidad({ httpStatus: 503 }), "HTTP 503");
  assertEquals(causaIndisponibilidad({ httpStatus: 502 }), "HTTP 502");
  assertEquals(
    causaIndisponibilidad(new Error("Not Ready or Lagging")),
    "conexión",
  );
  assertEquals(
    causaIndisponibilidad({ message: "x", cause: { code: "ECONNRESET" } }),
    "ECONNRESET",
  );
});

Deno.test("causaIndisponibilidad: errores de datos o esquema no son indisponibilidad", () => {
  assertEquals(causaIndisponibilidad({ httpStatus: 400 }), null);
  assertEquals(causaIndisponibilidad({ httpStatus: 404 }), null);
  assertEquals(causaIndisponibilidad({ httpStatus: 409 }), null);
  assertEquals(causaIndisponibilidad(new Error("Campo inválido")), null);
  assertEquals(causaIndisponibilidad(undefined), null);
});

Deno.test("ejecutarConDisponibilidad: indisponible devuelve el job sin consumir intento y lo procesa al volver", async () => {
  const job = jobFalso();
  const { pausas, control } = controlFalso();
  let llamadas = 0;
  const operacion = () => {
    llamadas++;
    if (llamadas === 1) return Promise.reject({ httpStatus: 503 });
    return Promise.resolve("ok");
  };

  await assertRejects(
    () => ejecutarConDisponibilidad(job, "token-1", control, operacion),
    ServicioNoDisponibleError,
  );
  assertEquals(job.movidos.length, 1);
  assertEquals(pausas, ["HTTP 503"]);

  // BullMQ vuelve a entregar el job cuando el worker se reanuda.
  const resultado = await ejecutarConDisponibilidad(
    job,
    "token-2",
    control,
    operacion,
  );
  assertStrictEquals(resultado, "ok");
  assertEquals(llamadas, 2);
  assertEquals(job.movidos.length, 1);
});

Deno.test("ejecutarConDisponibilidad: timeout con Typesense sano consume intento y no pausa", async () => {
  const job = jobFalso();
  const sonda = controlFalso(true);
  const error = { code: "ETIMEDOUT", message: "timed out" };

  let relanzado: unknown = null;
  try {
    await ejecutarConDisponibilidad(
      job,
      "token",
      sonda.control,
      () => Promise.reject(error),
    );
  } catch (e) {
    relanzado = e;
  }
  assertStrictEquals(relanzado, error);
  assertEquals(sonda.sondas, 1);
  assertEquals(job.movidos.length, 0);
  assertEquals(sonda.pausas.length, 0);
});

Deno.test("ejecutarConDisponibilidad: 502/504 intermitentes con health ok consumen intento", async () => {
  const job = jobFalso();
  const sonda = controlFalso(true);
  const error = { httpStatus: 504 };

  let relanzado: unknown = null;
  try {
    await ejecutarConDisponibilidad(
      job,
      "token",
      sonda.control,
      () => Promise.reject(error),
    );
  } catch (e) {
    relanzado = e;
  }
  assertStrictEquals(relanzado, error);
  assertEquals(job.movidos.length, 0);
  assertEquals(sonda.pausas.length, 0);
});

Deno.test("ejecutarConDisponibilidad: un error de datos se relanza y consume intento", async () => {
  const job = jobFalso();
  const { pausas, control } = controlFalso();
  const error = { httpStatus: 400, message: "esquema inválido" };

  let relanzado: unknown = null;
  try {
    await ejecutarConDisponibilidad(
      job,
      "token",
      control,
      () => Promise.reject(error),
    );
  } catch (e) {
    relanzado = e;
  }
  assertStrictEquals(relanzado, error);
  assertEquals(job.movidos.length, 0);
  assertEquals(pausas.length, 0);
});

Deno.test("crearControlDisponibilidad: una sola sonda, reanuda al estar listo y sin sondeos concurrentes", async () => {
  let pausas = 0;
  let reanudas = 0;
  let sondeos = 0;
  let enCurso = 0;
  let maximoConcurrente = 0;
  const respuestas = [false, false, true];
  const control = crearControlDisponibilidad({
    intervaloMs: 5,
    pausar: () => {
      pausas++;
      return Promise.resolve();
    },
    reanudar: () => {
      reanudas++;
    },
    sondear: async () => {
      sondeos++;
      enCurso++;
      maximoConcurrente = Math.max(maximoConcurrente, enCurso);
      await sleep(15);
      enCurso--;
      return respuestas.shift() ?? true;
    },
  });

  await control.pausar("ECONNREFUSED");
  await control.pausar("ECONNREFUSED");
  assertEquals(pausas, 1);

  await esperarHasta(() => reanudas === 1);
  const sondeosAlReanudar = sondeos;
  await sleep(40);
  assertEquals(reanudas, 1);
  assertEquals(sondeos, sondeosAlReanudar);
  assertEquals(sondeos, 3);
  assertEquals(maximoConcurrente, 1);
  control.detener();
});

Deno.test("crearControlDisponibilidad: detener corta la sonda", async () => {
  let sondeos = 0;
  const control = crearControlDisponibilidad({
    intervaloMs: 5,
    pausar: () => Promise.resolve(),
    reanudar: () => {},
    sondear: () => {
      sondeos++;
      return Promise.resolve(false);
    },
  });

  await control.pausar("ECONNRESET");
  await esperarHasta(() => sondeos >= 1);
  control.detener();
  const despues = sondeos;
  await sleep(40);
  assertEquals(sondeos, despues);
});

import { assertEquals } from "@std/assert";
import { sondearSalud } from "../../src/lib/sonda.ts";

const nodos = [
  { protocol: "http", host: "a", port: 8108 },
  { protocol: "http", host: "b", port: 8108 },
];

function fetchFalso(respuestas: Array<Response | Error>) {
  const urls: string[] = [];
  const senales: AbortSignal[] = [];
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    if (init?.signal) senales.push(init.signal);
    const siguiente = respuestas.shift();
    if (siguiente instanceof Error) return Promise.reject(siguiente);
    return Promise.resolve(siguiente!);
  }) as typeof fetch;
  return { fetcher, urls, senales };
}

Deno.test("sondearSalud: un nodo sano basta, sin reintentos y con timeout", async () => {
  const { fetcher, urls, senales } = fetchFalso([
    new Error("ECONNREFUSED"),
    new Response('{"ok":true}', { status: 200 }),
  ]);

  const ok = await sondearSalud(nodos, { fetcher, timeoutMs: 2000 });

  assertEquals(ok, true);
  assertEquals(urls, ["http://a:8108/health", "http://b:8108/health"]);
  assertEquals(senales.length, 2);
  assertEquals(senales.every((s) => s instanceof AbortSignal), true);
});

Deno.test("sondearSalud: 503 o ok false no cuentan como disponible", async () => {
  const { fetcher, urls } = fetchFalso([
    new Response('{"ok":false}', { status: 503 }),
    new Response('{"ok":false}', { status: 200 }),
  ]);

  assertEquals(await sondearSalud(nodos, { fetcher }), false);
  assertEquals(urls.length, 2);
});

Deno.test("sondearSalud: respuesta no JSON o error de red es caído, no excepción", async () => {
  const { fetcher } = fetchFalso([
    new Response("<html>", { status: 200 }),
    new TypeError("Connection reset by peer"),
  ]);

  assertEquals(await sondearSalud(nodos, { fetcher }), false);
});

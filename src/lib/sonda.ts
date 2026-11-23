export const TIMEOUT_SONDA_MS = 2000;

export interface NodoSonda {
  protocol: string;
  host: string;
  port: number;
}

/**
 * `true` si algún nodo responde `ok: true` en `/health`. Una sola petición por
 * nodo, sin reintentos ni logs: el cliente de escritura conserva su política.
 */
export async function sondearSalud(
  nodos: NodoSonda[],
  opciones: { timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<boolean> {
  const timeoutMs = opciones.timeoutMs ?? TIMEOUT_SONDA_MS;
  const fetcher = opciones.fetcher ?? fetch;
  for (const nodo of nodos) {
    try {
      const respuesta = await fetcher(
        `${nodo.protocol}://${nodo.host}:${nodo.port}/health`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      const cuerpo = await respuesta.text();
      if (respuesta.ok && JSON.parse(cuerpo).ok === true) return true;
    } catch {
      // Nodo caído o respuesta no válida: se prueba el siguiente.
    }
  }
  return false;
}

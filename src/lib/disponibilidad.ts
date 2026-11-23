export const INTERVALO_SONDA_MS = 5000;

export class ServicioNoDisponibleError extends Error {
  constructor(causa: string) {
    super(`Servicio no disponible (${causa})`);
    this.name = "ServicioNoDisponibleError";
  }
}

const CODIGOS_RED = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const ESTADOS_NO_DISPONIBLE = new Set([502, 503, 504]);
const MENSAJE_RED =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|Connection refused|socket hang up|Not Ready or Lagging/i;

/** Causa breve si el error indica que el servicio no está disponible; si no, `null`. */
export function causaIndisponibilidad(error: unknown): string | null {
  let actual: unknown = error;
  for (let profundidad = 0; actual && profundidad < 5; profundidad++) {
    const e = actual as {
      code?: unknown;
      httpStatus?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof e.code === "string" && CODIGOS_RED.has(e.code)) return e.code;
    if (
      typeof e.httpStatus === "number" &&
      ESTADOS_NO_DISPONIBLE.has(e.httpStatus)
    ) {
      return `HTTP ${e.httpStatus}`;
    }
    if (typeof e.message === "string" && MENSAJE_RED.test(e.message)) {
      return "conexión";
    }
    actual = e.cause;
  }
  return null;
}

export interface ControlDisponibilidadOpciones {
  /** `true` cuando el servicio responde OK. */
  sondear: () => Promise<boolean>;
  pausar: () => Promise<void>;
  reanudar: () => void;
  intervaloMs?: number;
}

export interface ControlDisponibilidad {
  /** Una sola sonda, sin pausar: decide si un error parece caída real. */
  sondear(): Promise<boolean>;
  pausar(causa: string): Promise<void>;
  detener(): void;
}

/**
 * Una sola sonda activa a la vez: mientras está pausado no se lanzan más
 * sondeos ni reanudaciones.
 */
export function crearControlDisponibilidad(
  opciones: ControlDisponibilidadOpciones,
): ControlDisponibilidad {
  const intervaloMs = opciones.intervaloMs ?? INTERVALO_SONDA_MS;
  let sonda: ReturnType<typeof setInterval> | null = null;
  let sondeando = false;
  let detenido = false;

  function detenerSonda() {
    if (sonda) clearInterval(sonda);
    sonda = null;
  }

  async function sondearUnaVez() {
    if (sondeando || detenido || sonda === null) return;
    sondeando = true;
    try {
      if (await opciones.sondear()) {
        detenerSonda();
        opciones.reanudar();
        console.log("[Worker] Typesense disponible; worker reanudado.");
      }
    } catch {
      // Sigue en pausa hasta la siguiente sonda.
    } finally {
      sondeando = false;
    }
  }

  return {
    sondear: () => opciones.sondear(),
    async pausar(causa: string) {
      if (detenido || sonda !== null) return;
      console.error(
        `[Worker] Typesense no disponible (${causa}). Worker en pausa; sondeo cada ${
          intervaloMs / 1000
        } s.`,
      );
      sonda = setInterval(() => void sondearUnaVez(), intervaloMs);
      await opciones.pausar();
    },
    detener() {
      detenido = true;
      detenerSonda();
    },
  };
}

/**
 * Si `operacion` falla con aspecto de indisponibilidad, confirma con una sola
 * sonda. Si Typesense responde sano (timeout de un lote grande, proxy con
 * 502/504 intermitentes), relanza el error original para que consuma un
 * intento normal. Solo si la sonda confirma la caída, devuelve el job a la
 * cola sin consumir intento, pausa el worker y lanza
 * `ServicioNoDisponibleError`, que el worker traduce a `DelayedError`.
 */
export async function ejecutarConDisponibilidad<T>(
  job: { moveToDelayed(timestamp: number, token?: string): Promise<void> },
  token: string | undefined,
  control: ControlDisponibilidad,
  operacion: () => Promise<T>,
): Promise<T> {
  try {
    return await operacion();
  } catch (error) {
    const causa = causaIndisponibilidad(error);
    if (causa === null) throw error;
    if (await control.sondear()) throw error;
    await job.moveToDelayed(Date.now() + INTERVALO_SONDA_MS, token);
    await control.pausar(causa);
    throw new ServicioNoDisponibleError(causa);
  }
}

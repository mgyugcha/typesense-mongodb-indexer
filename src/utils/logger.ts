export const isDebug = Deno.env.get("DEBUG") === "true";

export function debugLog(msg: string, data?: unknown) {
  if (isDebug) {
    console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data, null, 2) : "");
  }
}

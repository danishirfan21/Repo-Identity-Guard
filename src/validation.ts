/**
 * Small, total runtime validators for data crossing a trust boundary —
 * webview messages in particular. Every function here is total: it never
 * throws on a malformed input. Identity validation lives in
 * `src/identity/identityConfig.ts`.
 */

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Every array item that isn't a string is dropped rather than coerced — `String(obj)` silently produces `"[object Object]"`. */
export function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

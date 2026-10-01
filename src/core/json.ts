/** JSON helpers that preserve Infinity (used for open-ended boundary segments). */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v === Infinity ? 'Infinity' : v));
}

export function decodeJson<T>(text: string): T {
  return JSON.parse(text, (_key, v) => (v === 'Infinity' ? Infinity : v)) as T;
}

import { createHash } from "node:crypto";

/** Deterministische, UUID-ähnliche ID für Mock-Adapter (gleiche Eingabe → gleiche ID). */
export function mockId(prefix: string, seed: string): string {
  const h = createHash("sha256").update(`${prefix}|${seed}`).digest("hex");
  return `mock_${prefix}_${h.slice(0, 16)}`;
}

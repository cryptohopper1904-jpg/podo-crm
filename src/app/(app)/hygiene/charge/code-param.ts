import { normalizeBatchCode } from "@/lib/hygiene-rules";
import { BATCH_CODE_RE } from "@/server/hygiene";

/** Routenparameter → normalisierte Chargennummer (oder null bei ungültiger Eingabe). */
export function codeFromParam(raw: string): string | null {
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const n = normalizeBatchCode(v);
  return BATCH_CODE_RE.test(n) ? n : null;
}

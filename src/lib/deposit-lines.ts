import { dateDe } from "@/lib/format";

const PREFIX = /^Anzahlung( auf die Sammelrechnung( \d{4})?)?\s*:\s*/i;

/**
 * Text der Position, wenn eine Quittung (Anzahlung) mit ihrer Leistung in die Sammelrechnung übernommen wird:
 * „Anzahlung auf die Sammelrechnung 2026:“ fällt weg; steht kein Datum im Text, wird das Quittungsdatum vorangestellt.
 */
export function depositLineText(d: { description: string; issuedAt: string | null }): string {
  const text = d.description.replace(PREFIX, "").trim() || "Behandlung";
  const withDate = /\d{2}\.\d{2}\.\d{4}/.test(text) ? text : `${dateDe(d.issuedAt)}: ${text}`;
  return withDate.slice(0, 300);
}

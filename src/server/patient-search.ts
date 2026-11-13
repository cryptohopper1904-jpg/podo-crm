import "server-only";
import { and, asc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { isDeceased } from "@/lib/patient-deceased";
import {
  closestNames,
  FUZZY_BELOW_HITS,
  FUZZY_LIMIT,
  fuzzyEligible,
  queryTokens,
  SUGGEST_LIMIT,
  suggestedQuery,
} from "@/lib/patient-search";
import { patientSearchCondition } from "./patients";

/**
 * Live-Patientensuche der Kopfzeile (GET /api/patienten/vorschlaege).
 *
 * - Gleiche Grundmenge wie die Patientenliste (/kunden): Praxis der Sitzung (withOrg/RLS), nicht archiviert –
 *   damit auch keine Personen mit gelöschten Kontaktdaten (Löschung archiviert immer). Verstorbene erscheinen wie
 *   in der Liste, mit Kennzeichnung.
 * - Direkte Treffer: dieselbe Suchbedingung wie die Liste (patientSearchCondition), höchstens SUGGEST_LIMIT.
 * - „Meinten Sie“: bei weniger als FUZZY_BELOW_HITS Treffern werden Name/Vorname aller (höchstens
 *   FUZZY_SCAN_LIMIT) Personen der Praxis geladen und in der App verglichen (src/lib/patient-search.ts).
 *   Namen liegen unverschlüsselt in `patients` (wie für die Liste/ILIKE); es braucht weder pg_trgm noch einen
 *   zusätzlichen Index. ~5000 Personen ≈ zwei kurze Textspalten, nur im Fehlerfall und gedrosselt.
 * - Antwort nur mit Anzeige-Feldern (Nr., Name, Geburtsdatum, Ort, verstorben) – keine Kontakt- oder Gesundheitsdaten.
 */

/** Je Benutzer:in höchstens so viele Abfragen je Minute (Tippen ist entprellt, ~5/s wären viel) */
export const suggestLimiter = createRateLimiter({ windowMs: 60_000, max: 90 });
/** Obergrenze der Vergleichsmenge für „Meinten Sie“ */
export const FUZZY_SCAN_LIMIT = 20_000;

export type PatientSuggestion = {
  id: string;
  number: number;
  lastName: string;
  firstName: string | null;
  birthDate: string | null;
  city: string | null;
  deceased: boolean;
};

export type PatientSuggestResult = {
  hits: PatientSuggestion[];
  /** mehr direkte Treffer als angezeigt → Liste öffnen */
  more: boolean;
  didYouMean: { query: string; patients: PatientSuggestion[] } | null;
};

const fields = {
  id: patients.id,
  number: patients.number,
  lastName: patients.lastName,
  firstName: patients.firstName,
  birthDate: patients.birthDate,
  city: patients.city,
  extra: patients.extra,
};

type Row = { id: string; number: number; lastName: string; firstName: string | null; birthDate: string | null; city: string | null; extra: Record<string, unknown> };
const toSuggestion = ({ extra, ...r }: Row): PatientSuggestion => ({ ...r, deceased: isDeceased(extra) });

/** Audit „patients.suggest“ höchstens 1× je Benutzer:in und Minute (sonst ein Eintrag je Tastendruck) */
const auditSeen = new Map<string, number>();
function shouldAudit(key: string, now = Date.now()): boolean {
  const last = auditSeen.get(key);
  if (last !== undefined && now - last < 60_000) return false;
  auditSeen.delete(key);
  auditSeen.set(key, now);
  while (auditSeen.size > 5_000) {
    const oldest = auditSeen.keys().next().value;
    if (oldest === undefined) break;
    auditSeen.delete(oldest);
  }
  return true;
}

export class SuggestForbiddenError extends Error {}

export async function suggestPatients(auth: AuthContext, q: string): Promise<PatientSuggestResult> {
  if (!auth.can("patients.read")) throw new SuggestForbiddenError("Keine Berechtigung");
  const org = auth.organization.id;
  const base = and(eq(patients.organizationId, org), isNull(patients.archivedAt));
  const first = queryTokens(q)[0] ?? q;
  const prefix = `${first.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const result = await withOrg(org, async (tx) => {
    const rows = (await tx
      .select(fields)
      .from(patients)
      .where(and(base, patientSearchCondition(q)))
      // Nachname beginnt mit dem Suchwort → zuerst, dann Vorname, dann übrige Treffer
      .orderBy(
        sql`case when ${ilike(patients.lastName, prefix)} then 0 when ${ilike(patients.firstName, prefix)} then 1 else 2 end`,
        asc(patients.lastName),
        asc(patients.firstName),
        asc(patients.number),
      )
      .limit(SUGGEST_LIMIT + 1)) as Row[];
    const hits = rows.slice(0, SUGGEST_LIMIT).map(toSuggestion);
    const more = rows.length > SUGGEST_LIMIT;

    let didYouMean: PatientSuggestResult["didYouMean"] = null;
    if (hits.length < FUZZY_BELOW_HITS && fuzzyEligible(q)) {
      const names = await tx
        .select({ id: patients.id, lastName: patients.lastName, firstName: patients.firstName })
        .from(patients)
        .where(base)
        .limit(FUZZY_SCAN_LIMIT);
      const best = closestNames(q, names, { limit: FUZZY_LIMIT, exclude: new Set(hits.map((h) => h.id)) });
      if (best.length) {
        const details = (await tx
          .select(fields)
          .from(patients)
          .where(and(base, inArray(patients.id, best.map((b) => b.id))))) as Row[];
        const byId = new Map(details.map((d) => [d.id, toSuggestion(d)]));
        const ordered = best.map((b) => byId.get(b.id)).filter((x): x is PatientSuggestion => !!x);
        if (ordered.length) didYouMean = { query: suggestedQuery(q, best[0]), patients: ordered };
      }
    }
    return { hits, more, didYouMean };
  });

  if (shouldAudit(`${org}\u0000${auth.user.id}`)) {
    // wie patients.list: Suchtext nicht im Audit, nur Kennzeichnung und Anzahl
    await audit({ organizationId: org, userId: auth.user.id, action: "patients.suggest", meta: { q: "[suche]", n: result.hits.length, fuzzy: result.didYouMean?.patients.length ?? 0 } });
  }
  return result;
}

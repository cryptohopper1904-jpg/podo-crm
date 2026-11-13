import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
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
  prepareQuery,
  queryTokens,
  SUGGEST_LIMIT,
  suggestedQuery,
} from "@/lib/patient-search";
import { patientSearchCondition } from "./patients";

/**
 * Live-Patientensuche der Kopfzeile (POST /api/patienten/vorschlaege).
 *
 * - Gleiche Grundmenge wie die Patientenliste (/kunden): Praxis der Sitzung (withOrg/RLS), nicht archiviert –
 *   damit auch keine Personen mit gelöschten Kontaktdaten (Löschung archiviert immer). Verstorbene erscheinen wie
 *   in der Liste, mit Kennzeichnung.
 * - Direkte Treffer: dieselbe Suchbedingung wie die Liste (patientSearchCondition), höchstens SUGGEST_LIMIT.
 * - „Meinten Sie“ (nur ohne direkten Treffer) – Rechenzeit begrenzt (Appsec-Review):
 *   1. Vorfilter in der DB per pg_trgm (Migration 0043, GIN-Index patients_name_trgm): höchstens
 *      FUZZY_DB_CANDIDATES ähnlichste Namen. Fehlt die Extension, Rückfall auf höchstens FUZZY_FALLBACK_SCAN Namen
 *      mit gleichem Anfangsbuchstaben (Nach- oder Vorname).
 *   2. Feinbewertung in der App (src/lib/patient-search.ts: Suchtext/Namen auf 40 Zeichen gekürzt, Levenshtein
 *      mit frühem Abbruch).
 *   3. Eigene Drosselung (FUZZY_PER_MIN je Person) und höchstens ein Lauf gleichzeitig je Instanz – sonst Antwort
 *      ohne „Meinten Sie“.
 *   Namen liegen unverschlüsselt in `patients` (wie für die Liste/ILIKE); der Trigramm-Index enthält nichts Neues.
 * - Antwort nur mit Anzeige-Feldern (Nr., Name, Geburtsdatum, Ort, verstorben) – keine Kontakt- oder Gesundheitsdaten.
 */

/** Je Benutzer:in höchstens so viele Abfragen je Minute (Tippen ist entprellt, ~5/s wären viel) */
export const suggestLimiter = createRateLimiter({ windowMs: 60_000, max: 90 });
/** „Meinten Sie“-Läufe je Benutzer:in und Minute */
export const FUZZY_PER_MIN = 15;
export const fuzzyLimiter = createRateLimiter({ windowMs: 60_000, max: FUZZY_PER_MIN });
/** So viele Kandidaten liefert der DB-Vorfilter höchstens */
export const FUZZY_DB_CANDIDATES = 200;
/** Ohne pg_trgm: höchstens so viele Namen (gleicher Anfangsbuchstabe) bewerten */
export const FUZZY_FALLBACK_SCAN = 2_000;
/** Mindest-Ähnlichkeit im DB-Vorfilter (bewusst niedriger als FUZZY_MIN_SCORE, die App bewertet fein) */
const DB_TRGM_THRESHOLD = 0.25;

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
type NameRow = { id: string; lastName: string; firstName: string | null };
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

/** Höchstens ein „Meinten Sie“-Lauf gleichzeitig je Instanz */
let fuzzyBusy = false;
/** pg_trgm vorhanden? (einmal je Prozess ermittelt) */
let trgmAvailable: boolean | null = null;

/** Muss exakt zum Index patients_name_trgm passen (drizzle/0043_patientensuche_trgm.sql) */
const nameExpr = sql`lower(${patients.lastName} || ' ' || coalesce(${patients.firstName}, ''))`;

async function fuzzyCandidates(tx: Tx, org: string, q: string): Promise<NameRow[]> {
  const base = and(eq(patients.organizationId, org), isNull(patients.archivedAt));
  const needle = prepareQuery(q).norm;
  if (!needle) return [];
  if (trgmAvailable === null) {
    const r = await tx.execute(sql`select 1 from pg_extension where extname = 'pg_trgm'`);
    trgmAvailable = r.rows.length > 0;
  }
  if (trgmAvailable) {
    // Schwellen nur für diese Transaktion; `%`/`<%` nutzen den GIN-Index
    await tx.execute(sql`select set_config('pg_trgm.similarity_threshold', ${String(DB_TRGM_THRESHOLD)}, true), set_config('pg_trgm.word_similarity_threshold', ${String(DB_TRGM_THRESHOLD)}, true)`);
    return tx
      .select({ id: patients.id, lastName: patients.lastName, firstName: patients.firstName })
      .from(patients)
      .where(and(base, sql`(${nameExpr} % ${needle} or ${needle} <% ${nameExpr})`))
      .orderBy(desc(sql`greatest(similarity(${nameExpr}, ${needle}), word_similarity(${needle}, ${nameExpr}))`), asc(patients.id))
      .limit(FUZZY_DB_CANDIDATES);
  }
  // Rückfall ohne pg_trgm: gleicher Anfangsbuchstabe eines Suchworts (Nach- oder Vorname), begrenzt und stabil sortiert
  const initials = [...new Set(queryTokens(needle).map((t) => t[0]).filter(Boolean))].slice(0, 4);
  if (!initials.length) return [];
  const conds = initials.flatMap((c) => [ilike(patients.lastName, `${c}%`), ilike(patients.firstName, `${c}%`)]);
  return tx
    .select({ id: patients.id, lastName: patients.lastName, firstName: patients.firstName })
    .from(patients)
    .where(and(base, sql`(${sql.join(conds, sql` or `)})`))
    .orderBy(asc(patients.lastName), asc(patients.firstName), asc(patients.id))
    .limit(FUZZY_FALLBACK_SCAN);
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
    if (hits.length < FUZZY_BELOW_HITS && fuzzyEligible(q) && !fuzzyBusy && !fuzzyLimiter.limited(`user:${auth.user.id}`)) {
      fuzzyBusy = true;
      try {
        const names = await fuzzyCandidates(tx, org, q);
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
      } finally {
        fuzzyBusy = false;
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

/** Nur für Tests: Zustand der Sperre/Erkennung zurücksetzen */
export function __resetFuzzyStateForTests(opts: { trgm?: boolean | null } = {}) {
  fuzzyBusy = false;
  trgmAvailable = opts.trgm === undefined ? null : opts.trgm;
  fuzzyLimiter.reset();
}

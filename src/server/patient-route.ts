import "server-only";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** /kunden/<id> und alle Unterseiten (Doku, Anamnese, Bearbeiten …); /kunden/neu ist eine eigene Seite */
const AKTE = /^\/kunden\/([^/?#]+)(?:\/|$)/;

/** Kennung der Akte aus dem Pfad – null, wenn der Pfad keine Akte ist (Liste, „neu“, andere Bereiche). */
export function akteIdFromPath(path: string | null | undefined): string | null {
  const m = AKTE.exec(path ?? "");
  if (!m || m[1] === "neu") return null;
  return m[1];
}

/** Gibt es die Akte im eigenen Mandanten? (nur `select id`; fremde Praxis = RLS/withOrg = nicht gefunden) */
export async function patientExists(organizationId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const found = await withOrg(organizationId, (tx) =>
    tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, organizationId), eq(patients.id, id))).limit(1),
  );
  return found.length > 0;
}

/**
 * Echte 404 (HTTP-Status) für Akten, die es nicht gibt – Aufruf aus src/app/(app)/layout.tsx, also VOR der
 * Suspense-Grenze von (app)/loading.tsx.
 *
 * Warum dort: notFound() in der Seite (oder in einem Layout/generateViewport unterhalb von (app)) fällt erst nach
 * Start des Streamings – die Antwort hat dann schon Status 200 (nur noindex, „weiche 404“). Siehe
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md („Status codes“: notFound()
 * vor dem Streaming erhält den 404) und 02-guides/streaming.md („The HTTP contract“). Geprüft per Prod-Request.
 *
 * - Nur Pfade /kunden/<id>… (Pfad aus x-podo-path, von src/proxy.ts bei jeder Anfrage neu gesetzt): alle anderen
 *   Seiten lösen keine Abfrage aus.
 * - Nur mit patients.read; ohne Recht verweigert die Seite wie gewohnt (der Status verrät nichts über Kennungen).
 * - Unbekannt, kaputte Kennung und Akte einer fremden Praxis: gleich 404.
 */
export async function assertPatientRouteExists(auth: AuthContext, path: string | null | undefined): Promise<void> {
  const id = akteIdFromPath(path);
  if (id === null || !auth.can("patients.read")) return;
  if (!(await patientExists(auth.organization.id, id))) notFound();
}

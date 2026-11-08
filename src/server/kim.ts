import "server-only";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { integrationConnections, messages, organizations, patients } from "@/db/schema";
import { KIM_CONNECTION_PROVIDER } from "@/integrations/kim/provider";
import { getKimAdapter, isMockMode } from "@/integrations/registry";
import { describeError } from "@/integrations/test-connection";
import type { IntegrationConnection, KimInboundMessage, KimPort } from "@/integrations/types";
import { audit } from "@/lib/audit";
import { attachmentNote, extractKimHints, rankSuggestions, type PatientSuggestion } from "@/lib/kim-hints";
import { mapPool, withTimeout } from "@/lib/pool";
import { loadConnection, logSync } from "./integrations";

export interface KimSyncResult {
  fetched: number;
  imported: number;
  duplicates: number;
  mock: boolean;
}

/** KIM-Verbindung der Praxis (null = nicht eingerichtet bzw. aus, außer im globalen Testmodus). */
export async function loadKimConnection(organizationId: string): Promise<IntegrationConnection | null> {
  const conn = await loadConnection(organizationId, KIM_CONNECTION_PROVIDER);
  if (conn && conn.status !== "disconnected") return conn;
  return isMockMode() ? { status: "mock", organizationId } : null;
}

export async function kimAdapterFor(organizationId: string): Promise<KimPort | null> {
  const conn = await loadKimConnection(organizationId);
  return conn ? getKimAdapter(conn) : null;
}

/**
 * Speichert abgerufene KIM-Nachrichten im Posteingang.
 * - Dedupe über (Praxis, Kanal „kim“, Message-ID), unter Advisory-Lock je Praxis (parallele Läufe)
 * - Personen-Zuordnung NIE automatisch (patientId bleibt leer, die Praxis ordnet zu)
 * - Anhänge werden nicht gespeichert, nur ihre Namen/Größen im Text
 */
export async function storeKimMessages(organizationId: string, list: KimInboundMessage[]): Promise<{ imported: number; duplicates: number }> {
  return withOrg(organizationId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"kim-inbox:" + organizationId}))`);
    const ids = [...new Set(list.map((m) => m.messageId.slice(0, 300)))];
    const existing = ids.length
      ? await tx
          .select({ externalId: messages.externalId })
          .from(messages)
          .where(and(eq(messages.organizationId, organizationId), eq(messages.channel, "kim"), inArray(messages.externalId, ids)))
      : [];
    const seen = new Set(existing.map((e) => e.externalId));
    let imported = 0;
    let duplicates = 0;
    for (const m of list) {
      const externalId = m.messageId.slice(0, 300);
      if (seen.has(externalId)) {
        duplicates++;
        continue;
      }
      seen.add(externalId);
      const received = new Date(m.receivedAt);
      await tx.insert(messages).values({
        organizationId,
        patientId: null,
        channel: "kim",
        direction: "inbound",
        fromAddress: m.from.slice(0, 300),
        toAddress: m.to?.slice(0, 300) ?? null,
        subject: [m.kimService ? `[${m.kimService.split(";")[0]}]` : null, m.subject].filter(Boolean).join(" ").slice(0, 400) || null,
        body: (m.text || "(kein Textinhalt)") + attachmentNote(m.attachments),
        externalId,
        threadKey: m.inReplyTo ?? externalId,
        receivedAt: Number.isNaN(received.getTime()) ? new Date() : received,
      });
      imported++;
    }
    return { imported, duplicates };
  });
}

/** Ruft das KIM-Postfach ab und importiert neue Nachrichten (manuell aus dem Posteingang oder per Cron). */
export async function syncKimInbox(organizationId: string, opts: { adapter?: KimPort; userId?: string } = {}): Promise<KimSyncResult | { error: string }> {
  const adapter = opts.adapter ?? (await kimAdapterFor(organizationId).catch((e) => e as Error));
  if (adapter === null) return { error: "KIM ist nicht eingerichtet (Einstellungen → Schnittstellen)." };
  if (adapter instanceof Error) {
    await logSync(organizationId, KIM_CONNECTION_PROVIDER, { direction: "in", ok: false, message: `KIM: ${describeError(adapter)}` });
    return { error: "KIM-Verbindung ist nicht vollständig eingerichtet (Details im Synchronisationsprotokoll)." };
  }
  let list: KimInboundMessage[];
  try {
    list = await adapter.fetchInbox();
  } catch (e) {
    const detail = describeError(e);
    await logSync(organizationId, KIM_CONNECTION_PROVIDER, { direction: "in", ok: false, message: `KIM-Abruf: ${detail}` });
    await withOrg(organizationId, (tx) =>
      tx
        .update(integrationConnections)
        .set({ lastError: detail.slice(0, 300) })
        .where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, KIM_CONNECTION_PROVIDER))),
    );
    return { error: "KIM-Abruf fehlgeschlagen (Details im Synchronisationsprotokoll)." };
  }
  const { imported, duplicates } = await storeKimMessages(organizationId, list);
  await withOrg(organizationId, (tx) =>
    tx
      .update(integrationConnections)
      .set({ lastSyncAt: new Date(), lastError: null })
      .where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, KIM_CONNECTION_PROVIDER))),
  );
  await logSync(organizationId, KIM_CONNECTION_PROVIDER, {
    direction: "in",
    ok: true,
    message: `KIM${adapter.isMock ? " (Testmodus)" : ""}: ${list.length} abgerufen, ${imported} neu, ${duplicates} bereits vorhanden`,
  });
  if (imported) await audit({ organizationId, userId: opts.userId, action: "kim.sync", meta: { imported, duplicates, mock: adapter.isMock } });
  return { fetched: list.length, imported, duplicates, mock: adapter.isMock };
}

/** Gleichzeitige Praxen je Cron-Lauf und hartes Zeitlimit je Praxis (ein hängendes Clientmodul blockiert keine anderen). */
export const KIM_SYNC_CONCURRENCY = 5;
export const KIM_SYNC_TIMEOUT_MS = 60_000;

/**
 * Cron: alle Praxen mit aktiver KIM-Verbindung (Status „verbunden“, „Fehler“ oder „Testmodus“).
 * organizations hat keine RLS; Verbindungen werden je Praxis mit withOrg gelesen.
 * Höchstens `concurrency` Praxen parallel (jede in eigenen, kurzen Transaktionen), je Praxis `timeoutMs`.
 */
export async function runKimSyncAll(
  opts: { concurrency?: number; timeoutMs?: number; sync?: (organizationId: string) => Promise<KimSyncResult | { error: string }> } = {},
): Promise<{ organizations: number; imported: number; errors: number }> {
  const sync = opts.sync ?? ((id: string) => syncKimInbox(id));
  const timeoutMs = opts.timeoutMs ?? KIM_SYNC_TIMEOUT_MS;
  const orgs = await db.select({ id: organizations.id }).from(organizations).where(isNull(organizations.deletionRequestedAt));
  let n = 0;
  let imported = 0;
  let errors = 0;
  await mapPool(orgs, opts.concurrency ?? KIM_SYNC_CONCURRENCY, async (o) => {
    try {
      await withTimeout(
        (async () => {
          const conn = await loadConnection(o.id, KIM_CONNECTION_PROVIDER);
          if (!conn || conn.status === "disconnected") return;
          n++;
          const r = await sync(o.id);
          if ("error" in r) errors++;
          else imported += r.imported;
        })(),
        timeoutMs,
        "KIM-Abruf: Zeitlimit je Praxis überschritten",
      );
    } catch (e) {
      errors++;
      console.error("[cron/kim]", o.id, describeError(e));
    }
  });
  return { organizations: n, imported, errors };
}

/** Zuordnungsvorschläge (KVNR, Name, Geburtsdatum) – nur Anzeige, nie automatische Zuordnung. */
export async function kimPatientSuggestions(organizationId: string, msg: { subject: string | null; body: string }): Promise<PatientSuggestion[]> {
  const hints = extractKimHints(msg.subject, msg.body);
  if (!hints.kvnrs.length && !hints.nameTokens.length) return [];
  const conds: SQL[] = [];
  if (hints.kvnrs.length) conds.push(sql`upper(left(coalesce(${patients.insuranceNumber}, ''), 10)) in (${sql.join(hints.kvnrs.map((k) => sql`${k}`), sql`, `)})`);
  if (hints.nameTokens.length) conds.push(sql`lower(${patients.lastName}) in (${sql.join(hints.nameTokens.map((k) => sql`${k}`), sql`, `)})`);
  const candidates = await withOrg(organizationId, (tx) =>
    tx
      .select({
        id: patients.id,
        number: patients.number,
        firstName: patients.firstName,
        lastName: patients.lastName,
        birthDate: patients.birthDate,
        insuranceNumber: patients.insuranceNumber,
      })
      .from(patients)
      .where(and(eq(patients.organizationId, organizationId), isNull(patients.archivedAt), sql`(${sql.join(conds, sql` or `)})`))
      .limit(30),
  );
  return rankSuggestions(hints, candidates);
}

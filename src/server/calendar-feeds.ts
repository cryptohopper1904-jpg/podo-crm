import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, withOrg, type Tx } from "@/db";
import { appointments, calendarFeedEvents, calendarFeeds, memberships } from "@/db/schema";
import { CalendarFeedError, feedUrlHint, fetchIcs, normalizeFeedUrl } from "@/integrations/calendar-feed/fetch";
import type { Resolver } from "@/integrations/net-guard";
import { describeError } from "@/integrations/test-connection";
import { assertCan } from "@/lib/auth/assert";
import { CALENDAR_ROLES } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import { eventKey, parseIcs, type IcsWarnings, type ParsedIcsEvent } from "@/lib/ics-parse";
import { mapPool, withTimeout } from "@/lib/pool";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { isCalendarMember } from "./appointments";
import { logSync } from "./integrations";
import { lockBooking } from "./portal-booking";

/**
 * Kalender-Abo (iCal-Import, nur lesend): z. B. Google Kalender, in den Docal.io/CalMedi Doctolib-Termine spiegeln.
 * - Abruf alle ~5 min (Cron) oder „Jetzt abrufen“; Fenster heute − 7 Tage bis + 90 Tage
 * - idempotent über (Abo, UID + Vorkommen) → Termin; Änderungen/Absagen werden übernommen
 * - in PodoHero geänderte Termine werden nie überschrieben oder abgesagt (Konfliktkennzeichen „local_change“)
 * - Termine werden NIE automatisch einer Patient:in zugeordnet (wie Online-Buchung und KI-Telefon)
 * - Termine werden nie gelöscht; im Kalender gelöschte Ereignisse werden in PodoHero abgesagt
 */

export const FEED_WINDOW = { pastDays: 7, futureDays: 90 } as const;
export const FEED_SYNC_CONCURRENCY = 5;
export const FEED_SYNC_TIMEOUT_MS = 30_000;
export const MAX_FEEDS_PER_ORG = 10;
/** Termine ohne (sinnvolles) Ende bekommen diese Dauer */
const DEFAULT_DURATION_MS = 30 * 60_000;

export type FeedSource = "doctolib" | "extern";
export type FeedConflict = "local_change" | "overlap" | "deleted_locally";

export interface FeedSyncResult {
  notModified: boolean;
  events: number;
  created: number;
  updated: number;
  cancelled: number;
  unchanged: number;
  localChanges: number;
  overlaps: number;
  allDaySkipped: number;
  warnings: IcsWarnings;
}

const feedAad = (org: string, feedId: string) => `${org}:calendar_feed:${feedId}`;
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Abgleichsfenster: heute (Berlin) − 7 Tage bis Ende von heute + 90 Tage. */
export function feedWindow(now = new Date()) {
  const midnight = berlinToUtc(berlinDateIso(now), "00:00").getTime();
  const day = 86400_000;
  return { from: new Date(midnight - FEED_WINDOW.pastDays * day), to: new Date(midnight + (FEED_WINDOW.futureDays + 1) * day) };
}

/** Terminfelder, die der Abgleich aus einem Kalender-Ereignis setzt. */
export function appointmentFieldsFor(e: ParsedIcsEvent) {
  const end = e.end.getTime() > e.start.getTime() ? e.end : new Date(e.start.getTime() + DEFAULT_DURATION_MS);
  const notes = [e.location ? `Ort: ${e.location}` : null, e.description].filter(Boolean).join("\n").slice(0, 2000) || null;
  return {
    startsAt: e.start,
    endsAt: end,
    title: e.summary.slice(0, 200),
    notes,
    status: (e.status === "CANCELLED" ? "cancelled" : "planned") as "cancelled" | "planned",
  };
}

/**
 * Hash der vom Abgleich verwalteten Terminfelder – Abweichung = in PodoHero geändert.
 * Vom Status zählt nur „abgesagt ja/nein“: „bestätigt“, „erledigt“ und „nicht erschienen“ sind normaler Praxisablauf.
 */
export function appliedHashOf(a: { startsAt: Date; endsAt: Date; title: string | null; notes: string | null; status: string; therapistId: string | null }) {
  return sha([a.startsAt.toISOString(), a.endsAt.toISOString(), a.title ?? "", a.notes ?? "", a.status === "cancelled", a.therapistId ?? ""]);
}

/** Erledigte bzw. nicht wahrgenommene Termine werden vom Abgleich nicht mehr verändert. */
const isFinal = (status: string) => status === "done" || status === "no_show";

export const eventHash = (e: ParsedIcsEvent) => sha([e.start.toISOString(), e.end.toISOString(), e.allDay, e.summary, e.description, e.location, e.status]);

const externalIdFor = (feedId: string, key: string) => `ics:${sha([feedId, key]).slice(0, 40)}`;

type FeedRow = typeof calendarFeeds.$inferSelect;

/**
 * Überträgt die Ereignisse eines Abrufs in die Termine (eine Transaktion, Buchungssperre der Praxis).
 * `window`: nur Zuordnungen, deren Termin in diesem Fenster liegt, werden bei Fehlen im Kalender abgesagt.
 */
export async function applyFeedEvents(
  tx: Tx,
  feed: Pick<FeedRow, "id" | "organizationId" | "therapistId" | "source">,
  events: ParsedIcsEvent[],
  window: { from: Date; to: Date },
  now = new Date(),
): Promise<Omit<FeedSyncResult, "notModified" | "warnings" | "events">> {
  const org = feed.organizationId;
  await lockBooking(tx, org);
  const res = { created: 0, updated: 0, cancelled: 0, unchanged: 0, localChanges: 0, overlaps: 0, allDaySkipped: 0 };

  const maps = await tx.select().from(calendarFeedEvents).where(and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.feedId, feed.id)));
  const byKey = new Map(maps.map((m) => [m.eventKey, m]));
  const apptIds = maps.map((m) => m.appointmentId).filter((x): x is string => !!x);
  const appts = apptIds.length ? await tx.select().from(appointments).where(and(eq(appointments.organizationId, org), inArray(appointments.id, apptIds))) : [];
  const apptById = new Map(appts.map((a) => [a.id, a]));
  const seen = new Set<string>();
  // Ist die gebundene Person keine Behandler:in mehr (z. B. jetzt Empfang oder gesperrt), neue Termine ohne Zuordnung anlegen
  const therapistId = feed.therapistId && (await isCalendarMember(tx, org, feed.therapistId)) ? feed.therapistId : null;

  const setMap = (id: string, v: Partial<typeof calendarFeedEvents.$inferInsert>) =>
    tx.update(calendarFeedEvents).set({ ...v, updatedAt: now }).where(and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.id, id)));

  for (const e of events) {
    const key = eventKey(e).slice(0, 600);
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.allDay) {
      res.allDaySkipped++;
      continue;
    }
    const hash = eventHash(e);
    const fields = appointmentFieldsFor(e);
    const m = byKey.get(key);

    if (!m) {
      if (fields.status === "cancelled") continue; // abgesagt, bevor es je übernommen wurde
      const [a] = await tx
        .insert(appointments)
        .values({ organizationId: org, patientId: null, therapistId, source: feed.source, externalId: externalIdFor(feed.id, key), ...fields })
        .onConflictDoNothing()
        .returning();
      if (!a) continue; // gleiche externe ID existiert bereits (sollte über die Zuordnung nicht vorkommen)
      await tx.insert(calendarFeedEvents).values({
        organizationId: org,
        feedId: feed.id,
        eventKey: key,
        appointmentId: a.id,
        hash,
        appliedHash: appliedHashOf(a),
      });
      res.created++;
      continue;
    }

    const a = m.appointmentId ? apptById.get(m.appointmentId) : undefined;
    if (!a) {
      // Termin wurde in PodoHero gelöscht → nicht wieder anlegen
      if (m.conflict !== "deleted_locally") await setMap(m.id, { conflict: "deleted_locally", appointmentId: null });
      res.unchanged++;
      continue;
    }
    const locallyChanged = appliedHashOf(a) !== m.appliedHash;
    if (m.hash === hash && !m.removedAt) {
      if (locallyChanged) {
        res.localChanges++;
        if (m.conflict !== "local_change") await setMap(m.id, { conflict: "local_change" });
      } else res.unchanged++;
      continue;
    }
    if (locallyChanged || isFinal(a.status)) {
      // Kalender hat sich geändert, Termin aber auch in PodoHero (bzw. schon erledigt) → nichts überschreiben, kennzeichnen
      res.localChanges++;
      await setMap(m.id, { conflict: "local_change" });
      continue;
    }
    const wasCancelled = a.status === "cancelled";
    const [u] = await tx
      .update(appointments)
      .set({ ...fields, status: fields.status === "cancelled" ? "cancelled" : wasCancelled ? "planned" : a.status, therapistId: a.therapistId, updatedAt: now })
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, a.id)))
      .returning();
    await setMap(m.id, { hash, appliedHash: appliedHashOf(u), conflict: null, removedAt: null });
    if (fields.status === "cancelled" && !wasCancelled) res.cancelled++;
    else res.updated++;
  }

  // Im Kalender gelöschte Ereignisse (im Fenster): absagen – nie löschen, nie wenn in PodoHero geändert
  for (const m of maps) {
    if (seen.has(m.eventKey) || m.removedAt || !m.appointmentId) continue;
    const a = apptById.get(m.appointmentId);
    if (!a || a.startsAt < window.from || a.startsAt >= window.to) continue;
    if (appliedHashOf(a) !== m.appliedHash || isFinal(a.status)) {
      res.localChanges++;
      if (m.conflict !== "local_change") await setMap(m.id, { conflict: "local_change" });
      continue;
    }
    if (a.status === "cancelled") {
      await setMap(m.id, { removedAt: now });
      continue;
    }
    const [u] = await tx
      .update(appointments)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, a.id)))
      .returning();
    await setMap(m.id, { appliedHash: appliedHashOf(u), hash: "removed", removedAt: now, conflict: null });
    res.cancelled++;
  }

  res.overlaps = await flagOverlaps(tx, org, feed.id, window);
  return res;
}

/** Kennzeichnet importierte Termine, die sich mit anderen Terminen derselben Behandler:in überschneiden. */
async function flagOverlaps(tx: Tx, org: string, feedId: string, window: { from: Date; to: Date }): Promise<number> {
  const r = await tx.execute<{ id: string }>(sql`
    select m.id from calendar_feed_events m
      join appointments a on a.id = m.appointment_id and a.organization_id = m.organization_id
     where m.organization_id = ${org} and m.feed_id = ${feedId}
       and a.status <> 'cancelled' and a.therapist_id is not null
       and a.starts_at < ${window.to} and a.ends_at > ${window.from}
       and exists (select 1 from appointments b
                    where b.organization_id = a.organization_id and b.id <> a.id and b.therapist_id = a.therapist_id
                      and b.status <> 'cancelled' and b.starts_at < a.ends_at and b.ends_at > a.starts_at)`);
  const ids = r.rows.map((x) => x.id);
  await tx.execute(sql`
    update calendar_feed_events set conflict = null
     where organization_id = ${org} and feed_id = ${feedId} and conflict = 'overlap'
       ${ids.length ? sql`and id not in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql``}`);
  if (ids.length) {
    await tx.execute(sql`
      update calendar_feed_events set conflict = 'overlap'
       where organization_id = ${org} and feed_id = ${feedId} and conflict is null
         and id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  }
  return ids.length;
}

export interface SyncDeps {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  resolver?: Resolver;
  now?: Date;
  userId?: string;
}

/** Ruft ein Abo ab und gleicht es ab. Fehler werden am Abo gespeichert (ohne URL) und als Ergebnis geliefert. */
export async function syncCalendarFeed(org: string, feedId: string, deps: SyncDeps = {}): Promise<FeedSyncResult | { error: string }> {
  const now = deps.now ?? new Date();
  const [feed] = await withOrg(org, (tx) => tx.select().from(calendarFeeds).where(and(eq(calendarFeeds.organizationId, org), eq(calendarFeeds.id, feedId))));
  if (!feed) return { error: "Kalender-Abo nicht gefunden." };
  const setFeed = (v: Partial<typeof calendarFeeds.$inferInsert>) =>
    withOrg(org, (tx) => tx.update(calendarFeeds).set(v).where(and(eq(calendarFeeds.organizationId, org), eq(calendarFeeds.id, feedId))));

  try {
    let url: string;
    try {
      url = decryptSecret(feed.urlEnc, feedAad(org, feed.id));
    } catch {
      throw new CalendarFeedError("Gespeicherte Adresse nicht lesbar – bitte neu eintragen.");
    }
    const fetched = await fetchIcs(url, { etag: feed.etag, lastModified: feed.lastModified, fetchImpl: deps.fetchImpl, resolver: deps.resolver });
    const window = feedWindow(now);
    if (fetched.status === "not_modified") {
      await setFeed({ lastSyncAt: now, lastAttemptAt: now, lastError: null });
      return { notModified: true, events: 0, created: 0, updated: 0, cancelled: 0, unchanged: 0, localChanges: 0, overlaps: 0, allDaySkipped: 0, warnings: { rruleSkipped: 0, invalid: 0, unknownTz: 0, truncated: 0 } };
    }
    const parsed = parseIcs(fetched.body, window);
    const applied = await withOrg(org, (tx) => applyFeedEvents(tx, feed, parsed.events, window, now));
    const result: FeedSyncResult = { notModified: false, events: parsed.events.length, ...applied, warnings: parsed.warnings };
    await setFeed({
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      lastSyncAt: now,
      lastAttemptAt: now,
      lastError: null,
      lastResult: {
        events: result.events,
        created: result.created,
        updated: result.updated,
        cancelled: result.cancelled,
        localChanges: result.localChanges,
        overlaps: result.overlaps,
        allDaySkipped: result.allDaySkipped,
        rruleSkipped: parsed.warnings.rruleSkipped,
        invalid: parsed.warnings.invalid,
      },
    });
    if (result.created || result.updated || result.cancelled) {
      await logSync(org, "calendar_ics", {
        direction: "in",
        ok: true,
        message: `Kalender-Abo „${feed.label}“: ${result.created} neu, ${result.updated} geändert, ${result.cancelled} abgesagt${result.localChanges ? `, ${result.localChanges} in PodoHero geändert (nicht überschrieben)` : ""}${parsed.warnings.rruleSkipped ? `, ${parsed.warnings.rruleSkipped} Serien übersprungen` : ""}`,
      });
    }
    return result;
  } catch (e) {
    const msg = (e instanceof CalendarFeedError ? e.message : `Abgleich fehlgeschlagen (${describeError(e).slice(0, 120)})`).slice(0, 300);
    await setFeed({ lastAttemptAt: now, lastError: msg }).catch(() => undefined);
    await logSync(org, "calendar_ics", { direction: "in", ok: false, message: `Kalender-Abo „${feed.label}“: ${msg}` }).catch(() => undefined);
    return { error: msg };
  }
}

/** Cron: alle aktiven Abos aller Praxen, höchstens 5 parallel, je Abo 30 s. */
export async function runCalendarFeedSyncAll(
  opts: { concurrency?: number; timeoutMs?: number; sync?: (org: string, feedId: string) => Promise<FeedSyncResult | { error: string }> } = {},
): Promise<{ feeds: number; synced: number; errors: number; created: number; updated: number; cancelled: number }> {
  const sync = opts.sync ?? ((org: string, id: string) => syncCalendarFeed(org, id));
  const r = await db.execute<{ id: string; organization_id: string }>(sql`select id, organization_id from podo_calendar_feeds_active()`);
  const feeds = r.rows;
  const total = { feeds: feeds.length, synced: 0, errors: 0, created: 0, updated: 0, cancelled: 0 };
  await mapPool(feeds, opts.concurrency ?? FEED_SYNC_CONCURRENCY, async (f) => {
    try {
      const res = await withTimeout(sync(f.organization_id, f.id), opts.timeoutMs ?? FEED_SYNC_TIMEOUT_MS, "Kalender-Abo: Zeitlimit je Abo überschritten");
      if ("error" in res) total.errors++;
      else {
        total.synced++;
        total.created += res.created;
        total.updated += res.updated;
        total.cancelled += res.cancelled;
      }
    } catch (e) {
      total.errors++;
      console.error("[cron/kalender-abo]", f.id, describeError(e));
    }
  });
  return total;
}

/** Zustand aller aktiven Abos für /api/health/deep (nur Zähler/Zeitpunkte). */
export async function calendarFeedHealth(staleAfterMinutes = 30) {
  const r = await db.execute<{ active: number; stale: number; failing: number; oldest_success: string | Date | null }>(
    sql`select * from podo_calendar_feeds_health(make_interval(mins => ${staleAfterMinutes}))`,
  );
  const row = r.rows[0];
  return { active: Number(row?.active ?? 0), stale: Number(row?.stale ?? 0), failing: Number(row?.failing ?? 0), oldestSuccess: row?.oldest_success ? new Date(row.oldest_success) : null };
}

// ───────────── Verwaltung (Einstellungen → Kalender-Abo) ─────────────

export async function listCalendarFeeds(auth: AuthContext) {
  assertCan(auth, "integrations.manage");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const feeds = await tx
      .select({
        id: calendarFeeds.id,
        label: calendarFeeds.label,
        urlHint: calendarFeeds.urlHint,
        therapistId: calendarFeeds.therapistId,
        source: calendarFeeds.source,
        active: calendarFeeds.active,
        lastSyncAt: calendarFeeds.lastSyncAt,
        lastAttemptAt: calendarFeeds.lastAttemptAt,
        lastError: calendarFeeds.lastError,
        lastResult: calendarFeeds.lastResult,
      })
      .from(calendarFeeds)
      .where(eq(calendarFeeds.organizationId, org))
      .orderBy(asc(calendarFeeds.createdAt));
    const conflicts = await tx
      .select({ feedId: calendarFeedEvents.feedId, conflict: calendarFeedEvents.conflict, n: sql<number>`count(*)::int` })
      .from(calendarFeedEvents)
      .where(and(eq(calendarFeedEvents.organizationId, org), sql`${calendarFeedEvents.conflict} is not null`))
      .groupBy(calendarFeedEvents.feedId, calendarFeedEvents.conflict);
    return feeds.map((f) => ({
      ...f,
      conflicts: Object.fromEntries(conflicts.filter((c) => c.feedId === f.id).map((c) => [c.conflict as string, Number(c.n)])) as Partial<Record<FeedConflict, number>>,
    }));
  });
}

async function assertTherapist(tx: Tx, org: string, therapistId: string | null) {
  if (!therapistId) return;
  const [m] = await tx
    .select({ id: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.organizationId, org), eq(memberships.userId, therapistId), eq(memberships.active, true), inArray(memberships.role, [...CALENDAR_ROLES])));
  if (!m) throw new CalendarFeedError("Behandler:in gehört nicht zur Praxis (Empfang und Azubis haben keinen eigenen Kalender).");
}

export async function createCalendarFeed(auth: AuthContext, input: { url: string; label: string; therapistId: string | null; source: FeedSource }) {
  assertCan(auth, "integrations.manage");
  const org = auth.organization.id;
  const url = normalizeFeedUrl(input.url);
  const id = randomUUID();
  await withOrg(org, async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(calendarFeeds).where(eq(calendarFeeds.organizationId, org));
    if (Number(n) >= MAX_FEEDS_PER_ORG) throw new CalendarFeedError(`Höchstens ${MAX_FEEDS_PER_ORG} Kalender-Abos je Praxis.`);
    await assertTherapist(tx, org, input.therapistId);
    await tx.insert(calendarFeeds).values({
      id,
      organizationId: org,
      label: input.label,
      urlEnc: encryptSecret(url, feedAad(org, id)),
      urlHint: feedUrlHint(url),
      therapistId: input.therapistId,
      source: input.source,
    });
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "calendar_feed.create", entity: "calendar_feed", entityId: id, meta: { source: input.source } });
  return id;
}

export async function updateCalendarFeed(
  auth: AuthContext,
  feedId: string,
  input: { label: string; therapistId: string | null; source: FeedSource; active: boolean; url?: string | null },
) {
  assertCan(auth, "integrations.manage");
  const org = auth.organization.id;
  const url = input.url ? normalizeFeedUrl(input.url) : null;
  const n = await withOrg(org, async (tx) => {
    // Unveränderte Zuordnung nicht erneut prüfen: Umbenennen bleibt möglich, auch wenn die Person inzwischen keinen
    // eigenen Kalender mehr hat (der Abgleich legt neue Termine dann ohne Zuordnung an, siehe applyFeedEvents)
    const [cur] = await tx.select({ therapistId: calendarFeeds.therapistId }).from(calendarFeeds).where(and(eq(calendarFeeds.organizationId, org), eq(calendarFeeds.id, feedId)));
    if (!cur || cur.therapistId !== input.therapistId) await assertTherapist(tx, org, input.therapistId);
    const r = await tx
      .update(calendarFeeds)
      .set({
        label: input.label,
        therapistId: input.therapistId,
        source: input.source,
        active: input.active,
        updatedAt: new Date(),
        ...(url ? { urlEnc: encryptSecret(url, feedAad(org, feedId)), urlHint: feedUrlHint(url), etag: null, lastModified: null, lastError: null } : {}),
      })
      .where(and(eq(calendarFeeds.organizationId, org), eq(calendarFeeds.id, feedId)))
      .returning({ id: calendarFeeds.id });
    return r.length;
  });
  if (!n) throw new CalendarFeedError("Kalender-Abo nicht gefunden.");
  await audit({ organizationId: org, userId: auth.user.id, action: "calendar_feed.update", entity: "calendar_feed", entityId: feedId, meta: { urlChanged: !!url, active: input.active } });
}

/**
 * Entfernt ein Abo. Künftige, in PodoHero unveränderte Termine aus diesem Abo werden abgesagt (nicht gelöscht),
 * damit keine verwaisten Termine stehen bleiben; bereits geänderte und vergangene Termine bleiben unverändert.
 */
export async function deleteCalendarFeed(auth: AuthContext, feedId: string, now = new Date()) {
  assertCan(auth, "integrations.manage");
  const org = auth.organization.id;
  const cancelled = await withOrg(org, async (tx) => {
    const maps = await tx.select().from(calendarFeedEvents).where(and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.feedId, feedId)));
    const ids = maps.map((m) => m.appointmentId).filter((x): x is string => !!x);
    const appts = ids.length ? await tx.select().from(appointments).where(and(eq(appointments.organizationId, org), inArray(appointments.id, ids))) : [];
    let n = 0;
    for (const m of maps) {
      const a = appts.find((x) => x.id === m.appointmentId);
      if (!a || a.startsAt < now || a.status === "cancelled" || isFinal(a.status) || appliedHashOf(a) !== m.appliedHash) continue;
      await tx.update(appointments).set({ status: "cancelled", updatedAt: now }).where(and(eq(appointments.organizationId, org), eq(appointments.id, a.id)));
      n++;
    }
    await tx.delete(calendarFeeds).where(and(eq(calendarFeeds.organizationId, org), eq(calendarFeeds.id, feedId)));
    return n;
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "calendar_feed.delete", entity: "calendar_feed", entityId: feedId, meta: { cancelled } });
  return { cancelled };
}

/** Manuelle Zuordnung eines importierten Termins zu einer Patient:in (nie automatisch). */
export async function assignFeedAppointmentPatient(auth: AuthContext, appointmentId: string, patientId: string | null) {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  const ok = await withOrg(org, async (tx) => {
    const [m] = await tx
      .select({ id: calendarFeedEvents.id })
      .from(calendarFeedEvents)
      .where(and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.appointmentId, appointmentId)));
    if (!m) return false;
    if (patientId) {
      const p = await tx.execute(sql`select 1 from patients where organization_id = ${org} and id = ${patientId} and archived_at is null`);
      if (!p.rows.length) return false;
    }
    // patient_id ist nicht Teil des Abgleich-Hashes: die Zuordnung bleibt bei späteren Kalender-Änderungen erhalten
    await tx.update(appointments).set({ patientId, updatedAt: new Date() }).where(and(eq(appointments.organizationId, org), eq(appointments.id, appointmentId)));
    return true;
  });
  if (ok) await audit({ organizationId: org, userId: auth.user.id, action: "calendar_feed.assign_patient", entity: "appointment", entityId: appointmentId, meta: { assigned: !!patientId } });
  return ok;
}

/** Ist der Termin aus einem Kalender-Abo? (Server-Actions: Absage nur in der Quelle) */
export async function isFeedAppointment(org: string, appointmentId: string): Promise<boolean> {
  const r = await withOrg(org, (tx) =>
    tx.select({ id: calendarFeedEvents.id }).from(calendarFeedEvents).where(and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.appointmentId, appointmentId))).limit(1),
  );
  return r.length > 0;
}

/** Abos mit Fehler (für den Hinweis auf /heute). */
export async function failingCalendarFeeds(org: string) {
  return withOrg(org, (tx) =>
    tx
      .select({ id: calendarFeeds.id, label: calendarFeeds.label, lastError: calendarFeeds.lastError })
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.organizationId, org), eq(calendarFeeds.active, true), sql`${calendarFeeds.lastError} is not null`)),
  );
}

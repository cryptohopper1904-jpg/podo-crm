import "server-only";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { appointmentServices, appointments, messages, organizations, services, voiceCalls } from "@/db/schema";
import type { VoiceCallEvent, VoiceToolCall, VoiceToolResult, VoiceVendorId } from "@/integrations/types";
import {
  maskPhone,
  outcomeFromEndedReason,
  readVoiceSettings,
  runVoiceTools,
  shortName,
  shouldStoreTranscript,
  strongerOutcome,
  type BookableService,
  type VoiceOutcome,
  type VoiceToolDeps,
} from "@/integrations/voice/core";
import { isMockMode } from "@/integrations/registry";
import { describeError } from "@/integrations/test-connection";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { computeAvailability, mergeRanges, type TimeRange } from "@/lib/availability";
import { berlinToUtc } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { assertCan } from "./authz";
import { freeSlots } from "./appointments";
import { loadConnection, logSync } from "./integrations";
import { availability, staffMembers } from "./staff";

/**
 * KI-Telefonagent – Datenbankseite der Werkzeuge (anbieterneutral, siehe integrations/voice/core.ts).
 * Alle Zugriffe laufen mandantengebunden (withOrg → RLS) und filtern zusätzlich nach organizationId.
 */

const BOOKABLE_CATEGORIES = ["treatment", "cosmetic", "brace"];

type OrgRow = { id: string; name: string; street: string | null; zip: string | null; city: string | null; phone: string | null; state: string; settings: Record<string, unknown> };

async function loadOrg(org: string): Promise<OrgRow | null> {
  const [o] = await db
    .select({ id: organizations.id, name: organizations.name, street: organizations.street, zip: organizations.zip, city: organizations.city, phone: organizations.phone, state: organizations.state, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, org));
  return o ?? null;
}

const openingOf = (settings: Record<string, unknown>): TimeRange => {
  const o = (settings.opening ?? {}) as { from?: string; to?: string };
  return { start: o.from ?? "08:00", end: o.to ?? "18:00" };
};

export async function bookableServices(org: string, settings: Record<string, unknown>): Promise<BookableService[]> {
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ code: services.code, name: services.name, durationMin: services.durationMin })
      .from(services)
      .where(and(eq(services.organizationId, org), eq(services.active, true), inArray(services.category, BOOKABLE_CATEGORIES)))
      .orderBy(asc(services.name)),
  );
  const voiceCodes = readVoiceSettings(settings).serviceCodes;
  const onlineCodes = ((settings.onlineBooking ?? {}) as { serviceCodes?: string[] }).serviceCodes ?? [];
  const allowed = voiceCodes.length ? voiceCodes : onlineCodes;
  return rows.filter((s) => s.durationMin > 0 && (!allowed.length || allowed.includes(s.code)));
}

/**
 * Wählt aus freien Startzeiten je Tag höchstens `perDay` aus (Abwechslung), insgesamt `limit`.
 * Reine Funktion – testbar ohne Datenbank.
 */
export function proposeSlots(input: {
  days: { dateIso: string; ranges: TimeRange[] }[];
  busy: { startsAt: Date; endsAt: Date }[];
  durationMin: number;
  earliest: Date;
  limit: number;
  perDay?: number;
  stepMin?: number;
}): Date[] {
  const out: Date[] = [];
  const perDay = input.perDay ?? (input.days.length === 1 ? input.limit : 2);
  for (const d of input.days) {
    const day = d.ranges
      .flatMap((r) => freeSlots(input.busy, d.dateIso, input.durationMin, { from: r.start, to: r.end }, input.stepMin ?? 30))
      .filter((s) => s.getTime() >= input.earliest.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    out.push(...day.slice(0, perDay));
    if (out.length >= input.limit) break;
  }
  return out.slice(0, input.limit);
}

const dayList = (fromIso: string, toIso: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${fromIso}T12:00:00Z`); t <= Date.parse(`${toIso}T12:00:00Z`) && out.length < 31; t += 86400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/**
 * Freie Startzeiten: Verfügbarkeit des Teams (Arbeitszeiten, Abwesenheiten, Feiertage; ohne gepflegte
 * Arbeitszeiten Mo–Fr Öffnungszeiten) und – wie bei der Online-Buchung – praxisweit belegte Zeiten.
 */
export async function findVoiceSlots(
  org: string,
  o: Pick<OrgRow, "state" | "settings">,
  input: { fromIso: string; toIso: string; durationMin: number; limit: number; earliest: Date; perDay?: number },
): Promise<Date[]> {
  const staff = await staffMembers(org);
  const opening = openingOf(o.settings);
  const days: { dateIso: string; ranges: TimeRange[] }[] = [];
  for (const d of dayList(input.fromIso, input.toIso)) {
    const ranges = staff.length
      ? mergeRanges((await Promise.all(staff.map((s) => availability(org, s.id, d)))).flatMap((a) => a.ranges))
      : computeAvailability({ dateIso: d, hours: [], absences: [], holiday: holidayOn(d, o.state as StateCode), opening }).ranges;
    if (ranges.length) days.push({ dateIso: d, ranges });
  }
  if (!days.length) return [];
  const from = berlinToUtc(days[0].dateIso, "00:00");
  const to = new Date(berlinToUtc(days[days.length - 1].dateIso, "00:00").getTime() + 26 * 3600_000);
  const busy = await withOrg(org, (tx) =>
    tx
      .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), lt(appointments.startsAt, to), gte(appointments.endsAt, from))),
  );
  return proposeSlots({ days, busy: busy.filter((b) => b.status !== "cancelled"), durationMin: input.durationMin, earliest: input.earliest, limit: input.limit, perDay: input.perDay });
}

const berlinDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d);

/** Ausgang je Anruf vormerken (Zeile wird beim ersten Werkzeug angelegt, Ende-Bericht ergänzt). */
async function upsertCall(
  org: string,
  vendor: string,
  callId: string,
  patch: { outcome?: VoiceOutcome | null; appointmentId?: string | null; callerMasked?: string | null; startedAt?: Date; durationSec?: number | null; summary?: string | null; transcript?: string | null; final?: boolean },
) {
  await withOrg(org, async (tx) => {
    // serialisiert parallele Ereignisse desselben Anrufs
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`voice:${org}:${vendor}:${callId}`}))`);
    const [row] = await tx
      .select()
      .from(voiceCalls)
      .where(and(eq(voiceCalls.organizationId, org), eq(voiceCalls.provider, vendor), eq(voiceCalls.externalId, callId)));
    if (!row) {
      const outcome = patch.final ? strongerOutcome(null, patch.outcome ?? null) ?? "info" : patch.outcome ?? null;
      await tx.insert(voiceCalls).values({
        organizationId: org,
        provider: vendor,
        externalId: callId,
        callerMasked: patch.callerMasked ?? null,
        startedAt: patch.startedAt ?? new Date(),
        durationSec: patch.durationSec ?? null,
        outcome,
        summary: patch.summary ?? null,
        transcript: patch.transcript ?? null,
        appointmentId: patch.appointmentId ?? null,
      });
      return;
    }
    await tx
      .update(voiceCalls)
      .set({
        outcome: strongerOutcome(row.outcome, patch.outcome ?? null),
        appointmentId: row.appointmentId ?? patch.appointmentId ?? null,
        callerMasked: row.callerMasked ?? patch.callerMasked ?? null,
        ...(patch.startedAt && patch.final ? { startedAt: patch.startedAt } : {}),
        ...(patch.durationSec !== undefined ? { durationSec: patch.durationSec } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.transcript !== undefined ? { transcript: patch.transcript } : {}),
      })
      .where(eq(voiceCalls.id, row.id));
  });
}

export type VoiceCallContext = { vendor: VoiceVendorId; callId: string; caller: string | null; now?: () => Date };

/** Produktions-Implementierung der Werkzeug-Abhängigkeiten für einen Anruf. */
export function voiceToolDeps(org: string, o: OrgRow, ctx: VoiceCallContext): VoiceToolDeps {
  const now = ctx.now ?? (() => new Date());
  const externalId = `${ctx.vendor}:${ctx.callId}`.slice(0, 250);
  const callerMasked = maskPhone(ctx.caller);
  let svcCache: BookableService[] | null = null;
  return {
    now,
    caller: ctx.caller,
    async services() {
      svcCache ??= await bookableServices(org, o.settings);
      return svcCache;
    },
    findSlots: ({ fromIso, toIso, durationMin, limit }) =>
      findVoiceSlots(org, o, { fromIso, toIso, durationMin, limit, earliest: new Date(now().getTime() + 2 * 3600_000) }),
    async book({ firstName, lastName, phone, service, startsAt }) {
      // Zeit muss ein angebotener freier Slot sein (Arbeitszeiten/Abwesenheiten/Feiertage)
      const day = berlinDay(startsAt);
      const free = await findVoiceSlots(org, o, { fromIso: day, toIso: day, durationMin: service.durationMin, limit: 500, perDay: 500, earliest: new Date(now().getTime() + 2 * 3600_000) });
      const end = new Date(startsAt.getTime() + service.durationMin * 60_000);
      const res = await withOrg(org, async (tx) => {
        // gleiche Sperre wie die Online-Buchung → keine Doppelbelegung bei gleichzeitigen Anfragen
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"book:" + org}))`);
        const [dup] = await tx
          .select({ id: appointments.id, startsAt: appointments.startsAt })
          .from(appointments)
          .where(and(eq(appointments.organizationId, org), eq(appointments.source, "voice_agent"), eq(appointments.externalId, externalId)));
        if (dup) return { status: "duplicate" as const, appointmentId: dup.id, startsAt: dup.startsAt };
        if (!free.some((s) => s.getTime() === startsAt.getTime())) return { status: "taken" as const };
        const clash = await tx
          .select({ status: appointments.status })
          .from(appointments)
          .where(and(eq(appointments.organizationId, org), lt(appointments.startsAt, end), gte(appointments.endsAt, startsAt)));
        if (clash.some((c) => c.status !== "cancelled")) return { status: "taken" as const };
        const [svc] = await tx
          .select({ id: services.id })
          .from(services)
          .where(and(eq(services.organizationId, org), eq(services.code, service.code), eq(services.active, true)));
        if (!svc) return { status: "taken" as const };
        // Sicherheit: NIE an eine bestehende Akte hängen (Name + Telefonnummer sind kein Identitätsnachweis).
        const [a] = await tx
          .insert(appointments)
          .values({
            organizationId: org,
            patientId: null,
            startsAt,
            endsAt: end,
            status: "planned",
            source: "voice_agent",
            externalId,
            title: `Telefon: ${shortName(firstName, lastName)}`,
            notes: `Unbestätigt (KI-Telefon) · ${service.name}. Kunde im Posteingang zuordnen und Termin bestätigen.`,
          })
          .returning({ id: appointments.id });
        await tx.insert(appointmentServices).values({ organizationId: org, appointmentId: a.id, serviceId: svc.id });
        await tx.insert(messages).values({
          organizationId: org,
          patientId: null,
          channel: "phone",
          direction: "inbound",
          fromAddress: phone,
          subject: "Terminwunsch per KI-Telefon (unbestätigt)",
          body: [
            `Terminwunsch per KI-Telefon: ${service.name} am ${new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "full", timeStyle: "short" }).format(startsAt)} Uhr.`,
            `Name laut Anrufer: ${firstName} ${lastName}`,
            `Rückrufnummer: ${phone}`,
            "Der Termin ist vorgemerkt, aber nicht bestätigt. Bitte Kunde zuordnen (bestehend oder neu) und Termin bestätigen oder absagen.",
          ].join("\n"),
          status: "new",
          threadKey: externalId,
        });
        return { status: "booked" as const, appointmentId: a.id };
      });
      if (res.status === "booked") {
        await audit({ organizationId: org, action: "booking.voice_agent", entity: "appointment", entityId: res.appointmentId, meta: { vendor: ctx.vendor } }).catch(() => undefined);
      }
      return res;
    },
    async inbox({ subject, body, from }) {
      await withOrg(org, (tx) =>
        tx.insert(messages).values({ organizationId: org, patientId: null, channel: "phone", direction: "inbound", fromAddress: from, subject, body, status: "new", threadKey: externalId }),
      );
    },
    async practiceInfo() {
      const op = openingOf(o.settings);
      const address = [o.street, [o.zip, o.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;
      return { name: o.name, address, phone: o.phone, openingText: `Montag bis Freitag ${op.start} bis ${op.end} Uhr, an Feiertagen geschlossen` };
    },
    noteOutcome: (outcome, appointmentId) => upsertCall(org, ctx.vendor, ctx.callId, { outcome, appointmentId: appointmentId ?? null, callerMasked }),
  };
}

export async function runVoiceToolCalls(org: string, ctx: VoiceCallContext, calls: VoiceToolCall[]): Promise<VoiceToolResult[]> {
  const o = await loadOrg(org);
  if (!o) return calls.map((c) => ({ toolCallId: c.toolCallId, result: "Praxis nicht gefunden." }));
  return runVoiceTools(calls, voiceToolDeps(org, o, ctx), (e, tool) => {
    void logSync(org, "voice_agent", { direction: "in", ok: false, message: `Werkzeug ${tool}: ${describeError(e)}` }).catch(() => undefined);
  });
}

/** Ende-Bericht → voice_calls (Transkript nur mit Einstellung + angesagter Aufzeichnung). */
export async function recordCallEnd(org: string, vendor: VoiceVendorId, ev: Extract<VoiceCallEvent, { type: "call_ended" }>) {
  const o = await loadOrg(org);
  if (!o) return;
  const settings = readVoiceSettings(o.settings);
  const startedAt = ev.startedAt && Number.isFinite(Date.parse(ev.startedAt)) ? new Date(ev.startedAt) : new Date();
  await upsertCall(org, vendor, ev.callId, {
    final: true,
    outcome: outcomeFromEndedReason(ev.endedReason),
    callerMasked: maskPhone(ev.from),
    startedAt,
    durationSec: ev.durationSec === null ? null : Math.max(0, Math.min(ev.durationSec, 24 * 3600)),
    summary: ev.summary ? ev.summary.slice(0, 2000) : null,
    transcript: shouldStoreTranscript(settings, ev.transcript) ? ev.transcript!.slice(0, 100_000) : null,
  });
}

/** Verarbeitet ein normalisiertes Ereignis; liefert bei Werkzeug-Aufrufen die Ergebnisse. */
export async function processVoiceEvent(org: string, vendor: VoiceVendorId, ev: VoiceCallEvent): Promise<VoiceToolResult[] | null> {
  if (ev.type === "tool_calls") return runVoiceToolCalls(org, { vendor, callId: ev.callId, caller: ev.from }, ev.calls);
  if (ev.type === "call_ended") await recordCallEnd(org, vendor, ev);
  return null;
}

// ───────────────────────── Oberfläche (/telefon) ─────────────────────────

export async function listVoiceCalls(auth: AuthContext, limit = 50) {
  assertCan(auth, "messages.read");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({
        id: voiceCalls.id,
        provider: voiceCalls.provider,
        callerMasked: voiceCalls.callerMasked,
        startedAt: voiceCalls.startedAt,
        durationSec: voiceCalls.durationSec,
        outcome: voiceCalls.outcome,
        summary: voiceCalls.summary,
        hasTranscript: sql<boolean>`${voiceCalls.transcript} is not null`,
        appointmentId: voiceCalls.appointmentId,
        appointmentStartsAt: appointments.startsAt,
      })
      .from(voiceCalls)
      .leftJoin(appointments, eq(appointments.id, voiceCalls.appointmentId))
      .where(eq(voiceCalls.organizationId, org))
      .orderBy(desc(voiceCalls.startedAt))
      .limit(limit),
  );
}

export async function voicePageInfo(auth: AuthContext) {
  assertCan(auth, "messages.read");
  const o = await loadOrg(auth.organization.id);
  if (!o) throw new Error("Praxis nicht gefunden");
  return { settings: readVoiceSettings(o.settings), opening: openingOf(o.settings), services: await bookableServices(o.id, o.settings) };
}

export async function saveVoiceSettings(auth: AuthContext, input: { storeTranscripts: boolean }) {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  await db
    .update(organizations)
    .set({ settings: sql`jsonb_set(coalesce(${organizations.settings}, '{}'::jsonb), '{voice}', coalesce(${organizations.settings} -> 'voice', '{}'::jsonb) || ${JSON.stringify({ storeTranscripts: input.storeTranscripts })}::jsonb)` })
    .where(eq(organizations.id, org));
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.voice", meta: { storeTranscripts: input.storeTranscripts } });
}

/** „Anruf simulieren“ nur in Entwicklung oder im Testmodus der Schnittstelle – nie gegen eine echte Produktionsanbindung. */
export async function simulationAllowed(org: string): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return true;
  return isMockMode(await loadConnection(org, "voice_agent"));
}

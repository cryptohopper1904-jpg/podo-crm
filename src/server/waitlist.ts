import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { appointmentServices, appointments, consents, messages, organizations, patientLinks, patients, reminderLog, services, waitlist } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { dateDe, timeDe } from "@/lib/format";
import { hashPortalToken, isPortalToken, newPortalToken } from "@/lib/portal";
import { chooseChannel, grantedConsents, type ReminderChannel } from "@/lib/reminders";
import {
  describeWishes,
  matchWaitlist,
  OFFER_KIND,
  OFFER_PURPOSE,
  offerExpiry,
  normalizeWishes,
  offerText,
  wishesOfRow,
  type WaitlistWishes,
} from "@/lib/waitlist";
import { describeError } from "@/integrations/test-connection";
import type { MessagingPort, MessagingProvider } from "@/integrations/types";
import { isCalendarMember } from "./appointments";
import { adapterFor } from "./integrations";
import { mailMessagingPort } from "./mail";

const PROVIDER: Record<ReminderChannel, MessagingProvider> = { email: "email_imap", sms: "sms", whatsapp: "whatsapp" };
const REMINDER_CONSENTS = ["email_reminders", "sms_reminders", "whatsapp"] as const;
const offerKey = (linkId: string) => `wloffer:${linkId}`;
const wlCols = { wishes: waitlist.wishes, serviceIds: waitlist.serviceIds, weekdays: waitlist.weekdays, dayparts: waitlist.dayparts, note: waitlist.note };

/**
 * Basis-URL für Angebots-Links: absolut und HTTPS (Token im Link = Annahme im Namen der Person). http nur für
 * localhost (Entwicklung/E2E). null → kein Versand.
 */
export function offerBaseUrl(raw: string | undefined | null): string | null {
  try {
    const u = new URL(String(raw ?? "").trim());
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
const shortName = (first: string | null, last: string) => `${first ?? ""} ${last.slice(0, 1)}.`.trim();

export type OfferDeps = {
  now?: Date;
  getPort?: (org: string, provider: MessagingProvider) => Promise<MessagingPort>;
  /** Basis-URL für den Link (Standard: PUBLIC_URL) */
  baseUrl?: string;
};

/** Ergebnis ohne Links/Tokens (die stehen nur in der versendeten Nachricht). */
export type OfferSummary = { offered: number; manual: number; skipped?: string };

/**
 * Ein Termin wurde abgesagt (Praxis, Patientenportal; beim KI-Telefon sagt die Praxis nach Prüfung ab):
 * passende Wartelisten-Einträge bekommen ein Einmal-Angebot – nur mit Einwilligung für den Kanal.
 * Personen ohne Einwilligung erscheinen im Posteingang als Vorschlag „bitte anrufen“.
 * Mehrfachaufruf für denselben Termin bietet niemandem doppelt an (Sperre je Termin + Protokoll).
 */
export async function offerFreedSlot(org: string, appointmentId: string, deps: OfferDeps = {}): Promise<OfferSummary> {
  const now = deps.now ?? new Date();
  if (!z.uuid().safeParse(appointmentId).success) return { offered: 0, manual: 0, skipped: "invalid" };
  const [o] = await db.select({ name: organizations.name, phone: organizations.phone }).from(organizations).where(eq(organizations.id, org));
  if (!o) return { offered: 0, manual: 0, skipped: "org" };
  const base = offerBaseUrl(deps.baseUrl ?? process.env.PUBLIC_URL);
  if (!base) return { offered: 0, manual: 0, skipped: "no_https_url" };

  type Planned = { linkId: string; token: string; patientId: string; firstName: string | null; label: string; channel: ReminderChannel; to: string; expiresAt: Date };
  const prepared = await withOrg(org, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wl:${org}:${appointmentId}`}, 0))`);
    const [a] = await tx
      .select({ id: appointments.id, patientId: appointments.patientId, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, appointmentId)));
    if (!a || a.status !== "cancelled") return { skipped: "not_cancelled" as const };
    const expiresAt = offerExpiry(a.startsAt, now);
    if (!expiresAt) return { skipped: "too_soon" as const };
    // Zeit inzwischen anderweitig belegt?
    const overlap = await tx
      .select({ id: appointments.id, status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), lt(appointments.startsAt, a.endsAt), gt(appointments.endsAt, a.startsAt)));
    if (overlap.some((r) => r.id !== a.id && r.status !== "cancelled")) return { skipped: "taken" as const };
    const serviceIds = (
      await tx.select({ id: appointmentServices.serviceId }).from(appointmentServices).where(and(eq(appointmentServices.organizationId, org), eq(appointmentServices.appointmentId, a.id)))
    ).map((s) => s.id);
    const svcList = await tx.select({ id: services.id, name: services.name, code: services.code }).from(services).where(eq(services.organizationId, org));
    const entries = await tx
      .select({ id: waitlist.id, patientId: waitlist.patientId, createdAt: waitlist.createdAt, ...wlCols })
      .from(waitlist)
      .innerJoin(patients, eq(patients.id, waitlist.patientId))
      .where(and(eq(waitlist.organizationId, org), isNull(waitlist.resolvedAt), isNull(patients.archivedAt)));
    if (!entries.length) return { skipped: "no_entries" as const };
    // schon für diesen Termin angeboten oder anderes Angebot noch offen → nicht erneut
    const already = await tx
      .select({ patientId: reminderLog.patientId })
      .from(reminderLog)
      .where(and(eq(reminderLog.organizationId, org), eq(reminderLog.kind, OFFER_KIND), eq(reminderLog.appointmentId, a.id)));
    const activeOffers = await tx
      .select({ patientId: patientLinks.patientId })
      .from(patientLinks)
      .where(and(eq(patientLinks.organizationId, org), eq(patientLinks.purpose, OFFER_PURPOSE), isNull(patientLinks.revokedAt), isNull(patientLinks.usedAt), gt(patientLinks.expiresAt, now)));
    const exclude = [a.patientId, ...already.map((x) => x.patientId), ...activeOffers.map((x) => x.patientId)].filter((x): x is string => !!x);
    const candidates = entries.map((e) => ({ id: e.id, patientId: e.patientId, createdAt: e.createdAt, wishes: wishesOfRow(e, svcList) }));
    const picked = matchWaitlist(candidates, { startsAt: a.startsAt, endsAt: a.endsAt, serviceIds }, { excludePatientIds: exclude });
    if (!picked.length) return { skipped: "no_match" as const };
    const ids = picked.map((p) => p.patientId);
    const ps = await tx
      .select({ id: patients.id, firstName: patients.firstName, lastName: patients.lastName, email: patients.email, phoneMobile: patients.phoneMobile, phoneLandline: patients.phoneLandline, preferredChannel: patients.preferredChannel, extra: patients.extra })
      .from(patients)
      .where(and(eq(patients.organizationId, org), inArray(patients.id, ids)));
    const cons = await tx
      .select({ patientId: consents.patientId, type: consents.type, granted: consents.granted, recordedAt: consents.recordedAt })
      .from(consents)
      .where(and(eq(consents.organizationId, org), inArray(consents.patientId, ids), inArray(consents.type, [...REMINDER_CONSENTS])))
      .orderBy(desc(consents.recordedAt));
    const planned: Planned[] = [];
    const manual: { patientId: string; name: string; wishes: string }[] = [];
    for (const c of picked) {
      const p = ps.find((x) => x.id === c.patientId);
      if (!p) continue;
      const extra = (p.extra ?? {}) as Record<string, unknown>;
      const ch = chooseChannel(
        { id: p.id, firstName: p.firstName, email: p.email, phoneMobile: p.phoneMobile, preferredChannel: p.preferredChannel, noReminders: extra.no_reminders === true || extra.no_reminders === "true" },
        grantedConsents(cons.filter((r) => r.patientId === p.id)),
      );
      const label = shortName(p.firstName, p.lastName);
      if (!ch) {
        manual.push({ patientId: p.id, name: `${p.firstName ?? ""} ${p.lastName}`.trim(), wishes: describeWishes(c.wishes, svcList) });
        // auch ohne Versand protokollieren → beim nächsten Aufruf nicht erneut vorschlagen
        await tx
          .insert(reminderLog)
          .values({ organizationId: org, patientId: p.id, appointmentId: a.id, kind: OFFER_KIND, channel: "none", status: "skipped", detail: "keine Einwilligung/Adresse – Vorschlag im Posteingang", dedupeKey: `wloffer-manual:${a.id}:${p.id}` })
          .onConflictDoNothing({ target: [reminderLog.organizationId, reminderLog.dedupeKey] });
        continue;
      }
      const token = newPortalToken();
      const linkId = randomUUID();
      // Einmal-Link (höchstens ein aktives Angebot je Person – partieller Unique-Index), direkt mit dem freien Termin verknüpft
      const ins = await tx
        .insert(patientLinks)
        .values({ id: linkId, organizationId: org, patientId: p.id, purpose: OFFER_PURPOSE, tokenHash: hashPortalToken(token), expiresAt, appointmentId: a.id })
        .onConflictDoNothing()
        .returning({ id: patientLinks.id });
      if (!ins.length) continue;
      await tx.insert(reminderLog).values({ organizationId: org, patientId: p.id, appointmentId: a.id, kind: OFFER_KIND, channel: ch.channel, status: "pending", dedupeKey: offerKey(linkId) });
      planned.push({ linkId, token, patientId: p.id, firstName: p.firstName, label, channel: ch.channel, to: ch.to, expiresAt });
    }
    return { slot: a, planned, manual };
  });
  if ("skipped" in prepared) return { offered: 0, manual: 0, skipped: prepared.skipped };

  const { slot, planned, manual } = prepared;
  const getPort = deps.getPort ?? ((orgId: string, p: MessagingProvider) => (p === "email_imap" ? mailMessagingPort(orgId, { purpose: "reminder" }) : adapterFor(orgId, p)));
  const ports = new Map<MessagingProvider, MessagingPort | Error>();
  const sent: string[] = [];
  const failed: string[] = [];
  for (const r of planned) {
    const url = `${base}/portal/angebot/${r.token}`;
    const text = offerText(o, r.firstName, slot.startsAt, url, r.expiresAt);
    let status: "sent" | "failed" = "sent";
    let detail: string;
    try {
      const provider = PROVIDER[r.channel];
      if (!ports.has(provider)) ports.set(provider, await getPort(org, provider).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
      const port = ports.get(provider)!;
      if (port instanceof Error) throw port;
      const res = await port.send({ to: r.to, body: text.body, subject: r.channel === "email" ? text.subject : undefined });
      detail = port.isMock ? "Testmodus – nicht wirklich versendet" : `versendet (${res.externalId})`.slice(0, 200);
      // Im Verlauf ohne Link (nur der Hash ist gespeichert)
      await withOrg(org, (tx) =>
        tx.insert(messages).values({
          organizationId: org,
          patientId: r.patientId,
          channel: r.channel,
          direction: "outbound",
          toAddress: r.to,
          subject: r.channel === "email" ? text.subject : null,
          body: text.body.replace(url, "[persönlicher Link]"),
          status: "answered",
          externalId: res.externalId,
          threadKey: r.to,
        }),
      );
      sent.push(`${r.label} (${r.channel === "email" ? "E-Mail" : r.channel === "sms" ? "SMS" : "WhatsApp"})`);
    } catch (e) {
      status = "failed";
      detail = describeError(e).slice(0, 300);
      failed.push(r.label);
      // fehlgeschlagener Versand → Link sofort ungültig
      await db.update(patientLinks).set({ revokedAt: new Date() }).where(and(eq(patientLinks.organizationId, org), eq(patientLinks.id, r.linkId)));
    }
    await withOrg(org, (tx) => tx.update(reminderLog).set({ status, detail }).where(and(eq(reminderLog.organizationId, org), eq(reminderLog.dedupeKey, offerKey(r.linkId)))));
  }

  if (sent.length || failed.length || manual.length) {
    const when = `${dateDe(slot.startsAt)} um ${timeDe(slot.startsAt)} Uhr`;
    await withOrg(org, (tx) =>
      tx.insert(messages).values({
        organizationId: org,
        patientId: null,
        channel: "none",
        direction: "inbound",
        subject: `Warteliste: freier Termin ${when}`,
        body: [
          `Der abgesagte Termin am ${when} wurde der Warteliste angeboten. Wer zuerst annimmt, bekommt ihn automatisch (Status „geplant“).`,
          sent.length ? `Angebot verschickt an: ${sent.join(", ")}.` : null,
          failed.length ? `Versand fehlgeschlagen: ${failed.join(", ")}.` : null,
          manual.length ? `${manual.length} passende Person(en) ohne Einwilligung für Nachrichten – Anruf-Vorschläge stehen als eigene Nachrichten bei der jeweiligen Akte.` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        status: "new",
        threadKey: `waitlist:${slot.id}`,
      }),
    );
  }
  // Anruf-Vorschläge je Person an der Akte (keine Telefonnummer/Wünsche als Kopie in einer allgemeinen Nachricht)
  if (manual.length) {
    const when = `${dateDe(slot.startsAt)} um ${timeDe(slot.startsAt)} Uhr`;
    await withOrg(org, (tx) =>
      tx.insert(messages).values(
        manual.map((m) => ({
          organizationId: org,
          patientId: m.patientId,
          channel: "none" as const,
          direction: "inbound" as const,
          subject: `Warteliste: bitte anrufen – freier Termin ${when}`,
          body: `Der freie Termin am ${when} passt zum Wartelisten-Wunsch (${m.wishes}) von ${m.name}. Für Nachrichten liegt keine Einwilligung vor – bitte ggf. anrufen (Telefon in der Akte).`,
          status: "suggested" as const,
          aiSuggestion: "Vorschlag: Person anrufen und den freien Termin anbieten.",
          threadKey: `waitlist:${slot.id}:${m.patientId}`,
        })),
      ),
    );
  }
  await audit({ organizationId: org, action: "waitlist.offer", entity: "appointment", entityId: slot.id, meta: { offered: sent.length, failed: failed.length, manual: manual.length } });
  return { offered: sent.length, manual: manual.length };
}

/** Für Aufrufer nach einer Absage: Fehler im Angebot dürfen die Absage nie scheitern lassen. */
export async function offerFreedSlotSafe(org: string, appointmentId: string) {
  try {
    return await offerFreedSlot(org, appointmentId);
  } catch (e) {
    await audit({ organizationId: org, action: "waitlist.offer_failed", entity: "appointment", entityId: appointmentId, meta: { error: describeError(e).slice(0, 200) } }).catch(() => undefined);
    return null;
  }
}

// ───────────── Angebot annehmen (öffentlich, Einmal-Link) ─────────────

export type OfferView =
  | { state: "valid"; startsAt: Date; endsAt: Date; practice: { name: string; phone: string | null }; firstName: string | null }
  | { state: "taken" | "expired" | "accepted"; practice: { name: string; phone: string | null }; startsAt?: Date }
  | { state: "invalid" };

async function findOffer(token: string) {
  if (!isPortalToken(token)) return null;
  // patient_links hat bewusst keine RLS (Lookup nur über den Token-Hash, wie sessions; drizzle/0007) – danach wird
  // ausschließlich im Mandantenkontext der gefundenen Praxis gelesen.
  const [l] = await db
    .select({ id: patientLinks.id, organizationId: patientLinks.organizationId, patientId: patientLinks.patientId, purpose: patientLinks.purpose, expiresAt: patientLinks.expiresAt, usedAt: patientLinks.usedAt, revokedAt: patientLinks.revokedAt, appointmentId: patientLinks.appointmentId })
    .from(patientLinks)
    .where(eq(patientLinks.tokenHash, hashPortalToken(token)))
    .limit(1);
  if (!l || l.purpose !== OFFER_PURPOSE || !l.appointmentId) return null;
  const [o] = await db.select({ name: organizations.name, phone: organizations.phone }).from(organizations).where(eq(organizations.id, l.organizationId));
  if (!o) return null;
  const slot = await withOrg(l.organizationId, async (tx) => {
    const [a] = await tx
      .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, therapistId: appointments.therapistId, locationId: appointments.locationId, title: appointments.title })
      .from(appointments)
      .where(and(eq(appointments.organizationId, l.organizationId), eq(appointments.id, l.appointmentId!)));
    return a ?? null;
  });
  if (!slot) return null;
  return { link: l, practice: o, slot };
}

/** Anzeige der Angebotsseite (ohne Annahme – Link-Vorschauen/Scanner lösen nichts aus). */
export async function loadOffer(token: string, now = new Date()): Promise<OfferView> {
  const f = await findOffer(token);
  if (!f) return { state: "invalid" };
  const { link, practice, slot } = f;
  if (link.usedAt) return { state: "accepted", practice, startsAt: slot.startsAt };
  if (link.revokedAt) return { state: "taken", practice };
  if (link.expiresAt <= now || slot.startsAt <= now) return { state: "expired", practice };
  const taken = await withOrg(link.organizationId, async (tx) => {
    const rows = await tx
      .select({ id: appointments.id, status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.organizationId, link.organizationId), lt(appointments.startsAt, slot.endsAt), gt(appointments.endsAt, slot.startsAt)));
    return rows.some((r) => r.id !== slot.id && r.status !== "cancelled");
  });
  if (taken) return { state: "taken", practice };
  const [p] = await withOrg(link.organizationId, (tx) => tx.select({ firstName: patients.firstName }).from(patients).where(and(eq(patients.organizationId, link.organizationId), eq(patients.id, link.patientId))));
  return { state: "valid", startsAt: slot.startsAt, endsAt: slot.endsAt, practice, firstName: p?.firstName ?? null };
}

export type AcceptResult = { ok: true; message: string; appointmentId: string } | { ok: false; state: "taken" | "expired" | "invalid" | "accepted"; error: string };

const TAKEN_MSG = "Leider schon vergeben – jemand anderes war schneller. Sie bleiben auf der Warteliste.";

/**
 * Annahme: wer zuerst bestätigt, bekommt den Termin. Gleiche Buchungssperre wie /buchen und das Portal;
 * darin werden Link-Zustand und Überschneidung erneut geprüft. Danach werden alle anderen Angebote
 * für diesen Termin widerrufen.
 */
export async function acceptOffer(token: string, now = new Date()): Promise<AcceptResult> {
  const f = await findOffer(token);
  if (!f) return { ok: false, state: "invalid", error: "Der Link ist ungültig." };
  const { practice } = f;
  const org = f.link.organizationId;
  let slot = f.slot;
  const res = await withOrg(org, async (tx): Promise<AcceptResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"book:" + org}, 0))`);
    const [l] = await tx.select().from(patientLinks).where(and(eq(patientLinks.organizationId, org), eq(patientLinks.id, f.link.id))).for("update");
    if (!l) return { ok: false, state: "invalid", error: "Der Link ist ungültig." };
    if (l.usedAt) return { ok: false, state: "accepted", error: "Sie haben diesen Termin bereits angenommen." };
    if (l.revokedAt) return { ok: false, state: "taken", error: TAKEN_MSG };
    // Ursprungstermin UNTER der Sperre neu laden: nur ein weiterhin abgesagter Termin mit unveränderten Zeiten wird vergeben
    const [cur] = await tx
      .select({ id: appointments.id, status: appointments.status, startsAt: appointments.startsAt, endsAt: appointments.endsAt, therapistId: appointments.therapistId, locationId: appointments.locationId, title: appointments.title })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, slot.id)))
      .for("update");
    if (!cur || cur.status !== "cancelled" || cur.startsAt.getTime() !== slot.startsAt.getTime() || cur.endsAt.getTime() !== slot.endsAt.getTime()) {
      await tx.update(patientLinks).set({ revokedAt: now }).where(and(eq(patientLinks.organizationId, org), eq(patientLinks.id, l.id)));
      return { ok: false, state: "taken", error: TAKEN_MSG };
    }
    slot = { id: cur.id, startsAt: cur.startsAt, endsAt: cur.endsAt, therapistId: cur.therapistId, locationId: cur.locationId, title: cur.title };
    if (l.expiresAt <= now || slot.startsAt <= now) return { ok: false, state: "expired", error: "Das Angebot ist abgelaufen." };
    const rows = await tx
      .select({ id: appointments.id, status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), lt(appointments.startsAt, slot.endsAt), gt(appointments.endsAt, slot.startsAt)));
    // kein Ausschluss des Ursprungstermins mehr nötig: er ist (geprüft) abgesagt
    if (rows.some((r) => r.status !== "cancelled")) {
      await tx.update(patientLinks).set({ revokedAt: now }).where(and(eq(patientLinks.organizationId, org), eq(patientLinks.id, l.id)));
      return { ok: false, state: "taken", error: TAKEN_MSG };
    }
    const [p] = await tx.select({ firstName: patients.firstName, lastName: patients.lastName, archivedAt: patients.archivedAt }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, l.patientId)));
    if (!p || p.archivedAt) return { ok: false, state: "invalid", error: "Der Link ist ungültig." };
    // Behandler:in des Ursprungstermins nur übernehmen, wenn sie weiterhin einen eigenen Kalender hat (aktiv, Inhaber:in/Podolog:in) –
    // sonst ohne Zuordnung anlegen (wie Online-Buchungen), die Praxis ordnet zu
    const therapistId = slot.therapistId && (await isCalendarMember(tx, org, slot.therapistId)) ? slot.therapistId : null;
    const svc = await tx
      .select({ serviceId: appointmentServices.serviceId, quantity: appointmentServices.quantity })
      .from(appointmentServices)
      .where(and(eq(appointmentServices.organizationId, org), eq(appointmentServices.appointmentId, slot.id)));
    const [a] = await tx
      .insert(appointments)
      .values({
        organizationId: org,
        locationId: slot.locationId,
        patientId: l.patientId,
        therapistId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: "planned",
        source: "portal",
        externalId: `waitlist:${l.id}`,
        title: slot.title,
        notes: "Von der Warteliste nachgerückt (Angebot per persönlichem Link angenommen).",
      })
      .returning({ id: appointments.id });
    if (svc.length) await tx.insert(appointmentServices).values(svc.map((s) => ({ organizationId: org, appointmentId: a.id, serviceId: s.serviceId, quantity: s.quantity })));
    await tx.update(patientLinks).set({ usedAt: now }).where(and(eq(patientLinks.organizationId, org), eq(patientLinks.id, l.id)));
    // alle anderen Angebote für diesen Termin widerrufen
    await tx
      .update(patientLinks)
      .set({ revokedAt: now })
      .where(
        and(
          eq(patientLinks.organizationId, org),
          eq(patientLinks.purpose, OFFER_PURPOSE),
          eq(patientLinks.appointmentId, slot.id),
          isNull(patientLinks.usedAt),
          isNull(patientLinks.revokedAt),
        ),
      );
    await tx.update(waitlist).set({ resolvedAt: now }).where(and(eq(waitlist.organizationId, org), eq(waitlist.patientId, l.patientId), isNull(waitlist.resolvedAt)));
    await tx.insert(messages).values({
      organizationId: org,
      patientId: l.patientId,
      channel: "none",
      direction: "inbound",
      subject: "Warteliste: Termin angenommen",
      body: `${p.firstName ?? ""} ${p.lastName}`.trim() + ` hat den freien Termin am ${dateDe(slot.startsAt)} um ${timeDe(slot.startsAt)} Uhr über das Wartelisten-Angebot angenommen. Der Termin ist der Akte zugeordnet (Status „geplant“), der Wartelisten-Eintrag erledigt.`,
      status: "new",
      threadKey: `waitlist:${slot.id}`,
    });
    return { ok: true, appointmentId: a.id, message: `Der Termin am ${dateDe(slot.startsAt)} um ${timeDe(slot.startsAt)} Uhr gehört Ihnen. Wir freuen uns auf Sie! ${practice.name}` };
  });
  await audit({ organizationId: org, action: res.ok ? "waitlist.offer_accept" : "waitlist.offer_reject", entity: "appointment", entityId: res.ok ? res.appointmentId : f.slot.id, meta: res.ok ? { from: f.slot.id } : { state: res.state } });
  return res;
}

// ───────────── Praxis: Warteliste pflegen ─────────────

export async function listWaitlist(auth: AuthContext, patientId?: string) {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const svc = await tx.select({ id: services.id, name: services.name, code: services.code }).from(services).where(eq(services.organizationId, org));
    const rows = await tx
      .select({ id: waitlist.id, patientId: waitlist.patientId, createdAt: waitlist.createdAt, firstName: patients.firstName, lastName: patients.lastName, ...wlCols })
      .from(waitlist)
      .innerJoin(patients, eq(patients.id, waitlist.patientId))
      .where(and(eq(waitlist.organizationId, org), isNull(waitlist.resolvedAt), patientId ? eq(waitlist.patientId, patientId) : undefined))
      .orderBy(asc(waitlist.createdAt));
    return rows.map((r) => {
      const w = wishesOfRow(r, svc);
      return { id: r.id, patientId: r.patientId, createdAt: r.createdAt, firstName: r.firstName, lastName: r.lastName, label: describeWishes(w, svc), note: r.wishes?.trim() && !r.wishes.trim().startsWith("{") ? r.wishes : w.note };
    });
  });
}

export async function addWaitlistEntry(auth: AuthContext, patientId: string, wishes: Partial<WaitlistWishes>) {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(patientId).success) throw new Error("Person nicht gefunden.");
  const id = await withOrg(org, async (tx) => {
    const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId), isNull(patients.archivedAt)));
    if (!p) throw new Error("Person nicht gefunden.");
    const w = normalizeWishes(wishes);
    const [row] = await tx
      .insert(waitlist)
      .values({ organizationId: org, patientId, wishes: null, serviceIds: w.serviceIds, weekdays: w.weekdays, dayparts: w.dayparts, note: w.note })
      .returning({ id: waitlist.id });
    return row.id;
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "waitlist.add", entity: "patient", entityId: patientId });
  return id;
}

export async function resolveWaitlistEntry(auth: AuthContext, id: string) {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(id).success) return;
  const [row] = await withOrg(org, (tx) =>
    tx.update(waitlist).set({ resolvedAt: new Date() }).where(and(eq(waitlist.organizationId, org), eq(waitlist.id, id), isNull(waitlist.resolvedAt))).returning({ patientId: waitlist.patientId }),
  );
  if (row) await audit({ organizationId: org, userId: auth.user.id, action: "waitlist.resolve", entity: "patient", entityId: row.patientId });
}

/** Offene Angebote (für die Praxis), neueste zuerst. */
export async function openOffers(auth: AuthContext, limit = 30) {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({ at: reminderLog.at, status: reminderLog.status, channel: reminderLog.channel, startsAt: appointments.startsAt, firstName: patients.firstName, lastName: patients.lastName })
      .from(reminderLog)
      .innerJoin(appointments, eq(appointments.id, reminderLog.appointmentId))
      .leftJoin(patients, eq(patients.id, reminderLog.patientId))
      .where(and(eq(reminderLog.organizationId, org), eq(reminderLog.kind, OFFER_KIND), gte(appointments.startsAt, new Date())))
      .orderBy(desc(reminderLog.at))
      .limit(limit),
  );
}

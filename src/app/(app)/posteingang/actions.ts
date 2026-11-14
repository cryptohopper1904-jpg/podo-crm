"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { appointments, consents, messages, organizations, patients } from "@/db/schema";
import { redact, restore } from "@/integrations/llm/redact";
import { describeError } from "@/integrations/test-connection";
import type { MessagingProvider } from "@/integrations/types";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { adapterFor, logSync } from "@/server/integrations";
import { KIM_CONNECTION_PROVIDER } from "@/integrations/kim/provider";
import { kimAdapterFor, syncKimInbox } from "@/server/kim";
import { matchPatientByAddress } from "@/server/messages";
import { replyFacts } from "@/server/reply-context";
import { replySuggestionInput } from "@/server/reply-suggestion";
import { aiReplySettings } from "@/lib/ai-replies";
import { onlineRequestMessageAppointmentId } from "@/lib/online-request";

export type InboxState = { error?: string; ok?: string } | undefined;

const CHANNEL_PROVIDER: Partial<Record<string, MessagingProvider>> = { email: "email_imap", whatsapp: "whatsapp", sms: "sms" };

async function loadMessage(org: string, id: string) {
  const [m] = await withOrg(org, (tx) => tx.select().from(messages).where(and(eq(messages.organizationId, org), eq(messages.id, id))));
  return m ?? null;
}

export async function matchPatientAction(_: InboxState, form: FormData): Promise<InboxState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Nachricht nicht gefunden." };
  const m = await loadMessage(org, id.data);
  if (!m) return { error: "Nachricht nicht gefunden." };
  const numRaw = String(form.get("patientNumber") ?? "").trim();
  let patientId: string | null = null;
  if (numRaw) {
    const n = Number(numRaw);
    if (!Number.isInteger(n)) return { error: "Bitte eine Patientennummer eingeben." };
    const [p] = await withOrg(org, (tx) => tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.number, n))));
    if (!p) return { error: `Patientennummer ${n} nicht gefunden.` };
    patientId = p.id;
  } else if (m.channel === "kim") {
    // KIM: Absender ist eine Arztpraxis – nie über die Adresse zuordnen, nur bewusst per Patientennummer
    return { error: "Bitte die Patientennummer angeben oder einen Vorschlag wählen." };
  } else {
    patientId = await matchPatientByAddress(org, m.fromAddress);
    if (!patientId) return { error: "Keine eindeutige Zuordnung über Absender möglich – bitte Patientennummer angeben." };
  }
  // Online-Anfrage (/buchen): den vorgemerkten Termin derselben Praxis gleich mit zuordnen, sofern noch ohne Person –
  // sonst bliebe er „unbestätigt ohne Akte“ und fiele nach 6 Monaten unter die automatische Löschung
  // nur echte Formular-Eingänge (thread_key, ohne external_id, fester Betreff – AppSec I-4)
  const requestAppointmentId = onlineRequestMessageAppointmentId(m);
  const linked = await withOrg(org, async (tx) => {
    await tx.update(messages).set({ patientId }).where(and(eq(messages.organizationId, org), eq(messages.id, m.id)));
    if (!requestAppointmentId || !m.threadKey) return [];
    return tx
      .update(appointments)
      .set({ patientId })
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, requestAppointmentId), eq(appointments.externalId, m.threadKey), isNull(appointments.patientId)))
      .returning({ id: appointments.id });
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "message.match", entity: "message", entityId: m.id, meta: { patientId, ...(linked.length ? { appointmentId: linked[0].id } : {}) } });
  if (linked.length) revalidatePath("/kalender");
  revalidatePath("/posteingang");
  return { ok: "Zugeordnet." };
}

export async function suggestReplyAction(_: InboxState, form: FormData): Promise<InboxState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Nachricht nicht gefunden." };
  const m = await loadMessage(org, id.data);
  if (!m) return { error: "Nachricht nicht gefunden." };
  // KI-Antwortvorschläge nur, wenn die Praxis sie eingeschaltet hat (Einstellungen → Praxis; Standard aus)
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  if (!aiReplySettings(o?.settings).enabled) {
    return { error: "KI-Antwortvorschläge sind ausgeschaltet. Einschalten kann sie die Inhaberin bzw. der Inhaber unter Einstellungen → Praxis." };
  }
  const input = await replySuggestionInput(org, m);
  if ("error" in input) return { error: input.error };
  const { knownNames } = input;
  try {
    const { facts, practiceName } = await replyFacts(org, m.patientId);
    const llm = await adapterFor(org, "llm");
    // Datenminimierung: Namen, Telefonnummern, E-Mails, Datumsangaben vor dem Versand entfernen
    const { text: redacted, map } = redact(input.text, { names: knownNames });
    const raw = await llm.suggestReply(redacted, {
      practiceName,
      tone: "friendly",
      knownNames,
      facts: [...facts, m.channel === "whatsapp" || m.channel === "sms" ? "Kanal ist WhatsApp/SMS: nur Organisatorisches, keine medizinischen Inhalte, kurz halten." : m.channel === "kim" ? "Kanal ist KIM: fachliche Antwort an eine Arztpraxis, sachlich und kollegial." : "Kanal ist E-Mail."],
    });
    const suggestion = restore(raw, map);
    await withOrg(org, (tx) =>
      tx
        .update(messages)
        .set({ aiSuggestion: suggestion, status: m.status === "new" ? "suggested" : m.status })
        .where(and(eq(messages.organizationId, org), eq(messages.id, m.id))),
    );
    await audit({ organizationId: org, userId: auth.user.id, action: "ai.reply_suggestion", entity: "message", entityId: m.id, meta: { mock: llm.isMock } });
  } catch (e) {
    await logSync(org, "llm", { direction: "out", ok: false, message: `Antwortvorschlag: ${describeError(e)}`, entity: "message", entityId: m.id });
    return { error: "KI-Vorschlag fehlgeschlagen (Details im Synchronisationsprotokoll)." };
  }
  revalidatePath("/posteingang");
  return { ok: "Vorschlag erstellt – bitte prüfen und anpassen." };
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const PHONE_RE = /^\+?[0-9 ()/.-]{6,24}$/;
/** Entfernt Steuerzeichen (CR/LF etc.) – Schutz vor Header-Injection. */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

async function hasGrantedConsent(org: string, patientId: string, type: "whatsapp" | "sms_reminders" | "email_reminders") {
  const [c] = await withOrg(org, (tx) =>
    tx
      .select({ granted: consents.granted })
      .from(consents)
      .where(and(eq(consents.organizationId, org), eq(consents.patientId, patientId), eq(consents.type, type)))
      .orderBy(desc(consents.recordedAt))
      .limit(1),
  );
  return c?.granted === true;
}

export async function sendReplyAction(_: InboxState, form: FormData): Promise<InboxState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  const id = z.string().uuid().safeParse(form.get("id"));
  const body = z.string().trim().min(2, "Antwort ist leer.").max(4000).safeParse(form.get("body"));
  if (!id.success) return { error: "Nachricht nicht gefunden." };
  if (!body.success) return { error: body.error.issues[0]?.message };
  const m = await loadMessage(org, id.data);
  if (!m) return { error: "Nachricht nicht gefunden." };
  if (m.status !== "new" && m.status !== "suggested") return { error: "Diese Nachricht wurde bereits beantwortet." };
  if (m.channel === "kim") return sendKimReply(auth, m, body.data);
  const provider = CHANNEL_PROVIDER[m.channel];
  if (!provider) return { error: "Für diesen Kanal ist kein Versand möglich – bitte telefonisch/per Brief antworten und „Erledigt“ wählen." };

  // Empfänger und Betreff prüfen (keine Steuerzeichen, gültiges Format)
  const to = clean(m.fromAddress ?? "");
  if (!to) return { error: "Absenderadresse fehlt." };
  if (m.channel === "email" ? !EMAIL_RE.test(to) : !PHONE_RE.test(to) || to.replace(/\D/g, "").length < 7 || to.replace(/\D/g, "").length > 15) {
    return { error: "Empfängeradresse ist ungültig." };
  }
  const subject = m.subject ? clean(`Re: ${m.subject.replace(/^re:\s*/i, "")}`).slice(0, 200) : undefined;

  // WhatsApp/SMS: nur an zugeordnete Personen; WhatsApp zusätzlich nur mit Einwilligung
  if (m.channel === "whatsapp" || m.channel === "sms") {
    if (!m.patientId) return { error: "Bitte die Nachricht zuerst einer Person zuordnen – Freitext per WhatsApp/SMS nur an bekannte Kontakte." };
    if (m.channel === "whatsapp" && !(await hasGrantedConsent(org, m.patientId, "whatsapp"))) {
      return { error: "Keine WhatsApp-Einwilligung der Person hinterlegt – bitte per Telefon oder E-Mail antworten." };
    }
  }

  // Idempotenz: Nachricht atomar „reservieren“ – nur ein Versand pro Nachricht
  const claimed = await withOrg(org, (tx) =>
    tx
      .update(messages)
      .set({ status: "answered" })
      .where(and(eq(messages.organizationId, org), eq(messages.id, m.id), eq(messages.status, m.status)))
      .returning({ id: messages.id }),
  );
  if (claimed.length === 0) return { error: "Diese Nachricht wurde bereits gesendet." };

  let externalId: string;
  let mock = false;
  try {
    const port = await adapterFor(org, provider);
    mock = port.isMock;
    const res = await port.send({ to, body: body.data, subject });
    externalId = res.externalId;
  } catch (e) {
    // Versand fehlgeschlagen → Reservierung zurücknehmen
    await withOrg(org, (tx) =>
      tx.update(messages).set({ status: m.status }).where(and(eq(messages.organizationId, org), eq(messages.id, m.id), eq(messages.status, "answered"))),
    );
    await logSync(org, provider, { direction: "out", ok: false, message: describeError(e), entity: "message", entityId: m.id });
    return { error: "Versand fehlgeschlagen (Details im Synchronisationsprotokoll)." };
  }
  await withOrg(org, (tx) =>
    tx.insert(messages).values({
      organizationId: org,
      patientId: m.patientId,
      channel: m.channel,
      direction: "outbound",
      fromAddress: m.toAddress,
      toAddress: to,
      subject: subject ?? null,
      body: body.data,
      status: "answered",
      externalId,
      threadKey: m.threadKey ?? to,
    }),
  );
  await logSync(org, provider, { direction: "out", ok: true, message: mock ? "Testmodus – nicht wirklich versendet" : "versendet", entity: "message", entityId: m.id });
  await audit({ organizationId: org, userId: auth.user.id, action: "message.reply", entity: "message", entityId: m.id, meta: { channel: m.channel, mock } });
  revalidatePath("/posteingang");
  return { ok: mock ? "Testmodus: Antwort gespeichert, aber nicht wirklich versendet." : "Antwort versendet." };
}

type Msg = NonNullable<Awaited<ReturnType<typeof loadMessage>>>;

/** Antwort per KIM (nur Text, keine Anhänge) – Versand über das KIM-Clientmodul. */
async function sendKimReply(auth: Awaited<ReturnType<typeof requireAuth>>, m: Msg, text: string): Promise<InboxState> {
  const org = auth.organization.id;
  const to = clean(m.fromAddress ?? "");
  if (!EMAIL_RE.test(to)) return { error: "KIM-Adresse des Absenders ist ungültig." };
  const subject = clean(`Re: ${(m.subject ?? "Ihre Nachricht").replace(/^\[[^\]]*\]\s*/, "").replace(/^re:\s*/i, "")}`).slice(0, 200);
  const adapter = await kimAdapterFor(org).catch(() => null);
  if (!adapter) return { error: "KIM ist nicht eingerichtet (Einstellungen → Schnittstellen)." };
  const claimed = await withOrg(org, (tx) =>
    tx
      .update(messages)
      .set({ status: "answered" })
      .where(and(eq(messages.organizationId, org), eq(messages.id, m.id), eq(messages.status, m.status)))
      .returning({ id: messages.id }),
  );
  if (claimed.length === 0) return { error: "Diese Nachricht wurde bereits gesendet." };
  let externalId: string;
  try {
    externalId = (await adapter.send(to, subject, text, [], { inReplyTo: m.externalId })).messageId;
  } catch (e) {
    await withOrg(org, (tx) =>
      tx.update(messages).set({ status: m.status }).where(and(eq(messages.organizationId, org), eq(messages.id, m.id), eq(messages.status, "answered"))),
    );
    await logSync(org, KIM_CONNECTION_PROVIDER, { direction: "out", ok: false, message: `KIM-Versand: ${describeError(e)}`, entity: "message", entityId: m.id });
    return { error: "KIM-Versand fehlgeschlagen (Details im Synchronisationsprotokoll)." };
  }
  await withOrg(org, (tx) =>
    tx.insert(messages).values({
      organizationId: org,
      patientId: m.patientId,
      channel: "kim",
      direction: "outbound",
      fromAddress: m.toAddress,
      toAddress: to,
      subject,
      body: text,
      status: "answered",
      externalId,
      threadKey: m.threadKey ?? m.externalId ?? to,
    }),
  );
  await logSync(org, KIM_CONNECTION_PROVIDER, { direction: "out", ok: true, message: adapter.isMock ? "KIM Testmodus – nicht wirklich versendet" : "KIM versendet", entity: "message", entityId: m.id });
  await audit({ organizationId: org, userId: auth.user.id, action: "message.reply", entity: "message", entityId: m.id, meta: { channel: "kim", mock: adapter.isMock } });
  revalidatePath("/posteingang");
  return { ok: adapter.isMock ? "KIM-Testmodus: Antwort gespeichert, aber nicht wirklich versendet." : "Antwort per KIM versendet." };
}

/** „KIM abrufen“: neue Nachrichten aus dem KIM-Postfach holen (Dubletten werden übersprungen). */
export async function syncKimAction(_: InboxState, form: FormData): Promise<InboxState> {
  void form;
  const auth = await requireAuth("messages.write");
  const res = await syncKimInbox(auth.organization.id, { userId: auth.user.id });
  if ("error" in res) return { error: res.error };
  revalidatePath("/posteingang");
  const prefix = res.mock ? "Testmodus (Beispielnachrichten): " : "";
  return { ok: `${prefix}${res.fetched} abgerufen, ${res.imported} neu${res.duplicates ? `, ${res.duplicates} bereits vorhanden` : ""}.` };
}

export async function markDoneAction(_: InboxState, form: FormData): Promise<InboxState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Nachricht nicht gefunden." };
  const status = form.get("archive") === "1" ? ("archived" as const) : ("answered" as const);
  await withOrg(org, (tx) => tx.update(messages).set({ status }).where(and(eq(messages.organizationId, org), eq(messages.id, id.data))));
  await audit({ organizationId: org, userId: auth.user.id, action: `message.${status}`, entity: "message", entityId: id.data });
  revalidatePath("/posteingang");
  return { ok: "Erledigt." };
}

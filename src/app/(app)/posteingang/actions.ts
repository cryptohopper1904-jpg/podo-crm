"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { messages, patients } from "@/db/schema";
import type { MessagingProvider } from "@/integrations/types";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { adapterFor, logSync } from "@/server/integrations";
import { matchPatientByAddress } from "@/server/messages";
import { replyFacts } from "@/server/reply-context";

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
    if (!Number.isInteger(n)) return { error: "Bitte eine Kundennummer eingeben." };
    const [p] = await withOrg(org, (tx) => tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.number, n))));
    if (!p) return { error: `Kundennummer ${n} nicht gefunden.` };
    patientId = p.id;
  } else {
    patientId = await matchPatientByAddress(org, m.fromAddress);
    if (!patientId) return { error: "Keine eindeutige Zuordnung über Absender möglich – bitte Kundennummer angeben." };
  }
  await withOrg(org, (tx) => tx.update(messages).set({ patientId }).where(and(eq(messages.organizationId, org), eq(messages.id, m.id))));
  await audit({ organizationId: org, userId: auth.user.id, action: "message.match", entity: "message", entityId: m.id, meta: { patientId } });
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
  let knownNames: string[] = [];
  if (m.patientId) {
    const [p] = await withOrg(org, (tx) => tx.select({ firstName: patients.firstName, lastName: patients.lastName }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, m.patientId!))));
    if (p) knownNames = [[p.firstName, p.lastName].filter(Boolean).join(" "), p.lastName, p.firstName ?? ""].filter(Boolean);
  }
  try {
    const { facts, practiceName } = await replyFacts(org, m.patientId);
    const llm = await adapterFor(org, "llm");
    const suggestion = await llm.suggestReply(m.body, {
      practiceName,
      tone: "friendly",
      knownNames,
      facts: [...facts, m.channel === "whatsapp" || m.channel === "sms" ? "Kanal ist WhatsApp/SMS: nur Organisatorisches, keine medizinischen Inhalte, kurz halten." : "Kanal ist E-Mail."],
    });
    await withOrg(org, (tx) =>
      tx
        .update(messages)
        .set({ aiSuggestion: suggestion, status: m.status === "new" ? "suggested" : m.status })
        .where(and(eq(messages.organizationId, org), eq(messages.id, m.id))),
    );
    await audit({ organizationId: org, userId: auth.user.id, action: "ai.reply_suggestion", entity: "message", entityId: m.id, meta: { mock: llm.isMock } });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "KI-Vorschlag fehlgeschlagen." };
  }
  revalidatePath("/posteingang");
  return { ok: "Vorschlag erstellt – bitte prüfen und anpassen." };
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
  if (!m.fromAddress) return { error: "Absenderadresse fehlt." };
  const provider = CHANNEL_PROVIDER[m.channel];
  if (!provider) return { error: "Für diesen Kanal ist kein Versand möglich – bitte telefonisch/per Brief antworten und „Erledigt“ wählen." };

  let externalId: string;
  let mock = false;
  try {
    const port = await adapterFor(org, provider);
    mock = port.isMock;
    const res = await port.send({ to: m.fromAddress, body: body.data, subject: m.subject ? `Re: ${m.subject.replace(/^re:\s*/i, "")}` : undefined });
    externalId = res.externalId;
  } catch (e) {
    await logSync(org, provider, { direction: "out", ok: false, message: e instanceof Error ? e.message : String(e), entity: "message", entityId: m.id });
    return { error: e instanceof Error ? e.message : "Versand fehlgeschlagen." };
  }
  await withOrg(org, async (tx) => {
    await tx.insert(messages).values({
      organizationId: org,
      patientId: m.patientId,
      channel: m.channel,
      direction: "outbound",
      fromAddress: m.toAddress,
      toAddress: m.fromAddress,
      subject: m.subject ? `Re: ${m.subject.replace(/^re:\s*/i, "")}` : null,
      body: body.data,
      status: "answered",
      externalId,
      threadKey: m.threadKey ?? m.fromAddress,
    });
    await tx.update(messages).set({ status: "answered" }).where(and(eq(messages.organizationId, org), eq(messages.id, m.id)));
  });
  await logSync(org, provider, { direction: "out", ok: true, message: mock ? "Testmodus – nicht wirklich versendet" : "versendet", entity: "message", entityId: m.id });
  await audit({ organizationId: org, userId: auth.user.id, action: "message.reply", entity: "message", entityId: m.id, meta: { channel: m.channel, mock } });
  revalidatePath("/posteingang");
  return { ok: mock ? "Testmodus: Antwort gespeichert, aber nicht wirklich versendet." : "Antwort versendet." };
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

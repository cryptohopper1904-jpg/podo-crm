"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { parseMoney } from "@/lib/format";
import {
  addPayments,
  cancelInvoice,
  createDeposit,
  createInvoice,
  depositInput,
  DuplicateInvoiceError,
  InvoiceError,
  OpenDepositError,
  invoiceInput,
  openReceiptsForPatient,
  paymentInput,
  pushInvoiceToAccounting,
} from "@/server/invoices";
import { createPaymentLink, sendPaymentLink, simulateTestPayment, startTerminalPayment } from "@/server/card-payments";
import { sendInvoiceEmail } from "@/server/invoice-delivery";

export type InvoiceFormState = { error?: string; /** gleicher Beleg am selben Tag – „Trotzdem erstellen“ nötig */ duplicate?: { id: string; number: string | null }; /** Beleg zum Fehler (z. B. offene Anzahlung) */ link?: { id: string; label: string } } | undefined;
export type SimpleState = { error?: string; success?: string } | undefined;

function parseJson(raw: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse(String(raw ?? "[]"));
  } catch {
    return [];
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof InvoiceError) return e.message;
  console.error(e);
  return "Speichern fehlgeschlagen. Bitte erneut versuchen.";
}

export async function createInvoiceAction(_: InvoiceFormState, form: FormData): Promise<InvoiceFormState> {
  const auth = await requireAuth("invoices.write");
  const parsed = invoiceInput.safeParse({
    kind: form.get("kind"),
    patientId: form.get("patientId"),
    billingContactId: form.get("billingContactId"),
    issuedAt: form.get("issuedAt"),
    dueDays: form.get("dueDays") || undefined,
    therapeuticConfirmed: form.get("therapeuticConfirmed") === "on",
    therapeuticSource: form.get("therapeuticSource") === "setting" ? "setting" : "manual",
    notes: form.get("notes"),
    lines: parseJson(form.get("lines")),
    payments: parseJson(form.get("payments")),
    depositIds: parseJson(form.get("depositIds")),
    receiptIds: parseJson(form.get("receiptIds")),
    collectiveYear: form.get("collectiveYear") ?? undefined,
    duplicateAck: form.get("duplicateAck"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  let id: string;
  try {
    id = (await createInvoice(auth, parsed.data)).id;
  } catch (e) {
    if (e instanceof DuplicateInvoiceError) return { error: e.message, duplicate: e.duplicate };
    if (e instanceof OpenDepositError) return { error: e.message, link: { id: e.deposit.id, label: `Anzahlung ${e.deposit.number} öffnen` } };
    return { error: errorMessage(e) };
  }
  revalidatePath("/rechnungen");
  if (parsed.data.patientId) revalidatePath(`/kunden/${parsed.data.patientId}`);
  redirect(`/rechnungen/${id}`);
}

/** Offene (bezahlte, noch nicht angerechnete) Quittungen einer Person im Jahr – für die Sammelrechnung im Formular. */
export async function openReceiptsAction(patientId: string, year: number) {
  const auth = await requireAuth("invoices.write");
  if (typeof patientId !== "string" || typeof year !== "number") return [];
  return openReceiptsForPatient(auth, patientId, year);
}

/** Quittung über eine Anzahlung (wird auf die Sammelrechnung angerechnet) – aus Termin oder Behandlung. */
export async function createDepositAction(_: InvoiceFormState, form: FormData): Promise<InvoiceFormState> {
  const auth = await requireAuth("invoices.write");
  const parsed = depositInput.safeParse({
    patientId: form.get("patientId"),
    appointmentId: form.get("appointmentId"),
    treatmentRecordId: form.get("treatmentRecordId"),
    description: form.get("description"),
    amountCents: parseMoney(String(form.get("amount") ?? "")) ?? 0,
    vatRate: form.get("vatRate") ?? 0,
    method: form.get("method"),
    notes: form.get("notes"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  let id: string;
  try {
    id = (await createDeposit(auth, parsed.data)).id;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/rechnungen");
  revalidatePath(`/kunden/${parsed.data.patientId}`);
  if (parsed.data.appointmentId) revalidatePath(`/kalender/termin/${parsed.data.appointmentId}`);
  redirect(`/rechnungen/${id}`);
}

export async function addPaymentAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  const invoiceId = String(form.get("invoiceId") ?? "");
  const parsed = z.array(paymentInput).min(1, "Bitte eine Zahlung angeben.").safeParse(parseJson(form.get("payments")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  try {
    await addPayments(auth, invoiceId, parsed.data);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath(`/rechnungen/${invoiceId}`);
  revalidatePath("/rechnungen");
  return { success: "Zahlung erfasst." };
}

export async function cancelInvoiceAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  const invoiceId = String(form.get("invoiceId") ?? "");
  const reason = String(form.get("reason") ?? "").trim().slice(0, 300);
  let creditId: string;
  try {
    creditId = (await cancelInvoice(auth, invoiceId, reason)).id;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/rechnungen");
  redirect(`/rechnungen/${creditId}`);
}

export async function pushToLexofficeAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  const invoiceId = String(form.get("invoiceId") ?? "");
  try {
    const r = await pushInvoiceToAccounting(auth, invoiceId);
    return r.ok ? { success: r.message } : { error: r.message };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

export type LinkState = { error?: string; success?: string; url?: string } | undefined;

const invoiceIdOf = (form: FormData) => z.uuid().safeParse(form.get("invoiceId"));

function refresh(id: string) {
  revalidatePath(`/rechnungen/${id}`);
  revalidatePath("/rechnungen");
}

export async function sendInvoiceEmailAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  const id = invoiceIdOf(form);
  if (!id.success) return { error: "Rechnung nicht gefunden." };
  try {
    const r = await sendInvoiceEmail(auth, id.data);
    refresh(id.data);
    return { success: r.mock ? `Testmodus: E-Mail an ${r.to} vorbereitet, aber nicht wirklich versendet.` : `Rechnung an ${r.to} gesendet.` };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

export async function startTerminalAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  const id = invoiceIdOf(form);
  if (!id.success) return { error: "Rechnung nicht gefunden." };
  try {
    const r = await startTerminalPayment(auth, id.data);
    refresh(id.data);
    return {
      success: r.mock
        ? "Testmodus: Terminal-Zahlung vorgemerkt. Mit „Testzahlung simulieren“ als bezahlt buchen."
        : "Betrag wurde an das Terminal gesendet. Die Zahlung wird nach Bestätigung durch SumUp automatisch gebucht.",
    };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

export async function createPaymentLinkAction(_: LinkState, form: FormData): Promise<LinkState> {
  const auth = await requireAuth("invoices.write");
  const id = invoiceIdOf(form);
  if (!id.success) return { error: "Rechnung nicht gefunden." };
  try {
    const r = await createPaymentLink(auth, id.data);
    refresh(id.data);
    return { url: r.url, success: r.mock ? "Testmodus: Link ist nicht echt bezahlbar." : "Zahlungslink erzeugt." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

export async function sendPaymentLinkAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  const id = invoiceIdOf(form);
  const channel = z.enum(["email", "sms", "whatsapp"]).safeParse(form.get("channel"));
  if (!id.success || !channel.success) return { error: "Eingaben prüfen." };
  try {
    const r = await sendPaymentLink(auth, id.data, channel.data);
    return { success: r.mock ? "Testmodus: Nachricht gespeichert, aber nicht wirklich versendet." : "Zahlungslink versendet." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

export async function simulatePaymentAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  const id = invoiceIdOf(form);
  if (!id.success) return { error: "Rechnung nicht gefunden." };
  try {
    const r = await simulateTestPayment(auth, id.data);
    refresh(id.data);
    return r === "gebucht" ? { success: "Testzahlung gebucht." } : { error: `Testzahlung nicht gebucht: ${r}` };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

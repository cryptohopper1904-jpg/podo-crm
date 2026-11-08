"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import {
  addPayments,
  cancelInvoice,
  createInvoice,
  InvoiceError,
  invoiceInput,
  paymentInput,
  pushInvoiceToAccounting,
} from "@/server/invoices";

export type InvoiceFormState = { error?: string } | undefined;
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
    dueDays: form.get("dueDays") || 14,
    therapeuticConfirmed: form.get("therapeuticConfirmed") === "on",
    notes: form.get("notes"),
    lines: parseJson(form.get("lines")),
    payments: parseJson(form.get("payments")),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  let id: string;
  try {
    id = (await createInvoice(auth, parsed.data)).id;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/rechnungen");
  if (parsed.data.patientId) revalidatePath(`/kunden/${parsed.data.patientId}`);
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

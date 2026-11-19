"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { parseMoney } from "@/lib/format";
import { RUECKMELDUNG_MAX_BYTES } from "@/lib/gkv-handover/rueckmeldung";
import { confirmPayoutImport, previewPayoutImport, recordManualPayout, type PayoutPreview } from "@/server/gkv-handover";

export type PreviewState = { error?: string; preview?: PayoutPreview } | undefined;
export type SimpleState = { error?: string; ok?: string } | undefined;

const batchId = z.string().uuid();

/** Datei aus dem Formular – Größe vor dem Einlesen prüfen (Server-Action-Grenze 25 MB, Rückmeldung höchstens 1 MB) */
async function fileFrom(form: FormData): Promise<{ bytes: Buffer; name: string } | { error: string }> {
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return { error: "Bitte eine Rückmeldung (CSV oder JSON) auswählen." };
  if (file.size > RUECKMELDUNG_MAX_BYTES) return { error: `Die Datei ist zu groß (höchstens ${RUECKMELDUNG_MAX_BYTES / 1_048_576} MB).` };
  return { bytes: Buffer.from(await file.arrayBuffer()), name: file.name.slice(0, 200) };
}

/** Rückmeldung prüfen und zuordnen – ändert nichts */
export async function previewPayoutAction(form: FormData): Promise<PreviewState> {
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) return { error: "Keine Berechtigung." };
  const id = batchId.safeParse(form.get("batchId"));
  if (!id.success) return { error: "Ungültige Anfrage." };
  const f = await fileFrom(form);
  if ("error" in f) return f;
  const res = await previewPayoutImport(auth, id.data, f.bytes, f.name);
  return "error" in res ? { error: res.error } : { preview: res };
}

/** Rückmeldung übernehmen (dieselbe Datei wie in der Vorschau – Prüfsumme) */
export async function confirmPayoutAction(form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) return { error: "Keine Berechtigung." };
  const id = batchId.safeParse(form.get("batchId"));
  const sha = z.string().regex(/^[0-9a-f]{64}$/).safeParse(form.get("sha256"));
  if (!id.success || !sha.success) return { error: "Ungültige Anfrage." };
  const f = await fileFrom(form);
  if ("error" in f) return f;
  const res = await confirmPayoutImport(auth, id.data, f.bytes, f.name, sha.data);
  if ("error" in res) return { error: res.error };
  revalidatePath(`/verordnungen/abrechnung/${id.data}`);
  revalidatePath("/verordnungen/absetzungen");
  return { ok: `Rückmeldung übernommen: Auszahlung erfasst, ${res.deductions} Absetzung(en) angelegt${res.skippedDeductions ? `, ${res.skippedDeductions} schon erfasste übersprungen` : ""}.` };
}

/** Auszahlung von Hand */
export async function manualPayoutAction(_: SimpleState, form: FormData): Promise<SimpleState> {
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) return { error: "Keine Berechtigung." };
  const id = batchId.safeParse(form.get("batchId"));
  if (!id.success) return { error: "Ungültige Anfrage." };
  const cents = parseMoney(String(form.get("amount") ?? ""));
  if (cents === null) return { error: "Betrag ungültig." };
  const res = await recordManualPayout(auth, { batchId: id.data, amountCents: cents, paidAt: String(form.get("paidAt") ?? ""), reference: String(form.get("reference") ?? "") });
  if ("error" in res) return { error: res.error };
  revalidatePath(`/verordnungen/abrechnung/${id.data}`);
  return { ok: "Auszahlung erfasst." };
}

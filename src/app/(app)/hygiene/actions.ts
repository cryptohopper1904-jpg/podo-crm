"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/session";
import { parseChecklistLines } from "@/lib/hygiene-rules";
import {
  addDeviceEvent,
  adjustStock,
  batchInput,
  completeChecklistItem,
  createBatch,
  decideBatch,
  deviceEventInput,
  deviceInput,
  materialInput,
  saveChecklist,
  saveDevice,
  saveMaterial,
  undoChecklistItem,
} from "@/server/hygiene";
import { canEditHygiene, canEditMaterials, requireHygiene } from "./access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** leere oder ungültige ID → null (Neuanlage) bzw. Fehler */
const idOf = (form: FormData) => {
  const v = str(form, "id");
  return v === "" ? null : UUID.test(v) ? v : "invalid";
};

export type HygieneState = { error?: string; ok?: string } | undefined;

const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : "";
};
const firstIssue = (e: { issues: { message: string }[] }) => e.issues[0]?.message ?? "Eingaben prüfen.";

// ───────────── Chargen ─────────────

export async function createBatchAction(_: HygieneState, form: FormData): Promise<HygieneState> {
  const auth = await requireHygiene(canEditHygiene);
  const parsed = batchInput.safeParse({
    code: str(form, "code"),
    deviceId: str(form, "deviceId"),
    cycleNo: str(form, "cycleNo"),
    indicatorOk: form.get("indicatorOk") === "on",
    expiresAt: str(form, "expiresAt"),
    note: str(form, "note"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const r = await createBatch(auth, parsed.data);
  if (r.error) return { error: r.error };
  revalidatePath("/hygiene", "layout");
  return { ok: `Charge ${parsed.data.code} angelegt – bitte nach Prozessende freigeben.` };
}

export async function decideBatchAction(_: HygieneState, form: FormData): Promise<HygieneState> {
  const auth = await requireHygiene(canEditHygiene);
  const decision = str(form, "decision");
  if (decision !== "released" && decision !== "rejected") return { error: "Aktion unbekannt." };
  const id = str(form, "id");
  if (!UUID.test(id)) return { error: "Charge nicht gefunden." };
  const r = await decideBatch(auth, id, decision, {
    indicatorConfirmed: form.get("indicatorConfirmed") === "on",
    note: str(form, "note").slice(0, 500) || null,
  });
  if (r.error) return { error: r.error };
  revalidatePath("/hygiene", "layout");
  return { ok: decision === "released" ? "Charge freigegeben." : "Charge gesperrt." };
}

// ───────────── Geräte ─────────────

export async function saveDeviceAction(_: HygieneState, form: FormData): Promise<HygieneState> {
  const auth = await requireHygiene(canEditHygiene);
  const id = idOf(form);
  if (id === "invalid") return { error: "Gerät nicht gefunden." };
  const parsed = deviceInput.safeParse({
    name: str(form, "name"),
    kind: str(form, "kind"),
    manufacturer: str(form, "manufacturer"),
    serialNumber: str(form, "serialNumber"),
    location: str(form, "location"),
    nextMaintenanceAt: str(form, "nextMaintenanceAt"),
    nextValidationAt: str(form, "nextValidationAt"),
    nextElectricalCheckAt: str(form, "nextElectricalCheckAt"),
    active: id ? form.get("active") === "on" : true,
    notes: str(form, "notes"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const r = await saveDevice(auth, id, parsed.data);
  if (r.error) return { error: r.error };
  revalidatePath("/hygiene", "layout");
  if (!id) redirect(`/hygiene/geraete/${r.id}`);
  return { ok: "Gerät gespeichert." };
}

export async function addDeviceEventAction(_: HygieneState, form: FormData): Promise<HygieneState> {
  const auth = await requireHygiene(canEditHygiene);
  const parsed = deviceEventInput.safeParse({
    deviceId: str(form, "deviceId"),
    kind: str(form, "kind"),
    occurredAt: str(form, "occurredAt"),
    performedBy: str(form, "performedBy"),
    note: str(form, "note"),
    nextDueAt: str(form, "nextDueAt"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const r = await addDeviceEvent(auth, parsed.data);
  if (r.error) return { error: r.error };
  revalidatePath("/hygiene", "layout");
  return { ok: "Eintrag im Gerätebuch gespeichert." };
}

// ───────────── Checkliste ─────────────

export async function completeCheckAction(form: FormData) {
  const auth = await requireHygiene(canEditHygiene);
  const interval = str(form, "interval") === "weekly" ? "weekly" : "daily";
  await completeChecklistItem(auth, interval, str(form, "item"));
  revalidatePath("/hygiene");
}

export async function undoCheckAction(form: FormData) {
  const auth = await requireHygiene(canEditHygiene);
  const taskId = str(form, "taskId");
  if (UUID.test(taskId)) await undoChecklistItem(auth, taskId);
  revalidatePath("/hygiene");
}

export async function saveChecklistAction(_: HygieneState, form: FormData): Promise<HygieneState> {
  const auth = await requireAuth("settings.manage");
  const daily = parseChecklistLines(str(form, "daily"));
  const weekly = parseChecklistLines(str(form, "weekly"));
  await saveChecklist(auth, { daily, weekly });
  revalidatePath("/hygiene");
  return { ok: `Checkliste gespeichert (${daily.length} täglich, ${weekly.length} wöchentlich).` };
}

// ───────────── Material ─────────────

export async function saveMaterialAction(_: HygieneState, form: FormData): Promise<HygieneState> {
  const auth = await requireHygiene(canEditMaterials);
  const id = idOf(form);
  if (id === "invalid") return { error: "Material nicht gefunden." };
  const parsed = materialInput.safeParse({
    name: str(form, "name"),
    unit: str(form, "unit") || "Stück",
    stock: str(form, "stock") || "0",
    minStock: str(form, "minStock") || "0",
    supplier: str(form, "supplier"),
    orderUrl: str(form, "orderUrl"),
    active: id ? form.get("active") === "on" : true,
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const r = await saveMaterial(auth, id, parsed.data);
  if (r.error) return { error: r.error };
  revalidatePath("/hygiene/material", "layout");
  if (id) redirect("/hygiene/material");
  return { ok: "Material angelegt." };
}

export async function adjustStockAction(form: FormData) {
  const auth = await requireHygiene(canEditMaterials);
  const delta = Number(str(form, "delta"));
  const id = str(form, "id");
  if (UUID.test(id)) await adjustStock(auth, id, delta);
  revalidatePath("/hygiene/material", "layout");
}

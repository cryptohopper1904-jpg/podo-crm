"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { parseMoney } from "@/lib/format";
import { deactivateStartLocation, saveStartLocation, saveTripSettings, startLocationInput, TripError } from "@/server/trips";

export type FahrtenState = { error?: string; ok?: string } | undefined;
const PATH = "/einstellungen/fahrten";

export async function saveTripSettingsAction(_: FahrtenState, form: FormData): Promise<FahrtenState> {
  const auth = await requireAuth("settings.manage");
  const d = z
    .object({
      vehicleLabel: z.string().trim().max(60).optional(),
      plate: z.string().trim().max(15).optional(),
      rate: z.string().trim().max(10).optional(),
      billing: z.enum(["oneway", "roundtrip"]).default("oneway"),
      returnToStart: z.string().optional(),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben prüfen." };
  let rateCents: number | null = null;
  if (d.data.rate) {
    rateCents = parseMoney(d.data.rate);
    if (rateCents === null || rateCents < 0 || rateCents > 1000) return { error: "km-Satz ungültig (0,00 – 10,00 €)." };
  }
  await saveTripSettings(auth, {
    vehicleLabel: d.data.vehicleLabel || null,
    plate: d.data.plate ? d.data.plate.toUpperCase() : null,
    rateCents,
    billing: d.data.billing,
    returnToStart: d.data.returnToStart === "on",
  });
  revalidatePath(PATH);
  return { ok: "Gespeichert." };
}

export async function saveStartLocationAction(_: FahrtenState, form: FormData): Promise<FahrtenState> {
  const auth = await requireAuth("settings.manage");
  const raw = Object.fromEntries(form);
  const d = startLocationInput.safeParse({ ...raw, isDefault: raw.isDefault === "on" });
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben prüfen." };
  try {
    const r = await saveStartLocation(auth, d.data);
    revalidatePath(PATH);
    return r.geocoded ? { ok: "Startort gespeichert." } : { ok: "Gespeichert – die Adresse wurde aber nicht gefunden (keine Koordinaten). Bitte Schreibweise prüfen." };
  } catch (e) {
    if (e instanceof TripError) return { error: e.message };
    throw e;
  }
}

export async function removeStartLocationAction(form: FormData): Promise<void> {
  const auth = await requireAuth("settings.manage");
  await deactivateStartLocation(auth, String(form.get("id") ?? ""));
  revalidatePath(PATH);
}

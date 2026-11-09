"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { addTripCorrection, correctionInput, startTrip, startTripInput, TripError } from "@/server/trips";

export type TripState = { error?: string; ok?: string } | undefined;

/** "12,4" → 12.4; leer → null; ungültig → NaN */
const dec = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim().replace(/\s/g, "").replace(",", ".") : "";
  return s === "" ? null : Number(s);
};
const int = (v: FormDataEntryValue | null) => {
  const n = dec(v);
  return n === null ? null : Number.isInteger(n) ? n : NaN;
};

export async function startTripAction(_: TripState, form: FormData): Promise<TripState> {
  const auth = await requireAuth("appointments.write");
  const appointmentId = String(form.get("appointmentId") ?? "");
  const startRaw = String(form.get("start") ?? "");
  const odometerStart = int(form.get("odometerStart"));
  if (odometerStart !== null && (!Number.isFinite(odometerStart) || odometerStart < 0)) return { error: "Kilometerstand ungültig." };
  const start =
    startRaw === "here"
      ? { kind: "here", lat: form.get("lat"), lon: form.get("lon") }
      : startRaw === "last"
        ? { kind: "last" }
        : startRaw.startsWith("loc:")
          ? { kind: "location", locationId: startRaw.slice(4) }
          : null;
  const d = startTripInput.safeParse(start);
  if (!d.success || !z.uuid().safeParse(appointmentId).success) return { error: "Bitte einen Startpunkt wählen." };
  try {
    await startTrip(auth, { ...d.data, appointmentId, odometerStart });
  } catch (e) {
    if (e instanceof TripError) return { error: e.message };
    throw e;
  }
  revalidatePath("/touren");
  revalidatePath("/touren/losfahren");
  return { ok: "Fahrt erfasst – gute Fahrt!" };
}

async function correction(kind: "arrival" | "correction" | "void", form: FormData): Promise<TripState> {
  const auth = await requireAuth("appointments.write");
  const km = dec(form.get("km"));
  const odometerStart = int(form.get("odometerStart"));
  const odometerEnd = int(form.get("odometerEnd"));
  const d = correctionInput.safeParse({
    tripId: form.get("tripId"),
    kind,
    km,
    odometerStart,
    odometerEnd,
    purpose: (form.get("purpose") as string | null) || null,
    reason: (form.get("reason") as string | null) || null,
  });
  if (!d.success) return { error: "Eingaben prüfen (km 0–2000, Kilometerstände als ganze Zahl)." };
  if (kind === "correction" && km === null && odometerStart === null && odometerEnd === null && !d.data.purpose) return { error: "Keine Änderung angegeben." };
  try {
    await addTripCorrection(auth, d.data);
  } catch (e) {
    if (e instanceof TripError) return { error: e.message };
    throw e;
  }
  revalidatePath("/touren");
  revalidatePath("/touren/losfahren");
  revalidatePath("/touren/fahrtenbuch");
  return { ok: kind === "arrival" ? "Ankunft gespeichert." : kind === "void" ? "Fahrt storniert (bleibt sichtbar)." : "Korrektur gespeichert." };
}

export async function arriveTripAction(_: TripState, form: FormData): Promise<TripState> {
  await requireAuth("appointments.write");
  return correction("arrival", form);
}

export async function correctTripAction(_: TripState, form: FormData): Promise<TripState> {
  await requireAuth("appointments.write");
  return correction(form.get("void") === "on" ? "void" : "correction", form);
}

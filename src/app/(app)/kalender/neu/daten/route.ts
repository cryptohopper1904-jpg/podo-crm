import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/session";
import { newAppointmentData } from "../data";

/**
 * GET /kalender/neu/daten → Patient:innen (Name, Nummer), Leistungen, Team für das Fenster „Neuer Termin“ im Kalender.
 * Gleiche Rechte wie die Seite /kalender/neu (appointments.write); nicht zwischenspeichern.
 */
export async function GET() {
  const auth = await requireAuth("appointments.write");
  return NextResponse.json(await newAppointmentData(auth), { headers: { "Cache-Control": "private, no-store" } });
}

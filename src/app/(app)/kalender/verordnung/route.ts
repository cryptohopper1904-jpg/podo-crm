import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidIsoDate } from "@/lib/iso-date";
import { requireAuth } from "@/lib/auth/session";
import { seriesStarts } from "@/lib/appointment-series";
import { berlinDateIso } from "@/lib/format";
import { planningForPatient } from "@/server/appointment-prescriptions";

const headers = { "Cache-Control": "private, no-store" };

const query = z.object({
  patient: z.string().uuid(),
  datum: z.string().refine((v) => isValidIsoDate(v), "Datum ungültig"),
  wochen: z.coerce.number().int().min(0).max(26).default(0),
  anzahl: z.coerce.number().int().min(1).max(12).default(1),
  /** gewählte Verordnung; leer = ausdrücklich „ohne Verordnung“, fehlt = Vorschlag */
  vo: z.union([z.string().uuid(), z.literal("")]).optional(),
});

/**
 * GET /kalender/verordnung?patient=<id>&datum=JJJJ-MM-TT[&wochen=n&anzahl=n&vo=<id>]
 * Verordnungen der Person für das Terminformular und Warnungen zur geplanten Serie (Restmenge, Frist, Frequenz).
 * Ohne medizinisches Leserecht ohne Diagnosegruppe. GET statt Server Action: lesend (wie /kalender/belegung).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth("appointments.read");
  const parsed = query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Ungültige Angaben" }, { status: 400, headers });
  const d = parsed.data;
  const dates = seriesStarts(d.datum, "12:00", d.wochen, d.wochen > 0 ? d.anzahl : 1).map((s) => berlinDateIso(s));
  const res = await planningForPatient(auth, { patientId: d.patient, dates, prescriptionId: d.vo });
  return NextResponse.json(res, { headers });
}

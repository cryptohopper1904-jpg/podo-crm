import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidIsoDate } from "@/lib/iso-date";
import { requireAuth } from "@/lib/auth/session";
import { slotStatus } from "@/server/calendar-board";

const headers = { "Cache-Control": "private, no-store" };

const query = z.object({
  behandler: z.string().uuid(),
  datum: z.string().refine((v) => isValidIsoDate(v), "Datum ungültig"),
  zeit: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  dauer: z.coerce.number().int().min(5).max(480),
  ohne: z.string().uuid().optional(),
});

/**
 * GET /kalender/belegung?behandler=<id>&datum=JJJJ-MM-TT&zeit=HH:MM&dauer=<Min>[&ohne=<Termin-ID>]
 * Belegung für das Terminformular („belegt – nicht verfügbar“). Liefert nur Uhrzeiten, keine Namen.
 * GET statt Server Action: lesend, funktioniert damit auch im Nur-Lesen- und Support-Modus.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth("appointments.read");
  const parsed = query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Ungültige Angaben" }, { status: 400, headers });
  const d = parsed.data;
  const status = await slotStatus(auth, { therapistId: d.behandler, dateIso: d.datum, time: d.zeit, durationMin: d.dauer, excludeId: d.ohne });
  if (!status) return NextResponse.json({ error: "Behandler:in nicht gefunden" }, { status: 404, headers });
  return NextResponse.json(status, { headers });
}

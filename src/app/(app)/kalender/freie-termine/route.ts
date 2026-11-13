import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidIsoDate } from "@/lib/iso-date";
import { requireAuth } from "@/lib/auth/session";
import { searchFreeSlots } from "@/server/calendar-board";

const headers = { "Cache-Control": "private, no-store" };

const query = z.object({
  ab: z.string().refine((v) => isValidIsoDate(v), "Datum ungültig"),
  dauer: z.coerce.number().int().min(5).max(480),
  behandler: z.string().uuid().optional(),
});

/**
 * GET /kalender/freie-termine?ab=JJJJ-MM-TT&dauer=<Min>[&behandler=<id>]  → { slots }
 * „Freien Termin finden“: nächste freie Zeiten (ohne behandler = egal welche Behandler:in). Nur Zeiten, keine Namen.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth("appointments.read");
  const parsed = query.safeParse(Object.fromEntries([...req.nextUrl.searchParams].filter(([, v]) => v !== "")));
  if (!parsed.success) return NextResponse.json({ error: "Ungültige Angaben" }, { status: 400, headers });
  const d = parsed.data;
  const slots = await searchFreeSlots(auth, { fromIso: d.ab, durationMin: d.dauer, therapistId: d.behandler ?? null });
  if (!slots) return NextResponse.json({ error: "Behandler:in nicht gefunden" }, { status: 404, headers });
  return NextResponse.json({ slots: slots.map((s) => ({ date: s.dateIso, time: s.time, therapistId: s.therapistId })) }, { headers });
}

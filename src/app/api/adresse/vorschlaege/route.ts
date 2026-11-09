import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { validateQuery, validateZip } from "@/lib/address/photon";
import { addressLimiter, addressProvider, citiesByZip, practiceBias, suggestAddresses } from "@/server/address-suggest";

const headers = { "Cache-Control": "private, no-store" };

/**
 * GET /api/adresse/vorschlaege?q=<Adresstext>[&near=<PLZ/Ort>]  → { suggestions }
 * GET /api/adresse/vorschlaege?plz=<5 Ziffern>                   → { cities }
 * Nur mit Anmeldung. An den Geocoder geht nur der Adresstext (siehe src/server/address-suggest.ts).
 */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401, headers });
  if (addressLimiter.limited(`user:${auth.user.id}`)) {
    return NextResponse.json({ error: "Zu viele Anfragen" }, { status: 429, headers: { ...headers, "Retry-After": "60" } });
  }
  if (addressProvider() === "off") return NextResponse.json({ disabled: true, suggestions: [], cities: [] }, { headers });

  const sp = req.nextUrl.searchParams;
  if (sp.has("plz")) {
    const zip = validateZip(sp.get("plz"));
    if (!zip) return NextResponse.json({ error: "Ungültige PLZ" }, { status: 400, headers });
    return NextResponse.json({ cities: await citiesByZip(zip) }, { headers });
  }
  const q = validateQuery(sp.get("q"));
  if (!q) return NextResponse.json({ error: "Suchtext muss 3–120 Zeichen lang sein" }, { status: 400, headers });
  const nearRaw = validateQuery(sp.get("near"));
  const near = nearRaw && nearRaw.length <= 60 ? nearRaw : null;
  const bias = await practiceBias(auth.organization.id, near);
  return NextResponse.json({ suggestions: await suggestAddresses(q, bias) }, { headers });
}

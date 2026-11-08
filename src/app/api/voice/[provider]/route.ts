import { NextResponse, type NextRequest } from "next/server";
import { describeError } from "@/integrations/test-connection";
import { configuredVoiceVendor, IMPLEMENTED_VOICE_VENDORS, voiceAgentFor } from "@/integrations/voice/voice-agent";
import type { VoiceVendorId } from "@/integrations/types";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/read-body";
import { decryptSecret } from "@/lib/secrets";
import { loadConnection, logSync } from "@/server/integrations";
import { processVoiceEvent } from "@/server/voice";
import { isUuid } from "@/server/webhooks";

/**
 * KI-Telefonagent: POST /api/voice/{vendor}?org={organizationId}   (öffentlich, ohne Sitzung)
 *
 * FAIL CLOSED (wie /api/webhooks):
 *  1. Anbieter muss umgesetzt sein, org muss eine UUID sein, Größe max. 1 MB (Content-Length + gestreamt)
 *  2. Verbindung „KI-Telefonagent“ muss existieren und verbunden sein („Testmodus“ nur außerhalb Produktion),
 *     konfigurierter Anbieter muss zum Pfad passen
 *  3. Echtheit: Vapi `x-vapi-secret` = Geheimnis der Praxis (verschlüsselt gespeichert, zeitkonstanter Vergleich);
 *     Retell `x-retell-signature` = HMAC-SHA256 über den Roh-Body mit dem API-Schlüssel der Praxis;
 *     ohne hinterlegtes Geheimnis wird immer abgelehnt
 *  Minutenkontingent/Tarif: siehe processVoiceEvent → Werkzeuge antworten bei Überschreitung mit Rückrufbitte.
 *  4. Drosselung je IP (Fehlversuche) und je Praxis
 * Fehlerantworten sind generisch (kein Orakel für Praxis-IDs).
 */
const MAX_BODY = 1024 * 1024;
const failLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 30 });
const orgLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

const denied = () => NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });

function secretOf(secretEnc: string | null | undefined, org: string): Record<string, string> {
  if (!secretEnc) return {};
  try {
    return JSON.parse(decryptSecret(secretEnc, org));
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/voice/[provider]">) {
  const { provider } = await ctx.params;
  const ip = clientKey({ ip: clientIpFrom(req.headers.get("x-forwarded-for"), req.headers.get("x-real-ip")), userAgent: req.headers.get("user-agent") });
  if (failLimiter.exceeded(ip)) return NextResponse.json({ error: "Zu viele Anfragen" }, { status: 429 });
  const fail = () => {
    failLimiter.limited(ip);
    return denied();
  };

  const org = req.nextUrl.searchParams.get("org");
  if (!(IMPLEMENTED_VOICE_VENDORS as readonly string[]).includes(provider) || !isUuid(org)) return fail();
  const vendor = provider as VoiceVendorId;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return NextResponse.json({ error: "Zu groß" }, { status: 413 });

  const conn = await loadConnection(org, "voice_agent");
  const active = !!conn && (conn.status === "connected" || (conn.status === "mock" && process.env.NODE_ENV !== "production"));
  if (!conn || !active) return fail();
  if (configuredVoiceVendor(conn.config) !== vendor) return fail();

  let port;
  try {
    port = voiceAgentFor(vendor);
  } catch {
    return fail();
  }

  const rawBody = await readBodyCapped(req, MAX_BODY);
  if (rawBody === null) return NextResponse.json({ error: "Zu groß" }, { status: 413 });
  const headers = Object.fromEntries(req.headers.entries());
  if (!port.verify(headers, secretOf(conn.secretEnc, org), rawBody)) return fail();

  if (orgLimiter.limited(org)) return NextResponse.json({ error: "Zu viele Anfragen" }, { status: 429 });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }

  const event = port.parseEvent(payload);
  try {
    const results = await processVoiceEvent(org, vendor, event);
    if (results) return NextResponse.json(port.formatToolResults(results));
    return NextResponse.json({ ok: true });
  } catch (e) {
    await logSync(org, "voice_agent", { direction: "in", ok: false, message: `Telefonagent: ${describeError(e)}` }).catch(() => undefined);
    return NextResponse.json({ error: "Vorübergehender Fehler" }, { status: 503 });
  }
}

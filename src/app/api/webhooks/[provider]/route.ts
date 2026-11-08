import { after, NextResponse, type NextRequest } from "next/server";
import { describeError } from "@/integrations/test-connection";
import { verifyHmacSignature } from "@/integrations/sumup/sumup";
import type { NormalizedWebhookEvent } from "@/integrations/types";
import {
  handleLexofficeWebhook,
  handleSmsWebhook,
  handleSumupWebhook,
  handleVoiceAgentWebhook,
  handleWhatsAppWebhook,
} from "@/integrations/webhooks";
import { safeEqual } from "@/lib/safe-equal";
import { decryptSecret } from "@/lib/secrets";
import { loadConnection, logSync } from "@/server/integrations";
import { bodyHash, claimWebhookEvent, finishWebhookEvent, isUuid, processSumupEvent, storeInboundMessages } from "@/server/webhooks";

/**
 * Webhook-Eingang: /api/webhooks/{provider}?org={organizationId}[&token=…]
 *
 * FAIL CLOSED:
 *  1. Größe prüfen (Content-Length und gestreamt, max. 512 KB)
 *  2. Verbindung muss existieren und „verbunden“ sein („Testmodus“ nur außerhalb von Produktion)
 *  3. Authentisierung ist Pflicht: SumUp/WhatsApp per HMAC-Signatur, lexoffice/SMS/Telefonagent per
 *     zufälligem Token je Praxis (`?token=`, zeitkonstanter Vergleich)
 *  4. erst danach idempotent speichern; fehlgeschlagene Ereignisse werden bei erneuter Zustellung neu verarbeitet
 *  5. sofort 200, Verarbeitung nach der Antwort (after())
 * Fehlerantworten sind bewusst generisch (kein Orakel für Praxis-IDs).
 */
const PROVIDERS = ["sumup", "lexoffice", "whatsapp", "sms", "voice_agent"] as const;
type WebhookProvider = (typeof PROVIDERS)[number];
const MAX_BODY = 512 * 1024;

const denied = () => NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
const tooLarge = () => NextResponse.json({ error: "Zu groß" }, { status: 413 });

function secretOf(conn: Awaited<ReturnType<typeof loadConnection>>, org: string): Record<string, string> {
  if (!conn?.secretEnc) return {};
  try {
    return JSON.parse(decryptSecret(conn.secretEnc, org));
  } catch {
    return {};
  }
}

function connectionActive(conn: Awaited<ReturnType<typeof loadConnection>>): boolean {
  if (!conn) return false;
  if (conn.status === "connected") return true;
  return conn.status === "mock" && process.env.NODE_ENV !== "production";
}

/** Liest den Body gestreamt und bricht oberhalb von `max` Bytes ab. */
async function readBodyCapped(req: NextRequest, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** WhatsApp-Verifizierung (hub.challenge) */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/webhooks/[provider]">) {
  const { provider } = await ctx.params;
  const org = req.nextUrl.searchParams.get("org");
  if (provider !== "whatsapp" || !isUuid(org)) return denied();
  const conn = await loadConnection(org, "whatsapp");
  if (!connectionActive(conn)) return denied();
  const token = (conn?.config as Record<string, unknown> | undefined)?.verifyToken;
  const sp = req.nextUrl.searchParams;
  if (sp.get("hub.mode") === "subscribe" && typeof token === "string" && safeEqual(sp.get("hub.verify_token"), token)) {
    return new NextResponse(sp.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return denied();
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/webhooks/[provider]">) {
  const { provider: raw } = await ctx.params;
  const org = req.nextUrl.searchParams.get("org");
  if (!PROVIDERS.includes(raw as WebhookProvider) || !isUuid(org)) return denied();
  const provider = raw as WebhookProvider;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return tooLarge();

  const conn = await loadConnection(org, provider);
  if (!connectionActive(conn)) return denied();
  const secret = secretOf(conn, org);

  const rawBody = await readBodyCapped(req, MAX_BODY);
  if (rawBody === null) return tooLarge();
  const headers = Object.fromEntries(req.headers.entries());

  // Authentisierung – ohne hinterlegtes Geheimnis wird immer abgelehnt
  let authorized = false;
  if (provider === "sumup") {
    const header = String((conn?.config as Record<string, unknown> | undefined)?.signatureHeader ?? "x-payload-signature").toLowerCase();
    authorized = !!secret.webhookSecret && verifyHmacSignature(rawBody, headers[header], secret.webhookSecret);
  } else if (provider === "whatsapp") {
    authorized = !!secret.appSecret && verifyHmacSignature(rawBody, headers["x-hub-signature-256"], secret.appSecret);
  } else {
    authorized = safeEqual(req.nextUrl.searchParams.get("token"), secret.webhookToken);
  }
  if (!authorized) return denied();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }

  let normalized: NormalizedWebhookEvent | null = null;
  let externalId = bodyHash(rawBody);
  if (provider === "sumup") {
    normalized = handleSumupWebhook(payload, headers);
    externalId = normalized.externalId;
  } else if (provider === "lexoffice") {
    normalized = handleLexofficeWebhook(payload);
    externalId = normalized.externalId;
  }

  let claim: Awaited<ReturnType<typeof claimWebhookEvent>>;
  try {
    claim = await claimWebhookEvent(provider, org, externalId, payload);
  } catch {
    return NextResponse.json({ error: "Vorübergehender Fehler" }, { status: 503 });
  }
  if (!claim) return NextResponse.json({ ok: true });
  const eventId = claim.id;

  after(async () => {
    try {
      if (provider === "sumup" && normalized) await processSumupEvent(org, normalized);
      else if (provider === "whatsapp") await storeInboundMessages(org, handleWhatsAppWebhook(payload));
      else if (provider === "sms") await storeInboundMessages(org, handleSmsWebhook(payload));
      else if (provider === "voice_agent") handleVoiceAgentWebhook(payload);
      else if (provider === "lexoffice") {
        // TODO: Zahlungsstatus per getPaymentStatus nachladen und Rechnung abgleichen
        await logSync(org, "lexoffice", { direction: "in", ok: true, message: `Ereignis ${normalized?.type ?? "unbekannt"}` });
      }
      await finishWebhookEvent(eventId);
    } catch (e) {
      const detail = describeError(e);
      await finishWebhookEvent(eventId, detail).catch(() => undefined);
      await logSync(org, provider, { direction: "in", ok: false, message: `Webhook-Verarbeitung fehlgeschlagen: ${detail}` }).catch(() => undefined);
    }
  });
  return NextResponse.json({ ok: true });
}

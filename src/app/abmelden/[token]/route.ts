import type { NextRequest } from "next/server";
import { unsubscribeByToken } from "@/server/vertrieb";

/**
 * Abmeldung von Vertriebsmails des Plattform-Betreibers (öffentlich, ohne Sitzung).
 * - GET (Link in der Mail) und POST (RFC 8058 „List-Unsubscribe-Post: List-Unsubscribe=One-Click“) melden sofort ab:
 *   Adresse auf die Sperrliste, Status „abgemeldet“. Lieber einmal zu viel abgemeldet (z. B. durch Link-Scanner)
 *   als eine weitere Werbemail.
 * - Token = HMAC-signierte Lead-ID, keine Kontaktdaten in der URL; die Antwort enthält nie Daten des Eintrags.
 */
export const dynamic = "force-dynamic";

const page = (title: string, text: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>` +
      `<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f7f8;color:#1b1f23;margin:0;padding:48px 16px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e6e8;border-radius:16px;padding:28px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;margin:0}</style>` +
      `</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } },
  );

async function handle(ctx: RouteContext<"/abmelden/[token]">) {
  const { token } = await ctx.params;
  const ok = await unsubscribeByToken(token);
  if (!ok) return page("Link ungültig", "Dieser Abmeldelink ist ungültig. Antworten Sie bitte einfach auf die E-Mail mit „Abmelden“ – wir tragen Sie dann von Hand aus.", 404);
  return page("Sie sind abgemeldet", "Ihre E-Mail-Adresse erhält keine weiteren Nachrichten dieser Art von uns. Vielen Dank für Ihre Rückmeldung.");
}

export async function GET(_req: NextRequest, ctx: RouteContext<"/abmelden/[token]">) {
  return handle(ctx);
}

export async function POST(_req: NextRequest, ctx: RouteContext<"/abmelden/[token]">) {
  return handle(ctx);
}

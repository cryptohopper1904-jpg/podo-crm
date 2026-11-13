import { NextResponse, type NextRequest } from "next/server";
import { requestMeta } from "@/lib/auth/session";
import { PORTAL_COOKIE, portalCookieOptions, signPortalSession } from "@/lib/portal-session";
import { clientKey } from "@/lib/rate-limit";
import { portalFailLimiter, portalLimiter, resolvePortalLink } from "@/server/portal-core";

/**
 * Einstieg über den persönlichen Link /portal/<token>:
 * Token prüfen → kurzlebige, signierte Sitzung als HttpOnly-Cookie (SameSite=Strict, 2 h) → weiter zu /portal
 * (tokenfreie URL). Der Token bleibt bis zum Ablauf gültig, damit der Link erneut geöffnet werden kann.
 *
 * Weiterleitung bewusst per HTML (location.replace + meta refresh) statt HTTP-Redirect: Wird der Link aus
 * einer Mail (fremde Seite) geöffnet, würde ein Browser ein SameSite=Strict-Cookie bei einer HTTP-Weiterleitung
 * in derselben Navigation nicht mitsenden. location.replace entfernt den Token außerdem aus dem Verlauf.
 */
const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${title}</title>${body}`;

export async function GET(_req: NextRequest, ctx: RouteContext<"/portal/[token]">) {
  const { token } = await ctx.params;
  const key = clientKey(await requestMeta());
  if (portalFailLimiter.exceeded(key) || portalLimiter.limited(`open:${key}`)) {
    return new NextResponse(page("Zu viele Aufrufe", "</head><body><p>Zu viele Aufrufe. Bitte versuchen Sie es in einigen Minuten erneut.</p></body></html>"), { status: 429, headers: HEADERS });
  }
  const link = await resolvePortalLink(token);
  if (!link) {
    portalFailLimiter.limited(key);
    return new NextResponse(
      page("Link ungültig", "</head><body><p>Der Link ist ungültig oder abgelaufen. Bitte wenden Sie sich an Ihre Praxis, um einen neuen Link zu erhalten.</p></body></html>"),
      { status: 404, headers: HEADERS },
    );
  }
  const session = signPortalSession(link.id, link.expiresAt);
  const res = new NextResponse(
    page(
      "Patientenportal",
      `<meta http-equiv="refresh" content="0;url=/portal"><script>location.replace("/portal")</script></head><body><p><a href="/portal">Weiter zum Patientenportal</a></p></body></html>`,
    ),
    { status: 200, headers: HEADERS },
  );
  res.cookies.set(PORTAL_COOKIE, session.value, portalCookieOptions(session.expires));
  return res;
}

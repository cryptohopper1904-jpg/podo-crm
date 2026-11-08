/**
 * Name des Sitzungs-Cookies (ohne server-only, damit auch der Proxy ihn nutzen kann).
 *
 * Produktion: `__Host-podo_session` – der Browser akzeptiert ihn nur mit `Secure`, `Path=/` und OHNE
 * `Domain`. Damit kann weder eine Subdomain noch eine unverschlüsselte Verbindung das Cookie setzen
 * oder überschreiben (Cookie-Tossing/Session-Fixation).
 * Entwicklung (http://localhost): `podo_session`. Nur dort werden während der Umstellung beide Namen
 * gelesen; in Produktion zählt ausschließlich der `__Host-`-Name (alte Cookies → neu anmelden).
 */
export const SESSION_COOKIE_SECURE = "__Host-podo_session";
export const SESSION_COOKIE_DEV = "podo_session";

const isProd = (env: string | undefined) => env === "production";

/** Name, unter dem das Cookie gesetzt wird. */
export function sessionCookieName(env: string | undefined = process.env.NODE_ENV): string {
  return isProd(env) ? SESSION_COOKIE_SECURE : SESSION_COOKIE_DEV;
}

/** Namen, die beim Lesen akzeptiert werden (erster Treffer gewinnt). */
export function acceptedSessionCookieNames(env: string | undefined = process.env.NODE_ENV): readonly string[] {
  return isProd(env) ? [SESSION_COOKIE_SECURE] : [SESSION_COOKIE_DEV, SESSION_COOKIE_SECURE];
}

/** Optionen beim Setzen – `__Host-` verlangt secure + path=/ + keine Domain. */
export function sessionCookieOptions(expires: Date, env: string | undefined = process.env.NODE_ENV) {
  return { httpOnly: true, secure: isProd(env), sameSite: "lax" as const, path: "/", expires };
}

/** Liest das Token aus einem Cookie-Speicher (next/headers cookies() oder NextRequest.cookies). */
export function readSessionToken(jar: { get(name: string): { value: string } | undefined }, env: string | undefined = process.env.NODE_ENV): string | null {
  for (const name of acceptedSessionCookieNames(env)) {
    const v = jar.get(name)?.value;
    if (v) return v;
  }
  return null;
}

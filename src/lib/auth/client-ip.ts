/**
 * Client-IP aus X-Forwarded-For – nur so weit, wie wir den Proxys trauen.
 *
 * Jeder Proxy hängt die Adresse SEINES Gegenübers rechts an. Mit TRUSTED_PROXY_HOPS = n (Standard 1:
 * nur Caddy vor der App) ist der n-te Eintrag von rechts die Adresse, die unser äußerster
 * vertrauenswürdiger Proxy gesehen hat. Alles weiter links kann der Client frei erfinden.
 * TRUSTED_PROXY_HOPS = 0: App ohne Proxy direkt erreichbar → Header werden ignoriert (ip = null).
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

export function trustedProxyHops(raw: string | undefined = process.env.TRUSTED_PROXY_HOPS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : DEFAULT_TRUSTED_PROXY_HOPS;
}

export function clientIpFrom(xForwardedFor: string | null | undefined, xRealIp: string | null | undefined, hops: number = trustedProxyHops()): string | null {
  if (hops <= 0) return null;
  const list = (xForwardedFor ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) {
    // Weniger Einträge als Hops (z. B. Caddy überschreibt den Header ohne trusted_proxies): linkester Eintrag –
    // er wurde in jedem Fall von einem unserer Proxys geschrieben.
    const ip = list[Math.max(0, list.length - hops)];
    return ip.slice(0, 64);
  }
  return xRealIp?.trim().slice(0, 64) || null;
}

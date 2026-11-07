/**
 * SSRF-Schutz für frei konfigurierbare Ziele (baseUrl, SMTP/IMAP-Host):
 *  - nur https (bei URLs), keine Zugangsdaten in der URL
 *  - kein localhost, keine IP-Literale aus privaten/Loopback/Link-local/CGNAT/Multicast-Bereichen
 *  - DNS-Auflösung: alle Adressen müssen öffentlich sein
 * Rest-Risiko: DNS-Rebinding zwischen Prüfung und Verbindung (Prüfung erfolgt unmittelbar vor jedem Request).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeTargetError extends Error {
  constructor(message = "Ziel-Adresse ist nicht erlaubt.") {
    super(message);
    this.name = "UnsafeTargetError";
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // gemappte IPv4 in Hex-Form – sicherheitshalber sperren
    const first = parseInt(s.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // Multicast
    if (s.startsWith("64:ff9b:") || s.startsWith("2001:db8:")) return true; // NAT64 / Doku
    return false;
  }
  return true; // keine gültige IP → als unsicher werten
}

const BAD_HOST = /^(localhost|localhost\.localdomain|.*\.localhost|.*\.local|.*\.internal|metadata(\.google\.internal)?)$/i;

/** Formale Prüfung eines Hostnamens (ohne DNS). */
export function assertSafeHostSyntax(host: string): void {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h.length > 253) throw new UnsafeTargetError("Host fehlt oder ist zu lang.");
  if (BAD_HOST.test(h)) throw new UnsafeTargetError("Lokale Hosts sind nicht erlaubt.");
  if (isIP(h)) {
    if (isPrivateIp(h)) throw new UnsafeTargetError("Private oder lokale IP-Adressen sind nicht erlaubt.");
    return;
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) {
    throw new UnsafeTargetError("Ungültiger Hostname.");
  }
}

/** Formale Prüfung einer Basis-URL (ohne DNS). Gibt die normalisierte URL zurück. */
export function assertSafeUrlSyntax(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UnsafeTargetError("Ungültige URL.");
  }
  if (u.protocol !== "https:") throw new UnsafeTargetError("Nur https-Adressen sind erlaubt.");
  if (u.username || u.password) throw new UnsafeTargetError("Zugangsdaten in der URL sind nicht erlaubt.");
  if (u.port && u.port !== "443") throw new UnsafeTargetError("Nur Port 443 ist erlaubt.");
  assertSafeHostSyntax(u.hostname);
  return u;
}

export type Resolver = (host: string) => Promise<{ address: string }[]>;
const defaultResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/** Löst den Host auf und verlangt, dass ALLE Adressen öffentlich sind. */
export async function assertPublicHost(host: string, resolve: Resolver = defaultResolver): Promise<void> {
  assertSafeHostSyntax(host);
  const h = host.replace(/^\[|\]$/g, "");
  if (isIP(h)) return;
  let addrs: { address: string }[];
  try {
    addrs = await resolve(h);
  } catch {
    throw new UnsafeTargetError("Host konnte nicht aufgelöst werden.");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new UnsafeTargetError("Host zeigt auf eine private oder lokale Adresse.");
  }
}

export async function assertPublicUrl(raw: string, resolve?: Resolver): Promise<URL> {
  const u = assertSafeUrlSyntax(raw);
  await assertPublicHost(u.hostname, resolve);
  return u;
}

/** fetch-Wrapper: prüft jedes Ziel vor dem Request und folgt keinen Weiterleitungen. */
export function guardedFetch(inner: (input: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i), resolve?: Resolver) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    await assertPublicUrl(input, resolve);
    return inner(input, { ...init, redirect: "error" });
  };
}

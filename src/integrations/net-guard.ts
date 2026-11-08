/**
 * SSRF-Schutz für frei konfigurierbare Ziele (baseUrl, SMTP/IMAP-Host):
 *  - nur https (bei URLs), keine Zugangsdaten in der URL
 *  - kein localhost, keine IP-Literale aus privaten/Loopback/Link-local/CGNAT/Multicast-Bereichen
 *  - DNS-Auflösung: alle Adressen müssen öffentlich sein
 * Für Socket-Verbindungen (SMTP, KIM) `resolvePublicAddress` nutzen und mit der geprüften IP verbinden.
 * Rest-Risiko bei guardedFetch: DNS-Rebinding zwischen Prüfung und Request.
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

/** IPv6 → 8 Gruppen à 16 Bit (inkl. „::“-Kürzung, eingebetteter IPv4 und Zonen-ID); null bei ungültiger Form. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (isIP(v4[2]) !== 4) return null;
    const n = ipv4ToInt(v4[2]);
    s = `${v4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

export function isPrivateIp(ip: string): boolean {
  const raw = ip.replace(/^\[|\]$/g, "");
  const v = isIP(raw.split("%")[0]);
  if (v === 4) {
    const n = ipv4ToInt(raw);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (v === 6) {
    const g = ipv6Groups(raw);
    if (!g) return true;
    const embeddedV4 = () => `${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`;
    if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: und ::1
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateIp(embeddedV4()); // ::ffff:a.b.c.d
    if (g.slice(0, 6).every((x) => x === 0)) return true; // veraltete IPv4-kompatible Adressen ::a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96 (und /48 lokal)
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // Dokumentation
    if (g[0] === 0x2002) return isPrivateIp(embeddedV4From6to4(g)); // 6to4 → eingebettete IPv4
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (veraltet)
    if ((g[0] & 0xff00) === 0xff00) return true; // Multicast
    return false;
  }
  return true; // keine gültige IP → als unsicher werten
}

const embeddedV4From6to4 = (g: number[]) => `${g[1] >>> 8}.${g[1] & 0xff}.${g[2] >>> 8}.${g[2] & 0xff}`;

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

/**
 * Löst den Host EINMAL auf, verlangt, dass ALLE Adressen öffentlich sind, und gibt eine geprüfte Adresse
 * zurück. Verbindungen sollen genau mit dieser IP aufgebaut werden (kein DNS-Rebinding zwischen Prüfung
 * und Verbindung); TLS-SNI/Zertifikatsprüfung weiterhin gegen den Hostnamen.
 * IP-Literale werden ebenfalls geprüft (privat/Loopback/Link-local/Metadaten → abgelehnt).
 */
export async function resolvePublicAddress(host: string, resolve: Resolver = defaultResolver): Promise<string> {
  assertSafeHostSyntax(host);
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (isIP(h)) {
    if (isPrivateIp(h)) throw new UnsafeTargetError("Private oder lokale IP-Adressen sind nicht erlaubt.");
    return h;
  }
  let addrs: { address: string }[];
  try {
    addrs = await resolve(h);
  } catch {
    throw new UnsafeTargetError("Host konnte nicht aufgelöst werden.");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new UnsafeTargetError("Host zeigt auf eine private oder lokale Adresse.");
  }
  return addrs[0].address;
}

/** Löst den Host auf und verlangt, dass ALLE Adressen öffentlich sind. */
export async function assertPublicHost(host: string, resolve: Resolver = defaultResolver): Promise<void> {
  await resolvePublicAddress(host, resolve);
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

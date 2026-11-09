import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

/**
 * Zugangsdaten der Demo-Praxis (scripts/seed-demo.ts) – Gesamt-Review K1.
 *
 * Das bekannte Passwort `demo-passwort-123` gibt es nur noch für lokale bzw. IP-Installationen (Entwicklung,
 * E2E-Tests, Testserver ohne Domain). Läuft die Instanz unter einer echten Domain (PUBLIC_URL), wird ohne
 * ausdrückliches SEED_DEMO_PASSWORD ein zufälliges Passwort erzeugt und nur einmal ins migrate-Log geschrieben.
 * Bewusst ohne DB-/Next-Abhängigkeiten (läuft im migrate-Container, siehe deploy/Dockerfile.migrate).
 */
export const DEMO_EMAIL = "demo@podocrm.local";
export const WELL_KNOWN_DEMO_PASSWORD = "demo-passwort-123";
export const MIN_DEMO_PASSWORD_LENGTH = 12;

/** true, wenn PUBLIC_URL auf eine öffentliche Domain zeigt (nicht localhost, *.local/*.localhost, IP-Adresse). */
export function isPublicDomain(publicUrl: string | undefined | null): boolean {
  const raw = publicUrl?.trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || isIP(host)) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  return host.includes(".");
}

export type DemoPassword = { password: string; source: "env" | "generated" | "well-known" };

export function resolveDemoPassword(env: Record<string, string | undefined>, random: () => string = () => randomBytes(18).toString("base64url")): DemoPassword {
  const given = env.SEED_DEMO_PASSWORD?.trim();
  if (given) {
    if (given.length < MIN_DEMO_PASSWORD_LENGTH) throw new Error(`SEED_DEMO_PASSWORD ist zu kurz (mindestens ${MIN_DEMO_PASSWORD_LENGTH} Zeichen).`);
    if (given === WELL_KNOWN_DEMO_PASSWORD && isPublicDomain(env.PUBLIC_URL)) throw new Error("SEED_DEMO_PASSWORD darf auf einer öffentlichen Domain nicht das bekannte Demo-Passwort sein.");
    return { password: given, source: "env" };
  }
  if (isPublicDomain(env.PUBLIC_URL)) return { password: random(), source: "generated" };
  return { password: WELL_KNOWN_DEMO_PASSWORD, source: "well-known" };
}

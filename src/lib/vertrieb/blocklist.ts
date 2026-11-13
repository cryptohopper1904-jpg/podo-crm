/**
 * Sperrliste des Vertriebs (Abmeldungen/Widersprüche) als nicht umkehrbarer Prüfwert: HMAC-SHA256 mit einem aus
 * APP_ENCRYPTION_KEY abgeleiteten Schlüssel (eigener Zweck). Gespeichert wird nur der Prüfwert – ein Abgleich ist
 * möglich („ist diese Adresse/Website/Praxis gesperrt?“), eine Liste der Adressen nicht.
 *
 * Arten (kind): email (kleingeschriebene Adresse), host (Website-Host ohne www.), namezip (Praxisname + PLZ) – damit
 * dieselbe Praxis nach einer Abmeldung nicht mit anderer Adresse wieder als Lead entsteht.
 *
 * Schlüsselversion „v1:“. Rotation NUR per Schlüsselbund: alle Versionen vorhalten, neue Einträge mit neuer Version
 * schreiben, beim Abgleich je Adresse jede Version prüfen (DB-CHECK auf ^v[0-9]+:). Ein einfacher Tausch von
 * APP_ENCRYPTION_KEY macht die Sperrliste wirkungslos – der Kanarienwert (blocklistKeyCheck) erkennt das.
 */
import { createHmac } from "node:crypto";
import { loadKey } from "../crypto";
import { nameZipKey } from "./csv";
import { websiteHostKey } from "./lead-search";

export const BLOCK_KINDS = ["email", "host", "namezip"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

const derive = (key: Buffer) => createHmac("sha256", key).update("podo:vertrieb:sperrliste:v1").digest();
const mac = (input: string, key: Buffer) => `v1:${createHmac("sha256", derive(key)).update(input).digest("hex")}`;

export const normalizeBlockEmail = (email: string) => email.trim().toLowerCase();

/** Prüfwert „v1:<64 hex>“ einer E-Mail-Adresse */
export function blocklistHash(email: string, key: Buffer = loadKey()): string {
  return mac(normalizeBlockEmail(email), key);
}

/** Prüfwert für Website-Host bzw. Name+PLZ (eigener Präfix, damit sich die Arten nie überschneiden) */
export function blockHash(kind: BlockKind, value: string, key: Buffer = loadKey()): string {
  if (kind === "email") return blocklistHash(value, key);
  return mac(`${kind}:${value}`, key);
}

/** Alle Prüfwerte, die eine Praxis nach Abmeldung sperren: Adresse, Website-Host, Name+PLZ (soweit vorhanden). */
export function blockEntriesForLead(l: { email: string | null; website: string | null; name: string; zip: string | null }, key: Buffer = loadKey()): { kind: BlockKind; hash: string }[] {
  const out: { kind: BlockKind; hash: string }[] = [];
  if (l.email?.trim()) out.push({ kind: "email", hash: blocklistHash(l.email, key) });
  const host = websiteHostKey(l.website);
  if (host) out.push({ kind: "host", hash: blockHash("host", host, key) });
  if (l.name.trim() && l.zip?.trim()) out.push({ kind: "namezip", hash: blockHash("namezip", nameZipKey(l.name, l.zip), key) });
  return out;
}

export type BlockMatcher = { has(email: string): boolean; hasHost(website: string | null | undefined): boolean; hasNameZip(name: string, zip: string | null | undefined): boolean };

/** Abgleich über eine Menge von Prüfwerten (alle Arten) */
export function hashedEmailSet(hashes: Iterable<string>, key: Buffer = loadKey()): BlockMatcher {
  const set = new Set(hashes);
  return {
    has: (email: string) => set.has(blocklistHash(email, key)),
    hasHost: (website) => {
      const h = websiteHostKey(website ?? null);
      return !!h && set.has(blockHash("host", h, key));
    },
    hasNameZip: (name, zip) => !!zip?.trim() && set.has(blockHash("namezip", nameZipKey(name, zip), key)),
  };
}

/** Kanarienwert: passt der gespeicherte Wert nicht zum aktuellen Schlüssel, ist die Sperrliste wirkungslos. */
export function blocklistKeyCheck(key: Buffer = loadKey()): string {
  return mac("podo:check", key);
}

export const BLOCKLIST_KEY_MISMATCH = "Sperrlisten-Schlüssel passt nicht – Versand gesperrt (siehe BETRIEB.md).";

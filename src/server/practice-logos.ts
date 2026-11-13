import "server-only";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { withOrg } from "@/db";
import { organizationLogos } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { imageSize, imageStructureOk } from "@/lib/image-size";
import { discardStored, readDecrypted, sniffMime, storeEncrypted } from "@/lib/storage";
import { assertCan } from "./authz";

/**
 * Praxis-Logos (Einstellungen → Praxisdaten):
 *  - „compact“ (Zeichen): dezent auf Anamnese-/Doku-Bögen und Quittungen
 *  - „full“ (vollständig): Rechnungskopf und E-Mails an Patient:innen
 * Nur PNG/JPEG (für pdf-lib), höchstens 1 MB, verschlüsselt in der Ablage. Ändern nur mit settings.manage (Audit).
 */
export const LOGO_KINDS = ["compact", "full"] as const;
export type LogoKind = (typeof LOGO_KINDS)[number];
export const LOGO_MAX_BYTES = 1024 * 1024;
const LOGO_MIME = new Set(["image/png", "image/jpeg"]);
/** Für Druck reichen ~300 dpi bei 8 cm; größere Bilder belasten jedes PDF und jede Mail */
const MAX_SIDE = 2000;

export const LOGO_LABEL: Record<LogoKind, string> = { compact: "Logo kompakt (Zeichen)", full: "Logo vollständig" };

export class LogoError extends Error {}

export type LogoImage = { bytes: Uint8Array; mime: string; width: number; height: number };

/** Prüft eine Logo-Datei (Typ anhand der Bytes, Größe, Maße, lässt sich in ein PDF einbetten). */
export async function validateLogo(buf: Buffer): Promise<{ mime: string; width: number; height: number }> {
  if (!buf.length) throw new LogoError("Bitte eine Bilddatei auswählen.");
  if (buf.length > LOGO_MAX_BYTES) throw new LogoError("Das Logo ist zu groß (höchstens 1 MB).");
  const mime = sniffMime(buf);
  if (!mime || !LOGO_MIME.has(mime)) throw new LogoError("Bitte ein PNG- oder JPEG-Bild hochladen (SVG bitte vorher als PNG speichern).");
  // Vor pdf-lib: abgeschnittene/beschädigte Dateien abweisen (pdf-lib hängt sonst bei kaputten PNGs)
  if (!imageStructureOk(buf, mime)) throw new LogoError("Das Bild lässt sich nicht lesen (Datei unvollständig oder beschädigt).");
  const size = imageSize(buf, mime);
  if (!size || size.width > MAX_SIDE || size.height > MAX_SIDE) throw new LogoError("Das Bild lässt sich nicht lesen oder ist zu groß (max. 2000 × 2000 Pixel – bitte verkleinern).");
  try {
    const doc = await PDFDocument.create();
    if (mime === "image/png") await doc.embedPng(buf);
    else await doc.embedJpg(buf);
  } catch {
    throw new LogoError("Das Bild lässt sich nicht für Belege verwenden. Bitte als normales PNG oder JPEG speichern.");
  }
  return { mime, ...size };
}

export async function uploadLogo(auth: AuthContext, kind: LogoKind, buf: Buffer) {
  assertCan(auth, "settings.manage");
  if (!LOGO_KINDS.includes(kind)) throw new LogoError("Unbekannte Logo-Art.");
  const org = auth.organization.id;
  const info = await validateLogo(buf);
  const stored = await storeEncrypted(org, buf);
  let previous: string | null = null;
  try {
    previous = await withOrg(org, async (tx) => {
      const [old] = await tx
        .delete(organizationLogos)
        .where(and(eq(organizationLogos.organizationId, org), eq(organizationLogos.kind, kind)))
        .returning({ storageKey: organizationLogos.storageKey });
      await tx.insert(organizationLogos).values({
        organizationId: org,
        kind,
        storageKey: stored.storageKey,
        mime: info.mime,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        width: info.width,
        height: info.height,
        uploadedBy: auth.user.id,
      });
      return old?.storageKey ?? null;
    });
  } catch (e) {
    await discardStored(stored.storageKey).catch(() => {});
    throw e;
  }
  // altes Logo erst nach erfolgreichem Speichern entfernen (kein Gesundheitsdatum, keine Aufbewahrungspflicht)
  if (previous) await discardStored(previous).catch(() => {});
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.logo_upload", entity: "organization", entityId: org, meta: { kind, mime: info.mime, sizeBytes: stored.sizeBytes, width: info.width, height: info.height, sha256: stored.sha256 } });
}

export async function removeLogo(auth: AuthContext, kind: LogoKind) {
  assertCan(auth, "settings.manage");
  if (!LOGO_KINDS.includes(kind)) throw new LogoError("Unbekannte Logo-Art.");
  const org = auth.organization.id;
  const [old] = await withOrg(org, (tx) =>
    tx.delete(organizationLogos).where(and(eq(organizationLogos.organizationId, org), eq(organizationLogos.kind, kind))).returning({ storageKey: organizationLogos.storageKey }),
  );
  if (!old) return false;
  await discardStored(old.storageKey).catch(() => {});
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.logo_remove", entity: "organization", entityId: org, meta: { kind } });
  return true;
}

/** Metadaten beider Logos (Vorschau in den Einstellungen). */
export async function logoInfo(org: string) {
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ kind: organizationLogos.kind, mime: organizationLogos.mime, sizeBytes: organizationLogos.sizeBytes, width: organizationLogos.width, height: organizationLogos.height, createdAt: organizationLogos.createdAt, sha256: organizationLogos.sha256 })
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, org)),
  );
  return Object.fromEntries(rows.map((r) => [r.kind, r])) as Partial<Record<LogoKind, (typeof rows)[number]>>;
}

/**
 * Logo-Datei einer Praxis (entschlüsselt) oder null. Mit `fallback` wird bei fehlendem Logo die andere Art
 * genommen. Lesefehler (z. B. Datei fehlt) führen nie zum Abbruch eines Belegs – dann ohne Logo.
 */
export async function loadLogo(org: string, kind: LogoKind, opts: { fallback?: boolean } = {}): Promise<LogoImage | null> {
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ kind: organizationLogos.kind, storageKey: organizationLogos.storageKey, mime: organizationLogos.mime, width: organizationLogos.width, height: organizationLogos.height })
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, org)),
  );
  const row = rows.find((r) => r.kind === kind) ?? (opts.fallback ? rows.find((r) => r.kind !== kind) : undefined);
  if (!row) return null;
  try {
    const bytes = await readDecrypted(row.storageKey);
    return { bytes: new Uint8Array(bytes), mime: row.mime, width: row.width, height: row.height };
  } catch {
    return null;
  }
}

/** Beide Logos für einen Beleg (ohne Rückfall – das PDF entscheidet selbst). */
export async function loadLogos(org: string): Promise<{ full: LogoImage | null; compact: LogoImage | null }> {
  const [full, compact] = await Promise.all([loadLogo(org, "full"), loadLogo(org, "compact")]);
  return { full, compact };
}

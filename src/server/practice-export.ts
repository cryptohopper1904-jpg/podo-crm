import "server-only";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { withOrg } from "@/db";
import { media, memberships, organizations, users } from "@/db/schema";
import { mediaPath, stripRow, tenantTables, toJson } from "@/lib/practice-export";
import { readDecrypted } from "@/lib/storage";

type Row = Record<string, unknown>;

export type PracticeExport = {
  stream: ReadableStream<Uint8Array>;
  counts: Record<string, number>;
  mediaFiles: number;
  mediaErrors: number;
};

/**
 * Vollständiger Export einer Praxis als ZIP:
 * - tables/<tabelle>.json für jede Mandanten-Tabelle (über withOrg → RLS), ohne Geheimnisse
 * - tables/organizations.json, tables/users.json (nur Mitglieder, ohne Passwort-Hash/2FA)
 * - media/<Kundennummer>/<Datei> entschlüsselt
 * - README.txt mit Erläuterungen und Aufbewahrungshinweis
 */
export async function buildPracticeExport(opts: { organizationId: string; exportedBy: { name: string; email: string } }): Promise<PracticeExport> {
  const org = opts.organizationId;
  const tables = tenantTables();

  const data = await withOrg(org, async (tx) => {
    const out: Record<string, Row[]> = {};
    for (const t of tables) {
      const orgCol = (t.table as unknown as Record<string, PgColumn>).organizationId;
      const rows = (await tx
        .select()
        .from(t.table as PgTable)
        .where(eq(orgCol, org))) as Row[];
      out[t.name] = rows.map((r) => stripRow(r, t.strippedKeys) as Row);
    }
    const [orgRow] = await tx.select().from(organizations).where(eq(organizations.id, org));
    const memberIds = (await tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.organizationId, org))).map((m) => m.userId);
    out.users = memberIds.length
      ? await tx
          .select({ id: users.id, email: users.email, name: users.name, totpEnabled: users.totpEnabled, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
          .from(users)
          .where(inArray(users.id, memberIds))
      : [];
    // Speicherpfade der Medien werden nur intern gebraucht (nicht exportiert)
    const mediaKeys = new Map<string, string>();
    for (const m of await tx.select({ id: media.id, storageKey: media.storageKey }).from(media).where(eq(media.organizationId, org))) mediaKeys.set(m.id, m.storageKey);
    return { tables: out, org: orgRow, mediaKeys };
  });

  const zip = new JSZip();
  const patientNumbers = new Map<string, number>();
  for (const p of data.tables.patients ?? []) patientNumbers.set(p.id as string, p.number as number);

  // Medien entschlüsseln (nacheinander, um den Speicher zu schonen)
  let mediaFiles = 0;
  const mediaErrors: string[] = [];
  const mediaRows = data.tables.media ?? [];
  for (const m of mediaRows) {
    const key = data.mediaKeys.get(m.id as string);
    const file = mediaPath(
      { id: m.id as string, mime: m.mime as string, purpose: String(m.purpose), takenAt: m.takenAt as Date },
      patientNumbers.get(m.patientId as string),
    );
    if (!key) continue;
    try {
      const buf = await readDecrypted(key);
      // Bilder/Audio sind bereits komprimiert
      zip.file(file, buf, { compression: m.mime === "application/pdf" ? "DEFLATE" : "STORE", date: new Date(m.takenAt as Date) });
      m.exportFile = file;
      mediaFiles++;
    } catch {
      m.exportFile = null;
      m.exportError = "Datei konnte nicht gelesen/entschlüsselt werden";
      mediaErrors.push(m.id as string);
    }
  }

  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(data.tables)) {
    counts[name] = rows.length;
    zip.file(`tables/${name}.json`, toJson(rows));
  }
  zip.file("tables/organizations.json", toJson(data.org ? [data.org] : []));
  zip.file("README.txt", readme({ orgName: data.org?.name ?? "", exportedBy: opts.exportedBy, counts, mediaFiles, mediaErrors }));

  const node = zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 } });
  const stream = Readable.toWeb(new Readable().wrap(node)) as ReadableStream<Uint8Array>;
  return { stream, counts, mediaFiles, mediaErrors: mediaErrors.length };
}

function readme(p: { orgName: string; exportedBy: { name: string; email: string }; counts: Record<string, number>; mediaFiles: number; mediaErrors: string[] }) {
  const lines = [
    "PodoCRM – Vollständiger Datenexport",
    "===================================",
    "",
    `Praxis:        ${p.orgName}`,
    `Erstellt am:   ${new Date().toISOString()}`,
    `Erstellt von:  ${p.exportedBy.name} <${p.exportedBy.email}>`,
    "",
    "INHALT",
    "------",
    "tables/<tabelle>.json  Alle Datensätze der Praxis je Tabelle (JSON, UTF-8). Datumswerte im ISO-Format (UTC).",
    "                       Geldbeträge in Cent. Verknüpfungen über die Spalten *_id.",
    "tables/users.json      Mitglieder der Praxis (ohne Passwort und 2FA-Geheimnis).",
    "media/<Kundennummer>/  Fotos, Audio und Dokumente – entschlüsselt. Zuordnung über tables/media.json (Feld exportFile).",
    "                       Die Prüfsumme (sha256) in tables/media.json belegt die Unversehrtheit der Datei.",
    "",
    "Nicht enthalten: Passwort-Hashes, 2FA-Geheimnisse, Zugangsdaten zu Schnittstellen, Sitzungen, interne Speicherpfade.",
    "",
    "ANZAHL DATENSÄTZE",
    "-----------------",
    ...Object.entries(p.counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k.padEnd(28)} ${v}`),
    `${"Mediendateien".padEnd(28)} ${p.mediaFiles}`,
    ...(p.mediaErrors.length ? ["", `ACHTUNG: ${p.mediaErrors.length} Datei(en) konnten nicht gelesen werden (IDs in tables/media.json, Feld exportError).`] : []),
    "",
    "AUFBEWAHRUNG – BITTE BEACHTEN",
    "-----------------------------",
    "Dieser Export enthält Gesundheitsdaten (Art. 9 DSGVO) und unterliegt der Schweigepflicht (§ 203 StGB).",
    "Bewahren Sie ihn verschlüsselt und zugriffsgeschützt auf.",
    "",
    "Gesetzliche Aufbewahrungsfristen gelten für die Praxis weiter, auch nach einer Kündigung:",
    "- Behandlungsdokumentation: 10 Jahre nach Abschluss der Behandlung (§ 630f Abs. 3 BGB)",
    "- Rechnungen und Buchungsbelege: 8 Jahre, Bücher und Jahresabschlüsse: 10 Jahre (§ 147 AO, § 14b UStG)",
    "Nach der Löschung der Praxis in PodoCRM ist dieser Export Ihre einzige Kopie.",
    "",
  ];
  return lines.join("\n");
}

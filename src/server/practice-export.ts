import "server-only";
import { Readable } from "node:stream";
import archiver from "archiver";
import { and, asc, eq, gt, inArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { withOrg } from "@/db";
import { documentArchive, media, memberships, organizations, patients, users } from "@/db/schema";
import { mediaPath, sanitizeOrganizationRow, stripRow, tenantTables } from "@/lib/practice-export";
import { readDecryptedStream, verifyStored } from "@/lib/storage";
import { readArchivedPdf } from "./document-archive";
import { catchUpArchives, missingArchives } from "./archive-catchup";
import { log } from "@/lib/log";

/** Nachholen fehlender Archiv-PDFs vor dem Export: höchstens so viele je Art */
const EXPORT_CATCHUP_LIMIT = 200;

type Row = Record<string, unknown>;

export type ExportSummary = {
  counts: Record<string, number>;
  mediaFiles: number;
  mediaErrors: number;
  /** archivierte Beleg-PDFs im ZIP (belege/…) */
  archiveFiles: number;
  archiveErrors: number;
};

export type PracticeExport = {
  stream: ReadableStream<Uint8Array>;
  /** erfüllt, sobald das ZIP vollständig geschrieben ist (Zahlen erst dann bekannt); abgelehnt bei Abbruch/Fehler */
  done: Promise<ExportSummary>;
};

export type ExportOptions = {
  organizationId: string;
  exportedBy: { name: string; email: string };
  /** Zeilen je Datenbankabfrage (Standard 2.000) */
  pageSize?: number;
  /** Medien-Metadaten je Abfrage (Standard 200) */
  mediaPageSize?: number;
};

/** JSON wie JSON.stringify(rows, …, 2), aber zeilenweise erzeugt (Datumswerte ISO, BigInt als String). */
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const jsonElement = (row: unknown) => "  " + JSON.stringify(row, replacer, 2).split("\n").join("\n  ");

/**
 * Vollständiger Export einer Praxis als ZIP – STREAMEND, Speicherbedarf unabhängig von der Praxisgröße:
 * - tables/<tabelle>.json für jede Mandanten-Tabelle (über withOrg → RLS), ohne Geheimnisse,
 *   seitenweise gelesen (Keyset über id, je Seite eine kurze Transaktion) und als JSON-Array geschrieben
 * - tables/organizations.json, tables/users.json (nur Mitglieder, ohne Passwort-Hash/2FA)
 * - media/<Patientennummer>/<Datei> entschlüsselt – eine Datei nach der anderen, als Stream; jede Datei wird
 *   vorab auf Echtheit (GCM) geprüft, damit eine defekte Datei nicht den ganzen Export abbricht
 * - README.txt mit Erläuterungen und Aufbewahrungshinweis (am Ende, mit den Zahlen)
 * Aufbau und Dateinamen sind identisch mit dem bisherigen (JSZip-)Export. ZIP64 bei > 4 GB automatisch.
 * Im Speicher bleiben nur: eine Tabellenseite, ein Datei-Block und die IDs fehlerhafter Medien.
 */
export async function buildPracticeExport(opts: ExportOptions): Promise<PracticeExport> {
  const org = opts.organizationId;
  const pageSize = opts.pageSize ?? 2_000;
  const mediaPageSize = opts.mediaPageSize ?? 200;
  const archive = archiver("zip", { zlib: { level: 6 } });
  const out = new Readable().wrap(archive);

  let closed = false;
  let finished = false;
  let failure: Error | null = null;
  const waiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();
  const fail = (e: Error) => {
    failure ??= e;
    for (const w of waiters) w.reject(failure);
    waiters.clear();
  };
  archive.on("entry", () => {
    for (const w of waiters) w.resolve();
    waiters.clear();
  });
  archive.on("error", (e) => fail(e));
  archive.on("warning", (e) => fail(e));
  // Download abgebrochen (Client weg) → Erzeugung beenden
  out.on("close", () => {
    closed = true;
    if (!finished) {
      fail(new Error("Export abgebrochen"));
      archive.abort();
    }
  });

  /** Ein Eintrag nach dem anderen: erst wenn er fertig im ZIP steht, kommt der nächste (Gegendruck). */
  const add = (source: Readable | string, data: archiver.ZipEntryData) =>
    new Promise<void>((resolve, reject) => {
      if (failure || closed) return reject(failure ?? new Error("Export abgebrochen"));
      waiters.add({ resolve, reject });
      archive.append(source, data);
    });

  const counts: Record<string, number> = {};
  const mediaErrors = new Set<string>();
  let mediaFiles = 0;
  const archiveErrors = new Set<string>();
  let archiveFiles = 0;
  /** Pfad im ZIP für ein archiviertes Beleg-PDF (Dateiname = Belegnummer, je Praxis eindeutig) */
  const archivePath = (r: Row) => `belege/${r.kind === "payment_receipt" ? "zahlungsbelege" : "rechnungen"}/${String(r.filename).replace(/[^A-Za-z0-9._-]/g, "_")}`;

  /** Seitenweise alle Zeilen einer Tabelle (Keyset über id), je Seite eine kurze RLS-Transaktion. */
  async function* pages<T extends Row>(read: (after: unknown, limit: number) => Promise<T[]>, limit: number): AsyncGenerator<T[]> {
    let after: unknown = undefined;
    for (;;) {
      const rows = await read(after, limit);
      if (rows.length) yield rows;
      if (rows.length < limit) return;
      after = rows[rows.length - 1].id;
    }
  }

  const tableReader = (table: PgTable) => {
    const cols = table as unknown as Record<string, PgColumn>;
    return (after: unknown, limit: number) =>
      withOrg(org, async (tx) => {
        const conds: SQL[] = [eq(cols.organizationId, org)];
        if (after !== undefined) conds.push(gt(cols.id, after));
        return (await tx.select().from(table).where(and(...conds)).orderBy(asc(cols.id)).limit(limit)) as Row[];
      });
  };

  /** JSON-Array einer Tabelle als Stream; `map` darf Zeilen (seitenweise) ergänzen. */
  function jsonTable(name: string, source: AsyncGenerator<Row[]>, map?: (rows: Row[]) => Promise<Row[]> | Row[]) {
    counts[name] = 0;
    return Readable.from(
      (async function* () {
        let first = true;
        for await (const page of source) {
          const rows = map ? await map(page) : page;
          const parts: string[] = [];
          for (const r of rows) {
            parts.push(jsonElement(r));
            counts[name]++;
          }
          if (!parts.length) continue;
          yield (first ? "[\n" : ",\n") + parts.join(",\n");
          first = false;
        }
        yield first ? "[]" : "\n]";
      })(),
      { objectMode: false },
    );
  }

  /** Patientennummern für eine Seite von Medien (nur die benötigten). */
  const numbersFor = async (patientIds: string[]) => {
    const ids = [...new Set(patientIds.filter(Boolean))];
    if (!ids.length) return new Map<string, number>();
    const rows = await withOrg(org, (tx) =>
      tx.select({ id: patients.id, number: patients.number }).from(patients).where(and(eq(patients.organizationId, org), inArray(patients.id, ids))),
    );
    return new Map(rows.map((r) => [r.id, r.number]));
  };

  const exportFileOf = (m: Row, numbers: Map<string, number>) =>
    mediaPath(
      { id: m.id as string, mime: m.mime as string, purpose: String(m.purpose), takenAt: m.takenAt as Date },
      numbers.get(m.patientId as string),
    );

  async function produce() {
    const tables = tenantTables();
    const [orgRow] = await withOrg(org, (tx) => tx.select().from(organizations).where(eq(organizations.id, org)));

    // 1) Medien entschlüsseln – eine Datei nach der anderen
    const mediaCols = { id: media.id, storageKey: media.storageKey, mime: media.mime, purpose: media.purpose, takenAt: media.takenAt, patientId: media.patientId };
    const mediaPages = pages(
      (after, limit) =>
        withOrg(org, (tx) =>
          tx
            .select(mediaCols)
            .from(media)
            .where(and(eq(media.organizationId, org), after === undefined ? undefined : gt(media.id, after as string)))
            .orderBy(asc(media.id))
            .limit(limit),
        ),
      mediaPageSize,
    );
    for await (const page of mediaPages) {
      const numbers = await numbersFor(page.map((m) => m.patientId as string));
      for (const m of page) {
        if (!m.storageKey) continue;
        const file = exportFileOf(m, numbers);
        try {
          await verifyStored(m.storageKey);
        } catch {
          mediaErrors.add(m.id);
          continue;
        }
        // Bilder/Audio sind bereits komprimiert
        await add(readDecryptedStream(m.storageKey), { name: file, store: m.mime !== "application/pdf", date: new Date(m.takenAt) });
        mediaFiles++;
      }
    }

    // 1b) Beleg-Archiv (GoBD): vorher fehlende PDFs nachholen (Ablage beim Ausstellen gescheitert), dann die archivierten
    //     Original-PDFs entschlüsselt, Prüfsumme in tables/document_archive.json
    try {
      // höchstens EXPORT_CATCHUP_LIMIT je Art (der Export soll nicht minutenlang PDFs erzeugen); der Rest steht im README
      await catchUpArchives({ organizationIds: [org], limitPerOrg: EXPORT_CATCHUP_LIMIT });
    } catch (e) {
      log.error("export.archive_catchup_failed", { error: e });
    }
    const archiveCols = {
      id: documentArchive.id,
      organizationId: documentArchive.organizationId,
      storageKey: documentArchive.storageKey,
      sha256: documentArchive.sha256,
      sizeBytes: documentArchive.sizeBytes,
      kind: documentArchive.kind,
      filename: documentArchive.filename,
      createdAt: documentArchive.createdAt,
    };
    const archivePages = pages(
      (after, limit) =>
        withOrg(org, (tx) =>
          tx
            .select(archiveCols)
            .from(documentArchive)
            .where(and(eq(documentArchive.organizationId, org), after === undefined ? undefined : gt(documentArchive.id, after as string)))
            .orderBy(asc(documentArchive.id))
            .limit(limit),
        ),
      mediaPageSize,
    );
    for await (const page of archivePages) {
      for (const a of page) {
        // Beleg-PDFs sind klein: vollständig lesen und gegen die gespeicherte SHA-256 prüfen (nicht nur GCM)
        let bytes: Uint8Array;
        try {
          bytes = await readArchivedPdf(a);
        } catch {
          archiveErrors.add(a.id);
          continue;
        }
        await add(Readable.from([Buffer.from(bytes)]), { name: archivePath(a), store: false, date: new Date(a.createdAt) });
        archiveFiles++;
      }
    }

    // 2) Tabellen (seitenweise)
    for (const t of tables) {
      const isMedia = t.name === "media";
      const isArchive = t.name === "document_archive";
      const source = jsonTable(t.name, pages(tableReader(t.table), pageSize), async (rows) => {
        const numbers = isMedia ? await numbersFor(rows.map((r) => r.patientId as string)) : null;
        return rows.map((r) => {
          const hadFile = isMedia && !!r.storageKey;
          const clean = stripRow(r, t.strippedKeys) as Row;
          if (isArchive) {
            if (archiveErrors.has(r.id as string)) {
              clean.exportFile = null;
              clean.exportError = "Datei konnte nicht gelesen/entschlüsselt werden oder Prüfsumme stimmt nicht";
            } else clean.exportFile = archivePath(r);
          }
          if (hadFile && numbers) {
            if (mediaErrors.has(r.id as string)) {
              clean.exportFile = null;
              clean.exportError = "Datei konnte nicht gelesen/entschlüsselt werden";
            } else {
              clean.exportFile = exportFileOf(r, numbers);
            }
          }
          return clean;
        });
      });
      await add(source, { name: `tables/${t.name}.json` });
    }
    const memberIds = (
      await withOrg(org, (tx) => tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.organizationId, org)))
    ).map((m) => m.userId);
    const userRows = memberIds.length
      ? await withOrg(org, (tx) =>
          tx
            .select({ id: users.id, email: users.email, name: users.name, totpEnabled: users.totpEnabled, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
            .from(users)
            .where(inArray(users.id, memberIds)),
        )
      : [];
    counts.users = userRows.length;
    await add(JSON.stringify(userRows, replacer, 2), { name: "tables/users.json" });
    await add(JSON.stringify(orgRow ? [sanitizeOrganizationRow(orgRow)] : [], replacer, 2), { name: "tables/organizations.json" });
    const missing = await missingArchives(org, 10_000);
    const notArchived = [...missing.invoices.map((i) => i.number ?? i.id), ...missing.receipts.map((r) => r.number)];
    await add(readme({ orgName: orgRow?.name ?? "", exportedBy: opts.exportedBy, counts, mediaFiles, mediaErrors: [...mediaErrors], archiveFiles, archiveErrors: [...archiveErrors], notArchived }), {
      name: "README.txt",
    });
    await archive.finalize();
    finished = true;
    return { counts, mediaFiles, mediaErrors: mediaErrors.size, archiveFiles, archiveErrors: archiveErrors.size };
  }

  const done = produce().catch((e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    if (!closed) out.destroy(err);
    throw err;
  });
  // unbehandelte Ablehnung vermeiden, falls niemand auf done wartet
  done.catch(() => undefined);
  const stream = Readable.toWeb(out) as ReadableStream<Uint8Array>;
  return { stream, done };
}

function readme(p: {
  orgName: string;
  exportedBy: { name: string; email: string };
  counts: Record<string, number>;
  mediaFiles: number;
  mediaErrors: string[];
  archiveFiles: number;
  archiveErrors: string[];
  /** Belegnummern seit Einführung des Archivs ohne archiviertes PDF */
  notArchived: string[];
}) {
  const lines = [
    "PodoHero – Vollständiger Datenexport",
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
    "media/<Patientennummer>/  Fotos, Audio und Dokumente – entschlüsselt. Zuordnung über tables/media.json (Feld exportFile).",
    "                       Die Prüfsumme (sha256) in tables/media.json belegt die Unversehrtheit der Datei.",
    "belege/rechnungen/     Beleg-Archiv: die beim Ausstellen gespeicherten Original-PDFs (Rechnungen, Quittungen,",
    "                       Anzahlungen, Stornorechnungen, Sammelrechnungen) – byte-gleich, Prüfsumme (sha256) und",
    "                       Zuordnung in tables/document_archive.json (Feld exportFile). Jede Datei wurde beim Export",
    "                       gegen ihre Prüfsumme geprüft. Belege ohne Archiv (ausgestellt vor Einführung des",
    "                       Beleg-Archivs) lassen sich aus den Tabellen reproduzieren.",
    "belege/zahlungsbelege/ Belege über Zahlungseingänge nach Ausstellung (Kassenbelege mit TSE-Angaben); ihre",
    "                       festgeschriebenen Angaben stehen zusätzlich in tables/payment_receipts.json (Feld data).",
    "",
    "NICHT ENTHALTEN – BITTE SEPARAT ERSTELLEN: der DSFinV-K-Export (Kasse → DSFinV-K-Export, ggf. mehrere Zeiträume –",
    "max. 3 Jahre je Export) und der TSE-Export (beim TSE-Anbieter) für ALLE Zeiträume bis zur Kündigung. Beide sind",
    "Kassenaufzeichnungen (10 Jahre aufzubewahren) und lassen sich nach der Löschung der Praxis über PodoHero nicht mehr",
    "erzeugen.",
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
    `${"Archivierte Belege (PDF)".padEnd(28)} ${p.archiveFiles}`,
    ...(p.archiveErrors.length ? ["", `ACHTUNG: ${p.archiveErrors.length} archivierte(r) Beleg(e) konnten nicht gelesen werden (IDs in tables/document_archive.json, Feld exportError).`] : []),
    ...(p.notArchived.length
      ? [
          "",
          `ACHTUNG: ${p.notArchived.length} Beleg(e) seit Einführung des Beleg-Archivs ohne archiviertes PDF (Ablage gescheitert, auch`,
          `der Nachhol-Lauf vor dem Export war erfolglos oder auf ${EXPORT_CATCHUP_LIMIT} je Art begrenzt – bitte später erneut exportieren`,
          "bzw. den Support kontaktieren). Ihre Angaben sind in den Tabellen",
          `festgeschrieben: ${p.notArchived.slice(0, 50).join(", ")}${p.notArchived.length > 50 ? " …" : ""}`,
        ]
      : []),
    "",
    "AUFBEWAHRUNG – BITTE BEACHTEN",
    "-----------------------------",
    "Dieser Export enthält Gesundheitsdaten (Art. 9 DSGVO) und unterliegt der Schweigepflicht (§ 203 StGB).",
    "Bewahren Sie ihn verschlüsselt und zugriffsgeschützt auf.",
    "",
    "Gesetzliche Aufbewahrungsfristen gelten für die Praxis weiter, auch nach einer Kündigung:",
    "- Behandlungsdokumentation: 10 Jahre nach Abschluss der Behandlung (§ 630f Abs. 3 BGB)",
    "- Rechnungen, Quittungen, Zahlungsbelege und andere Buchungsbelege: 8 Jahre ab Ende des Ausstellungsjahres (§ 147 AO, § 14b UStG)",
    "- Bücher, Jahresabschlüsse und Kassenaufzeichnungen (Einzelaufzeichnungen, TSE-/DSFinV-K-Export): 10 Jahre (§ 147 AO)",
    "- Arbeitsanweisungen und Organisationsunterlagen (Verfahrensdokumentation, Einrichtungsprotokolle der Kasse,",
    "  Kassenmeldung ans Finanzamt, Angaben zum TSE-Zertifikat): 10 Jahre (§ 147 AO)",
    "- Steuerliche Fristen enden frühestens dann – Ablaufhemmung nach § 147 Abs. 3 S. 5 AO beachten.",
    "Nach der Löschung der Praxis in PodoHero ist dieser Export Ihre einzige Kopie.",
    "",
  ];
  return lines.join("\n");
}

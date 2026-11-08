/**
 * Prüft die Hash-Ketten der Behandlungsdokumentation (treatment_records je Patient:in, record_addenda je Eintrag)
 * durch Neuberechnung mit demselben Code wie die App (src/lib/records.ts).
 * Gedacht für den Wiederherstellungs-Test (deploy/restore-test.sh) gegen eine Wegwerf-Datenbank;
 * braucht eine Rolle, die RLS umgeht (Superuser/Eigentümer). Liest nur.
 *
 *   DATABASE_URL=postgres://podo_owner:…@host/db pnpm exec tsx scripts/verify-hash-chains.ts [--org <praxis-id>]
 *
 * Ausgabe: nur Zähler und Datensatz-IDs – keine Inhalte. Exit-Code 1 bei Abweichungen.
 * Demo-Praxen (slug „demo-…“, scripts/seed-demo.ts) nutzen ein vereinfachtes Inhaltsformat;
 * dort werden nur Verkettung und nicht der Inhalt gewertet.
 */
import { Pool } from "pg";
import { chainHash, treatmentContent } from "../src/lib/records";

type RecordRow = {
  id: string;
  organization_id: string;
  patient_id: string;
  author_id: string;
  treated_at: Date;
  findings: string | null;
  services_text: string | null;
  material: string | null;
  sterile_batch_code: string | null;
  reaction: string | null;
  recommendation: string | null;
  foot_points: unknown[];
  structured: Record<string, unknown>;
  appointment_id: string | null;
  prescription_id: string | null;
  missing_photo_reason: string | null;
  ai_assisted: boolean;
  countersign_required: boolean;
  prev_hash: string | null;
  hash: string;
  demo: boolean;
};
type AddendumRow = { id: string; record_id: string; author_id: string; kind: string; text: string; created_at: Date; prev_hash: string | null; hash: string; demo: boolean };

/** Reihenfolge über die Verkettung (nicht über Zeitstempel). Liefert IDs mit Verkettungsfehlern. */
function orderChain<T extends { id: string; prev_hash: string | null; hash: string }>(rows: T[], start: string | null): { ordered: T[]; broken: string[] } {
  const byPrev = new Map<string | null, T[]>();
  for (const r of rows) byPrev.set(r.prev_hash, [...(byPrev.get(r.prev_hash) ?? []), r]);
  const ordered: T[] = [];
  const broken: string[] = [];
  let cur = start;
  const seen = new Set<string>();
  for (;;) {
    const next = byPrev.get(cur) ?? [];
    if (next.length === 0) break;
    if (next.length > 1) broken.push(...next.slice(1).map((r) => r.id)); // Verzweigung
    const n = next[0];
    if (seen.has(n.hash)) break;
    seen.add(n.hash);
    ordered.push(n);
    cur = n.hash;
  }
  const inChain = new Set(ordered.map((r) => r.id));
  for (const r of rows) if (!inChain.has(r.id) && !broken.includes(r.id)) broken.push(r.id); // nicht erreichbar
  return { ordered, broken };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL fehlt");
  const orgArg = process.argv.indexOf("--org");
  const org = orgArg > 0 ? process.argv[orgArg + 1] : null;
  if (org !== null && !/^[0-9a-f-]{36}$/i.test(org)) throw new Error("--org erwartet eine Praxis-ID (UUID)");
  const pool = new Pool({ connectionString: url });
  const records = (
    await pool.query<RecordRow>(
      `select r.*, o.slug like 'demo-%' as demo from treatment_records r join organizations o on o.id = r.organization_id
        where $1::uuid is null or r.organization_id = $1::uuid`,
      [org],
    )
  ).rows;
  const addenda = (
    await pool.query<AddendumRow>(
      `select a.id, a.record_id, a.author_id, a.kind, a.text, a.created_at, a.prev_hash, a.hash, o.slug like 'demo-%' as demo
         from record_addenda a join organizations o on o.id = a.organization_id
        where $1::uuid is null or a.organization_id = $1::uuid`,
      [org],
    )
  ).rows;
  await pool.end();

  let linkErrors = 0;
  let contentErrors = 0;
  let demoSkipped = 0;
  const report = (kind: string, ids: string[]) => {
    for (const id of ids.slice(0, 20)) console.log(`  ${kind}: ${id}`);
    if (ids.length > 20) console.log(`  … und ${ids.length - 20} weitere`);
  };

  // Behandlungseinträge je Patient:in
  const byPatient = new Map<string, RecordRow[]>();
  for (const r of records) byPatient.set(`${r.organization_id}/${r.patient_id}`, [...(byPatient.get(`${r.organization_id}/${r.patient_id}`) ?? []), r]);
  const linkIds: string[] = [];
  const contentIds: string[] = [];
  for (const rows of byPatient.values()) {
    const { ordered, broken } = orderChain(rows, null);
    linkIds.push(...broken);
    let prev: string | null = null;
    for (const r of ordered) {
      if (r.demo) {
        demoSkipped++;
      } else {
        const content = treatmentContent({
          patientId: r.patient_id,
          authorId: r.author_id,
          treatedAt: r.treated_at.toISOString(),
          findings: r.findings,
          servicesText: r.services_text,
          material: r.material,
          sterileBatchCode: r.sterile_batch_code,
          reaction: r.reaction,
          recommendation: r.recommendation,
          footPoints: r.foot_points ?? [],
          structured: r.structured ?? {},
          appointmentId: r.appointment_id,
          missingPhotoReason: r.missing_photo_reason,
          aiAssisted: r.ai_assisted,
          countersignRequired: r.countersign_required,
          prescriptionId: r.prescription_id,
        });
        if (chainHash(prev, content) !== r.hash) contentIds.push(r.id);
      }
      prev = r.hash;
    }
  }
  linkErrors += linkIds.length;
  contentErrors += contentIds.length;

  // Nachträge je Eintrag: Kette beginnt beim Hash des Eintrags
  const recordHash = new Map(records.map((r) => [r.id, r.hash]));
  const byRecord = new Map<string, AddendumRow[]>();
  for (const a of addenda) byRecord.set(a.record_id, [...(byRecord.get(a.record_id) ?? []), a]);
  const addLinkIds: string[] = [];
  const addContentIds: string[] = [];
  for (const [recordId, rows] of byRecord) {
    const start = recordHash.get(recordId);
    if (!start) {
      addLinkIds.push(...rows.map((r) => r.id));
      continue;
    }
    const { ordered, broken } = orderChain(rows, start);
    addLinkIds.push(...broken);
    let prev = start;
    for (const a of ordered) {
      const content = { recordId, authorId: a.author_id, kind: a.kind, text: a.text, at: a.created_at.toISOString() };
      if (chainHash(prev, content) !== a.hash) addContentIds.push(a.id);
      prev = a.hash;
    }
  }
  linkErrors += addLinkIds.length;
  contentErrors += addContentIds.length;

  console.log(`Behandlungseinträge: ${records.length} (${byPatient.size} Ketten), Nachträge: ${addenda.length}`);
  if (demoSkipped) console.log(`Demo-Praxis: ${demoSkipped} Einträge nur auf Verkettung geprüft`);
  report("Verkettung fehlerhaft (Eintrag)", linkIds);
  report("Inhalt passt nicht zum Hash (Eintrag)", contentIds);
  report("Verkettung fehlerhaft (Nachtrag)", addLinkIds);
  report("Inhalt passt nicht zum Hash (Nachtrag)", addContentIds);
  if (linkErrors || contentErrors) {
    console.log(`FEHLER: ${linkErrors} Verkettungs-, ${contentErrors} Inhaltsabweichungen`);
    process.exit(1);
  }
  console.log("Alle Hash-Ketten stimmen.");
}

main().catch((e) => {
  console.error("Prüfung fehlgeschlagen:", e instanceof Error ? e.message : e);
  process.exit(1);
});

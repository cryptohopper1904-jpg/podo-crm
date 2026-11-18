import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { prescriptions, treatmentRecords, treatmentSignatures, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { berlinDateIso } from "@/lib/format";
import { hasAnlage3Fields } from "@/lib/rules/prescription";
import { MAX_SIGNATURE_DATAURL_CHARS, SIGNER_ROLES, type SignerRole } from "@/lib/signature";
import { checkSignaturePng } from "@/lib/signature-png";
import { discardStored, readDecrypted, storeEncrypted } from "@/lib/storage";
import { assertCan } from "./authz";

/**
 * Unterschrift der versicherten Person je Behandlung (GKV Paket B, Teil 1). Erfasst beim Behandlungseintrag (Doku,
 * Besuchstag) oder nachträglich im Leistungsnachweis; PNG verschlüsselt in der Dateiablage, Zeile in
 * treatment_signatures (append-only, Migration 0064). Alternativ der bewusst gesetzte Vermerk „Unterschrift auf der
 * Papier-Verordnung (Rückseite) erfasst“. Keine Namen/Bilddaten in Logs oder Audit-Metadaten.
 */

const checkbox = z.preprocess((v) => v === "on" || v === "1" || v === true, z.boolean());
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** Formularfelder (Doku, Besuchstag, Nachtrag) – alle optional; ohne Angabe bleibt die Unterschrift offen */
export const signatureFields = z.object({
  signatureData: z.preprocess(emptyToUndef, z.string().max(MAX_SIGNATURE_DATAURL_CHARS, "Die Unterschrift ist zu groß – bitte löschen und erneut unterschreiben.").optional()),
  // keine Steuer-/Formatzeichen (z. B. Richtungswechsel U+202E, die den Namen im PDF verfälschen) – Review R2-10
  signerName: z.preprocess(
    emptyToUndef,
    z.string().trim().min(2, "Bitte den Namen der unterschreibenden Person angeben.").max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u, "Der Name enthält unzulässige Zeichen.").optional(),
  ),
  signerRole: z.preprocess(emptyToUndef, z.enum(SIGNER_ROLES, { message: "Bitte angeben, wer unterschreibt." }).optional()),
  paperSigned: checkbox.optional(),
});
export type SignatureFields = z.infer<typeof signatureFields>;

export type PreparedSignature =
  | { kind: "device"; signerName: string; signerRole: SignerRole; bytes: Buffer }
  | { kind: "paper"; signerName: string | null; signerRole: SignerRole | null };

/** data:image/png;base64,… → Bytes (Inhalt prüft checkSignaturePng) */
function dataUrlToBytes(dataUrl: string): Buffer | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl.trim());
  return m ? Buffer.from(m[1], "base64") : null;
}

/** Formularangaben prüfen. null = keine Unterschrift angegeben (bleibt „Unterschrift fehlt“). */
export function prepareSignature(f: SignatureFields): PreparedSignature | null | { error: string } {
  if (f.paperSigned) {
    if (f.signatureData) return { error: "Bitte entweder auf dem Gerät unterschreiben lassen oder „Unterschrift auf der Papier-Verordnung“ ankreuzen." };
    return { kind: "paper", signerName: f.signerName ?? null, signerRole: f.signerRole ?? null };
  }
  if (!f.signatureData) return null;
  const bytes = dataUrlToBytes(f.signatureData);
  if (!bytes) return { error: "Die Unterschrift konnte nicht gelesen werden – bitte erneut unterschreiben." };
  const ok = checkSignaturePng(bytes);
  if (!ok.ok) return { error: ok.error };
  if (!f.signerName) return { error: "Bitte den Namen der unterschreibenden Person angeben." };
  if (!f.signerRole) return { error: "Bitte angeben, wer unterschreibt (Versicherte:r, rechtliche Betreuung, Angehörige:r, Pflegekraft)." };
  return { kind: "device", signerName: f.signerName, signerRole: f.signerRole, bytes };
}

/** Gespeicherte, aber (noch) nicht verzeichnete Dateien – nach einem Rollback aufräumen */
export type PendingSignatureFiles = string[];

export async function cleanupSignatureFiles(keys: PendingSignatureFiles) {
  await Promise.all(keys.splice(0).map((k) => discardStored(k).catch(() => undefined)));
}

/**
 * Unterschrift zu einem Behandlungseintrag speichern (in der Transaktion des Aufrufers). Die Datei wird vorher
 * verschlüsselt abgelegt und in `pending` vermerkt – scheitert die Transaktion, räumt der Aufrufer sie weg.
 * Prüft (zusätzlich zum DB-Trigger) Eintrag, Person und Verordnung.
 */
export async function insertSignature(
  tx: Tx,
  ctx: { org: string; userId: string },
  ref: { recordId: string; patientId: string },
  sig: PreparedSignature,
  pending: PendingSignatureFiles,
): Promise<{ id: string; prescriptionId: string }> {
  const [rec] = await tx
    .select({ patientId: treatmentRecords.patientId, prescriptionId: treatmentRecords.prescriptionId })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, ctx.org), eq(treatmentRecords.id, ref.recordId)));
  if (!rec || rec.patientId !== ref.patientId) throw new SignatureError("Behandlungseintrag nicht gefunden.");
  if (!rec.prescriptionId) throw new SignatureError("Eine Unterschrift für den Leistungsnachweis gibt es nur bei Behandlungen auf Verordnung.");
  const [dup] = await tx.select({ id: treatmentSignatures.id }).from(treatmentSignatures).where(and(eq(treatmentSignatures.organizationId, ctx.org), eq(treatmentSignatures.recordId, ref.recordId)));
  if (dup) throw new SignatureError("Für diese Behandlung ist bereits eine Unterschrift erfasst – sie ist unveränderbar.");
  let file: { storageKey: string; sha256: string; sizeBytes: number } | null = null;
  if (sig.kind === "device") {
    file = await storeEncrypted(ctx.org, sig.bytes);
    pending.push(file.storageKey);
  }
  const [row] = await tx
    .insert(treatmentSignatures)
    .values({
      organizationId: ctx.org,
      recordId: ref.recordId,
      patientId: ref.patientId,
      prescriptionId: rec.prescriptionId,
      kind: sig.kind,
      signerName: sig.signerName,
      signerRole: sig.signerRole,
      storageKey: file?.storageKey ?? null,
      mime: file ? "image/png" : null,
      sizeBytes: file?.sizeBytes ?? null,
      sha256: file?.sha256 ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: treatmentSignatures.id });
  return { id: row.id, prescriptionId: rec.prescriptionId };
}

export class SignatureError extends Error {}

/** Audit-Eintrag ohne Namen/Bilddaten */
export async function auditSignature(org: string, userId: string, sig: { id: string; prescriptionId: string }, recordId: string, kind: PreparedSignature["kind"], role: SignerRole | null, later: boolean) {
  await audit({ organizationId: org, userId, action: kind === "paper" ? "record.signature_paper" : "record.signature", entity: "treatment_record", entityId: recordId, meta: { signatureId: sig.id, prescriptionId: sig.prescriptionId, role, later } });
}

/** Unterschrift nachträglich erfassen (Leistungsnachweis). Recht medical.write, nicht im Support-/Nur-Lese-Modus. */
export async function addSignature(auth: AuthContext, input: { recordId: string; patientId: string } & SignatureFields): Promise<{ ok: true } | { error: string }> {
  assertCan(auth, "medical.write");
  const ids = z.object({ recordId: z.string().uuid(), patientId: z.string().uuid() }).safeParse(input);
  if (!ids.success) return { error: "Ungültige Anfrage." };
  const blocked = gkvGuard(auth.organization, "verordnungen");
  if (blocked) return blocked;
  // Felder hier erneut prüfen (Aufruf auch ohne Server-Action möglich)
  const fields = signatureFields.safeParse({ signatureData: input.signatureData, signerName: input.signerName, signerRole: input.signerRole, paperSigned: input.paperSigned });
  if (!fields.success) return { error: fields.error.issues[0]?.message ?? "Unterschrift prüfen." };
  const prepared = prepareSignature(fields.data);
  if (!prepared) return { error: "Bitte unterschreiben lassen oder „Unterschrift auf der Papier-Verordnung“ ankreuzen." };
  if ("error" in prepared) return prepared;
  const org = auth.organization.id;
  const pending: PendingSignatureFiles = [];
  try {
    const sig = await withOrg(org, async (tx) => {
      // gleichzeitige Nachträge zur selben Behandlung serialisieren (eindeutiger Index bleibt die letzte Sperre)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"sig:" + input.recordId}))`);
      return insertSignature(tx, { org, userId: auth.user.id }, input, prepared, pending);
    });
    await auditSignature(org, auth.user.id, sig, input.recordId, prepared.kind, prepared.signerRole, true);
    return { ok: true };
  } catch (e) {
    await cleanupSignatureFiles(pending);
    if (e instanceof SignatureError) return { error: e.message };
    const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") return { error: "Für diese Behandlung ist bereits eine Unterschrift erfasst – sie ist unveränderbar." };
    throw e;
  }
}

export type SignatureRow = {
  id: string;
  kind: "device" | "paper";
  signerName: string | null;
  signerRole: SignerRole | null;
  signedAt: Date;
  createdByName: string | null;
  /** auf dem Gerät nicht am Behandlungstag unterschrieben (nachgetragen) – Hinweis im Leistungsnachweis (R2-17) */
  late: boolean;
};

export type ProofRow = { recordId: string; date: string; treatedAt: Date; signature: SignatureRow | null };

export const paperBulkInput = z.object({
  prescriptionId: z.string().uuid(),
  patientId: z.string().uuid(),
  until: z.iso.date({ message: "Bitte ein gültiges Datum angeben." }),
});

/**
 * Sammel-Vermerk „Unterschriften liegen auf der Papier-Verordnung vor“ für alle noch offenen Behandlungen einer
 * Verordnung bis einschließlich `until` – für Bestands-Verordnungen, deren Behandlungen vor Einführung der
 * Unterschrift auf dem Gerät erfasst wurden (Review R2-13). Bewusster Schritt, protokolliert.
 */
export async function markPaperSignatures(auth: AuthContext, raw: z.input<typeof paperBulkInput>): Promise<{ count: number } | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "verordnungen");
  if (blocked) return blocked;
  const parsed = paperBulkInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  if (d.until > berlinDateIso()) return { error: "Das Datum darf nicht in der Zukunft liegen." };
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    const [vo] = await tx.select({ id: prescriptions.id }).from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.prescriptionId), eq(prescriptions.patientId, d.patientId))).for("update");
    if (!vo) return null;
    const rows = (await proofRows(tx, org, [vo.id])).get(vo.id) ?? [];
    const open = rows.filter((r) => !r.signature && r.date <= d.until);
    if (!open.length) return [];
    await tx.insert(treatmentSignatures).values(open.map((r) => ({ organizationId: org, recordId: r.recordId, patientId: d.patientId, prescriptionId: vo.id, kind: "paper" as const, createdBy: auth.user.id })));
    return open.map((r) => r.recordId);
  });
  if (!res) return { error: "Verordnung nicht gefunden." };
  if (res.length) await audit({ organizationId: org, userId: auth.user.id, action: "record.signature_paper_bulk", entity: "prescription", entityId: d.prescriptionId, meta: { until: d.until, count: res.length, recordIds: res } });
  return { count: res.length };
}

/** Behandlungen je Verordnung mit Unterschrift (aufsteigend) */
export async function proofRows(tx: Tx, org: string, prescriptionIds: string[]): Promise<Map<string, ProofRow[]>> {
  const out = new Map<string, ProofRow[]>();
  if (!prescriptionIds.length) return out;
  const recs = await tx
    .select({ id: treatmentRecords.id, prescriptionId: treatmentRecords.prescriptionId, treatedAt: treatmentRecords.treatedAt })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.prescriptionId, prescriptionIds)))
    .orderBy(asc(treatmentRecords.treatedAt));
  const sigs = recs.length
    ? await tx
        .select({ s: treatmentSignatures, by: users.name })
        .from(treatmentSignatures)
        .leftJoin(users, eq(users.id, treatmentSignatures.createdBy))
        .where(and(eq(treatmentSignatures.organizationId, org), inArray(treatmentSignatures.recordId, recs.map((r) => r.id))))
    : [];
  const byRecord = new Map(sigs.map((x) => [x.s.recordId, x]));
  for (const r of recs) {
    const x = byRecord.get(r.id);
    const list = out.get(r.prescriptionId!) ?? [];
    list.push({
      recordId: r.id,
      date: berlinDateIso(r.treatedAt),
      treatedAt: r.treatedAt,
      signature: x
        ? { id: x.s.id, kind: x.s.kind, signerName: x.s.signerName, signerRole: x.s.signerRole, signedAt: x.s.signedAt, createdByName: x.by ?? null, late: x.s.kind === "device" && berlinDateIso(x.s.signedAt) !== berlinDateIso(r.treatedAt) }
        : null,
    });
    out.set(r.prescriptionId!, list);
  }
  return out;
}

/** Anzahl Behandlungen ohne Unterschrift/Papier-Vermerk je Verordnung */
export async function missingSignatureCounts(tx: Tx, org: string, prescriptionIds: string[]): Promise<Map<string, { total: number; missing: number }>> {
  const rows = await proofRows(tx, org, prescriptionIds);
  const out = new Map<string, { total: number; missing: number }>();
  for (const [id, list] of rows) out.set(id, { total: list.length, missing: list.filter((r) => !r.signature).length });
  return out;
}

/**
 * Pflicht für „abrechnungsreif“: jede Behandlung mit Unterschrift oder Papier-Vermerk – für Verordnungen nach aktuellem
 * Regelwerk (ab podo-2026-11). Übernahmen/Altbestand: nur Hinweis (die Bestätigung liegt dort auf Papier vor).
 */
export function signatureRequired(rulesVersion: string | null | undefined): boolean {
  return hasAnlage3Fields(rulesVersion);
}

/** Bild einer Unterschrift (PNG) für Ansicht/PDF – nur für Rollen mit medical.read */
export async function signatureImage(auth: AuthContext, signatureId: string): Promise<Buffer | null> {
  assertCan(auth, "medical.read");
  const org = auth.organization.id;
  const [row] = await withOrg(org, (tx) =>
    tx
      .select({ key: treatmentSignatures.storageKey, kind: treatmentSignatures.kind, patientId: treatmentSignatures.patientId })
      .from(treatmentSignatures)
      .where(and(eq(treatmentSignatures.organizationId, org), eq(treatmentSignatures.id, signatureId))),
  );
  if (!row?.key || row.kind !== "device" || !row.key.startsWith(`${org}/`)) return null;
  const bytes = await readDecrypted(row.key);
  await audit({ organizationId: org, userId: auth.user.id, action: "record.signature_view", entity: "treatment_signature", entityId: signatureId, meta: { patientId: row.patientId } });
  return bytes;
}

/** Bilder mehrerer Unterschriften (für das Leistungsnachweis-PDF) – Schlüssel geprüft auf die eigene Praxis */
export async function signatureImages(tx: Tx, org: string, ids: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (!ids.length) return out;
  const rows = await tx
    .select({ id: treatmentSignatures.id, key: treatmentSignatures.storageKey })
    .from(treatmentSignatures)
    .where(and(eq(treatmentSignatures.organizationId, org), inArray(treatmentSignatures.id, ids)));
  for (const r of rows) {
    if (!r.key || !r.key.startsWith(`${org}/`)) continue;
    out.set(r.id, new Uint8Array(await readDecrypted(r.key)));
  }
  return out;
}

/** Verordnung gehört zur Person? (für Seiten/Routen) */
export async function prescriptionOf(tx: Tx, org: string, id: string) {
  const [vo] = await tx.select().from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, id)));
  return vo ?? null;
}

import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import JSZip from "jszip";
import { db, withOrg, type Tx } from "@/db";
import { billingBatches, organizations, patients, prescriptions } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { begleitzettelPdf } from "@/lib/gkv302/begleitzettel-pdf";
import {
  MAX_FAELLE_JE_LAUF,
  Nummernkreis,
  TestpaketFehler,
  erzeugeTestpaket,
  kassenartAus,
  pruefeFaelle,
  zaehlerstandAus,
  type DaKotrDatei,
  type DaPraxis,
  type DaVerordnung,
  type Pruefergebnis,
  type Testpaket,
} from "@/lib/gkv302/direktabrechnung";
import { ausLatin1 } from "@/lib/gkv302/edifact";
import { KotrCache } from "@/lib/gkv302/kotr-cache";
import { KOTR_MAX_BYTES, KotrFehler, parseKostentraegerdatei, pruefeKotrDateiname, pruefeKotrUmfang } from "@/lib/gkv302/kostentraeger";
import { createRateLimiter } from "@/lib/rate-limit";
import { istGueltigesTarifkennzeichen } from "@/lib/gkv302/schluessel";
import { aktivesKryptomodul, type KryptoStatus } from "@/lib/gkv302/sicherheit";
import { discardStored, readDecrypted, storeEncrypted } from "@/lib/storage";
import { assertCan } from "./authz";

/**
 * Direktabrechnung § 302 SGB V – Server-Teil (Paket D, Erprobung, docs/GKV-302.md „Bedienung in PodoHero“).
 *
 *  - Prüflauf und Testpaket für abrechnungsreife Verordnungen oder einen Abrechnungslauf (billing_batches). Rechte:
 *    invoices.write + medical.read (Diagnosen). Daten nur über withOrg (RLS) und mit organization_id-Filter.
 *  - Preis-Snapshots werden unverändert aus der DB übernommen (keine Neuberechnung, docs/GKV-302.md 2a/2b).
 *  - Nummernkreise (Test) in organizations.settings.gkv302Zaehler, fortgeschrieben unter Zeilensperre (FOR UPDATE)
 *    in derselben Transaktion wie das Erzeugen – Nutzdateien, Begleitzettel-PDF und ZIP entstehen VOR dem Speichern des
 *    Zählerstands; scheitert irgendein Schritt, rollt die Transaktion zurück und es werden keine Nummern verbraucht.
 *  - Kostenträgerdateien (KOTR) verschlüsselt in der Dateiablage, Metadaten in organizations.settings.gkv302.kotr.
 *  - Keine Patientendaten in Audit-Einträgen oder Logs (nur Anzahlen, Dateinamen, Rechnungsnummern, IKs von Kassen).
 *
 * Kein Versand, keine Verschlüsselung: siehe src/lib/gkv302/sicherheit.ts.
 */

/** Größte KOTR-Datei: 2 MB (größte gemessene echte Datei 214 KB), definiert in der Bibliothek */
export { KOTR_MAX_BYTES } from "@/lib/gkv302/kostentraeger";
/** höchstens so viele Kostenträgerdateien je Praxis (eine je Kassenart) */
export const KOTR_MAX_DATEIEN = 12;
/** Uploads je Praxis und 10 Minuten (Zerlegen kostet Rechenzeit; Review-Runde 2, AppSec H1) */
export const KOTR_UPLOADS_JE_FENSTER = 10;
const kotrUploads = createRateLimiter({ windowMs: 10 * 60_000, max: KOTR_UPLOADS_JE_FENSTER, maxKeys: 5_000 });

/** Speicherschlüssel aus settings nur verwenden, wenn er zur eigenen Praxis gehört (Review-Runde 2, AppSec H4) */
const eigenerSchluessel = (org: string, key: string) => typeof key === "string" && key.startsWith(`${org}/`) && !key.includes("..");

/** zerlegte Kostenträgerdateien je Prüfsumme: LRU nach Bytes (≤ 32 MB), tief eingefroren (geteilt zwischen Praxen) */
const kotrCache = new KotrCache();

/** Support (Break-Glass) ändert keine Kostenträgerdateien – das entscheidet die Praxis (Review-Runde 2, AppSec H5) */
function keinSupport(auth: AuthContext) {
  if (auth.support) throw new Gkv302Fehler("Im Support-Modus können Kostenträgerdateien nicht geändert werden – das erledigt die Praxis selbst.");
}

export type KotrEintrag = {
  kassenart: string;
  dateiname: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  /** Gültig ab laut Dateiname, z. B. „Q4/2026“ oder „10/2026“ */
  gueltigAb: string;
  /** erster Tag dieses Zeitraums (JJJJ-MM-TT) */
  gueltigAbDatum: string;
  /** Erstellung laut UNB „JJMMTT:HHMM“ */
  erstellt: string;
  institutionen: number;
  hochgeladenAm: string;
};

export type Gkv302Einstellungen = { tarifkennzeichen: string | null; kotr: KotrEintrag[] };

const istObjekt = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function gkv302Einstellungen(settings: unknown): Gkv302Einstellungen {
  const g = istObjekt(settings) && istObjekt(settings.gkv302) ? settings.gkv302 : {};
  const tk = typeof g.tarifkennzeichen === "string" && g.tarifkennzeichen ? g.tarifkennzeichen : null;
  const kotr = Array.isArray(g.kotr) ? (g.kotr.filter((e) => istObjekt(e) && typeof e.storageKey === "string" && typeof e.kassenart === "string") as KotrEintrag[]) : [];
  return { tarifkennzeichen: tk, kotr };
}

/** „Q4“ + „26“ → 2026-10-01; „03“ + „26“ → 2026-03-01 */
function gueltigAb(name: { gueltigAb: string; jahr: string }): { text: string; datum: string } {
  const jahr = `20${name.jahr}`;
  const q = /^Q([1-4])$/.exec(name.gueltigAb);
  const monat = q ? String((Number(q[1]) - 1) * 3 + 1).padStart(2, "0") : name.gueltigAb;
  return { text: `${q ? name.gueltigAb : monat}/${jahr}`, datum: `${jahr}-${monat}-01` };
}

/** Zeile der Organisation sperren und settings.<pfad> setzen (jsonb_set, atomar in der laufenden Transaktion) */
async function setzeEinstellung(tx: Tx, org: string, pfad: "gkv302" | "gkv302Zaehler", wert: unknown) {
  await tx
    .update(organizations)
    .set({ settings: sql`jsonb_set(coalesce(${organizations.settings}, '{}'::jsonb), ${`{${pfad}}`}::text[], ${JSON.stringify(wert)}::jsonb, true)` })
    .where(eq(organizations.id, org));
}

async function sperreOrganisation(tx: Tx, org: string) {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org)).for("update");
  if (!o) throw new Error("Praxis nicht gefunden.");
  return (o.settings ?? {}) as Record<string, unknown>;
}

// ───────────────────────── Einstellungen ─────────────────────────

export class Gkv302Fehler extends Error {}

export async function saveTarifkennzeichen(auth: AuthContext, roh: string): Promise<void> {
  assertCan(auth, "settings.manage");
  const blocked = gkvGuard(auth.organization, "gkvBilling");
  if (blocked) throw new Gkv302Fehler(blocked.error);
  const tk = roh.replace(/\s+/g, "").toUpperCase();
  if (tk && !istGueltigesTarifkennzeichen(tk)) throw new Gkv302Fehler("Tarifkennzeichen ungültig: 5 Stellen (2 Ziffern Tarifbereich + 3 Stellen Sondertarif, z. B. aus dem Zulassungsbescheid).");
  const org = auth.organization.id;
  await withOrg(org, async (tx) => {
    const s = await sperreOrganisation(tx, org);
    const g = gkv302Einstellungen(s);
    const roh302 = istObjekt(s.gkv302) ? s.gkv302 : {};
    await setzeEinstellung(tx, org, "gkv302", { ...roh302, kotr: g.kotr, tarifkennzeichen: tk || null });
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.gkv302_tarifkennzeichen", entity: "organization", entityId: org, meta: { gesetzt: !!tk } });
}

/**
 * Prüft eine hochgeladene Kostenträgerdatei: Größe, Dateiname nach Anhang 3 Kap. 6 (aus dem Upload oder dem UNB),
 * nur Text (keine Steuer-/Binärzeichen), vollständig zerlegbar, mindestens eine Institution. Wird nie ausgeführt –
 * nur als Text gelesen.
 */
export function pruefeKotrUpload(dateiname: string, buf: Buffer): { kassenart: string; name: string; gueltig: { text: string; datum: string }; erstellt: string; institutionen: number } {
  if (!buf.length) throw new Gkv302Fehler("Bitte eine Kostenträgerdatei auswählen.");
  if (buf.length > KOTR_MAX_BYTES) throw new Gkv302Fehler(`Die Datei ist zu groß (höchstens ${KOTR_MAX_BYTES / 1024 / 1024} MB).`);
  // Text in ISO 8859-1: Steuerzeichen außer Tab/Zeilenumbruch und NUL deuten auf Binärdateien (ZIP, PDF, Programme)
  for (const b of buf) if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) throw new Gkv302Fehler("Das ist keine Kostenträgerdatei (Binärdaten). Bitte die entpackte Datei (z. B. AO05Q426.KE0) hochladen.");
  const text = ausLatin1(new Uint8Array(buf));
  let datei;
  try {
    datei = parseKostentraegerdatei(text);
  } catch (e) {
    if (e instanceof KotrFehler) throw new Gkv302Fehler(`Kostenträgerdatei nicht lesbar: ${e.message}`);
    throw new Gkv302Fehler("Kostenträgerdatei nicht lesbar (Format nach Anhang 3 zur TA1 erwartet).");
  }
  try {
    pruefeKotrUmfang(datei);
  } catch (e) {
    throw new Gkv302Fehler(`Kostenträgerdatei abgelehnt: ${(e as Error).message}`);
  }
  const kurz = (dateiname.split(/[\\/]/).pop() ?? "").trim();
  const name = pruefeKotrDateiname(kurz) ? kurz : datei.dateiname.length > 3 ? `${datei.dateiname.slice(0, -3)}.${datei.dateiname.slice(-3)}` : datei.dateiname;
  const info = pruefeKotrDateiname(name);
  const kassenart = kassenartAus(name);
  if (!info || !kassenart) throw new Gkv302Fehler("Dateiname der Kostenträgerdatei nicht erkannt (erwartet z. B. „AO05Q426.KE0“, Anhang 3 Kap. 6).");
  if (!datei.institutionen.length) throw new Gkv302Fehler("Die Kostenträgerdatei enthält keine Kostenträger.");
  return { kassenart, name: name.toUpperCase(), gueltig: gueltigAb(info), erstellt: datei.erstellt, institutionen: datei.institutionen.length };
}

export async function kotrHochladen(auth: AuthContext, dateiname: string, buf: Buffer): Promise<KotrEintrag> {
  assertCan(auth, "settings.manage");
  keinSupport(auth);
  const blocked = gkvGuard(auth.organization, "gkvBilling");
  if (blocked) throw new Gkv302Fehler(blocked.error);
  const org = auth.organization.id;
  // vor dem Zerlegen drosseln (jeder Versuch zählt, auch abgelehnte Dateien)
  if (kotrUploads.limited(org)) throw new Gkv302Fehler("Zu viele Uploads in kurzer Zeit. Bitte in einigen Minuten erneut versuchen.");
  const info = pruefeKotrUpload(dateiname, buf);
  const stored = await storeEncrypted(org, buf);
  const eintrag: KotrEintrag = {
    kassenart: info.kassenart,
    dateiname: info.name,
    storageKey: stored.storageKey,
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    gueltigAb: info.gueltig.text,
    gueltigAbDatum: info.gueltig.datum,
    erstellt: info.erstellt,
    institutionen: info.institutionen,
    hochgeladenAm: new Date().toISOString(),
  };
  let alt: string | null = null;
  try {
    alt = await withOrg(org, async (tx) => {
      const s = await sperreOrganisation(tx, org);
      const g = gkv302Einstellungen(s);
      const vorher = g.kotr.find((e) => e.kassenart === eintrag.kassenart) ?? null;
      const liste = [...g.kotr.filter((e) => e.kassenart !== eintrag.kassenart), eintrag].sort((a, b) => a.kassenart.localeCompare(b.kassenart));
      if (liste.length > KOTR_MAX_DATEIEN) throw new Gkv302Fehler(`Höchstens ${KOTR_MAX_DATEIEN} Kostenträgerdateien (eine je Kassenart).`);
      await setzeEinstellung(tx, org, "gkv302", { ...(istObjekt(s.gkv302) ? s.gkv302 : {}), kotr: liste });
      return vorher?.storageKey ?? null;
    });
  } catch (e) {
    await discardStored(stored.storageKey).catch(() => {});
    throw e;
  }
  // ersetzte Datei erst nach erfolgreichem Speichern entfernen (öffentliche Verzeichnisdaten, keine Aufbewahrungspflicht)
  if (alt && eigenerSchluessel(org, alt)) await discardStored(alt).catch(() => {});
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.gkv302_kotr_upload", entity: "organization", entityId: org, meta: { kassenart: eintrag.kassenart, dateiname: eintrag.dateiname, sizeBytes: eintrag.sizeBytes, sha256: eintrag.sha256, institutionen: eintrag.institutionen, ersetzt: !!alt } });
  return eintrag;
}

export async function kotrEntfernen(auth: AuthContext, kassenart: string): Promise<boolean> {
  assertCan(auth, "settings.manage");
  keinSupport(auth);
  const org = auth.organization.id;
  const alt = await withOrg(org, async (tx) => {
    const s = await sperreOrganisation(tx, org);
    const g = gkv302Einstellungen(s);
    const weg = g.kotr.find((e) => e.kassenart === kassenart);
    if (!weg) return null;
    await setzeEinstellung(tx, org, "gkv302", { ...(istObjekt(s.gkv302) ? s.gkv302 : {}), kotr: g.kotr.filter((e) => e !== weg) });
    return weg.storageKey;
  });
  if (!alt) return false;
  if (eigenerSchluessel(org, alt)) await discardStored(alt).catch(() => {});
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.gkv302_kotr_remove", entity: "organization", entityId: org, meta: { kassenart } });
  return true;
}

/** Status für die Einstellungen (ohne Patientendaten): Tarifkennzeichen, KOTR-Dateien, Zertifikat */
export async function gkv302Status(org: string): Promise<Gkv302Einstellungen & { krypto: KryptoStatus }> {
  const [o] = await db.select({ settings: organizations.settings, ik: organizations.ik }).from(organizations).where(eq(organizations.id, org));
  const g = gkv302Einstellungen(o?.settings);
  const modul = aktivesKryptomodul();
  const krypto = modul.status ? await modul.status({ ik: o?.ik ?? null }) : { zertifikat: "nicht_hinterlegt" as const };
  return { ...g, krypto };
}

// ───────────────────────── Prüflauf / Testpaket ─────────────────────────

export type Gkv302Quelle = { art: "bereit" } | { art: "lauf"; batchId: string };

/** KOTR-Dateien entschlüsseln und zerlegen; unlesbare werden übersprungen und gemeldet */
async function ladeKotr(org: string, eintraege: KotrEintrag[]): Promise<{ dateien: DaKotrDatei[]; hinweise: string[] }> {
  const dateien: DaKotrDatei[] = [];
  const hinweise: string[] = [];
  for (const e of eintraege) {
    try {
      if (!eigenerSchluessel(org, e.storageKey)) throw new Error("fremder Speicherschlüssel");
      const buf = await readDecrypted(e.storageKey);
      // Prüfsumme des entschlüsselten Inhalts als Cache-Schlüssel (nicht der gespeicherte Wert aus settings)
      const sha = createHash("sha256").update(buf).digest("hex");
      dateien.push({ datei: kotrCache.hole(sha, buf.length, () => parseKostentraegerdatei(ausLatin1(new Uint8Array(buf)))), kassenart: e.kassenart });
    } catch {
      hinweise.push(`Kostenträgerdatei ${e.dateiname} ist nicht lesbar – bitte erneut hochladen.`);
    }
  }
  return { dateien, hinweise };
}

type OrgZeile = { name: string; legalName: string | null; street: string | null; zip: string | null; city: string | null; phone: string | null; email: string | null; ik: string | null; legsCode: string | null; settings: unknown };

function praxisAus(o: OrgZeile): DaPraxis {
  return {
    ik: o.ik,
    name: o.legalName?.trim() || o.name,
    strasse: o.street,
    plz: o.zip,
    ort: o.city,
    telefon: o.phone,
    email: o.email,
    legsCode: o.legsCode,
    tarifkennzeichen: gkv302Einstellungen(o.settings).tarifkennzeichen,
  };
}

const ORG_FELDER = {
  name: organizations.name,
  legalName: organizations.legalName,
  street: organizations.street,
  zip: organizations.zip,
  city: organizations.city,
  phone: organizations.phone,
  email: organizations.email,
  ik: organizations.ik,
  legsCode: organizations.legsCode,
  settings: organizations.settings,
};

/** Verordnungen der Quelle (nur dieser Praxis), sortiert nach Name und Ausstellungsdatum */
async function ladeVerordnungen(tx: Tx, org: string, quelle: Gkv302Quelle): Promise<DaVerordnung[] | null> {
  if (quelle.art === "lauf") {
    const [b] = await tx.select({ id: billingBatches.id }).from(billingBatches).where(and(eq(billingBatches.organizationId, org), eq(billingBatches.id, quelle.batchId)));
    if (!b) return null;
  }
  const rows = await tx
    .select({ vo: prescriptions, p: patients })
    .from(prescriptions)
    .innerJoin(patients, and(eq(patients.id, prescriptions.patientId), eq(patients.organizationId, org)))
    .where(and(eq(prescriptions.organizationId, org), quelle.art === "lauf" ? eq(prescriptions.billingBatchId, quelle.batchId) : inArray(prescriptions.status, ["billing_ready"])))
    .orderBy(asc(patients.lastName), asc(patients.firstName), asc(prescriptions.issuedAt), asc(prescriptions.id))
    .limit(MAX_FAELLE_JE_LAUF + 1);
  return rows.map(({ vo, p }) => ({
    id: vo.id,
    anzeige: `${[p.firstName, p.lastName].filter(Boolean).join(" ")} (#${p.number}) · VO ${vo.issuedAt.split("-").reverse().join(".")}`,
    issuedAt: vo.issuedAt,
    doctorLanr: vo.doctorLanr,
    doctorBsnr: vo.doctorBsnr,
    diagnosisGroup: vo.diagnosisGroup,
    icd10: vo.icd10,
    diagnosisText: vo.diagnosisText,
    leitsymptomatik: vo.leitsymptomatik,
    leitsymptomatikText: vo.leitsymptomatikText,
    homeVisit: vo.homeVisit,
    urgent: vo.urgent,
    copaymentExempt: vo.copaymentExempt,
    therapyReportRequested: vo.therapyReportRequested,
    externalRef: vo.externalRef,
    source: vo.source,
    insurerIk: vo.insurerIk,
    insuranceNumber: vo.insuranceNumber,
    insuredStatus: vo.insuredStatus,
    priceSnapshot: vo.priceSnapshot,
    // Kennzeichen Verordnungsart speichert PodoHero noch nicht (Schemafeld folgt) → fehlende Angabe, nie raten
    verordnungsart: null,
    patient: {
      lastName: p.lastName,
      firstName: p.firstName,
      birthDate: p.birthDate,
      street: p.street,
      zip: p.zip,
      city: p.city,
      insuranceNumber: p.insuranceNumber,
      insurerIk: p.insurerIk,
      insuredStatus: p.insuredStatus,
      copaymentExemptions: p.copaymentExemptions,
    },
  }));
}

function pruefeZugriff(auth: AuthContext): { error: string } | null {
  // Abrechnungsdaten enthalten Diagnosen (ICD-10) → zusätzlich medizinisches Leserecht
  assertCan(auth, "invoices.write", "medical.read");
  return gkvGuard(auth.organization, "gkvBilling");
}

/** Berliner Datum/Uhrzeit für UNB und Auftragsdatei */
export function berlinJetzt(d = new Date()): { datum: string; uhrzeit: string; sekunde: string } {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { datum: `${teile.year}-${teile.month}-${teile.day}`, uhrzeit: `${teile.hour}:${teile.minute}`, sekunde: teile.second };
}

/** Prüflauf (liest nur, vergibt keine Nummern). */
export async function pruefe302(auth: AuthContext, quelle: Gkv302Quelle, jetzt = berlinJetzt()): Promise<Pruefergebnis | { error: string }> {
  const blocked = pruefeZugriff(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  const [o] = await db.select(ORG_FELDER).from(organizations).where(eq(organizations.id, org));
  if (!o) return { error: "Praxis nicht gefunden." };
  const g = gkv302Einstellungen(o.settings);
  const kotr = await ladeKotr(org, g.kotr);
  const vos = await withOrg(org, (tx) => ladeVerordnungen(tx, org, quelle));
  if (!vos) return { error: "Abrechnungslauf nicht gefunden." };
  const e = pruefeFaelle(praxisAus(o), vos, kotr.dateien, jetzt.datum);
  e.kotrHinweise.push(...kotr.hinweise);
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "gkv302.pruefen",
    entity: quelle.art === "lauf" ? "billing_batch" : undefined,
    entityId: quelle.art === "lauf" ? quelle.batchId : undefined,
    meta: { quelle: quelle.art, faelle: e.faelle.length, ok: e.anzahlOk, fehlend: e.faelle.filter((f) => f.status === "fehlend").length, abweichung: e.faelle.filter((f) => f.status === "abweichung").length },
  });
  return e;
}

export type Testdownload = { dateiname: string; zip: Uint8Array; ausgeschlossen: number; dateien: number };

/**
 * Testpaket als ZIP: Nutzdatei(en) TSOL0nnn (unverschlüsselt), Auftragsdatei(en), Begleitzettel (Text + PDF) und
 * LIESMICH. Nummern (Test-Kreis) und Audit-Eintrag in derselben Transaktion; nur Fälle mit Status „ok“.
 */
export async function testpaket302(auth: AuthContext, quelle: Gkv302Quelle, jetzt = berlinJetzt()): Promise<Testdownload | { error: string }> {
  const blocked = pruefeZugriff(auth);
  if (blocked) return blocked;
  const org = auth.organization.id;
  const [vorab] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  if (!vorab) return { error: "Praxis nicht gefunden." };
  const kotr = await ladeKotr(org, gkv302Einstellungen(vorab.settings).kotr);
  const r = await withOrg(org, async (tx): Promise<{ error: string } | { paket: Testpaket; bytes: Uint8Array }> => {
    const settings = await sperreOrganisation(tx, org);
    const [o] = await tx.select(ORG_FELDER).from(organizations).where(eq(organizations.id, org));
    const vos = await ladeVerordnungen(tx, org, quelle);
    if (!vos) return { error: "Abrechnungslauf nicht gefunden." };
    const zaehler = istObjekt(settings.gkv302Zaehler) ? settings.gkv302Zaehler : {};
    const nummern = new Nummernkreis(zaehlerstandAus(zaehler.test), "T");
    let paket;
    try {
      paket = erzeugeTestpaket(praxisAus(o), vos, kotr.dateien, jetzt, nummern);
    } catch (e) {
      if (e instanceof TestpaketFehler) return { error: e.meldungen.slice(0, 20).join("\n") };
      throw e;
    }
    // ZIP und Begleitzettel-PDF noch in der Transaktion: scheitern sie, wird der Zählerstand nicht gespeichert
    const zip = new JSZip();
    for (const d of paket.dateien) zip.file(d.name, d.bytes, { date: new Date() });
    if (paket.begleitzettel.length) zip.file("Begleitzettel_TEST.pdf", await begleitzettelPdf(paket.begleitzettel, { test: true }));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    await setzeEinstellung(tx, org, "gkv302Zaehler", { ...zaehler, test: nummern.stand });
    await audit(
      {
        organizationId: org,
        userId: auth.user.id,
        action: "gkv302.testdatei",
        entity: quelle.art === "lauf" ? "billing_batch" : undefined,
        entityId: quelle.art === "lauf" ? quelle.batchId : undefined,
        meta: { quelle: quelle.art, ausgeschlossen: paket.ausgeschlossen, dateien: paket.uebersicht },
      },
      tx,
    );
    return { paket, bytes };
  });
  if ("error" in r) return r;
  const { paket, bytes } = r;
  return { dateiname: `TEST-302-${jetzt.datum}-${paket.uebersicht.map((u) => u.nutzdatei).join("_")}.zip`, zip: bytes, ausgeschlossen: paket.ausgeschlossen, dateien: paket.dateien.length };
}

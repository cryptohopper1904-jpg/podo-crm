/**
 * Import einer Heilmittel-eVerordnung als FHIR-R4-Bundle (KBV-ähnliche Struktur).
 *
 * Stand: Die Heilmittel-eVerordnung ist von der gematik angekündigt, aber noch nicht flächendeckend
 * verfügbar; die finalen KBV-Profile können abweichen. Der Parser ist deshalb bewusst defensiv:
 *  - nur die Ressourcen Patient, Practitioner, Organization, Coverage, Condition und die
 *    Verordnung selbst (ServiceRequest bzw. MedicationRequest-/DeviceRequest-ähnlich) werden gelesen,
 *  - Kennzeichen werden über Systeme/URLs mit Schlüsselwörtern erkannt (z. B. „kvid“, „ANR“, „BSNR“,
 *    „Diagnosegruppe“, „Leitsymptomatik“), unbekannte Felder werden ignoriert,
 *  - fehlende Angaben führen zu Hinweisen, nicht zum Abbruch – die Praxis prüft die Vorschau.
 * Reine Funktionen, keine DB.
 */
import { z } from "zod";

export const MAX_BUNDLE_BYTES = 1_000_000;
const MAX_ENTRIES = 300;

const DIAGNOSIS_GROUPS = ["DF", "NF", "QF", "UI1", "UI2"] as const;
export type ImportDiagnosisGroup = (typeof DIAGNOSIS_GROUPS)[number];

// ───────────── lose Schemas (unbekannte Felder werden ignoriert) ─────────────
const str = z.string().max(2000);
const coding = z.looseObject({ system: str.optional(), code: str.optional(), display: str.optional() });
const codeableConcept = z.looseObject({ coding: z.array(coding).max(50).optional(), text: str.optional() });
const identifier = z.looseObject({ system: str.optional(), value: str.optional(), type: codeableConcept.optional() });
const reference = z.looseObject({ reference: str.optional(), display: str.optional(), identifier: identifier.optional() });
const humanName = z.looseObject({ use: str.optional(), text: str.optional(), family: str.optional(), given: z.array(str).max(10).optional(), prefix: z.array(str).max(10).optional() });
const quantity = z.looseObject({ value: z.number().optional(), unit: str.optional() });
type Extension = { url?: string; extension?: Extension[] } & Record<string, unknown>;
const extension: z.ZodType<Extension> = z.lazy(() => z.looseObject({ url: str.optional(), extension: z.array(extension).max(50).optional() }));

const resource = z.looseObject({ resourceType: z.string().max(100), id: str.optional() });
export const bundleSchema = z.looseObject({
  resourceType: z.literal("Bundle", { message: "Keine FHIR-Bundle-Datei (resourceType ≠ Bundle)." }),
  id: str.optional(),
  meta: z.looseObject({ profile: z.array(str).max(20).optional() }).optional(),
  identifier: identifier.optional(),
  type: str.optional(),
  timestamp: str.optional(),
  entry: z
    .array(z.looseObject({ fullUrl: str.optional(), resource: resource.optional() }))
    .min(1, "Das Bundle enthält keine Einträge.")
    .max(MAX_ENTRIES, `Höchstens ${MAX_ENTRIES} Einträge.`),
});

const patientSchema = z.looseObject({
  identifier: z.array(identifier).max(20).optional(),
  name: z.array(humanName).max(10).optional(),
  birthDate: str.optional(),
  gender: str.optional(),
  address: z.array(z.looseObject({ line: z.array(str).max(5).optional(), postalCode: str.optional(), city: str.optional() })).max(5).optional(),
});
const practitionerSchema = z.looseObject({ identifier: z.array(identifier).max(20).optional(), name: z.array(humanName).max(10).optional() });
const organizationSchema = z.looseObject({ identifier: z.array(identifier).max(20).optional(), name: str.optional(), telecom: z.array(z.looseObject({ system: str.optional(), value: str.optional() })).max(10).optional() });
const coverageSchema = z.looseObject({
  type: codeableConcept.optional(),
  payor: z.array(reference).max(5).optional(),
  extension: z.array(extension).max(50).optional(),
});
const conditionSchema = z.looseObject({ code: codeableConcept.optional() });
const requestSchema = z.looseObject({
  status: str.optional(),
  intent: str.optional(),
  priority: str.optional(),
  authoredOn: str.optional(),
  category: z.array(codeableConcept).max(20).optional(),
  code: codeableConcept.optional(),
  medicationCodeableConcept: codeableConcept.optional(),
  quantityQuantity: quantity.optional(),
  dispenseRequest: z.looseObject({ quantity: quantity.optional() }).optional(),
  occurrenceTiming: z.looseObject({ repeat: z.looseObject({ frequency: z.number().optional(), period: z.number().optional(), periodMax: z.number().optional(), periodUnit: str.optional() }).optional(), code: codeableConcept.optional() }).optional(),
  reasonCode: z.array(codeableConcept).max(20).optional(),
  reasonReference: z.array(reference).max(20).optional(),
  extension: z.array(extension).max(50).optional(),
  note: z.array(z.looseObject({ text: str.optional() })).max(10).optional(),
  orderDetail: z.array(codeableConcept).max(20).optional(),
});

// ───────────── Ergebnis ─────────────
export interface EverordnungRemedy {
  code: string | null;
  display: string;
  units: number | null;
}

export interface EverordnungSummary {
  /** eindeutige Referenz der eVerordnung (Bundle-Identifier, sonst Bundle-ID) → prescriptions.external_ref */
  externalRef: string;
  identifierSystem: string | null;
  profile: string | null;
  /** YYYY-MM-DD */
  issuedAt: string | null;
  patient: {
    lastName: string | null;
    firstName: string | null;
    birthDate: string | null;
    gender: "female" | "male" | "diverse" | "unknown";
    kvnr: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
  };
  coverage: { insurerName: string | null; ik: string | null; kind: "gkv" | "pkv" | "beihilfe" | "self" | null; copaymentExempt: boolean };
  practitioner: { name: string | null; lanr: string | null };
  organization: { name: string | null; bsnr: string | null };
  diagnoses: { code: string; display: string | null }[];
  diagnosisGroup: ImportDiagnosisGroup | null;
  diagnosisGroupInferred: boolean;
  leitsymptomatik: string | null;
  remedies: EverordnungRemedy[];
  units: number | null;
  frequency: string | null;
  homeVisit: boolean;
  urgent: boolean;
  therapyReport: boolean;
  note: string | null;
  warnings: string[];
}

export type ParseResult = { ok: true; summary: EverordnungSummary } | { ok: false; error: string };

// ───────────── Hilfen ─────────────
const has = (s: string | undefined, ...keys: string[]) => !!s && keys.some((k) => s.toLowerCase().includes(k.toLowerCase()));
const clip = (s: string | null | undefined, n = 200) => (s ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n) || null : null);
const isoDate = (s: string | undefined | null) => {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})/);
  return m && !Number.isNaN(new Date(m[1]).getTime()) ? m[1] : null;
};

function nameOf(names: z.infer<typeof humanName>[] | undefined) {
  const n = names?.find((x) => x.use === "official") ?? names?.[0];
  if (!n) return { family: null, given: null, text: null };
  const family = clip(n.family, 120);
  const given = clip(n.given?.join(" "), 120);
  const text = clip(n.text, 200) ?? (clip([...(n.prefix ?? []), given, family].filter(Boolean).join(" "), 200));
  return { family, given, text };
}

/** Alle (verschachtelten) Extensions flach, mit voller URL-Kette. */
function flatExtensions(list: Extension[] | undefined, prefix = ""): { url: string; ext: Extension }[] {
  const out: { url: string; ext: Extension }[] = [];
  for (const e of list ?? []) {
    const url = `${prefix}${prefix ? ">" : ""}${e.url ?? ""}`;
    out.push({ url, ext: e });
    if (e.extension) out.push(...flatExtensions(e.extension, url));
  }
  return out;
}

function extValue(e: Extension): { code: string | null; display: string | null; bool: boolean | null; num: number | null } {
  const vc = coding.safeParse(e.valueCoding);
  const vcc = codeableConcept.safeParse(e.valueCodeableConcept);
  const c = vc.success ? vc.data : vcc.success ? vcc.data.coding?.[0] : undefined;
  const q = quantity.safeParse(e.valueQuantity);
  return {
    code: clip(c?.code ?? (typeof e.valueCode === "string" ? e.valueCode : null), 50),
    display: clip(c?.display ?? (vcc.success ? vcc.data.text : undefined) ?? (typeof e.valueString === "string" ? e.valueString : null), 500),
    bool: typeof e.valueBoolean === "boolean" ? e.valueBoolean : null,
    num: typeof e.valuePositiveInt === "number" ? e.valuePositiveInt : typeof e.valueInteger === "number" ? e.valueInteger : q.success && typeof q.data.value === "number" ? q.data.value : null,
  };
}

const ICD_SYSTEM = (s?: string) => has(s, "icd-10", "icd10");
const ICD_RE = /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?[GVZA+*!]?$/;

function icdCodes(cc: z.infer<typeof codeableConcept> | undefined): { code: string; display: string | null }[] {
  const out: { code: string; display: string | null }[] = [];
  for (const c of cc?.coding ?? []) {
    const code = c.code?.trim().toUpperCase();
    if (code && (ICD_SYSTEM(c.system) || ICD_RE.test(code))) out.push({ code: code.slice(0, 20), display: clip(c.display) });
  }
  return out;
}

function asGroup(v: string | null | undefined): ImportDiagnosisGroup | null {
  const u = v?.trim().toUpperCase();
  return (DIAGNOSIS_GROUPS as readonly string[]).includes(u ?? "") ? (u as ImportDiagnosisGroup) : null;
}

function frequencyText(t: z.infer<typeof requestSchema>["occurrenceTiming"]): string | null {
  const r = t?.repeat;
  if (r?.frequency && r.period) {
    const unit = r.periodUnit === "wk" ? "Wochen" : r.periodUnit === "d" ? "Tage" : r.periodUnit === "mo" ? "Monate" : r.periodUnit ?? "";
    if (r.period === 1 && !r.periodMax) return `${r.frequency}x ${r.periodUnit === "wk" ? "pro Woche" : `je ${unit}`}`.slice(0, 80);
    return `${r.frequency}x alle ${r.period}${r.periodMax ? `-${r.periodMax}` : ""} ${unit}`.trim().slice(0, 80);
  }
  return clip(t?.code?.text ?? t?.code?.coding?.[0]?.display, 80);
}

const REQUEST_TYPES = new Set(["ServiceRequest", "MedicationRequest", "DeviceRequest", "NutritionOrder"]);

// ───────────── Parser ─────────────
export function parseEverordnungText(text: string): ParseResult {
  if (Buffer.byteLength(text, "utf8") > MAX_BUNDLE_BYTES) return { ok: false, error: "Datei ist größer als 1 MB." };
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { ok: false, error: "Keine gültige JSON-Datei. Erwartet wird ein FHIR-Bundle im JSON-Format (XML wird nicht unterstützt)." };
  }
  return parseEverordnungBundle(json);
}

export function parseEverordnungBundle(json: unknown): ParseResult {
  const b = bundleSchema.safeParse(json);
  if (!b.success) return { ok: false, error: b.error.issues[0]?.message ?? "Ungültiges FHIR-Bundle." };
  const bundle = b.data;
  const warnings: string[] = [];
  const resources = bundle.entry.map((e) => e.resource).filter((r): r is NonNullable<typeof r> => !!r);
  const byType = (t: string) => resources.filter((r) => r.resourceType === t);
  const byRef = (ref: string | undefined) => {
    if (!ref) return undefined;
    const [type, id] = ref.replace(/^urn:uuid:/, "").split("/").slice(-2);
    return bundle.entry.find((e) => e.fullUrl === ref || e.fullUrl?.endsWith(ref) || (e.resource?.resourceType === type && e.resource?.id === id) || e.resource?.id === ref.replace(/^urn:uuid:/, ""))?.resource;
  };

  // Identifikation
  const externalRef = clip(bundle.identifier?.value, 120) ?? clip(bundle.id, 120);
  if (!externalRef) return { ok: false, error: "Die eVerordnung hat keine Kennung (Bundle.identifier bzw. Bundle.id) – Import nicht möglich." };

  // Verordnung(en)
  const requests = resources.filter((r) => REQUEST_TYPES.has(r.resourceType)).map((r) => requestSchema.safeParse(r)).filter((r) => r.success).map((r) => r.data);
  if (!requests.length) return { ok: false, error: "Keine Verordnung im Bundle gefunden (erwartet: ServiceRequest o. Ä.)." };

  // Patient
  const pRes = patientSchema.safeParse(byType("Patient")[0] ?? {});
  const p = pRes.success ? pRes.data : {};
  const pName = nameOf(p.name);
  const kvnrRaw = p.identifier?.find((i) => has(i.system, "kvid", "kvnr") || i.type?.coding?.some((c) => c.code === "GKV" || c.code === "KVZ10"))?.value;
  const kvnr = kvnrRaw && /^[A-Z]\d{9}$/.test(kvnrRaw.trim().toUpperCase()) ? kvnrRaw.trim().toUpperCase() : null;
  if (kvnrRaw && !kvnr) warnings.push("Versichertennummer (KVNR) hat ein unerwartetes Format und wurde nicht übernommen.");
  if (!pName.family) warnings.push("Name der Patientin/des Patienten fehlt.");
  const addr = p.address?.[0];
  const gender = p.gender === "female" ? "female" : p.gender === "male" ? "male" : p.gender === "other" ? "diverse" : "unknown";

  // Kostenträger
  const covRes = coverageSchema.safeParse(byType("Coverage")[0] ?? {});
  const cov = covRes.success ? covRes.data : {};
  const payor = cov.payor?.[0];
  const ikRaw = payor?.identifier?.value?.trim();
  const covType = cov.type?.coding?.[0]?.code?.toUpperCase();
  const covExt = flatExtensions(cov.extension);
  const copayExt = covExt.find((e) => has(e.url, "zuzahlung") && (extValue(e.ext).bool !== null || extValue(e.ext).code !== null));
  const copayVal = copayExt ? extValue(copayExt.ext) : null;

  // Arzt / Betriebsstätte
  const prRes = practitionerSchema.safeParse(byType("Practitioner")[0] ?? {});
  const pr = prRes.success ? prRes.data : {};
  const lanrRaw = pr.identifier?.find((i) => has(i.system, "anr", "lanr") || i.type?.coding?.some((c) => c.code === "LANR"))?.value?.trim();
  const lanr = lanrRaw && /^\d{9}$/.test(lanrRaw) ? lanrRaw : null;
  if (lanrRaw && !lanr) warnings.push("LANR hat nicht 9 Ziffern und wurde nicht übernommen.");
  const orgRes = organizationSchema.safeParse(byType("Organization").find((o) => (o as { identifier?: { system?: string }[] }).identifier?.some((i) => has(i.system, "bsnr"))) ?? byType("Organization")[0] ?? {});
  const org = orgRes.success ? orgRes.data : {};
  const bsnrRaw = org.identifier?.find((i) => has(i.system, "bsnr") || i.type?.coding?.some((c) => c.code === "BSNR"))?.value?.trim();
  const bsnr = bsnrRaw && /^\d{9}$/.test(bsnrRaw) ? bsnrRaw : null;
  if (bsnrRaw && !bsnr) warnings.push("BSNR hat nicht 9 Ziffern und wurde nicht übernommen.");

  // Diagnosen: Condition-Ressourcen (referenziert oder im Bundle) + reasonCode
  const diagnoses: { code: string; display: string | null }[] = [];
  const pushDx = (list: { code: string; display: string | null }[]) => {
    for (const d of list) if (!diagnoses.some((x) => x.code === d.code)) diagnoses.push(d);
  };
  for (const r of requests) {
    for (const rc of r.reasonCode ?? []) pushDx(icdCodes(rc));
    for (const ref of r.reasonReference ?? []) {
      const c = conditionSchema.safeParse(byRef(ref.reference) ?? {});
      if (c.success) pushDx(icdCodes(c.data.code));
    }
  }
  for (const c of byType("Condition")) {
    const cs = conditionSchema.safeParse(c);
    if (cs.success) pushDx(icdCodes(cs.data.code));
  }
  if (!diagnoses.length) warnings.push("Kein ICD-10-Code gefunden – für die Abrechnung erforderlich.");

  // Diagnosegruppe, Leitsymptomatik, Kennzeichen (Extensions, Kategorien)
  let diagnosisGroup: ImportDiagnosisGroup | null = null;
  let leitsymptomatik: string | null = null;
  let homeVisit = false;
  let urgent = false;
  let therapyReport = false;
  let extUnits: number | null = null;
  let extFrequency: string | null = null;
  for (const r of requests) {
    for (const { url, ext } of flatExtensions(r.extension)) {
      const v = extValue(ext);
      if (has(url, "diagnosegruppe", "diagnosisgroup")) diagnosisGroup ??= asGroup(v.code ?? v.display);
      else if (has(url, "leitsymptom")) leitsymptomatik ??= clip([v.code, v.display].filter(Boolean).join(" – "), 500);
      else if (has(url, "hausbesuch", "homevisit")) homeVisit ||= v.bool === true;
      else if (has(url, "dringlich", "urgent")) urgent ||= v.bool === true;
      else if (has(url, "therapiebericht")) therapyReport ||= v.bool === true;
      else if (has(url, "einheiten", "behandlungseinheit", "anzahl", "menge")) extUnits ??= v.num;
      else if (has(url, "frequenz", "frequency")) extFrequency ??= clip(v.display ?? v.code, 80);
    }
    if (r.priority === "urgent" || r.priority === "asap" || r.priority === "stat") urgent = true;
    for (const cc of [...(r.category ?? []), ...(r.orderDetail ?? [])]) {
      for (const c of cc.coding ?? []) diagnosisGroup ??= asGroup(c.code);
    }
  }
  let diagnosisGroupInferred = false;
  if (!diagnosisGroup) {
    // Ableitung aus ICD-10 nur als Vorschlag (DF bei diabetischem Fußsyndrom), UI1/UI2 nicht ableitbar
    if (diagnoses.some((d) => /^E1[0-4]\.7/.test(d.code))) {
      diagnosisGroup = "DF";
      diagnosisGroupInferred = true;
      warnings.push("Diagnosegruppe nicht angegeben – aus ICD-10 als „DF“ vorgeschlagen, bitte prüfen.");
    } else warnings.push("Diagnosegruppe nicht erkannt – bitte in der Vorschau auswählen.");
  }

  // Heilmittel/Positionen
  const remedies: EverordnungRemedy[] = [];
  for (const r of requests) {
    const cc = r.code ?? r.medicationCodeableConcept;
    const c = cc?.coding?.find((x) => x.code || x.display) ?? null;
    const display = clip(c?.display ?? cc?.text, 200) ?? clip(c?.code, 50);
    if (!display) continue;
    const qty = r.quantityQuantity?.value ?? r.dispenseRequest?.quantity?.value ?? null;
    remedies.push({ code: clip(c?.code, 20), display, units: typeof qty === "number" && Number.isInteger(qty) && qty > 0 && qty < 100 ? qty : null });
  }
  if (!remedies.length) warnings.push("Kein Heilmittel erkannt – bitte nach dem Import ergänzen.");
  const sumUnits = remedies.reduce((s, x) => s + (x.units ?? 0), 0);
  const units = extUnits && extUnits > 0 && extUnits < 100 ? extUnits : sumUnits > 0 ? sumUnits : null;
  if (!units) warnings.push("Anzahl der Behandlungseinheiten fehlt.");
  const frequency = extFrequency ?? requests.map((r) => frequencyText(r.occurrenceTiming)).find(Boolean) ?? null;

  // Ausstellungsdatum
  const composition = byType("Composition")[0] as { date?: unknown } | undefined;
  const issuedAt = requests.map((r) => isoDate(r.authoredOn)).find(Boolean) ?? isoDate(typeof composition?.date === "string" ? composition.date : null) ?? isoDate(bundle.timestamp);
  if (!issuedAt) warnings.push("Ausstellungsdatum fehlt.");

  return {
    ok: true,
    summary: {
      externalRef,
      identifierSystem: clip(bundle.identifier?.system, 200),
      profile: clip(bundle.meta?.profile?.[0], 200),
      issuedAt,
      patient: {
        lastName: pName.family,
        firstName: pName.given,
        birthDate: isoDate(p.birthDate),
        gender,
        kvnr,
        street: clip(addr?.line?.join(" "), 200),
        zip: clip(addr?.postalCode, 10),
        city: clip(addr?.city, 100),
      },
      coverage: {
        insurerName: clip(payor?.display, 200),
        ik: ikRaw && /^\d{9}$/.test(ikRaw) ? ikRaw : null,
        kind: covType === "GKV" ? "gkv" : covType === "PKV" ? "pkv" : covType === "BG" || covType === "SEL" ? "self" : covType ? null : "gkv",
        copaymentExempt: copayVal?.bool === true || copayVal?.code === "1",
      },
      practitioner: { name: nameOf(pr.name).text, lanr },
      organization: { name: clip(org.name, 200), bsnr },
      diagnoses: diagnoses.slice(0, 10),
      diagnosisGroup,
      diagnosisGroupInferred,
      leitsymptomatik,
      remedies: remedies.slice(0, 10),
      units,
      frequency,
      homeVisit,
      urgent,
      therapyReport,
      note: clip(requests.flatMap((r) => r.note ?? []).map((n) => n.text).filter(Boolean).join(" "), 500),
      warnings,
    },
  };
}

/** Verdichtete Zusammenfassung für prescriptions.import_data – ohne Rohdaten, ohne Adresse/Name. */
export function condensedImportData(s: EverordnungSummary, importedAt = new Date()) {
  return {
    format: "fhir-r4-bundle",
    profile: s.profile,
    identifierSystem: s.identifierSystem,
    externalRef: s.externalRef,
    importedAt: importedAt.toISOString(),
    issuedAt: s.issuedAt,
    kvnr: s.patient.kvnr,
    coverage: { insurerName: s.coverage.insurerName, ik: s.coverage.ik, kind: s.coverage.kind },
    practitioner: s.practitioner,
    organization: s.organization,
    diagnoses: s.diagnoses,
    diagnosisGroup: s.diagnosisGroup,
    diagnosisGroupInferred: s.diagnosisGroupInferred,
    leitsymptomatik: s.leitsymptomatik,
    remedies: s.remedies,
    units: s.units,
    frequency: s.frequency,
    flags: { homeVisit: s.homeVisit, urgent: s.urgent, therapyReport: s.therapyReport, copaymentExempt: s.coverage.copaymentExempt },
    warnings: s.warnings,
  };
}

/** Positionen für die Verordnung aus den Heilmitteln (5-stellige Positionsnummer, sonst nur Bezeichnung). */
export function positionsFrom(s: EverordnungSummary, units: number): { position?: string; label: string; units: number }[] {
  const list = s.remedies.map((r) => ({
    ...(r.code && /^\d{5}$/.test(r.code) ? { position: r.code } : {}),
    label: r.display,
    units: Math.min(r.units ?? units, units),
  }));
  return list.length ? list : [{ label: "Podologische Behandlung (aus eVerordnung)", units }];
}

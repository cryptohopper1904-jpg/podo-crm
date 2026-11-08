/**
 * Strukturierte Anamnese (indikationsabhängig, Datensparsamkeit nach Review 14.1):
 * - Basisfragen immer
 * - Diabetes-Block (Typ, HbA1c optional, Insulin) NUR wenn Diabetes angekreuzt
 * - Sensibilitätsbefunde (Monofilament/Stimmgabel) NUR wenn getestet
 * - IWGDF-Risikoklasse (0–3) NUR bei Diabetes
 * Felder, die nicht zur Indikation passen, werden beim Speichern verworfen (nicht nur ausgeblendet).
 * Gespeichert wird je Erfassung eine neue Zeile in `anamneses` (append-only = Versionen).
 */
import { z } from "zod";
import type { RiskFlags } from "@/db/schema";

export const ANAMNESIS_VERSION = "2026-11";
/** Rydel-Seiffer-Stimmgabel (128 Hz, Skala 0–8): Werte ≤ diesem Grenzwert gelten als vermindert */
export const TUNING_FORK_ABNORMAL_MAX = 4;

export type AnamnesisSource = "practice" | "online";
export type SensResult = "normal" | "reduced" | "absent";

export type AnamnesisData = {
  schemaVersion: string;
  source: AnamnesisSource;
  diabetes: boolean;
  diabetesType?: "1" | "2" | "other" | "unknown";
  diabetesSince?: string;
  hba1c?: number;
  insulin?: boolean;
  pavk: boolean;
  neuropathy: boolean;
  sensTested?: boolean;
  monofilamentLeft?: SensResult;
  monofilamentRight?: SensResult;
  tuningForkLeft?: number;
  tuningForkRight?: number;
  anticoagulation: boolean;
  anticoagulant?: string;
  allergies?: string;
  allergyLatex: boolean;
  allergyDisinfectant: boolean;
  medications?: string;
  mrsa: boolean;
  otherInfections?: string;
  ulcerHistory: boolean;
  amputation: boolean;
  dialysis: boolean;
  deformity: boolean;
  footwear?: string;
  insoles: boolean;
  iwgdfRisk?: 0 | 1 | 2 | 3;
  notes?: string;
};

const bool = z.preprocess((v) => v === "on" || v === "1" || v === "true" || v === true, z.boolean());
const text = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || undefined : v), z.string().max(max, `Text zu lang (max. ${max} Zeichen)`).optional());
const sens = z.preprocess((v) => (v === "" ? undefined : v), z.enum(["normal", "reduced", "absent"]).optional());
const fork = z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.coerce.number().int().min(0).max(8).optional());

const raw = z.object({
  diabetes: bool,
  diabetesType: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["1", "2", "other", "unknown"]).optional()),
  diabetesSince: z.preprocess((v) => (typeof v === "string" ? v.trim() || undefined : v), z.string().regex(/^(19|20)\d{2}$/, "Diabetes seit: bitte Jahr (JJJJ)").optional()),
  hba1c: z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() || undefined : v), z.coerce.number().min(3, "HbA1c unplausibel").max(20, "HbA1c unplausibel").optional()),
  insulin: bool,
  pavk: bool,
  neuropathy: bool,
  sensTested: bool,
  monofilamentLeft: sens,
  monofilamentRight: sens,
  tuningForkLeft: fork,
  tuningForkRight: fork,
  anticoagulation: bool,
  anticoagulant: text(200),
  allergies: text(500),
  allergyLatex: bool,
  allergyDisinfectant: bool,
  medications: text(2000),
  mrsa: bool,
  otherInfections: text(300),
  ulcerHistory: bool,
  amputation: bool,
  dialysis: bool,
  deformity: bool,
  footwear: text(300),
  insoles: bool,
  iwgdfRisk: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.coerce.number().int().min(0).max(3).optional()),
  notes: text(2000),
});

/** Felder, die nur die Praxis erfasst (nicht im Online-Bogen) */
const PRACTICE_ONLY = ["sensTested", "monofilamentLeft", "monofilamentRight", "tuningForkLeft", "tuningForkRight", "iwgdfRisk"] as const;

/** Liest Formularwerte, entfernt Felder außerhalb der Indikation. */
export function parseAnamnesis(input: Record<string, unknown>, source: AnamnesisSource): { ok: true; data: AnamnesisData } | { ok: false; error: string } {
  const parsed = raw.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  const data: AnamnesisData = {
    schemaVersion: ANAMNESIS_VERSION,
    source,
    diabetes: d.diabetes,
    pavk: d.pavk,
    neuropathy: d.neuropathy,
    anticoagulation: d.anticoagulation,
    allergyLatex: d.allergyLatex,
    allergyDisinfectant: d.allergyDisinfectant,
    mrsa: d.mrsa,
    ulcerHistory: d.ulcerHistory,
    amputation: d.amputation,
    dialysis: d.dialysis,
    deformity: d.deformity,
    insoles: d.insoles,
  };
  const set = <K extends keyof AnamnesisData>(k: K, v: AnamnesisData[K] | undefined) => {
    if (v !== undefined) data[k] = v;
  };
  if (d.diabetes) {
    set("diabetesType", d.diabetesType ?? "unknown");
    set("diabetesSince", d.diabetesSince);
    set("hba1c", d.hba1c);
    set("insulin", d.insulin);
  }
  if (d.anticoagulation) set("anticoagulant", d.anticoagulant);
  set("allergies", d.allergies);
  set("medications", d.medications);
  set("otherInfections", d.otherInfections);
  set("footwear", d.footwear);
  set("notes", d.notes);
  if (source === "practice") {
    if (d.sensTested) {
      data.sensTested = true;
      set("monofilamentLeft", d.monofilamentLeft);
      set("monofilamentRight", d.monofilamentRight);
      set("tuningForkLeft", d.tuningForkLeft);
      set("tuningForkRight", d.tuningForkRight);
    }
    if (d.diabetes && d.iwgdfRisk !== undefined) data.iwgdfRisk = d.iwgdfRisk as 0 | 1 | 2 | 3;
  } else {
    for (const k of PRACTICE_ONLY) delete (data as Record<string, unknown>)[k];
  }
  return { ok: true, data };
}

/** Schutzsensibilität vermindert (LOPS) laut Angabe oder Testbefund */
export function hasLops(d: Pick<AnamnesisData, "neuropathy" | "sensTested" | "monofilamentLeft" | "monofilamentRight" | "tuningForkLeft" | "tuningForkRight">): boolean {
  if (d.neuropathy) return true;
  if (!d.sensTested) return false;
  const mono = [d.monofilamentLeft, d.monofilamentRight].some((m) => m === "reduced" || m === "absent");
  const forkLow = [d.tuningForkLeft, d.tuningForkRight].some((f) => f !== undefined && f <= TUNING_FORK_ABNORMAL_MAX);
  return mono || forkLow;
}

/**
 * Vorschlag IWGDF-Risikoklasse (IWGDF 2023 / NVL Typ-2-Diabetes Fußkomplikationen):
 * 0 = kein LOPS, keine pAVK · 1 = LOPS oder pAVK · 2 = LOPS + pAVK, oder LOPS/pAVK + Fußdeformität
 * 3 = LOPS oder pAVK + Ulkus/Amputation in der Vorgeschichte oder terminale Niereninsuffizienz (Dialyse).
 * Nur Hilfestellung – die Einstufung trifft die Fachkraft (keine automatisierte medizinische Bewertung, MDR).
 */
export function suggestIwgdfRisk(d: { lops: boolean; pad: boolean; deformity: boolean; ulcerHistory: boolean; amputation: boolean; dialysis: boolean }): 0 | 1 | 2 | 3 {
  const base = d.lops || d.pad;
  if (base && (d.ulcerHistory || d.amputation || d.dialysis)) return 3;
  if ((d.lops && d.pad) || (d.lops && d.deformity) || (d.pad && d.deformity)) return 2;
  if (base) return 1;
  return 0;
}

export const IWGDF_LABEL: Record<number, string> = {
  0: "0 – sehr geringes Risiko (Kontrolle 1× jährlich)",
  1: "1 – geringes Risiko (alle 6–12 Monate)",
  2: "2 – mittleres Risiko (alle 3–6 Monate)",
  3: "3 – hohes Risiko (alle 1–3 Monate)",
};

const DIABETES_TYPE_LABEL: Record<string, string> = { "1": "Typ 1", "2": "Typ 2", other: "andere Form", unknown: "Typ unbekannt" };

/** Risiko-Flags am Patienten aus der Anamnese ableiten (andere Angaben bleiben erhalten). */
export function riskFlagsFromAnamnesis(d: AnamnesisData, existing: RiskFlags = {}): RiskFlags {
  const allergies = [d.allergyLatex ? "Latex" : null, d.allergyDisinfectant ? "Desinfektionsmittel" : null, d.allergies ?? null].filter(Boolean).join(", ");
  return {
    ...existing,
    diabetes: d.diabetes,
    diabetesType: d.diabetes ? DIABETES_TYPE_LABEL[d.diabetesType ?? "unknown"] : undefined,
    anticoagulation: d.anticoagulation,
    pavk: d.pavk,
    neuropathy: hasLops(d),
    mrsa: d.mrsa,
    allergies: allergies || undefined,
  };
}

/** Lesbare Zusammenfassung (Akte, Verlauf) */
export function anamnesisSummary(d: AnamnesisData): [string, string][] {
  const yes = (b: boolean | undefined) => (b ? "ja" : "nein");
  const sensLabel: Record<SensResult, string> = { normal: "normal", reduced: "vermindert", absent: "aufgehoben" };
  const rows: [string, string | undefined][] = [
    ["Diabetes", d.diabetes ? [DIABETES_TYPE_LABEL[d.diabetesType ?? "unknown"], d.diabetesSince ? `seit ${d.diabetesSince}` : null, d.hba1c !== undefined ? `HbA1c ${String(d.hba1c).replace(".", ",")} %` : null, d.insulin ? "Insulin" : null].filter(Boolean).join(" · ") : "nein"],
    ["pAVK / Durchblutungsstörung", yes(d.pavk)],
    ["Neuropathie (bekannt)", yes(d.neuropathy)],
    ["Sensibilität", d.sensTested ? [
      d.monofilamentLeft || d.monofilamentRight ? `Monofilament li ${d.monofilamentLeft ? sensLabel[d.monofilamentLeft] : "–"} / re ${d.monofilamentRight ? sensLabel[d.monofilamentRight] : "–"}` : null,
      d.tuningForkLeft !== undefined || d.tuningForkRight !== undefined ? `Stimmgabel li ${d.tuningForkLeft ?? "–"}/8 · re ${d.tuningForkRight ?? "–"}/8` : null,
    ].filter(Boolean).join(" · ") || "getestet" : undefined],
    ["Blutverdünner", d.anticoagulation ? (d.anticoagulant ? `ja (${d.anticoagulant})` : "ja") : "nein"],
    ["Allergien", [d.allergyLatex ? "Latex" : null, d.allergyDisinfectant ? "Desinfektionsmittel" : null, d.allergies].filter(Boolean).join(", ") || "keine bekannt"],
    ["Medikamente", d.medications],
    ["MRSA", yes(d.mrsa)],
    ["Weitere Infektionen", d.otherInfections],
    ["Ulkus/Wunde früher", yes(d.ulcerHistory)],
    ["Amputation", yes(d.amputation)],
    ["Dialyse", yes(d.dialysis)],
    ["Fußfehlstellung", yes(d.deformity)],
    ["Schuhe", d.footwear],
    ["Einlagen", yes(d.insoles)],
    ["IWGDF-Risikoklasse", d.iwgdfRisk !== undefined ? IWGDF_LABEL[d.iwgdfRisk] : undefined],
    ["Notizen", d.notes],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]);
}

/**
 * Vorbelegung der Erstanamnese aus den Risikomerkmalen der Kundenakte.
 * Verhindert, dass beim ersten Speichern (mit „Risikomerkmale übernehmen“) bekannte Risiken
 * wie Diabetes oder Blutverdünner versehentlich aus der Akte gelöscht werden.
 */
export function initialFromRiskFlags(flags: {
  diabetes?: boolean;
  diabetesType?: string;
  anticoagulation?: boolean;
  pavk?: boolean;
  neuropathy?: boolean;
  mrsa?: boolean;
  allergies?: string;
}): Partial<AnamnesisData> {
  const t = flags.diabetesType ?? "";
  const diabetesType: AnamnesisData["diabetesType"] = /1/.test(t) ? "1" : /2/.test(t) ? "2" : t ? "other" : undefined;
  return {
    diabetes: !!flags.diabetes,
    diabetesType: flags.diabetes ? diabetesType ?? "unknown" : undefined,
    anticoagulation: !!flags.anticoagulation,
    pavk: !!flags.pavk,
    neuropathy: !!flags.neuropathy,
    mrsa: !!flags.mrsa,
    allergies: flags.allergies || undefined,
  };
}

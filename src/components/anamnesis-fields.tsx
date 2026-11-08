"use client";

import { useState, type ChangeEvent } from "react";
import type { AnamnesisData } from "@/lib/anamnesis";
import { IWGDF_LABEL, hasLops, suggestIwgdfRisk } from "@/lib/anamnesis";
import { Card, Checkbox, Field, Input, Select, Textarea } from "./ui";

type Mode = "practice" | "online";

/** Texte: Praxis (Fachsprache) vs. Online-Bogen (patientenfreundlich) */
const T = {
  practice: {
    base: "Basisangaben",
    diabetes: "Diabetes mellitus",
    pavk: "pAVK / arterielle Durchblutungsstörung",
    neuropathy: "Neuropathie bekannt",
    anticoagulation: "Antikoagulation / Thrombozytenaggregationshemmer",
    anticoagulant: "Präparat",
    allergyLatex: "Latexallergie",
    allergyDisinfectant: "Allergie gegen Desinfektionsmittel",
    allergies: "Weitere Allergien / Unverträglichkeiten",
    medications: "Medikation",
    mrsa: "MRSA / multiresistente Erreger",
    otherInfections: "Weitere Infektionen (z. B. Hepatitis)",
    history: "Vorgeschichte",
    ulcerHistory: "Ulkus in der Vorgeschichte",
    amputation: "Amputation (Minor/Major)",
    dialysis: "Terminale Niereninsuffizienz / Dialyse",
    deformity: "Fußdeformität (z. B. Hallux valgus, Hammerzehen, Charcot)",
    shoes: "Schuhversorgung",
    footwear: "Schuhe (Art, orthopädisch, diabetesadaptiert)",
    insoles: "Einlagen",
    diabetesBlock: "Diabetes",
    diabetesType: "Typ",
    diabetesSince: "Seit (Jahr)",
    hba1c: "HbA1c in % (optional)",
    insulin: "Insulintherapie",
    notes: "Notizen",
  },
  online: {
    base: "Ihre Gesundheit",
    diabetes: "Ich habe Diabetes (Zucker)",
    pavk: "Ich habe Durchblutungsstörungen in den Beinen (z. B. Schaufensterkrankheit)",
    neuropathy: "Ich habe Taubheitsgefühle oder Kribbeln in den Füßen (Nervenschädigung)",
    anticoagulation: "Ich nehme blutverdünnende Medikamente",
    anticoagulant: "Welches Medikament? (z. B. ASS, Marcumar, Eliquis)",
    allergyLatex: "Ich bin allergisch gegen Latex",
    allergyDisinfectant: "Ich vertrage Desinfektionsmittel nicht",
    allergies: "Weitere Allergien oder Unverträglichkeiten",
    medications: "Welche Medikamente nehmen Sie regelmäßig?",
    mrsa: "Bei mir wurde MRSA oder ein anderer resistenter Keim festgestellt",
    otherInfections: "Andere ansteckende Erkrankungen (z. B. Hepatitis)",
    history: "Frühere Fußprobleme",
    ulcerHistory: "Ich hatte schon einmal eine offene Wunde am Fuß",
    amputation: "Mir wurde schon einmal ein Zeh oder ein Teil des Fußes amputiert",
    dialysis: "Ich bin Dialysepatient:in",
    deformity: "Ich habe eine Fehlstellung am Fuß (z. B. Ballenzeh, Hammerzehen)",
    shoes: "Schuhe und Einlagen",
    footwear: "Was für Schuhe tragen Sie meistens?",
    insoles: "Ich trage Einlagen",
    diabetesBlock: "Ihr Diabetes",
    diabetesType: "Diabetes-Typ",
    diabetesSince: "Seit wann? (Jahr, falls bekannt)",
    hba1c: "Letzter HbA1c-Wert in % (falls bekannt)",
    insulin: "Ich spritze Insulin",
    notes: "Möchten Sie uns noch etwas mitteilen?",
  },
} as const;

const SENS: [string, string][] = [["", "–"], ["normal", "normal"], ["reduced", "vermindert"], ["absent", "aufgehoben"]];

export function AnamnesisFields({ mode, initial }: { mode: Mode; initial?: Partial<AnamnesisData> | null }) {
  const t = T[mode];
  const i = initial ?? {};
  const [v, setV] = useState({
    diabetes: !!i.diabetes,
    anticoagulation: !!i.anticoagulation,
    sensTested: !!i.sensTested,
    pavk: !!i.pavk,
    neuropathy: !!i.neuropathy,
    deformity: !!i.deformity,
    ulcerHistory: !!i.ulcerHistory,
    amputation: !!i.amputation,
    dialysis: !!i.dialysis,
    monofilamentLeft: i.monofilamentLeft ?? "",
    monofilamentRight: i.monofilamentRight ?? "",
    tuningForkLeft: i.tuningForkLeft !== undefined ? String(i.tuningForkLeft) : "",
    tuningForkRight: i.tuningForkRight !== undefined ? String(i.tuningForkRight) : "",
  });
  const toggle = (k: keyof typeof v) => (e: ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.checked }));
  const lops = hasLops({
    neuropathy: v.neuropathy,
    sensTested: v.sensTested,
    monofilamentLeft: (v.monofilamentLeft || undefined) as AnamnesisData["monofilamentLeft"],
    monofilamentRight: (v.monofilamentRight || undefined) as AnamnesisData["monofilamentRight"],
    tuningForkLeft: v.tuningForkLeft === "" ? undefined : Number(v.tuningForkLeft),
    tuningForkRight: v.tuningForkRight === "" ? undefined : Number(v.tuningForkRight),
  });
  const suggestion = suggestIwgdfRisk({ lops, pad: v.pavk, deformity: v.deformity, ulcerHistory: v.ulcerHistory, amputation: v.amputation, dialysis: v.dialysis });

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <h3 className="mb-2 font-display text-lg font-semibold">{t.base}</h3>
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Checkbox name="diabetes" checked={v.diabetes} onChange={toggle("diabetes")} label={t.diabetes} />
          <Checkbox name="pavk" checked={v.pavk} onChange={toggle("pavk")} label={t.pavk} />
          <Checkbox name="neuropathy" checked={v.neuropathy} onChange={toggle("neuropathy")} label={t.neuropathy} />
          <Checkbox name="anticoagulation" checked={v.anticoagulation} onChange={toggle("anticoagulation")} label={t.anticoagulation} />
          <Checkbox name="mrsa" defaultChecked={i.mrsa} label={t.mrsa} />
          <Checkbox name="allergyLatex" defaultChecked={i.allergyLatex} label={t.allergyLatex} />
          <Checkbox name="allergyDisinfectant" defaultChecked={i.allergyDisinfectant} label={t.allergyDisinfectant} />
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {v.anticoagulation ? <Field label={t.anticoagulant}><Input name="anticoagulant" defaultValue={i.anticoagulant} maxLength={200} /></Field> : null}
          <Field label={t.allergies}><Input name="allergies" defaultValue={i.allergies} maxLength={500} /></Field>
          <Field label={t.otherInfections}><Input name="otherInfections" defaultValue={i.otherInfections} maxLength={300} /></Field>
          <Field label={t.medications} className="sm:col-span-2" hint={mode === "online" ? "Gerne eine Zeile pro Medikament." : undefined}>
            <Textarea name="medications" defaultValue={i.medications} rows={3} maxLength={2000} />
          </Field>
        </div>
      </Card>

      {v.diabetes ? (
        <Card>
          <h3 className="mb-3 font-display text-lg font-semibold">{t.diabetesBlock}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t.diabetesType}>
              <Select name="diabetesType" defaultValue={i.diabetesType ?? "unknown"}>
                <option value="1">Typ 1</option>
                <option value="2">Typ 2</option>
                <option value="other">andere Form</option>
                <option value="unknown">{mode === "online" ? "weiß ich nicht" : "unbekannt"}</option>
              </Select>
            </Field>
            <Field label={t.diabetesSince}><Input name="diabetesSince" inputMode="numeric" maxLength={4} defaultValue={i.diabetesSince} placeholder="JJJJ" /></Field>
            <Field label={t.hba1c}><Input name="hba1c" inputMode="decimal" defaultValue={i.hba1c !== undefined ? String(i.hba1c).replace(".", ",") : ""} placeholder="z. B. 7,2" /></Field>
          </div>
          <Checkbox name="insulin" defaultChecked={i.insulin} label={t.insulin} />
        </Card>
      ) : null}

      <Card>
        <h3 className="mb-2 font-display text-lg font-semibold">{t.history}</h3>
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Checkbox name="ulcerHistory" checked={v.ulcerHistory} onChange={toggle("ulcerHistory")} label={t.ulcerHistory} />
          <Checkbox name="amputation" checked={v.amputation} onChange={toggle("amputation")} label={t.amputation} />
          <Checkbox name="dialysis" checked={v.dialysis} onChange={toggle("dialysis")} label={t.dialysis} />
          <Checkbox name="deformity" checked={v.deformity} onChange={toggle("deformity")} label={t.deformity} />
        </div>
      </Card>

      <Card>
        <h3 className="mb-2 font-display text-lg font-semibold">{t.shoes}</h3>
        <div className="grid items-end gap-4 sm:grid-cols-2">
          <Field label={t.footwear}><Input name="footwear" defaultValue={i.footwear} maxLength={300} /></Field>
          <Checkbox name="insoles" defaultChecked={i.insoles} label={t.insoles} />
        </div>
      </Card>

      {mode === "practice" ? (
        <Card>
          <h3 className="mb-2 font-display text-lg font-semibold">Sensibilität</h3>
          <Checkbox name="sensTested" checked={v.sensTested} onChange={toggle("sensTested")} label="Heute getestet (Monofilament 10 g / Stimmgabel 128 Hz)" />
          {v.sensTested ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-4">
              <Field label="Monofilament links">
                <Select name="monofilamentLeft" value={v.monofilamentLeft} onChange={(e) => setV((s) => ({ ...s, monofilamentLeft: e.target.value }))}>{SENS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              </Field>
              <Field label="Monofilament rechts">
                <Select name="monofilamentRight" value={v.monofilamentRight} onChange={(e) => setV((s) => ({ ...s, monofilamentRight: e.target.value }))}>{SENS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              </Field>
              <Field label="Stimmgabel links (0–8)"><Input name="tuningForkLeft" type="number" min={0} max={8} value={v.tuningForkLeft} onChange={(e) => setV((s) => ({ ...s, tuningForkLeft: e.target.value }))} /></Field>
              <Field label="Stimmgabel rechts (0–8)"><Input name="tuningForkRight" type="number" min={0} max={8} value={v.tuningForkRight} onChange={(e) => setV((s) => ({ ...s, tuningForkRight: e.target.value }))} /></Field>
            </div>
          ) : (
            <p className="text-xs text-muted">Testergebnisse werden nur gespeichert, wenn heute getestet wurde.</p>
          )}
        </Card>
      ) : null}

      {mode === "practice" && v.diabetes ? (
        <Card>
          <h3 className="mb-2 font-display text-lg font-semibold">IWGDF-Risikoklasse</h3>
          <Field label="Einstufung" hint={`Vorschlag aus den Angaben: Klasse ${suggestion} (LOPS ${lops ? "ja" : "nein"}, pAVK ${v.pavk ? "ja" : "nein"}). Nur Hilfestellung – die Einstufung trifft die Fachkraft.`}>
            <Select name="iwgdfRisk" defaultValue={i.iwgdfRisk !== undefined ? String(i.iwgdfRisk) : ""}>
              <option value="">– nicht eingestuft –</option>
              {[0, 1, 2, 3].map((k) => <option key={k} value={k}>{IWGDF_LABEL[k]}{k === suggestion ? " (Vorschlag)" : ""}</option>)}
            </Select>
          </Field>
        </Card>
      ) : null}

      <Card>
        <Field label={t.notes}><Textarea name="notes" defaultValue={i.notes} rows={3} maxLength={2000} /></Field>
      </Card>
    </div>
  );
}

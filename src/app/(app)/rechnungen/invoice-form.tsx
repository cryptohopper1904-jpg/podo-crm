"use client";

import { keepValues } from "@/lib/forms";
import Link from "next/link";
import { useActionState, useMemo, useRef, useState } from "react";
import { AlertTriangle, Car, Info, Plus, Trash2 } from "lucide-react";
import { Button, Card, Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { depositLineText } from "@/lib/deposit-lines";
import { dateDe, money, parseMoney } from "@/lib/format";
import { computeTotals, lineTotalCents } from "@/lib/invoice-math";
import { findServiceByCode, normalizeServiceCode } from "@/lib/service-code";
import { PRODUCT_IN_TREATMENT_LABEL, productVatHint, resolveProductVat, type VatRuleLine } from "@/lib/product-vat";
import { CREATABLE_KINDS, INVOICE_KIND_LABEL, NOTE_SMALL_BUSINESS, THERAPEUTIC_LABEL, type CreatableKind } from "@/lib/invoice-labels";
import { createInvoiceAction } from "./actions";
import { newPaymentRow, PaymentsEditor, paymentsSum, paymentsToJson, type PaymentRow } from "./payments-editor";

type Service = { id: string; code: string; name: string; priceCents: number; vatRate: number; requiresTherapeuticPurpose: boolean };
/** Verkaufsprodukt (Produkte-Katalog); vatRate = regulärer Satz (19/7 %) */
export type ProductOpt = { id: string; code: string | null; name: string; priceCents: number; vatRate: number; unit: string };
type PatientOpt = { id: string; number: number; firstName: string | null; lastName: string; billingContactId: string | null; careHomeId: string | null };
type ContactOpt = { id: string; name: string; kind: string };

export type InvoicePreset = {
  kind: CreatableKind;
  /** vorausgewählte Patient:in (Rechnung aus Termin/Behandlung, Sammelrechnung je Patient:in) */
  patientId?: string | null;
  billingContactId?: string | null;
  notes?: string | null;
  lines: { treatmentRecordId?: string | null; appointmentId?: string | null; serviceId: string | null; description: string; quantity: number; unitPriceCents: number | null; vatRate: number }[];
};

/** Noch nicht angerechnete Anzahlungen (Quittungen) – werden auf Rechnung/Sammelrechnung derselben Person angerechnet. */
export type OpenDeposit = {
  id: string;
  patientId: string;
  number: string | null;
  issuedAt: string | null;
  totalCents: number;
  /** Leistung laut Quittung (wird bei Auswahl als Position der Sammelrechnung übernommen) */
  description: string;
  vatRate: number;
  appointmentId: string | null;
  treatmentRecordId: string | null;
};

/** Wegegeld für Hausbesuche (nur vor dem Ausstellen, nur Privat/Selbstzahler) – siehe src/server/trips.ts */
export type TravelOptions = {
  patientId: string;
  eligible: boolean;
  rateCents: number | null;
  billing: "oneway" | "roundtrip";
  flatServices: { id: string; name: string; priceCents: number }[];
  suggestions: { tripId: string; date: string; km: number; description: string; maybeBilled: boolean }[];
} | null;

type Line = { key: string; /** aus diesen Quittungen übernommen (fällt beim Abwählen wieder weg) */ depositIds?: string[]; treatmentRecordId?: string | null; appointmentId?: string | null; serviceId: string; /** Produktverkauf statt Leistung */ productId?: string; /** Produkt in der Behandlung angewendet (0 %) */ inTreatment?: boolean; /** zugeordnete Behandlungsposition (Zeilen-Key) */ treatmentKey?: string; description: string; quantity: string; factor: string; price: string; vatRate: number; /** Eingabe im Kürzel-Feld (sonst Kürzel der gewählten Leistung) */ codeInput?: string; /** Stand vor der Kürzel-Eingabe (für unbekannte Kürzel) */ codeStart?: { serviceId: string; productId?: string; inTreatment?: boolean; description: string; price: string; vatRate: number } };

let seq = 0;
const euro = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
const num = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const isEmptyLine = (l: Line) => !l.serviceId && !l.productId && !l.description.trim() && !l.price.trim() && !l.treatmentRecordId && !l.appointmentId;
const PRODUCT_PREFIX = "p:";

/**
 * Positionen passend zu den gewählten Quittungen. Steht die Behandlung schon als Position drin (Termin/Doku aus dem
 * Jahresvorschlag), wird nur angerechnet. Sonst eine Position je Behandlung – mehrere Quittungen zum selben Termin
 * ergeben eine Position mit der Summe (nie doppelt). Unveränderte Auswahl behält die vorhandene (ggf. bearbeitete) Zeile.
 */
function syncDepositLines(ls: Line[], chosen: OpenDeposit[]): Line[] {
  const others = ls.filter((l) => !l.depositIds?.length);
  const existing = ls.filter((l) => l.depositIds?.length);
  const groups = new Map<string, OpenDeposit[]>();
  for (const d of chosen) {
    const covered = others.some(
      (l) => (!!d.appointmentId && l.appointmentId === d.appointmentId) || (!!d.treatmentRecordId && l.treatmentRecordId === d.treatmentRecordId),
    );
    if (covered) continue;
    const key = `${d.appointmentId ?? d.treatmentRecordId ?? d.id}|${d.vatRate}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const depLines = [...groups.values()].map((g) => {
    const ids = g.map((d) => d.id);
    const prev = existing.find((l) => sameIds(l.depositIds!, ids));
    if (prev) return prev;
    const d = g[0];
    return newLine({
      depositIds: ids,
      appointmentId: d.appointmentId,
      treatmentRecordId: d.treatmentRecordId,
      description: depositLineText(d),
      price: euro(g.reduce((s, x) => s + x.totalCents, 0)),
      vatRate: d.vatRate,
    });
  });
  const result = [...(depLines.length ? others.filter((l) => !isEmptyLine(l)) : others), ...depLines];
  return result.length ? result : [newLine()];
}

const newLine = (patch: Partial<Line> = {}): Line => ({
  key: `l${++seq}`,
  serviceId: "",
  description: "",
  quantity: "1",
  factor: "1",
  price: "",
  vatRate: 0,
  ...patch,
});

export function InvoiceForm({
  patients,
  services,
  products = [],
  billingContacts,
  smallBusiness,
  defaultDueDays = 14,
  therapeuticDefault = false,
  today,
  preselectPatientId,
  preset,
  travel,
  privateOnly = false,
  openDeposits = [],
  receiptsThisYear = {},
  receiptsYear,
}: {
  patients: PatientOpt[];
  services: Service[];
  /** aktive Verkaufsprodukte (Salben, Cremes …) */
  products?: ProductOpt[];
  billingContacts: ContactOpt[];
  smallBusiness: boolean;
  /** Standard-Zahlungsziel der Praxis (Einstellungen → Praxisdaten → Belege), 0 = sofort */
  defaultDueDays?: number;
  /** Praxis hat den USt-Wächter dauerhaft bestätigt (Einstellungen → Belege) – Haken vorbelegt, abwählbar */
  therapeuticDefault?: boolean;
  today: string;
  preselectPatientId?: string | null;
  preset?: InvoicePreset;
  travel?: TravelOptions;
  /** Praxis nur für Privat-/Selbstzahler (src/lib/features.ts): keine Kassen-Hinweise */
  privateOnly?: boolean;
  openDeposits?: OpenDeposit[];
  /** normale Quittungen (sofort bezahlt) je Patient:in im laufenden Jahr – bereits abgerechnet */
  receiptsThisYear?: Record<string, { count: number; cents: number }>;
  receiptsYear?: number;
}) {
  const [state, action, pending] = useActionState(createInvoiceAction, undefined);
  const svcById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const prodById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  /** Kürzel-Schnelleingabe: zuerst Leistungen, dann Produkte mit Kürzel */
  const codeItems = useMemo(
    () => [
      ...services.map((s) => ({ code: s.code, serviceId: s.id, productId: "" })),
      ...products.filter((p) => p.code).map((p) => ({ code: p.code!, serviceId: "", productId: p.id })),
    ],
    [services, products],
  );
  const initialPatient = patients.find((p) => p.id === (preset ? preset.patientId : preselectPatientId));

  const [kind, setKind] = useState<CreatableKind>(preset?.kind ?? "invoice");
  const [patientId, setPatientId] = useState(initialPatient?.id ?? "");
  const [billingContactId, setBillingContactId] = useState(preset?.billingContactId ?? initialPatient?.billingContactId ?? "");
  /** Auswahl der anzurechnenden Anzahlungen (Standard: bei Sammelrechnung alle offenen der Person, sonst keine) */
  const [depositSel, setDepositSel] = useState<Record<string, boolean>>({});
  const [patientFilter, setPatientFilter] = useState("");
  const [lines, setLines] = useState<Line[]>(() => {
    const start = preset?.lines.length
      ? preset.lines.map((l) =>
          newLine({
            treatmentRecordId: l.treatmentRecordId ?? null,
            appointmentId: l.appointmentId ?? null,
            // inaktive/unbekannte Leistung → Freitext mit Katalogpreis
            serviceId: l.serviceId && svcById.has(l.serviceId) ? l.serviceId : "",
            description: l.description,
            quantity: String(l.quantity).replace(".", ","),
            price: l.unitPriceCents === null ? "" : euro(l.unitPriceCents),
            vatRate: l.vatRate,
          }),
        )
      : [newLine()];
    // Sammelrechnung: offene Quittungen der Person sind vorausgewählt → ihre Leistungen gleich als Positionen
    const k = preset?.kind ?? "invoice";
    const pid = initialPatient?.id;
    return k === "collective" && pid ? syncDepositLines(start, openDeposits.filter((d) => d.patientId === pid)) : start;
  });
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [confirmed, setConfirmed] = useState(therapeuticDefault);
  const [showGuard, setShowGuard] = useState(!therapeuticDefault);

  const filteredPatients = useMemo(() => {
    const f = patientFilter.trim().toLowerCase();
    if (!f) return patients;
    return patients.filter((p) => `${p.lastName} ${p.firstName ?? ""} ${p.number}`.toLowerCase().includes(f) || p.id === patientId);
  }, [patients, patientFilter, patientId]);

  const computed = lines.map((l) => {
    const s = l.serviceId ? svcById.get(l.serviceId) : undefined;
    const p = l.productId ? prodById.get(l.productId) : undefined;
    const unit = s ? s.priceCents : p ? p.priceCents : (parseMoney(l.price) ?? 0);
    const requested = p ? (l.inTreatment ? 0 : p.vatRate) : l.vatRate;
    const vatRate = smallBusiness ? 0 : requested;
    return {
      ...l,
      requested,
      unit,
      vatRate,
      totalCents: lineTotalCents(unit, num(l.quantity), p ? 1 : num(l.factor)),
      // komplett leere Zeile (z. B. nach Enter im Kürzel-Feld) wird ignoriert – weder abgerechnet noch geprüft
      blank: isEmptyLine(l),
      // Behandlungsposition (Katalogleistung mit therapeutischem Ziel, 0 %): Voraussetzung für 0 % bei Produkten
      treatment: !!s && s.requiresTherapeuticPurpose && l.vatRate === 0 && kind !== "no_show_fee",
      needsConfirm: !smallBusiness && vatRate === 0 && (p ? !!l.inTreatment : s ? s.requiresTherapeuticPurpose : kind !== "no_show_fee"),
    };
  }).map((l) => (l.blank ? { ...l, needsConfirm: false, treatment: false } : l));
  const filled = computed.filter((l) => !l.blank);
  const treatmentLines = filled.filter((l) => l.treatment);
  /** dieselbe Regel wie auf dem Server (src/lib/product-vat.ts) */
  const ruleOf = (l: (typeof computed)[number]): VatRuleLine => {
    const p = l.productId ? prodById.get(l.productId) : undefined;
    if (!p) return { kind: "service", vatRate: l.vatRate, therapeutic: l.treatment };
    const idx = l.treatmentKey ? filled.findIndex((x) => x.key === l.treatmentKey) : -1;
    return { kind: "product", vatRate: l.requested, productVatRate: p.vatRate, inTreatment: !!l.inTreatment, treatmentLine: idx >= 0 ? idx : null };
  };
  const productError = resolveProductVat(filled.map(ruleOf), { smallBusiness, invoiceKind: kind }).error;
  const hasProducts = filled.some((l) => l.productId);
  const totals = computeTotals(filled);
  const needsConfirm = computed.some((l) => l.needsConfirm);
  const paid = paymentsSum(payments);
  const depositsAllowed = kind === "invoice" || kind === "collective";
  const patientDeposits = depositsAllowed && patientId ? openDeposits.filter((d) => d.patientId === patientId) : [];
  const depositOn = (id: string) => depositSel[id] ?? kind === "collective";
  const credited = patientDeposits.filter((d) => depositOn(d.id));
  const creditedCents = credited.reduce((s, d) => s + d.totalCents, 0);
  const openAfterDeposits = totals.totalCents - creditedCents;

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  /** Patch für eine gewählte Leistung bzw. ein Produkt (Beschreibung, Katalogpreis, USt) */
  function itemPatch(serviceId: string, productId: string): Partial<Line> | null {
    const s = serviceId ? svcById.get(serviceId) : undefined;
    if (s) return { serviceId: s.id, productId: undefined, inTreatment: false, treatmentKey: undefined, description: s.name, price: euro(s.priceCents), vatRate: s.vatRate };
    const p = productId ? prodById.get(productId) : undefined;
    if (p) return { serviceId: "", productId: p.id, inTreatment: false, treatmentKey: undefined, description: p.name, price: euro(p.priceCents), vatRate: p.vatRate, factor: "1" };
    return null;
  }

  function chooseService(key: string, value: string) {
    const patch = value.startsWith(PRODUCT_PREFIX) ? itemPatch("", value.slice(PRODUCT_PREFIX.length)) : itemPatch(value, "");
    if (!patch) return update(key, { serviceId: "", productId: undefined, inTreatment: false, treatmentKey: undefined, description: "", price: "", codeInput: undefined, codeStart: undefined });
    update(key, { ...patch, codeInput: undefined, codeStart: undefined });
  }

  /**
   * Schnelleingabe: Kürzel tippen (z. B. „PK“) → passende Leistung wird gewählt – genau wie über die Auswahlliste
   * (Beschreibung, Katalogpreis und USt werden ersetzt, damit Text, Entgelt und Steuer zusammenpassen).
   * Bleibt das Kürzel unbekannt, stellt codeBlur den Stand vor der Eingabe wieder her.
   */
  function typeCode(key: string, value: string) {
    const hit = findServiceByCode(codeItems, value);
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l;
        const codeStart = l.codeStart ?? { serviceId: l.serviceId, productId: l.productId, inTreatment: l.inTreatment, description: l.description, price: l.price, vatRate: l.vatRate };
        const same = hit && (hit.serviceId ? hit.serviceId === l.serviceId : hit.productId === l.productId);
        const patch = hit && !same ? itemPatch(hit.serviceId, hit.productId) : null;
        if (!patch) return { ...l, codeInput: value, codeStart };
        return { ...l, ...patch, codeInput: value, codeStart };
      }),
    );
  }

  // Fokus über Refs statt DOM-ids (Zeilen-Keys unterscheiden sich zwischen Server und Browser)
  const codeRefs = useRef(new Map<string, HTMLInputElement>());
  /** neu angelegte Zeile: Fokus, sobald ihr Kürzel-Feld im DOM ist (im Ref-Callback) */
  const pendingFocus = useRef<string | null>(null);

  const codeUnknown = (l: Line) => !!l.codeInput?.trim() && !findServiceByCode(codeItems, l.codeInput);
  const isBlank = isEmptyLine;

  /** Enter im Kürzel-Feld: zur nächsten Position bzw. neue anlegen – nie das Formular abschicken */
  function codeKeyDown(e: React.KeyboardEvent<HTMLInputElement>, key: string) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const idx = lines.findIndex((l) => l.key === key);
    const cur = lines[idx];
    if (!cur || codeUnknown(cur) || isBlank(cur)) return; // unbekanntes Kürzel bzw. leere Zeile: hier bleiben
    const next = lines[idx + 1];
    if (next) return codeRefs.current.get(next.key)?.focus();
    const nl = newLine();
    pendingFocus.current = nl.key;
    setLines((ls) => [...ls, nl]);
  }

  /** Verlassen des Kürzel-Felds: unbekanntes/leeres Kürzel → Stand vor der Eingabe zurück (kein stehengebliebener Zwischentreffer) */
  function codeBlur(key: string) {
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key || l.codeInput === undefined) return l;
        if ((codeUnknown(l) || !l.codeInput.trim()) && l.codeStart) return { ...l, ...l.codeStart, codeInput: undefined, codeStart: undefined };
        return { ...l, codeInput: undefined, codeStart: undefined };
      }),
    );
  }

  /** Auswahl der Quittungen ändern und Positionen nachziehen */
  function applyDeposits(nextKind: CreatableKind, pid: string, sel: Record<string, boolean>) {
    const allowed = nextKind === "invoice" || nextKind === "collective";
    const chosen = allowed && pid ? openDeposits.filter((d) => d.patientId === pid && (sel[d.id] ?? nextKind === "collective")) : [];
    setLines((ls) => syncDepositLines(ls, chosen));
  }
  function toggleDeposit(id: string, on: boolean) {
    const sel = { ...depositSel, [id]: on };
    setDepositSel(sel);
    applyDeposits(kind, patientId, sel);
  }
  function selectAllDeposits(on: boolean) {
    const sel = { ...depositSel };
    for (const d of patientDeposits) sel[d.id] = on;
    setDepositSel(sel);
    applyDeposits(kind, patientId, sel);
  }

  function chooseKind(k: CreatableKind) {
    setKind(k);
    applyDeposits(k, patientId, depositSel);
    if (k === "no_show_fee" && lines.every((l) => l.depositIds?.length || (!l.serviceId && !l.description))) {
      setLines([newLine({ description: "Ausfallhonorar (§ 615 BGB) für den Termin am …", vatRate: 0 })]);
    }
    if (k === "receipt" && payments.length === 0 && totals.totalCents > 0) setPayments([newPaymentRow(totals.totalCents)]);
  }

  function choosePatient(id: string) {
    setPatientId(id);
    applyDeposits(kind, id, depositSel);
    const p = patients.find((x) => x.id === id);
    if (p) setBillingContactId(p.billingContactId ?? (kind === "collective" ? (p.careHomeId ?? "") : ""));
  }

  const [addedTrips, setAddedTrips] = useState<string[]>([]);
  const showTravel = !!travel && travel.patientId === patientId && (kind === "invoice" || kind === "receipt" || kind === "collective");
  /** Position anhängen (leere Startzeile ersetzen) */
  const appendLine = (l: Line) => setLines((ls) => [...ls.filter((x) => x.serviceId || x.productId || x.description || x.price), l]);
  function addTravel(s: NonNullable<TravelOptions>["suggestions"][number]) {
    if (!travel?.rateCents) return;
    appendLine(newLine({ description: s.description, quantity: String(s.km).replace(".", ","), price: euro(travel.rateCents), vatRate: 0 }));
    setAddedTrips((a) => [...a, s.tripId]);
  }
  function addFlat(svcId: string) {
    const sv = svcById.get(svcId);
    if (sv) appendLine(newLine({ serviceId: sv.id, description: sv.name, price: euro(sv.priceCents), vatRate: sv.vatRate }));
  }

  const vatOptions = (l: Line) => {
    const s = l.serviceId ? svcById.get(l.serviceId) : undefined;
    if (s) return s.vatRate === 19 ? [19] : [s.vatRate, 19];
    return [0, 7, 19];
  };

  const linesJson = JSON.stringify(
    filled.map((l) => {
      const rule = ruleOf(l);
      return {
        serviceId: l.serviceId || null,
        productId: l.productId || null,
        inTreatment: !!l.productId && !!l.inTreatment && !smallBusiness,
        treatmentLine: rule.kind === "product" ? (rule.treatmentLine ?? null) : null,
        treatmentRecordId: l.treatmentRecordId || null,
        appointmentId: l.appointmentId || null,
        description: l.description,
        quantity: num(l.quantity),
        factor: l.productId ? 1 : num(l.factor),
        unitPriceCents: l.unit,
        // Wunschsatz; Kleinunternehmer → der Server setzt 0 %
        vatRate: l.productId ? l.requested : l.vatRate,
      };
    }),
  );

  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-6">
      <input type="hidden" name="lines" value={linesJson} />
      <input type="hidden" name="payments" value={paymentsToJson(payments)} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="depositIds" value={JSON.stringify(credited.map((d) => d.id))} />
      <FormError message={state?.error} />

      <Card>
        <h2 className="mb-4 font-display text-lg font-semibold">Beleg</h2>
        <div className="mb-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Belegart">
          {CREATABLE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => chooseKind(k)}
              className={`inline-flex h-11 items-center rounded-xl px-3.5 text-sm font-semibold ${kind === k ? "bg-primary text-on-primary" : "border border-border bg-surface hover:bg-surface-2"}`}
            >
              {INVOICE_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {/* iPad (1024 px, mit Seitenleiste ~700 px Inhalt): zwei Spalten, erst ab xl vier (Gesamt-Review M8) */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
          <Field label="Patient suchen">
            <Input value={patientFilter} onChange={(e) => setPatientFilter(e.target.value)} placeholder="Name oder Nummer" autoComplete="off" />
          </Field>
          <Field label={kind === "collective" ? "Patient (für die Jahres-Sammelrechnung)" : "Patient *"}>
            <Select name="patientId" value={patientId} onChange={(e) => choosePatient(e.target.value)} required={kind !== "collective" || !billingContactId}>
              <option value="">– bitte wählen –</option>
              {filteredPatients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.lastName}{p.firstName ? `, ${p.firstName}` : ""} (#{p.number})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={kind === "collective" ? "Rechnungsempfänger (z. B. Pflegeheim)" : "Abweichender Rechnungsempfänger"} hint={kind === "collective" ? "Patient oder Rechnungsempfänger angeben" : "z. B. Pflegeheim, Betreuer:in, Angehörige"}>
            <Select name="billingContactId" value={billingContactId} onChange={(e) => setBillingContactId(e.target.value)} required={kind === "collective" && !patientId}>
              <option value="">– keiner –</option>
              {billingContacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Datum">
              <Input type="date" name="issuedAt" defaultValue={today} max={today} required />
            </Field>
            <Field label="Zahlungsziel (Tage)" hint="0 = sofort">
              <Input type="number" name="dueDays" min={0} max={120} defaultValue={kind === "receipt" ? 0 : defaultDueDays} key={kind === "receipt" ? "r" : "o"} disabled={kind === "receipt"} />
            </Field>
          </div>
        </div>
      </Card>

      {patientDeposits.length ? (
        <Card>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">
              Quittungen von {patients.find((p) => p.id === patientId)?.lastName ?? "der Patient:in"} ({patientDeposits.length})
            </h2>
            <div className="flex gap-3 text-sm font-semibold">
              <button type="button" className="text-primary hover:underline" onClick={() => selectAllDeposits(true)}>Alle wählen</button>
              <button type="button" className="text-muted hover:underline" onClick={() => selectAllDeposits(false)}>Keine</button>
            </div>
          </div>
          <p className="mb-3 text-sm text-muted">
            Gewählte Quittungen kommen mit ihrer Leistung als Position auf die {kind === "collective" ? "Sammelrechnung" : "Rechnung"} (Betrag = gezahlter Betrag, bitte prüfen); der bereits bezahlte Betrag wird angerechnet.
          </p>
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {patientDeposits.map((d) => (
              <li key={d.id} className="px-3 py-1">
                <Checkbox
                  checked={depositOn(d.id)}
                  onChange={(e) => toggleDeposit(d.id, e.target.checked)}
                  label={`${d.number ?? "Quittung"} vom ${dateDe(d.issuedAt)} · ${depositLineText(d)} · ${money(d.totalCents)}${
                    d.appointmentId || d.treatmentRecordId ? "" : " – ohne Terminbezug: bitte prüfen, dass die Behandlung nicht doppelt als Position steht"
                  }`}
                />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm">
            {credited.length} von {patientDeposits.length} gewählt · angerechnet: <span className="font-semibold tabular-nums">{money(creditedCents)}</span>
          </p>
        </Card>
      ) : null}

      {kind === "collective" && patientId && receiptsThisYear[patientId] ? (
        <p className="flex gap-2 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
          <Info size={18} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {receiptsYear ? `${receiptsYear} gibt es` : "Dieses Jahr gibt es"} außerdem {receiptsThisYear[patientId].count} normale Quittung(en) über {money(receiptsThisYear[patientId].cents)}. Diese sind bereits
            fertige, bezahlte Belege und dürfen nicht noch einmal in die Sammelrechnung. Für Behandlungen, die erst zum Jahresende abgerechnet werden, beim Termin
            „Quittung für Sammelrechnung“ wählen – nur diese erscheinen oben zur Auswahl. Für Versicherung/Beihilfe eine Kopie der Quittung verwenden.
          </span>
        </p>
      ) : null}

      <Card>
        <h2 className="mb-4 font-display text-lg font-semibold">Positionen</h2>
        {/* Enter in Positionsfeldern stellt nie versehentlich die (unveränderbare) Rechnung aus */}
        <div
          className="flex flex-col gap-3"
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
          }}
        >
          {computed.map((l, i) => {
            const s = l.serviceId ? svcById.get(l.serviceId) : undefined;
            const prod = l.productId ? prodById.get(l.productId) : undefined;
            const otherTreatments = treatmentLines.filter((t) => t.key !== l.key);
            return (
              // Ab md zwei Zeilen (Leistung/Beschreibung, dann Zahlen), erst ab 2xl alles in einer Zeile – kein horizontales
              // Scrollen auf dem iPad (Gesamt-Review M8). min-w-0: Eingabefelder dürfen schrumpfen.
              <div key={l.key} className="grid gap-3 rounded-xl border border-border p-3 md:grid-cols-6 md:items-end 2xl:grid-cols-[minmax(10rem,1.2fr)_minmax(10rem,2fr)_5rem_5rem_7rem_7rem_auto] [&>*]:min-w-0">
                <div role="group" aria-labelledby={`pos-${i}-label`} className="flex flex-col gap-1.5 md:col-span-3 2xl:col-span-1">
                  <span id={`pos-${i}-label`} className="text-sm font-medium">{`Pos. ${i + 1}: ${prod ? "Produkt" : "Leistung"}`}</span>
                  <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
                    <Input
                      ref={(el) => {
                        if (!el) return void codeRefs.current.delete(l.key);
                        codeRefs.current.set(l.key, el);
                        if (pendingFocus.current === l.key) {
                          pendingFocus.current = null;
                          el.focus();
                        }
                      }}
                      aria-label={`Pos. ${i + 1}: Leistung – Kürzel`}
                      aria-invalid={codeUnknown(l) || undefined}
                      aria-describedby={codeUnknown(l) ? `pos-${i}-hint` : undefined}
                      title="Kürzel eintippen, z. B. PK – Enter für die nächste Position"
                      placeholder="Kürzel"
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={10}
                      className="uppercase"
                      value={l.codeInput ?? s?.code ?? prod?.code ?? ""}
                      onChange={(e) => typeCode(l.key, e.target.value)}
                      onKeyDown={(e) => codeKeyDown(e, l.key)}
                      onBlur={() => codeBlur(l.key)}
                    />
                    <Select aria-label={`Pos. ${i + 1}: Leistung auswählen`} title="Leistung oder Produkt auswählen" value={l.productId ? `${PRODUCT_PREFIX}${l.productId}` : l.serviceId} onChange={(e) => chooseService(l.key, e.target.value)}>
                      <option value="">Freitext</option>
                      {products.length ? (
                        <>
                          <optgroup label="Leistungen">
                            {services.map((sv) => (
                              <option key={sv.id} value={sv.id}>{sv.code} · {sv.name}</option>
                            ))}
                          </optgroup>
                          <optgroup label="Produkte">
                            {products.map((p) => (
                              <option key={p.id} value={`${PRODUCT_PREFIX}${p.id}`}>{p.code ? `${p.code} · ` : ""}{p.name}</option>
                            ))}
                          </optgroup>
                        </>
                      ) : (
                        services.map((sv) => (
                          <option key={sv.id} value={sv.id}>{sv.code} · {sv.name}</option>
                        ))
                      )}
                    </Select>
                  </div>
                  {codeUnknown(l) ? (
                    <span id={`pos-${i}-hint`} aria-live="polite" className="text-xs text-danger">Kürzel „{normalizeServiceCode(l.codeInput ?? "")}“ unbekannt</span>
                  ) : null}
                </div>
                <Field label="Beschreibung" className="md:col-span-3 2xl:col-span-1">
                  <Input value={l.description} disabled={!!prod} title={prod ? "Produktname aus dem Katalog" : undefined} onChange={(e) => update(l.key, { description: e.target.value })} placeholder={s?.name ?? "z. B. Pflegeprodukt"} />
                </Field>
                <Field label="Menge">
                  <Input inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                </Field>
                <Field label="Faktor">
                  <Input inputMode="decimal" value={prod ? "1" : l.factor} disabled={!!prod} onChange={(e) => update(l.key, { factor: e.target.value })} />
                </Field>
                <Field label="Preis (€)" hint={s || prod ? "aus Katalog" : undefined}>
                  <Input inputMode="decimal" value={l.price} disabled={!!s || !!prod} onChange={(e) => update(l.key, { price: e.target.value })} placeholder="0,00" />
                </Field>
                <Field label="USt">
                  {smallBusiness ? (
                    <Input value="0 % (§ 19)" disabled />
                  ) : prod ? (
                    <Input value={l.inTreatment ? "0 % (Behandlung)" : `${prod.vatRate} %`} disabled />
                  ) : (
                    <Select value={l.vatRate} onChange={(e) => update(l.key, { vatRate: Number(e.target.value) })}>
                      {vatOptions(l).map((r) => (
                        <option key={r} value={r}>{r} %</option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="flex items-center justify-between gap-2 md:col-span-2 md:justify-end 2xl:col-span-1 2xl:flex-col 2xl:items-end">
                  <span className="font-semibold tabular-nums">{money(l.totalCents)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Position ${i + 1} entfernen`}
                    disabled={lines.length === 1}
                    onClick={() => {
                      // Position aus einer Quittung entfernt → Quittung auch nicht mehr anrechnen
                      if (l.depositIds?.length) setDepositSel((x) => ({ ...x, ...Object.fromEntries(l.depositIds!.map((id) => [id, false])) }));
                      setLines((ls) => ls.filter((x) => x.key !== l.key));
                    }}
                  >
                    <Trash2 size={18} aria-hidden />
                  </Button>
                </div>
                {prod && !smallBusiness ? (
                  <div className="flex flex-col gap-1 md:col-span-6 2xl:col-span-7">
                    <Checkbox
                      checked={!!l.inTreatment}
                      disabled={!l.inTreatment && !otherTreatments.length}
                      onChange={(e) => update(l.key, { inTreatment: e.target.checked, treatmentKey: e.target.checked ? l.treatmentKey : undefined })}
                      label={PRODUCT_IN_TREATMENT_LABEL}
                    />
                    {!otherTreatments.length ? (
                      <span className="text-xs text-muted">Nur möglich, wenn der Beleg auch eine Heilbehandlung (0 %) enthält – sonst {prod.vatRate} %.</span>
                    ) : null}
                    {l.inTreatment && num(l.quantity) >= 2 ? (
                      <span role="status" className="text-xs font-medium text-warn-soft-text">
                        Wirklich {l.quantity} Stück in der Behandlung verbraucht? Mitgegebene Ware ist eine Lieferung mit regulärem Satz ({prod.vatRate} %) – dann bitte eine eigene Position ohne Haken.
                      </span>
                    ) : null}
                    {l.inTreatment && otherTreatments.length > 1 ? (
                      <Field label="Angewendet bei Behandlung">
                        <Select value={l.treatmentKey ?? ""} onChange={(e) => update(l.key, { treatmentKey: e.target.value || undefined })}>
                          <option value="">{kind === "collective" ? "– bitte zuordnen –" : "– erste Behandlung –"}</option>
                          {otherTreatments.map((t) => (
                            <option key={t.key} value={t.key}>Pos. {computed.findIndex((x) => x.key === t.key) + 1}: {t.description}</option>
                          ))}
                        </Select>
                      </Field>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          <div>
            <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>
              <Plus size={18} aria-hidden /> Position
            </Button>
          </div>
        </div>

        {showTravel && travel ? (
          <div className="mt-5 rounded-xl border border-dashed border-border-strong p-4">
            <p className="flex items-center gap-2 font-semibold"><Car size={18} aria-hidden /> Wegegeld (Hausbesuch)</p>
            {!travel.eligible ? (
              <p className="mt-1 text-sm text-muted">Nur für Privat- und Selbstzahler – bei GKV läuft das Wegegeld über die Verordnung.</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {travel.rateCents === null ? (
                  <p className="w-full text-sm text-muted">Kein km-Satz hinterlegt (Einstellungen → Fahrten &amp; Startorte).</p>
                ) : travel.suggestions.length === 0 ? (
                  <p className="w-full text-sm text-muted">Keine erfassten Fahrten zu dieser Person in den letzten 120 Tagen.</p>
                ) : (
                  travel.suggestions.map((s) => (
                    <Button key={s.tripId} type="button" variant="secondary" disabled={addedTrips.includes(s.tripId)} onClick={() => addTravel(s)} title={s.maybeBilled ? "Möglicherweise bereits abgerechnet" : undefined}>
                      <Plus size={16} aria-hidden /> Wegegeld hinzufügen: {s.date.slice(8, 10)}.{s.date.slice(5, 7)}. · {String(s.km).replace(".", ",")} km × {euro(travel.rateCents ?? 0)} €{s.maybeBilled ? " (evtl. schon abgerechnet)" : ""}
                    </Button>
                  ))
                )}
                {travel.flatServices.map((f) => (
                  <Button key={f.id} type="button" variant="secondary" onClick={() => addFlat(f.id)}>
                    <Plus size={16} aria-hidden /> {f.name} (Pauschale {euro(f.priceCents)} €)
                  </Button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        <dl className="mt-5 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-[15px]">
          {totals.groups.map((g) => (
            <div key={g.rate} className="contents text-muted">
              <dt>{g.rate ? `enthaltene USt ${g.rate} % (auf ${money(g.grossCents)})` : `steuerfrei 0 % (${money(g.grossCents)})`}</dt>
              <dd className="text-right tabular-nums">{money(g.vatCents)}</dd>
            </div>
          ))}
          <dt>Netto</dt>
          <dd className="text-right tabular-nums">{money(totals.netCents)}</dd>
          <dt className="font-semibold">Gesamt (brutto)</dt>
          <dd className="text-right font-display text-xl font-bold tabular-nums">{money(totals.totalCents)}</dd>
        </dl>
        {smallBusiness ? <p className="mt-3 text-sm text-muted">{NOTE_SMALL_BUSINESS}</p> : null}
        {hasProducts && !smallBusiness ? (
          <p className="mt-3 flex gap-2 text-sm text-muted">
            <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
            {productVatHint(filled.map((l) => (l.productId ? prodById.get(l.productId)?.vatRate : undefined)).filter((r): r is number => r !== undefined))}
          </p>
        ) : null}
        {productError ? <p role="alert" className="mt-3 text-sm font-medium text-danger">{productError}</p> : null}
      </Card>

      {/* Einklappen nur, wenn alle betroffenen Positionen Katalogleistungen sind – Freitext mit 0 % bleibt sichtbar zu prüfen */}
      {needsConfirm && therapeuticDefault && confirmed && !showGuard && computed.every((l) => !l.needsConfirm || !!l.serviceId) ? (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
          <input type="hidden" name="therapeuticConfirmed" value="on" />
          <input type="hidden" name="therapeuticSource" value="setting" />
          Heilbehandlung (0 % USt, § 4 Nr. 14 UStG) für {computed.filter((l) => l.needsConfirm).length} Position(en) – durch Praxis-Einstellung vorbelegt.
          <button type="button" className="font-semibold text-primary hover:underline" onClick={() => setShowGuard(true)}>
            Prüfen/Ändern
          </button>
        </p>
      ) : needsConfirm ? (
        <Card className="border-warn-soft-text/40 bg-warn-soft text-warn-soft-text">
          <div className="flex gap-3">
            <AlertTriangle size={22} className="mt-0.5 shrink-0" aria-hidden />
            <div className="flex-1">
              <p className="font-semibold">USt-Wächter (§ 4 Nr. 14 UStG)</p>
              <p className="text-sm">
                0 % USt ist nur bei einer Heilbehandlung mit therapeutischem Ziel zulässig. Bitte bestätigen – sonst die betroffenen Positionen mit dem regulären Satz abrechnen (Leistungen 19 %, Produkte ihr Verkaufssatz).
              </p>
              <Checkbox name="therapeuticConfirmed" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} label={THERAPEUTIC_LABEL} />
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  setLines((ls) => ls.map((l, i) => (computed[i]?.needsConfirm ? (l.productId ? { ...l, inTreatment: false, treatmentKey: undefined } : { ...l, vatRate: 19 }) : l)))
                }
              >
                {computed.some((l) => l.needsConfirm && l.productId) ? "Betroffene Positionen auf regulären Satz umstellen" : "Betroffene Positionen auf 19 % umstellen"}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {patientDeposits.length ? (
        <p className="text-sm">
          Quittungen angerechnet: <span className="font-semibold tabular-nums">{money(creditedCents)}</span> · noch offen:{" "}
          <span className={openAfterDeposits < 0 ? "font-semibold text-danger" : "font-semibold tabular-nums"}>{money(openAfterDeposits)}</span>
          {openAfterDeposits < 0 ? " – die Quittungen übersteigen den Rechnungsbetrag." : ""}
        </p>
      ) : null}

      <Card>
        <h2 className="mb-1 font-display text-lg font-semibold">Zahlung</h2>
        <p className="mb-4 text-sm text-muted">
          {kind === "receipt"
            ? "Quittung: Der Betrag wird sofort vollständig bezahlt."
            : "Optional – sofort bezahlte Beträge erfassen. Mischzahlung (z. B. Gutschein + bar) möglich."}
        </p>
        <PaymentsEditor rows={payments} onChange={setPayments} openCents={Math.max(0, openAfterDeposits)} />
        {kind === "receipt" && paid !== totals.totalCents ? (
          <p className="mt-3 text-sm font-medium text-danger">Für eine Quittung muss die Zahlung genau {money(totals.totalCents)} betragen.</p>
        ) : null}
      </Card>

      <Card>
        <Field label="Hinweis auf der Rechnung (keine Diagnosen)">
          <Textarea name="notes" defaultValue={preset?.notes ?? ""} placeholder={privateOnly ? "z. B. Behandlungszeitraum" : "z. B. Behandlungszeitraum, Bezug auf Verordnung"} />
        </Field>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending || totals.totalCents <= 0 || openAfterDeposits < 0 || (needsConfirm && !confirmed) || !!productError}>
          {pending ? "Wird ausgestellt …" : `${INVOICE_KIND_LABEL[kind]} ausstellen`}
        </Button>
        <Link href="/rechnungen" className="inline-flex h-11 items-center px-4 font-semibold text-muted">Abbrechen</Link>
        <p className="w-full text-xs text-muted">Nach dem Ausstellen sind Nummer und Beträge unveränderbar (GoBD). Korrekturen nur per Storno.</p>
      </div>
    </form>
  );
}

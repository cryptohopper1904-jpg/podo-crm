"use client";

import { keepValues } from "@/lib/forms";
import Link from "next/link";
import { useActionState, useMemo, useRef, useState, useTransition } from "react";
import { AlertTriangle, Car, Plus, Trash2 } from "lucide-react";
import { Button, Card, Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { depositLineText } from "@/lib/deposit-lines";
import { dateDe, money, parseMoney } from "@/lib/format";
import { computeTotals, lineTotalCents } from "@/lib/invoice-math";
import { findServiceByCode, normalizeServiceCode } from "@/lib/service-code";
import { CREATABLE_KINDS, INVOICE_KIND_LABEL, NOTE_SMALL_BUSINESS, THERAPEUTIC_LABEL, type CreatableKind } from "@/lib/invoice-labels";
import { createInvoiceAction, openReceiptsAction } from "./actions";
import { newPaymentRow, PaymentsEditor, paymentsSum, paymentsToJson, type PaymentRow } from "./payments-editor";

type Service = { id: string; code: string; name: string; priceCents: number; vatRate: number; requiresTherapeuticPurpose: boolean };
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

/**
 * Bezahlte normale Quittung (Teilrechnung) der Person, noch auf keiner Sammelrechnung – wird mit allen Positionen in die
 * Sammelrechnung übernommen und als „bereits bezahlt“ angerechnet (siehe openReceiptsFor in src/server/invoices.ts).
 */
export type OpenReceipt = {
  id: string;
  patientId: string;
  number: string | null;
  issuedAt: string | null;
  totalCents: number;
  vatCents: number;
  lines: {
    description: string;
    quantity: number;
    factor: number;
    unitPriceCents: number;
    vatRate: number;
    totalCents: number;
    appointmentId: string | null;
    treatmentRecordId: string | null;
    /** Leistungsdatum (Termin/Doku-Eintrag, sonst Quittungsdatum) */
    serviceDate: string | null;
  }[];
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

type Line = { key: string; /** aus diesen Anzahlungen bzw. dieser Quittung übernommen (fällt beim Abwählen wieder weg) */ depositIds?: string[]; /** Position einer normalen Quittung (eine Quittung kann mehrere haben) */ fromReceipt?: boolean; treatmentRecordId?: string | null; appointmentId?: string | null; serviceId: string; description: string; quantity: string; factor: string; price: string; vatRate: number; /** Eingabe im Kürzel-Feld (sonst Kürzel der gewählten Leistung) */ codeInput?: string; /** Stand vor der Kürzel-Eingabe (für unbekannte Kürzel) */ codeStart?: { serviceId: string; description: string; price: string; vatRate: number } };

let seq = 0;
const euro = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
const num = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const isEmptyLine = (l: Line) => !l.serviceId && !l.description.trim() && !l.price.trim() && !l.treatmentRecordId && !l.appointmentId;

/** Text einer übernommenen Quittungs-Position: Leistungsdatum voran, sofern der Text noch kein Datum nennt */
const receiptLineText = (l: OpenReceipt["lines"][number]) => (/\d{2}\.\d{2}\.\d{4}/.test(l.description) ? l.description : `${dateDe(l.serviceDate)}: ${l.description}`).slice(0, 300);

/**
 * Positionen passend zu den gewählten Quittungen.
 * - Normale Quittungen (Teilrechnungen): alle ihre Positionen mit Preis, Menge, Faktor, USt und Termin-/Doku-Bezug
 *   (als Freitext, damit der bezahlte Preis bleibt – auch wenn sich der Katalogpreis inzwischen geändert hat).
 * - Anzahlungen: eine Position je Behandlung – mehrere Anzahlungen zum selben Termin ergeben eine Position mit der Summe.
 * Steht eine Behandlung schon als Position drin (Termin/Doku aus dem Jahresvorschlag oder einer anderen Quittung), wird
 * sie nicht noch einmal übernommen (nie doppelt), nur angerechnet. Unveränderte Auswahl behält vorhandene (ggf.
 * bearbeitete) Zeilen.
 */
function syncDepositLines(ls: Line[], chosen: OpenDeposit[], chosenReceipts: OpenReceipt[] = []): Line[] {
  const others = ls.filter((l) => !l.depositIds?.length);
  const existing = ls.filter((l) => l.depositIds?.length);
  const covers = (list: { appointmentId?: string | null; treatmentRecordId?: string | null }[], x: { appointmentId: string | null; treatmentRecordId: string | null }) =>
    list.some((l) => (!!x.appointmentId && l.appointmentId === x.appointmentId) || (!!x.treatmentRecordId && l.treatmentRecordId === x.treatmentRecordId));
  const receiptLines: Line[] = [];
  for (const r of chosenReceipts) {
    const prev = existing.filter((l) => l.fromReceipt && l.depositIds![0] === r.id);
    if (prev.length) {
      receiptLines.push(...prev);
      continue;
    }
    for (const rl of r.lines) {
      if (covers([...others, ...receiptLines], rl)) continue;
      receiptLines.push(
        newLine({
          depositIds: [r.id],
          fromReceipt: true,
          appointmentId: rl.appointmentId,
          treatmentRecordId: rl.treatmentRecordId,
          description: receiptLineText(rl),
          quantity: String(rl.quantity).replace(".", ","),
          factor: String(rl.factor).replace(".", ","),
          price: euro(rl.unitPriceCents),
          vatRate: rl.vatRate,
        }),
      );
    }
  }
  const groups = new Map<string, OpenDeposit[]>();
  for (const d of chosen) {
    if (covers([...others, ...receiptLines], d)) continue;
    const key = `${d.appointmentId ?? d.treatmentRecordId ?? d.id}|${d.vatRate}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const depLines = [...groups.values()].map((g) => {
    const ids = g.map((d) => d.id);
    const prev = existing.find((l) => !l.fromReceipt && sameIds(l.depositIds!, ids));
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
  const added = [...receiptLines, ...depLines];
  const result = [...(added.length ? others.filter((l) => !isEmptyLine(l)) : others), ...added];
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
  openReceipts = [],
  receiptsYear,
}: {
  patients: PatientOpt[];
  services: Service[];
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
  /** offene normale Quittungen (Teilrechnungen) der vorausgewählten Person im Jahr `receiptsYear` */
  openReceipts?: OpenReceipt[];
  /** Jahr der Sammelrechnung: angeboten werden die Quittungen dieses Jahres */
  receiptsYear?: number;
}) {
  const [state, action, pending] = useActionState(createInvoiceAction, undefined);
  const svcById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const initialPatient = patients.find((p) => p.id === (preset ? preset.patientId : preselectPatientId));

  const [kind, setKind] = useState<CreatableKind>(preset?.kind ?? "invoice");
  const [patientId, setPatientId] = useState(initialPatient?.id ?? "");
  const [billingContactId, setBillingContactId] = useState(preset?.billingContactId ?? initialPatient?.billingContactId ?? "");
  /** Auswahl der anzurechnenden Anzahlungen (Standard: bei Sammelrechnung alle offenen der Person, sonst keine) */
  const [depositSel, setDepositSel] = useState<Record<string, boolean>>({});
  /** Auswahl der anzurechnenden normalen Quittungen (nur Sammelrechnung; Standard: alle des Jahres) */
  const [receiptSel, setReceiptSel] = useState<Record<string, boolean>>({});
  /** geladene offene Quittungen je Person (vorausgewählte Person vom Server, andere werden nachgeladen) */
  const [receiptsBy, setReceiptsBy] = useState<Record<string, OpenReceipt[]>>(() => {
    const m: Record<string, OpenReceipt[]> = {};
    if (initialPatient) m[initialPatient.id] = openReceipts.filter((r) => r.patientId === initialPatient.id);
    return m;
  });
  const [loadingReceipts, startLoadingReceipts] = useTransition();
  /** aktueller Stand für das Nachladen (Antwort kommt asynchron, Auswahl kann sich inzwischen geändert haben) */
  const cur = useRef({ kind: (preset?.kind ?? "invoice") as CreatableKind, patientId: initialPatient?.id ?? "", depositSel: {} as Record<string, boolean>, receiptSel: {} as Record<string, boolean> });
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
    // Sammelrechnung: offene Anzahlungen und Quittungen der Person sind vorausgewählt → ihre Leistungen gleich als Positionen
    const k = preset?.kind ?? "invoice";
    const pid = initialPatient?.id;
    return k === "collective" && pid
      ? syncDepositLines(start, openDeposits.filter((d) => d.patientId === pid), openReceipts.filter((r) => r.patientId === pid))
      : start;
  });
  // Quittung aus dem Termin: Barzahlung über den vorausgefüllten Betrag vorschlagen
  const [payments, setPayments] = useState<PaymentRow[]>(() => {
    if (preset?.kind !== "receipt") return [];
    const cents = preset.lines.reduce((s, l) => s + lineTotalCents(l.unitPriceCents ?? 0, l.quantity, 1), 0);
    return cents > 0 ? [newPaymentRow(cents)] : [];
  });
  const [confirmed, setConfirmed] = useState(therapeuticDefault);
  const [showGuard, setShowGuard] = useState(!therapeuticDefault);

  const filteredPatients = useMemo(() => {
    const f = patientFilter.trim().toLowerCase();
    if (!f) return patients;
    return patients.filter((p) => `${p.lastName} ${p.firstName ?? ""} ${p.number}`.toLowerCase().includes(f) || p.id === patientId);
  }, [patients, patientFilter, patientId]);

  const computed = lines.map((l) => {
    const s = l.serviceId ? svcById.get(l.serviceId) : undefined;
    const unit = s ? s.priceCents : (parseMoney(l.price) ?? 0);
    const vatRate = smallBusiness ? 0 : l.vatRate;
    return {
      ...l,
      unit,
      vatRate,
      totalCents: lineTotalCents(unit, num(l.quantity), num(l.factor)),
      // komplett leere Zeile (z. B. nach Enter im Kürzel-Feld) wird ignoriert – weder abgerechnet noch geprüft
      blank: !l.serviceId && !l.description.trim() && !l.price.trim() && !l.treatmentRecordId && !l.appointmentId,
      needsConfirm: !smallBusiness && vatRate === 0 && (s ? s.requiresTherapeuticPurpose : kind !== "no_show_fee"),
    };
  }).map((l) => (l.blank ? { ...l, needsConfirm: false } : l));
  const totals = computeTotals(computed.filter((l) => !l.blank));
  const needsConfirm = computed.some((l) => l.needsConfirm);
  const paid = paymentsSum(payments);
  const depositsAllowed = kind === "invoice" || kind === "collective";
  const patientDeposits = depositsAllowed && patientId ? openDeposits.filter((d) => d.patientId === patientId) : [];
  /** Sammelrechnung: vorausgewählt sind die offenen Quittungen (AZ und Q) aus dem Jahr der Sammelrechnung */
  const inYear = (iso: string | null) => !receiptsYear || !iso || iso.startsWith(String(receiptsYear));
  const depositDefault = (k: CreatableKind, d: OpenDeposit) => k === "collective" && inYear(d.issuedAt);
  const depositOn = (id: string) => depositSel[id] ?? depositDefault(kind, patientDeposits.find((d) => d.id === id)!);
  const credited = patientDeposits.filter((d) => depositOn(d.id));
  const patientReceipts = kind === "collective" && patientId ? (receiptsBy[patientId] ?? []) : [];
  const receiptOn = (id: string) => receiptSel[id] ?? true;
  const creditedReceipts = patientReceipts.filter((r) => receiptOn(r.id));
  const creditedReceiptCents = creditedReceipts.reduce((s, r) => s + r.totalCents, 0);
  const creditedCents = credited.reduce((s, d) => s + d.totalCents, 0) + creditedReceiptCents;
  const hasPartials = patientDeposits.length > 0 || patientReceipts.length > 0;
  /** eine Auswahlliste für beide Quittungsarten (Sammelrechnung), nach Datum */
  const partialItems = [
    ...patientDeposits.map((d) => ({ id: d.id, kind: "deposit" as const, number: d.number, issuedAt: d.issuedAt, totalCents: d.totalCents, text: depositLineText(d), warn: !d.appointmentId && !d.treatmentRecordId, on: depositOn(d.id) })),
    ...patientReceipts.map((r) => ({ id: r.id, kind: "receipt" as const, number: r.number, issuedAt: r.issuedAt, totalCents: r.totalCents, text: r.lines.map((l) => l.description).join(", "), warn: false, on: receiptOn(r.id) })),
  ].sort((x, y) => (x.issuedAt ?? "").localeCompare(y.issuedAt ?? "") || (x.number ?? "").localeCompare(y.number ?? ""));
  const openAfterDeposits = totals.totalCents - creditedCents;

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function chooseService(key: string, serviceId: string) {
    const s = svcById.get(serviceId);
    if (!s) return update(key, { serviceId: "", description: "", price: "", codeInput: undefined, codeStart: undefined });
    update(key, { serviceId, description: s.name, price: euro(s.priceCents), vatRate: s.vatRate, codeInput: undefined, codeStart: undefined });
  }

  /**
   * Schnelleingabe: Kürzel tippen (z. B. „PK“) → passende Leistung wird gewählt – genau wie über die Auswahlliste
   * (Beschreibung, Katalogpreis und USt werden ersetzt, damit Text, Entgelt und Steuer zusammenpassen).
   * Bleibt das Kürzel unbekannt, stellt codeBlur den Stand vor der Eingabe wieder her.
   */
  function typeCode(key: string, value: string) {
    const s = findServiceByCode(services, value);
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l;
        const codeStart = l.codeStart ?? { serviceId: l.serviceId, description: l.description, price: l.price, vatRate: l.vatRate };
        if (!s || s.id === l.serviceId) return { ...l, codeInput: value, codeStart };
        return { ...l, serviceId: s.id, description: s.name, price: euro(s.priceCents), vatRate: s.vatRate, codeInput: value, codeStart };
      }),
    );
  }

  // Fokus über Refs statt DOM-ids (Zeilen-Keys unterscheiden sich zwischen Server und Browser)
  const codeRefs = useRef(new Map<string, HTMLInputElement>());
  /** neu angelegte Zeile: Fokus, sobald ihr Kürzel-Feld im DOM ist (im Ref-Callback) */
  const pendingFocus = useRef<string | null>(null);

  const codeUnknown = (l: Line) => !!l.codeInput?.trim() && !findServiceByCode(services, l.codeInput);
  const isBlank = (l: Line) => !l.serviceId && !l.description.trim() && !l.price.trim() && !l.treatmentRecordId && !l.appointmentId;

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

  /** gewählte Anzahlungen und Quittungen für Belegart/Person/Auswahl */
  function chosenPartials(nextKind: CreatableKind, pid: string, dSel: Record<string, boolean>, rSel: Record<string, boolean>, rBy: Record<string, OpenReceipt[]>) {
    const allowed = nextKind === "invoice" || nextKind === "collective";
    const deps = allowed && pid ? openDeposits.filter((d) => d.patientId === pid && (dSel[d.id] ?? depositDefault(nextKind, d))) : [];
    const recs = nextKind === "collective" && pid ? (rBy[pid] ?? []).filter((r) => rSel[r.id] ?? true) : [];
    return { deps, recs };
  }
  /** Auswahl der Quittungen ändern und Positionen nachziehen (`without`: gerade entfernte Position) */
  function applyDeposits(nextKind: CreatableKind, pid: string, dSel: Record<string, boolean>, rSel: Record<string, boolean> = receiptSel, without?: string) {
    cur.current = { kind: nextKind, patientId: pid, depositSel: dSel, receiptSel: rSel };
    const { deps, recs } = chosenPartials(nextKind, pid, dSel, rSel, receiptsBy);
    setLines((ls) => syncDepositLines(without ? ls.filter((l) => l.key !== without) : ls, deps, recs));
    // Quittungen der Person für die Sammelrechnung nachladen (einmal je Person)
    if (nextKind === "collective" && pid && !(pid in receiptsBy) && receiptsYear) {
      startLoadingReceipts(async () => {
        const list = (await openReceiptsAction(pid, receiptsYear)) as OpenReceipt[];
        setReceiptsBy((m) => ({ ...m, [pid]: list }));
        const c = cur.current;
        if (c.kind !== "collective" || c.patientId !== pid || !list.length) return;
        const next = chosenPartials(c.kind, pid, c.depositSel, c.receiptSel, { [pid]: list });
        setLines((ls) => syncDepositLines(ls, next.deps, next.recs));
      });
    }
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
  function selectAllPartials(on: boolean) {
    const dSel = { ...depositSel };
    for (const d of patientDeposits) dSel[d.id] = on;
    const rSel = { ...receiptSel };
    for (const r of patientReceipts) rSel[r.id] = on;
    setDepositSel(dSel);
    setReceiptSel(rSel);
    applyDeposits(kind, patientId, dSel, rSel);
  }
  function toggleReceipt(id: string, on: boolean) {
    const sel = { ...receiptSel, [id]: on };
    setReceiptSel(sel);
    applyDeposits(kind, patientId, depositSel, sel);
  }
  /** Position entfernen; stammt sie aus einer Quittung/Anzahlung, wird diese auch nicht mehr angerechnet */
  function removeLine(l: Line) {
    if (!l.depositIds?.length) return setLines((ls) => ls.filter((x) => x.key !== l.key));
    const off = Object.fromEntries(l.depositIds.map((id) => [id, false]));
    const dSel = l.fromReceipt ? depositSel : { ...depositSel, ...off };
    const rSel = l.fromReceipt ? { ...receiptSel, ...off } : receiptSel;
    setDepositSel(dSel);
    setReceiptSel(rSel);
    applyDeposits(kind, patientId, dSel, rSel, l.key);
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
  const appendLine = (l: Line) => setLines((ls) => [...ls.filter((x) => x.serviceId || x.description || x.price), l]);
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
    computed.filter((l) => !l.blank).map((l) => ({
      serviceId: l.serviceId || null,
      treatmentRecordId: l.treatmentRecordId || null,
      appointmentId: l.appointmentId || null,
      description: l.description,
      quantity: num(l.quantity),
      factor: num(l.factor),
      unitPriceCents: l.unit,
      vatRate: l.vatRate,
    })),
  );

  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-6">
      <input type="hidden" name="lines" value={linesJson} />
      <input type="hidden" name="payments" value={paymentsToJson(payments)} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="depositIds" value={JSON.stringify(credited.map((d) => d.id))} />
      <input type="hidden" name="receiptIds" value={JSON.stringify(creditedReceipts.map((r) => r.id))} />
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

      {kind !== "collective" && patientDeposits.length ? (
        <Card>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">
              Quittungen (Anzahlungen) von {patients.find((p) => p.id === patientId)?.lastName ?? "der Patient:in"} ({patientDeposits.length})
            </h2>
            <div className="flex gap-3 text-sm font-semibold">
              <button type="button" className="text-primary hover:underline" onClick={() => selectAllDeposits(true)}>Alle wählen</button>
              <button type="button" className="text-muted hover:underline" onClick={() => selectAllDeposits(false)}>Keine</button>
            </div>
          </div>
          <p className="mb-3 text-sm text-muted">
            Gewählte Quittungen kommen mit ihrer Leistung als Position auf die Rechnung (Betrag = gezahlter Betrag, bitte prüfen); der bereits bezahlte Betrag wird angerechnet.
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

      {kind === "collective" && patientId && loadingReceipts && !(patientId in receiptsBy) ? (
        <p className="text-sm text-muted" aria-live="polite">Quittungen {receiptsYear ?? ""} werden geladen …</p>
      ) : null}
      {kind === "collective" && hasPartials ? (
        <Card>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">
              Quittungen von {patients.find((p) => p.id === patientId)?.lastName ?? "der Patient:in"} ({partialItems.length})
            </h2>
            <div className="flex gap-3 text-sm font-semibold">
              <button type="button" className="text-primary hover:underline" onClick={() => selectAllPartials(true)}>Alle wählen</button>
              <button type="button" className="text-muted hover:underline" onClick={() => selectAllPartials(false)}>Keine</button>
            </div>
          </div>
          <p className="mb-3 text-sm text-muted">
            Alle bezahlten Quittungen – aus dem Kalender (AZ…) und aus Rechnungen (Q…) – werden auf der Sammelrechnung zusammengeführt: ihre Leistungen kommen als
            Positionen dazu, der bezahlte Betrag wird als „bereits bezahlt“ abgezogen (mit USt-Ausweis). Kein zweiter Umsatz und keine neue Kassenbuchung.
            Vorausgewählt sind die offenen Quittungen {receiptsYear ? `aus ${receiptsYear}` : "des Jahres"}.
          </p>
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {partialItems.map((it) => (
              <li key={it.id} className="px-3 py-1">
                <Checkbox
                  checked={it.on}
                  onChange={(e) => (it.kind === "receipt" ? toggleReceipt(it.id, e.target.checked) : toggleDeposit(it.id, e.target.checked))}
                  label={`${it.number ?? "Quittung"} vom ${dateDe(it.issuedAt)} · ${it.text} · ${money(it.totalCents)}${it.warn ? " – ohne Terminbezug: bitte prüfen, dass die Behandlung nicht doppelt als Position steht" : ""}`}
                />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm">
            {partialItems.filter((it) => it.on).length} von {partialItems.length} gewählt · bereits bezahlt: <span className="font-semibold tabular-nums">{money(creditedCents)}</span>
          </p>
        </Card>
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
            return (
              // Ab md zwei Zeilen (Leistung/Beschreibung, dann Zahlen), erst ab 2xl alles in einer Zeile – kein horizontales
              // Scrollen auf dem iPad (Gesamt-Review M8). min-w-0: Eingabefelder dürfen schrumpfen.
              <div key={l.key} className="grid gap-3 rounded-xl border border-border p-3 md:grid-cols-6 md:items-end 2xl:grid-cols-[minmax(10rem,1.2fr)_minmax(10rem,2fr)_5rem_5rem_7rem_7rem_auto] [&>*]:min-w-0">
                <div role="group" aria-labelledby={`pos-${i}-label`} className="flex flex-col gap-1.5 md:col-span-3 2xl:col-span-1">
                  <span id={`pos-${i}-label`} className="text-sm font-medium">{`Pos. ${i + 1}: Leistung`}</span>
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
                      value={l.codeInput ?? s?.code ?? ""}
                      onChange={(e) => typeCode(l.key, e.target.value)}
                      onKeyDown={(e) => codeKeyDown(e, l.key)}
                      onBlur={() => codeBlur(l.key)}
                    />
                    <Select aria-label={`Pos. ${i + 1}: Leistung auswählen`} value={l.serviceId} onChange={(e) => chooseService(l.key, e.target.value)}>
                      <option value="">Freitext</option>
                      {services.map((sv) => (
                        <option key={sv.id} value={sv.id}>{sv.code} · {sv.name}</option>
                      ))}
                    </Select>
                  </div>
                  {codeUnknown(l) ? (
                    <span id={`pos-${i}-hint`} aria-live="polite" className="text-xs text-danger">Kürzel „{normalizeServiceCode(l.codeInput ?? "")}“ unbekannt</span>
                  ) : null}
                </div>
                <Field label="Beschreibung" className="md:col-span-3 2xl:col-span-1">
                  <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} placeholder={s?.name ?? "z. B. Pflegeprodukt"} />
                </Field>
                <Field label="Menge">
                  <Input inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                </Field>
                <Field label="Faktor">
                  <Input inputMode="decimal" value={l.factor} onChange={(e) => update(l.key, { factor: e.target.value })} />
                </Field>
                <Field label="Preis (€)" hint={s ? "aus Katalog" : undefined}>
                  <Input inputMode="decimal" value={l.price} disabled={!!s} onChange={(e) => update(l.key, { price: e.target.value })} placeholder="0,00" />
                </Field>
                <Field label="USt">
                  {smallBusiness ? (
                    <Input value="0 % (§ 19)" disabled />
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
                    onClick={() => removeLine(l)}
                  >
                    <Trash2 size={18} aria-hidden />
                  </Button>
                </div>
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
                0 % USt ist nur bei einer Heilbehandlung mit therapeutischem Ziel zulässig. Bitte bestätigen – sonst die betroffenen Positionen mit 19 % abrechnen.
              </p>
              <Checkbox name="therapeuticConfirmed" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} label={THERAPEUTIC_LABEL} />
              <Button
                type="button"
                variant="secondary"
                onClick={() => setLines((ls) => ls.map((l, i) => (computed[i]?.needsConfirm ? { ...l, vatRate: 19 } : l)))}
              >
                Betroffene Positionen auf 19 % umstellen
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {hasPartials ? (
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
            ? "Quittung: Der Betrag wird sofort vollständig bezahlt. Kann später in die Sammelrechnung übernommen werden (wird dort als „bereits bezahlt“ angerechnet)."
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
        <Button type="submit" disabled={pending || totals.totalCents <= 0 || openAfterDeposits < 0 || (needsConfirm && !confirmed)}>
          {pending ? "Wird ausgestellt …" : `${INVOICE_KIND_LABEL[kind]} ausstellen`}
        </Button>
        <Link href="/rechnungen" className="inline-flex h-11 items-center px-4 font-semibold text-muted">Abbrechen</Link>
        <p className="w-full text-xs text-muted">Nach dem Ausstellen sind Nummer und Beträge unveränderbar (GoBD). Korrekturen nur per Storno.</p>
      </div>
    </form>
  );
}

"use client";

import { keepValues } from "@/lib/forms";
import Link from "next/link";
import { useActionState, useMemo, useRef, useState, useTransition } from "react";
import { AlertTriangle, Car, Info, Plus, Trash2 } from "lucide-react";
import { Button, Card, Checkbox, cx, Field, fieldCls, FieldSlot, fieldLabelCls, FormError, Input, Select, Textarea } from "@/components/ui";
import { depositLineText } from "@/lib/deposit-lines";
import { dateDe, money, parseMoney } from "@/lib/format";
import { serviceDateDefaults } from "@/lib/invoice-view";
import { computeTotals, lineTotalCents } from "@/lib/invoice-math";
import { findServiceByCode, normalizeServiceCode } from "@/lib/service-code";
import { PRODUCT_IN_TREATMENT_LABEL, productVatHint, resolveProductVat, type VatRuleLine } from "@/lib/product-vat";
import { CREATABLE_KINDS, INVOICE_KIND_LABEL, NOTE_SMALL_BUSINESS, RECEIPT_COLLECTIVE_HINT, THERAPEUTIC_LABEL, type CreatableKind } from "@/lib/invoice-labels";
import { depositCheckHint, depositPreselected } from "@/lib/deposit-rules";
import { euro, isEmptyLine, newLine, syncDepositLines, type Line, type OpenDeposit, type OpenReceipt } from "@/lib/partial-lines";
import { createInvoiceAction, openReceiptsAction } from "./actions";
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
  /** Leistungsdatum für Positionen ohne Termin-Bezug (z. B. Tag des Termins, aus dem die Rechnung entsteht) */
  serviceDate?: string | null;
  lines: { treatmentRecordId?: string | null; appointmentId?: string | null; serviceId: string | null; description: string; quantity: number; unitPriceCents: number | null; vatRate: number }[];
};

export type { OpenDeposit, OpenReceipt } from "@/lib/partial-lines";

/** Wegegeld für Hausbesuche (nur vor dem Ausstellen, nur Privat/Selbstzahler) – siehe src/server/trips.ts */
export type TravelOptions = {
  patientId: string;
  eligible: boolean;
  rateCents: number | null;
  billing: "oneway" | "roundtrip";
  flatServices: { id: string; name: string; priceCents: number }[];
  suggestions: { tripId: string; date: string; km: number; description: string; maybeBilled: boolean }[];
} | null;

const num = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const PRODUCT_PREFIX = "p:";

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
  openReceipts = [],
  receiptsYear,
  alreadyBilled = [],
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
  /** Vorab-Prüfung (Termin/Behandlung der Vorlage ist schon abgerechnet): Hinweis mit Link, Ausstellen gesperrt */
  alreadyBilled?: { id: string; label: string }[];
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
  /** Termine/Behandlungen der Vorlage: offene Anzahlungen dazu sind bei einer Rechnung vorausgewählt (nie doppelt kassieren) */
  const presetRefs = new Set((preset?.lines ?? []).flatMap((l) => [l.appointmentId, l.treatmentRecordId]).filter((x): x is string => !!x));
  /** Vorauswahl: Sammelrechnung nur Anzahlungen des Jahres mit erbrachter Leistung (src/lib/deposit-rules.ts) */
  const depositDefault = (k: CreatableKind, d: OpenDeposit) => depositPreselected(k, d, { today, receiptsYear, presetRefs });
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
    // Sammelrechnung: offene Quittungen und Anzahlungen mit erbrachter Leistung sind vorausgewählt → ihre Leistungen gleich als Positionen
    const k = preset?.kind ?? "invoice";
    const pid = initialPatient?.id;
    return k === "collective" && pid
      ? syncDepositLines(start, openDeposits.filter((d) => d.patientId === pid && depositDefault(k, d)), openReceipts.filter((r) => r.patientId === pid))
      : start;
  });
  // Quittung aus dem Termin: Barzahlung über den vorausgefüllten Betrag vorschlagen
  const [payments, setPayments] = useState<PaymentRow[]>(() => {
    if (preset?.kind !== "receipt") return [];
    const cents = preset.lines.reduce((s, l) => s + lineTotalCents(l.unitPriceCents ?? 0, l.quantity, 1), 0);
    return cents > 0 ? [newPaymentRow(cents)] : [];
  });
  const [issuedAt, setIssuedAt] = useState(today);
  /** Leistungsdatum ohne Termin-/Doku-Bezug; null = folgt dem Rechnungsdatum, bis es geändert wird */
  const [serviceDate, setServiceDate] = useState<string | null>(preset?.serviceDate ?? null);
  /** Sammelrechnung ohne Termin-Bezug: Ende des Leistungszeitraums (optional) */
  const [serviceDateTo, setServiceDateTo] = useState<string | null>(null);
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
  /**
   * Eigene Positionen ohne Bezug (z. B. Pflegeprodukt, nicht aus einer Quittung übernommen): brauchen ein Leistungsdatum –
   * auch neben verknüpften. Übernommene Quittungen bringen ihr festgeschriebenes Leistungsdatum selbst mit.
   */
  const freeLines = computed.some((l) => !l.blank && !l.appointmentId && !l.treatmentRecordId && !l.fromReceipt);
  const fromRefs = computed.some((l) => !l.blank && (!!l.appointmentId || !!l.treatmentRecordId || !!l.fromReceipt));
  const needsConfirm = computed.some((l) => l.needsConfirm);
  const paid = paymentsSum(payments);
  const depositsAllowed = kind === "invoice" || kind === "collective";
  const patientDeposits = depositsAllowed && patientId ? openDeposits.filter((d) => d.patientId === patientId) : [];
  // „Trotzdem erstellen“ gilt nur für genau den angezeigten Dubletten-Beleg: zeigt der nächste Hinweis auf einen anderen,
  // ist der Haken automatisch wieder aus (Bestätigung an die ID gebunden statt per Effekt zurückgesetzt)
  const [duplicateAckFor, setDuplicateAckFor] = useState<string | null>(null);
  const duplicateId = state?.duplicate?.id ?? null;
  const confirmDuplicate = !!duplicateId && duplicateAckFor === duplicateId;
  const setConfirmDuplicate = (on: boolean) => setDuplicateAckFor(on ? duplicateId : null);
  const depositOn = (id: string) => depositSel[id] ?? depositDefault(kind, patientDeposits.find((d) => d.id === id)!);
  const credited = patientDeposits.filter((d) => depositOn(d.id));
  const patientReceipts = kind === "collective" && patientId ? (receiptsBy[patientId] ?? []) : [];
  const receiptOn = (id: string) => receiptSel[id] ?? true;
  const creditedReceipts = patientReceipts.filter((r) => receiptOn(r.id));
  const creditedReceiptCents = creditedReceipts.reduce((s, r) => s + r.totalCents, 0);
  /** Leistungstage der übernommenen Quittungen → Vorbelegung des Leistungszeitraums (Sammelrechnung) */
  const receiptDays = creditedReceipts.flatMap((r) => r.lines.map((l) => l.serviceDate ?? r.issuedAt)).filter((d): d is string => !!d).sort();
  const { from: serviceValue, to: serviceToValue, receiptHint } = serviceDateDefaults({ kind, issuedAt, serviceDate, serviceDateTo, receiptDays, dateDe });
  const serviceLabel = kind === "no_show_fee" ? "Termin am" : kind === "collective" ? "Leistung von" : "Leistungsdatum";
  const creditedCents = credited.reduce((s, d) => s + d.totalCents, 0) + creditedReceiptCents;
  const hasPartials = patientDeposits.length > 0 || patientReceipts.length > 0;
  /** eine Auswahlliste für Quittungen und Anzahlungen (Sammelrechnung), nach Datum */
  const partialItems = [
    ...patientDeposits.map((d) => ({ id: d.id, kind: "deposit" as const, number: d.number, issuedAt: d.issuedAt, totalCents: d.totalCents, text: depositLineText(d), warn: depositCheckHint(d, today), on: depositOn(d.id) })),
    ...patientReceipts.map((r) => ({ id: r.id, kind: "receipt" as const, number: r.number, issuedAt: r.issuedAt, totalCents: r.totalCents, text: r.lines.map((l) => l.description).join(", "), warn: null as string | null, on: receiptOn(r.id) })),
  ].sort((x, y) => (x.issuedAt ?? "").localeCompare(y.issuedAt ?? "") || (x.number ?? "").localeCompare(y.number ?? ""));
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
        // aus einer übernommenen Quittung: deren Leistungsdatum gilt (nicht das Formular-Datum)
        fromReceipt: !!l.fromReceipt,
        description: l.description,
        quantity: num(l.quantity),
        factor: l.productId ? 1 : num(l.factor),
        unitPriceCents: l.unit,
        // Wunschsatz; Kleinunternehmer → der Server setzt 0 %
        vatRate: l.productId ? l.requested : l.vatRate,
      };
    }),
  );

  // Texte unten passend zur oben gewählten Belegart (Rechnung, Quittung, Sammelrechnung, Ausfallhonorar)
  const docLabel = INVOICE_KIND_LABEL[kind];
  const onDoc = kind === "no_show_fee" ? "auf dem Beleg" : `auf der ${docLabel}`;
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-6">
      <input type="hidden" name="lines" value={linesJson} />
      <input type="hidden" name="payments" value={paymentsToJson(payments)} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="depositIds" value={JSON.stringify(credited.map((d) => d.id))} />
      <input type="hidden" name="receiptIds" value={JSON.stringify(creditedReceipts.map((r) => r.id))} />
      {kind === "collective" && receiptsYear ? <input type="hidden" name="collectiveYear" value={receiptsYear} /> : null}
      {alreadyBilled.length ? (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">
          Diese Behandlung wurde bereits abgerechnet:{" "}
          {alreadyBilled.map((b, i) => (
            <span key={b.id}>
              {i ? ", " : ""}
              <Link href={`/rechnungen/${b.id}`} className="underline">{b.label}</Link>
            </span>
          ))}
          . Ein zweiter Beleg ist nicht möglich.
        </p>
      ) : null}
      {state?.duplicate ? (
        <div role="alert" className="rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">
          <p className="font-semibold">
            {state.error}{" "}
            <Link href={`/rechnungen/${state.duplicate.id}`} className="underline" target="_blank">{state.duplicate.number} ansehen</Link>
          </p>
          <Checkbox checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} label="Trotzdem erstellen (wird protokolliert)" />
          {/* Bestätigung gilt nur für genau diesen Beleg */}
          {confirmDuplicate ? <input type="hidden" name="duplicateAck" value={state.duplicate.id} /> : null}
        </div>
      ) : state?.link ? (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">
          {state.error}{" "}
          <Link href={`/rechnungen/${state.link.id}`} className="underline">{state.link.label}</Link>
        </p>
      ) : (
        <FormError message={state?.error} />
      )}

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
        {/* iPad (1024 px, mit Seitenleiste ~700 px Inhalt): zwei Spalten, erst ab xl drei (Gesamt-Review M8). Beschriftungen
            einzeilig, Hinweise unter dem Feld – die Eingaben einer Zeile stehen immer auf derselben Höhe. */}
        <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Patient suchen">
            <Input value={patientFilter} onChange={(e) => setPatientFilter(e.target.value)} placeholder="Name oder Nummer" autoComplete="off" />
          </Field>
          <Field label={kind === "collective" ? "Patient" : "Patient *"} hint={kind === "collective" ? "für die Jahres-Sammelrechnung" : undefined}>
            <Select name="patientId" value={patientId} onChange={(e) => choosePatient(e.target.value)} required={kind !== "collective" || !billingContactId}>
              <option value="">– bitte wählen –</option>
              {filteredPatients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.lastName}{p.firstName ? `, ${p.firstName}` : ""} (#{p.number})
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={kind === "collective" ? "Rechnungsempfänger" : "Abweichender Rechnungsempfänger"}
            hint={kind === "collective" ? "z. B. Pflegeheim – Patient oder Rechnungsempfänger angeben" : "z. B. Pflegeheim, Betreuer:in, Angehörige"}
          >
            <Select name="billingContactId" value={billingContactId} onChange={(e) => setBillingContactId(e.target.value)} required={kind === "collective" && !patientId}>
              <option value="">– keiner –</option>
              {billingContacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Datum">
            <Input type="date" name="issuedAt" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} max={today} required />
          </Field>
          {/* § 14 Abs. 4 Nr. 6 UStG: Zeitpunkt der Leistung. Verknüpfte Termine liefern ihn selbst; Positionen ohne Bezug
              brauchen ein Datum – der Beleg nennt beim Ausstellen den Zeitraum aus beidem (festgeschrieben). */}
          {fromRefs && !freeLines ? (
            <Field label={kind === "no_show_fee" ? "Termin am" : "Leistungsdatum"} hint={receiptHint ?? "aus den verknüpften Terminen bzw. übernommenen Quittungen"}>
              <Input value="laut Termin/Quittung" disabled readOnly />
            </Field>
          ) : (
            <Field
              label={serviceLabel}
              hint={
                kind === "no_show_fee"
                  ? "Datum des versäumten Termins"
                  : receiptHint
                    ? `Eigene Positionen (z. B. Produkte). ${receiptHint}.`
                    : fromRefs
                      ? "für Positionen ohne Termin/Quittung (z. B. Produkte)"
                      : "Tag der Behandlung bzw. Lieferung"
              }
            >
              <Input type="date" name="serviceDate" value={serviceValue} onChange={(e) => setServiceDate(e.target.value)} max={today} required />
            </Field>
          )}
          {kind === "collective" && (freeLines || !fromRefs) ? (
            <Field label="Leistung bis" hint="optional – Leistungszeitraum (§ 31 Abs. 4 UStDV)">
              <Input type="date" name="serviceDateTo" value={serviceToValue} onChange={(e) => setServiceDateTo(e.target.value)} min={serviceValue || undefined} max={today} />
            </Field>
          ) : null}
          <Field label="Zahlungsziel" hint={kind === "receipt" ? "Quittung: sofort bezahlt" : "in Tagen, 0 = sofort"}>
            <Input type="number" name="dueDays" min={0} max={120} suffix="Tage" defaultValue={kind === "receipt" ? 0 : defaultDueDays} key={kind === "receipt" ? "r" : "o"} disabled={kind === "receipt"} />
          </Field>
        </div>
      </Card>

      {kind !== "collective" && patientDeposits.length ? (
        <Card>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">
              Anzahlungen von {patients.find((p) => p.id === patientId)?.lastName ?? "der Patient:in"} ({patientDeposits.length})
            </h2>
            <div className="flex gap-3 text-sm font-semibold">
              <button type="button" className="text-primary hover:underline" onClick={() => selectAllDeposits(true)}>Alle wählen</button>
              <button type="button" className="text-muted hover:underline" onClick={() => selectAllDeposits(false)}>Keine</button>
            </div>
          </div>
          <p className="mb-3 text-sm text-muted">
            Gewählte Anzahlungen kommen mit ihrer Leistung als Position auf die Rechnung (Betrag = gezahlter Betrag, bitte prüfen); der bereits bezahlte Betrag wird angerechnet.
          </p>
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {patientDeposits.map((d) => (
              <li key={d.id} className="px-3 py-1">
                <Checkbox
                  checked={depositOn(d.id)}
                  onChange={(e) => toggleDeposit(d.id, e.target.checked)}
                  label={`${d.number ?? "Anzahlung"} vom ${dateDe(d.issuedAt)} · ${depositLineText(d)} · ${money(d.totalCents)}${
                    depositCheckHint(d, today) ? ` – ${depositCheckHint(d, today)}` : ""
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
        <p className="text-sm text-muted" aria-live="polite">Quittungen & Anzahlungen {receiptsYear ?? ""} werden geladen …</p>
      ) : null}
      {kind === "collective" && hasPartials ? (
        <Card>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">
              Quittungen & Anzahlungen von {patients.find((p) => p.id === patientId)?.lastName ?? "der Patient:in"} ({partialItems.length})
            </h2>
            <div className="flex gap-3 text-sm font-semibold">
              <button type="button" className="text-primary hover:underline" onClick={() => selectAllPartials(true)}>Alle wählen</button>
              <button type="button" className="text-muted hover:underline" onClick={() => selectAllPartials(false)}>Keine</button>
            </div>
          </div>
          <p className="mb-3 text-sm text-muted">
            Bezahlte Quittungen (Q…) und Anzahlungen (AZ…) werden auf der Sammelrechnung zusammengeführt: ihre Leistungen kommen als
            Positionen dazu, der bezahlte Betrag wird als „bereits bezahlt“ abgezogen (mit USt-Ausweis). Kein zweiter Umsatz und keine neue Kassenbuchung.
            Vorausgewählt sind die offenen Quittungen {receiptsYear ? `aus ${receiptsYear}` : "des Jahres"} und Anzahlungen, deren Termin schon stattgefunden hat;
            Anzahlungen für künftige Termine oder ohne Termin bitte nur nach Prüfung anwählen.
          </p>
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {partialItems.map((it) => (
              <li key={it.id} className="px-3 py-1">
                <Checkbox
                  checked={it.on}
                  onChange={(e) => (it.kind === "receipt" ? toggleReceipt(it.id, e.target.checked) : toggleDeposit(it.id, e.target.checked))}
                  label={`${it.number ?? (it.kind === "receipt" ? "Quittung" : "Anzahlung")} vom ${dateDe(it.issuedAt)} · ${it.text} · ${money(it.totalCents)}${it.warn ? ` – ${it.warn}` : ""}`}
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
            const prod = l.productId ? prodById.get(l.productId) : undefined;
            const otherTreatments = treatmentLines.filter((t) => t.key !== l.key);
            return (
              // Ab md zwei Zeilen (Leistung/Beschreibung, dann Zahlen), erst ab 2xl alles in einer Zeile – kein horizontales
              // Scrollen auf dem iPad (Gesamt-Review M8). min-w-0: Eingabefelder dürfen schrumpfen.
              <div key={l.key} className="grid gap-3 rounded-xl border border-border p-3 md:grid-cols-6 md:items-start 2xl:grid-cols-[minmax(10rem,1.2fr)_minmax(10rem,2fr)_5rem_5rem_7rem_7rem_auto] [&>*]:min-w-0">
                <div role="group" aria-labelledby={`pos-${i}-label`} className={cx(fieldCls, "md:col-span-3 2xl:col-span-1")}>
                  <span id={`pos-${i}-label`} className={fieldLabelCls}>{`Pos. ${i + 1}: ${prod ? "Produkt" : "Leistung"}`}</span>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
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
                        className="uppercase placeholder:normal-case"
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
                <Field label="Preis" hint={s || prod ? "aus Katalog" : undefined}>
                  <Input inputMode="decimal" suffix="€" value={l.price} disabled={!!s || !!prod} onChange={(e) => update(l.key, { price: e.target.value })} placeholder="0,00" />
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
                {/* Zeilensumme + Löschen auf der Linie der Eingaben (Platzhalter in Höhe der Beschriftung) */}
                <FieldSlot spacer="hidden md:block" className="md:col-span-2 2xl:col-span-1">
                  <div className="flex w-full items-center justify-between gap-2 md:justify-end">
                    <span className="font-semibold whitespace-nowrap tabular-nums">{money(l.totalCents)}</span>
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
                </FieldSlot>
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
                          <option value="">– bitte zuordnen –</option>
                          {otherTreatments.map((t) => (
                            <option key={t.key} value={t.key}>Pos. {filled.findIndex((x) => x.key === t.key) + 1}: {t.description}</option>
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

      {hasPartials ? (
        <p className="text-sm">
          {kind === "collective" ? "Quittungen & Anzahlungen" : "Anzahlungen"} angerechnet: <span className="font-semibold tabular-nums">{money(creditedCents)}</span> · noch offen:{" "}
          <span className={openAfterDeposits < 0 ? "font-semibold text-danger" : "font-semibold tabular-nums"}>{money(openAfterDeposits)}</span>
          {openAfterDeposits < 0 ? ` – die angerechneten Beträge übersteigen den Betrag der ${docLabel}.` : ""}
        </p>
      ) : null}

      <Card>
        <h2 className="mb-1 font-display text-lg font-semibold">Zahlung</h2>
        <p className="mb-4 text-sm text-muted">
          {kind === "receipt"
            ? `Quittung: Der Betrag wird sofort vollständig bezahlt. ${RECEIPT_COLLECTIVE_HINT} Dort wird er als „bereits bezahlt“ angerechnet.`
            : kind === "collective"
              ? "Optional – nur den noch offenen Betrag der Sammelrechnung erfassen (Quittungen und Anzahlungen sind oben bereits angerechnet). Mischzahlung möglich."
              : "Optional – sofort bezahlte Beträge erfassen. Mischzahlung (z. B. Gutschein + bar) möglich."}
        </p>
        <PaymentsEditor rows={payments} onChange={setPayments} openCents={Math.max(0, openAfterDeposits)} />
        {kind === "receipt" && paid !== totals.totalCents ? (
          <p className="mt-3 text-sm font-medium text-danger">Für eine Quittung muss die Zahlung genau {money(totals.totalCents)} betragen.</p>
        ) : null}
      </Card>

      <Card>
        <Field label={`Hinweis ${onDoc} (keine Diagnosen)`}>
          <Textarea name="notes" defaultValue={preset?.notes ?? ""} placeholder={privateOnly ? "z. B. Behandlungszeitraum" : "z. B. Behandlungszeitraum, Bezug auf Verordnung"} />
        </Field>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={
            pending || totals.totalCents <= 0 || openAfterDeposits < 0 || (needsConfirm && !confirmed) || !!productError || alreadyBilled.length > 0 || (!!state?.duplicate && !confirmDuplicate)
          }
        >
          {pending ? "Wird ausgestellt …" : `${INVOICE_KIND_LABEL[kind]} ausstellen`}
        </Button>
        <Link href="/rechnungen" className="inline-flex h-11 items-center px-4 font-semibold text-muted">Abbrechen</Link>
        <p className="w-full text-xs text-muted">Nach dem Ausstellen sind Nummer und Beträge {kind === "no_show_fee" ? "des Belegs" : `der ${docLabel}`} unveränderbar (GoBD). Korrekturen nur per Storno.</p>
      </div>
    </form>
  );
}

/**
 * Fahrtenbuch-Hilfe (reine Funktionen): Pseudonymisierung, Nachträge anwenden, Summen, CSV, Einstellungen,
 * Navigations-Links und Wegegeld. Ausdrücklich KEIN finanzamtsfestes elektronisches Fahrtenbuch.
 */
import { kmDe } from "./geo";

export const TRIP_LOG_DISCLAIMER =
  "Hilfe zur Dokumentation der Fahrten – kein automatisch finanzamtsfestes elektronisches Fahrtenbuch. Bitte Angaben prüfen; " +
  "für ein ordnungsgemäßes Fahrtenbuch u. a. Kilometerstände und Anlass vollständig und zeitnah erfassen.";

/** Ziel im Fahrtenbuch: NIE der Name, nur die Kundennummer. */
export function tripTargetLabel(patientNumber: number | null | undefined): string {
  return Number.isInteger(patientNumber) && (patientNumber as number) > 0 ? `Hausbesuch K-${patientNumber}` : "Hausbesuch";
}

/** Label darf nur Startort-Namen, „Aktueller Standort“ oder ein Pseudonym enthalten – begrenzt und ohne Steuerzeichen. */
export function cleanLabel(s: string, max = 60): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// ───────────── Einstellungen (organizations.settings.trips) ─────────────
export type TripBilling = "oneway" | "roundtrip";
export type TripSettings = {
  vehicleLabel: string | null;
  plate: string | null;
  /** Wegegeld je km in Cent (z. B. 30 = 0,30 €) – null = nicht festgelegt */
  rateCents: number | null;
  /** Wegegeld: nur Hinweg oder Hin- und Rückweg (×2) */
  billing: TripBilling;
  /** Tour: standardmäßig zum Startort zurückkehren */
  returnToStart: boolean;
};

export function tripSettings(settings: Record<string, unknown> | null | undefined): TripSettings {
  const t = (settings?.trips ?? {}) as Partial<Record<keyof TripSettings, unknown>>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null);
  const rate = typeof t.rateCents === "number" && Number.isInteger(t.rateCents) && t.rateCents >= 0 && t.rateCents <= 1000 ? t.rateCents : null;
  return {
    vehicleLabel: str(t.vehicleLabel),
    plate: str(t.plate),
    rateCents: rate,
    billing: t.billing === "roundtrip" ? "roundtrip" : "oneway",
    returnToStart: t.returnToStart !== false,
  };
}

// ───────────── Nachträge ─────────────
export type TripRow = {
  id: string;
  tripDate: string;
  startedAt: Date;
  fromLabel: string;
  toLabel: string;
  purpose: string;
  distanceM: number;
  durationSec: number | null;
  distanceSource: string;
  appointmentId: string | null;
  vehicleLabel: string | null;
  plate: string | null;
  odometerStart: number | null;
  driverId: string | null;
};

export type CorrectionRow = {
  id: string;
  tripId: string;
  kind: string;
  distanceM: number | null;
  durationSec: number | null;
  purpose: string | null;
  odometerStart: number | null;
  odometerEnd: number | null;
  arrivedAt: Date | null;
  voided: boolean;
  reason: string | null;
  createdBy: string;
  createdAt: Date;
};

export type EffectiveTrip = TripRow & {
  odometerEnd: number | null;
  arrivedAt: Date | null;
  voided: boolean;
  corrected: boolean;
  /** ursprünglich berechnete Strecke (bei Korrektur) */
  originalDistanceM: number;
  corrections: CorrectionRow[];
};

/** Wendet die Nachträge in zeitlicher Reihenfolge an (spätere Angaben überschreiben frühere). */
export function applyCorrections(trip: TripRow, all: CorrectionRow[]): EffectiveTrip {
  const list = all.filter((c) => c.tripId === trip.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const e: EffectiveTrip = { ...trip, odometerEnd: null, arrivedAt: null, voided: false, corrected: false, originalDistanceM: trip.distanceM, corrections: list };
  for (const c of list) {
    if (c.distanceM !== null) {
      e.distanceM = c.distanceM;
      e.distanceSource = "manual";
      e.corrected = true;
    }
    if (c.durationSec !== null) e.durationSec = c.durationSec;
    if (c.purpose) e.purpose = c.purpose;
    if (c.odometerStart !== null) e.odometerStart = c.odometerStart;
    if (c.odometerEnd !== null) e.odometerEnd = c.odometerEnd;
    if (c.arrivedAt) e.arrivedAt = c.arrivedAt;
    if (c.voided) e.voided = true;
  }
  return e;
}

export function monthTotals(list: EffectiveTrip[]) {
  const valid = list.filter((t) => !t.voided);
  return {
    count: valid.length,
    distanceM: valid.reduce((s, t) => s + t.distanceM, 0),
    durationSec: valid.reduce((s, t) => s + (t.durationSec ?? 0), 0),
    estimated: valid.filter((t) => t.distanceSource === "estimate").length,
  };
}

const SOURCE_LABEL: Record<string, string> = { route: "berechnet", estimate: "geschätzt", manual: "manuell" };
export const distanceSourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

const dateDe = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const kmNum = (m: number) => (Math.round(m / 100) / 10).toFixed(1).replace(".", ",");

/** Zeilen für CSV/PDF – Spalten wie vom Steuerbüro erwartet. Stornierte Fahrten sind gekennzeichnet, zählen nicht. */
export function tripLogRows(list: EffectiveTrip[]): string[][] {
  const head = ["Datum", "Start", "Ziel (pseudonymisiert)", "Zweck", "km", "Quelle", "Kennzeichen", "km-Stand Beginn", "km-Stand Ende", "Status"];
  const rows = list.map((t) => [
    dateDe(t.tripDate),
    t.fromLabel,
    t.toLabel,
    t.purpose,
    kmNum(t.distanceM),
    distanceSourceLabel(t.distanceSource),
    t.plate ?? "",
    t.odometerStart?.toString() ?? "",
    t.odometerEnd?.toString() ?? "",
    t.voided ? "storniert" : t.corrected ? "korrigiert" : "",
  ]);
  return [head, ...rows];
}

// ───────────── Wegegeld ─────────────
/** km für das Wegegeld (eine Nachkommastelle), ggf. Hin- und Rückweg */
export function travelKm(distanceM: number, billing: TripBilling): number {
  const km = Math.round(distanceM / 100) / 10;
  return billing === "roundtrip" ? Math.round(km * 20) / 10 : km;
}

export function travelLineDescription(dateIso: string, distanceM: number, billing: TripBilling): string {
  return `Wegegeld Hausbesuch am ${dateDe(dateIso)} (${kmDe(distanceM)}${billing === "roundtrip" ? ", Hin- und Rückweg" : ""})`;
}

/** Privat/Selbstzahler (keine GKV-Abrechnung über Verordnung) */
export const isPrivatePayer = (insuranceType: string) => insuranceType === "self" || insuranceType === "pkv" || insuranceType === "beihilfe";

// ───────────── Links (nur auf Klick, keine eingebetteten Karten) ─────────────
export function navigationLinks(address: string) {
  const q = encodeURIComponent(address);
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`,
    apple: `https://maps.apple.com/?daddr=${q}&dirflg=d`,
  };
}

/** Statischer Link zur Strecke auf openstreetmap.org (öffnet erst auf Klick) */
export function osmLegLink(a: { lat: number; lon: number }, b: { lat: number; lon: number }): string {
  const f = (p: { lat: number; lon: number }) => `${p.lat.toFixed(4)}%2C${p.lon.toFixed(4)}`;
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${f(a)}%3B${f(b)}`;
}

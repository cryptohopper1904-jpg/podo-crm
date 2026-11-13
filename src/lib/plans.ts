/**
 * Tarife, Funktionsumfang und Zugriffsmodus (SaaS, Phase 3, PLAN.md 4.11).
 *
 * PREISE VORLÄUFIG – Platzhalter, noch nicht kalkuliert/freigegeben. Alle Preise netto pro Monat.
 *
 * Nur-Lesen-Modus: Ist die Testphase abgelaufen oder das Abo gekündigt/überfällig (nach 14 Tagen Kulanz),
 * lehnt die App alle schreibenden Aktionen ab. LESEN UND EXPORTIEREN BLEIBEN IMMER MÖGLICH –
 * Patient:innen haben Anspruch auf Einsicht/Kopie (§ 630g BGB, Art. 15/20 DSGVO), die Praxis
 * auf ihre Aufbewahrungspflichten. Durchgesetzt in requireAuth()/getAuth() (src/lib/auth/session.ts).
 */

export const PRICES_PRELIMINARY = true;
export const PRICES_NOTE = "Preise vorläufig – Platzhalter, Änderungen vorbehalten. Alle Preise netto zzgl. USt.";

export const TRIAL_DAYS = 30;
export const GRACE_DAYS = 14;
export const EXTRA_SEAT_CENTS = 1500;

export const FEATURES = ["portal", "voice_agent", "website"] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, string> = {
  portal: "Patientenportal",
  voice_agent: "KI-Telefonagent",
  website: "Praxis-Website",
};

export const PLAN_IDS = ["trial", "free", "starter", "praxis", "plus", "internal"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
/** Buchbare Tarife (Stripe) */
export const PAID_PLANS = ["starter", "praxis", "plus"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

export type PlanInfo = {
  label: string;
  /** Netto-Grundpreis pro Monat in Cent (vorläufig) */
  priceCents: number;
  /** im Grundpreis enthaltene Behandler-/Team-Plätze */
  includedSeats: number;
  /** Obergrenze (null = unbegrenzt) */
  maxSeats: number | null;
  features: readonly Feature[];
  /** Im Tarif enthaltene KI-Telefon-Minuten je Kalendermonat (0 = nur als Zusatzmodul) */
  voiceMinutesIncluded: number;
  /** Höchstzahl Patient:innen (auch archivierte; nur gelöschte zählen nicht), null = unbegrenzt */
  maxPatients: number | null;
  description: string;
};

/** Kostenloser Tarif: ohne Zeitlimit gratis, begrenzt auf so viele Patient:innen (archivierte zählen mit, gelöschte nicht) */
export const FREE_MAX_PATIENTS = 20;

export const PLANS: Record<PlanId, PlanInfo> = {
  trial: {
    label: "Testphase",
    priceCents: 0,
    includedSeats: 2,
    // Standard 2 Plätze; der Betreiber kann in der Plattform-Konsole für Testpraxen bis 10 freigeben
    maxSeats: 10,
    features: FEATURES,
    voiceMinutesIncluded: 30,
    maxPatients: null,
    description: `${TRIAL_DAYS} Tage alle Funktionen, 2 Personen (auf Anfrage mehr)`,
  },
  free: {
    label: "Kostenlos",
    priceCents: 0,
    includedSeats: 1,
    maxSeats: 1,
    features: [],
    voiceMinutesIncluded: 0,
    maxPatients: FREE_MAX_PATIENTS,
    description: `Kostenlos ohne Zeitlimit: bis zu ${FREE_MAX_PATIENTS} Patient:innen, 1 Person; ohne Patientenportal, KI-Telefon und Website`,
  },
  starter: {
    label: "Starter",
    priceCents: 5900,
    includedSeats: 1,
    maxSeats: 1,
    features: [],
    voiceMinutesIncluded: 0,
    maxPatients: null,
    description: "Für Einzelpraxen: 1 Person, ohne Patientenportal und KI-Telefon; Praxis-Website als Zusatzmodul",
  },
  praxis: {
    label: "Praxis",
    priceCents: 9900,
    includedSeats: 2,
    maxSeats: 5,
    features: ["portal", "website"],
    voiceMinutesIncluded: 0,
    maxPatients: null,
    description: "Bis zu 5 Personen, alle Funktionen; KI-Telefon als Zusatzmodul",
  },
  plus: {
    label: "Plus",
    priceCents: 14900,
    includedSeats: 3,
    maxSeats: null,
    features: ["portal", "voice_agent", "website"],
    voiceMinutesIncluded: 300,
    maxPatients: null,
    description: "Unbegrenzt viele Personen, inkl. KI-Telefonagent (300 Minuten/Monat)",
  },
  internal: {
    label: "Intern",
    priceCents: 0,
    includedSeats: 0,
    maxSeats: null,
    features: FEATURES,
    voiceMinutesIncluded: 300,
    maxPatients: null,
    description: "Betreiber-/Pilotpraxis ohne Abrechnung",
  },
};

export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);
export const isPaidPlan = (v: unknown): v is PaidPlan => typeof v === "string" && (PAID_PLANS as readonly string[]).includes(v);

/** Die für Tarif/Zugriff relevanten Felder einer Organisation */
export type OrgBilling = {
  plan: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  seats: number;
};

export type AccessInfo =
  | { mode: "full"; trialDaysLeft?: number; graceEndsAt?: Date; reason?: undefined }
  | { mode: "readonly"; reason: "trial_expired" | "payment_overdue" | "canceled"; trialDaysLeft?: undefined; graceEndsAt?: undefined };

export const READONLY_REASON_LABELS: Record<"trial_expired" | "payment_overdue" | "canceled", string> = {
  trial_expired: "Die Testphase ist abgelaufen.",
  payment_overdue: "Die Zahlung für das Abo ist seit mehr als 14 Tagen überfällig.",
  canceled: "Das Abo ist beendet.",
};

const DAY = 86_400_000;

/** Monatlicher Netto-Preis (vorläufig) für Tarif + Plätze */
export function monthlyPriceCents(plan: PaidPlan, seats: number): number {
  const p = PLANS[plan];
  return p.priceCents + Math.max(0, seats - p.includedSeats) * EXTRA_SEAT_CENTS;
}

/** Ermittelt, ob die Praxis schreiben darf (voll) oder nur lesen/exportieren. */
export function accessMode(org: OrgBilling, now: Date = new Date()): AccessInfo {
  // Kostenlos und Intern laufen nie ab (Grenze beim Kostenlos-Tarif: Anzahl Patient:innen, siehe patientLimitProblem)
  if (org.plan === "internal" || org.plan === "free") return { mode: "full" };
  const status = org.subscriptionStatus;
  if (status === "active") return { mode: "full" };
  if (status === "trialing" || (org.plan === "trial" && status === "none")) {
    if (!org.trialEndsAt) return { mode: "full" };
    const left = org.trialEndsAt.getTime() - now.getTime();
    if (left > 0) return { mode: "full", trialDaysLeft: Math.ceil(left / DAY) };
    return { mode: "readonly", reason: "trial_expired" };
  }
  // past_due, canceled, paused, none …: 14 Tage Kulanz ab Ende des bezahlten Zeitraums
  const base = org.currentPeriodEnd ?? org.trialEndsAt;
  if (base) {
    const graceEndsAt = new Date(base.getTime() + GRACE_DAYS * DAY);
    if (now < graceEndsAt) return { mode: "full", graceEndsAt };
  }
  return { mode: "readonly", reason: status === "past_due" ? "payment_overdue" : "canceled" };
}

export type Entitlements = {
  plan: PlanId;
  planLabel: string;
  features: ReadonlySet<Feature>;
  /** Anzahl erlaubter Team-Plätze (Steuerberatung zählt nicht), Infinity = unbegrenzt */
  seatLimit: number;
  access: AccessInfo;
  readOnly: boolean;
};

export function seatLimit(org: Pick<OrgBilling, "plan" | "seats">): number {
  const plan = isPlanId(org.plan) ? org.plan : "starter";
  const p = PLANS[plan];
  // Testphase: Standard 2 Plätze, vom Betreiber in der Plattform-Konsole bis maxSeats erweiterbar
  if (plan === "trial") return Math.min(Math.max(org.seats, p.includedSeats), p.maxSeats ?? p.includedSeats);
  if (plan === "internal") return Infinity;
  const paid = Math.max(org.seats, p.includedSeats);
  return p.maxSeats === null ? paid : Math.min(paid, p.maxSeats);
}

export function entitlements(org: OrgBilling, now: Date = new Date()): Entitlements {
  const plan: PlanId = isPlanId(org.plan) ? org.plan : "starter";
  const access = accessMode(org, now);
  return {
    plan,
    planLabel: PLANS[plan].label,
    features: new Set(PLANS[plan].features),
    seatLimit: seatLimit(org),
    access,
    readOnly: access.mode === "readonly",
  };
}

export class EntitlementError extends Error {
  constructor(
    public readonly feature: Feature | "write" | "seats",
    message: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

/** Wirft, wenn der Tarif die Funktion nicht enthält oder die Praxis im Nur-Lesen-Modus ist. */
export function assertEntitled(org: OrgBilling, feature: Feature, now: Date = new Date()): void {
  const e = entitlements(org, now);
  if (e.readOnly) throw new EntitlementError("write", `${READONLY_REASON_LABELS[e.access.reason!]} Die Praxis ist im Nur-Lesen-Modus.`);
  if (!e.features.has(feature)) {
    throw new EntitlementError(
      feature,
      `${FEATURE_LABELS[feature]} ist im Tarif „${e.planLabel}“ nicht enthalten. Bitte unter Einstellungen → Abo & Tarif upgraden.`,
    );
  }
}

/** Rollen, die einen Platz belegen (die Steuerberatung ist kostenlos) */
export const seatCounts = (role: string) => role !== "accountant";

/**
 * Prüft, ob eine weitere Person mit `role` hinzukommen darf. `usedSeats` = aktive Mitgliedschaften
 * ohne Steuerberatung. Gibt eine Fehlermeldung zurück oder null.
 */
export function seatProblem(org: Pick<OrgBilling, "plan" | "seats">, usedSeats: number, role: string): string | null {
  if (!seatCounts(role)) return null;
  const limit = seatLimit(org);
  if (usedSeats + 1 <= limit) return null;
  const plan = isPlanId(org.plan) ? PLANS[org.plan].label : org.plan;
  return `Alle ${limit} Plätze im Tarif „${plan}“ sind belegt. Unter Einstellungen → Abo & Tarif kannst du weitere Plätze buchen oder den Tarif wechseln. (Die Steuerberatung belegt keinen Platz.)`;
}

// ───────────── Patienten-Grenze (Kostenlos-Tarif) ─────────────

/** Höchstzahl Patient:innen im Tarif (Infinity = unbegrenzt) */
export function patientLimit(org: Pick<OrgBilling, "plan">): number {
  const plan = isPlanId(org.plan) ? org.plan : "starter";
  return PLANS[plan].maxPatients ?? Infinity;
}

/** Fehlermeldung, wenn `adding` weitere Patient:innen die Tarif-Grenze überschreiten würden, sonst null. */
export function patientLimitProblem(org: Pick<OrgBilling, "plan">, activePatients: number, adding = 1): string | null {
  const limit = patientLimit(org);
  if (activePatients + adding <= limit) return null;
  const left = Math.max(0, limit - activePatients);
  return (
    `Im Tarif „${PLANS[isPlanId(org.plan) ? org.plan : "starter"].label}“ sind höchstens ${limit} Patient:innen möglich (archivierte zählen mit) ` +
    `(aktuell ${activePatients}${adding > 1 ? `, ${adding} sollen dazukommen, frei: ${left}` : ""}). ` +
    "Für mehr Patient:innen bitte unter Einstellungen → Abo & Tarif einen Tarif wählen."
  );
}

/**
 * Wechsel in den Kostenlos-Tarif möglich? Nur ohne laufendes Stripe-Abo (erst kündigen; auch pausiert/überfällig
 * zählt als laufend) und mit höchstens 20 Patient:innen. Weitere Teammitglieder deaktiviert der Wechsel selbst.
 */
export function freeSwitchProblem(org: OrgBilling & { stripeSubscriptionId?: string | null }, patientCount: number): string | null {
  if (org.plan === "free") return "Die Praxis nutzt bereits den kostenlosen Tarif.";
  if (org.plan === "internal") return "Interne Praxen brauchen keinen Tarifwechsel.";
  const subscriptionEnded = org.subscriptionStatus === "canceled" || org.subscriptionStatus === "none";
  if (!subscriptionEnded && (org.stripeSubscriptionId || org.plan !== "trial")) {
    return "Bitte zuerst das bezahlte Abo unter „Rechnungen & Zahlungsart“ kündigen. Danach kann die Praxis kostenlos weitergeführt werden.";
  }
  if (patientCount > FREE_MAX_PATIENTS) {
    return `Der kostenlose Tarif erlaubt höchstens ${FREE_MAX_PATIENTS} Patient:innen (archivierte zählen mit) – in der Praxis sind ${patientCount}. Bitte einen bezahlten Tarif wählen; alle Daten bleiben lesbar und exportierbar.`;
  }
  return null;
}

// ───────────── KI-Telefon: Zusatzmodul und Minuten ─────────────

/** Tarife, in denen das KI-Telefon als Zusatzmodul gebucht werden kann (organizations.settings.voiceAddon). */
export const VOICE_ADDON_PLANS: readonly PlanId[] = ["praxis"];
/** Minuten je Kalendermonat mit Zusatzmodul */
export const VOICE_ADDON_MINUTES = 300;

export type VoiceEntitlement = {
  /** Telefonagent darf Anrufe bearbeiten (Tarif oder Zusatzmodul, nicht im Nur-Lesen-Modus) */
  enabled: boolean;
  /** Freiminuten je Kalendermonat */
  includedMinutes: number;
  source: "plan" | "addon" | null;
  /** Grund, falls nicht freigeschaltet (für die Oberfläche) */
  reason: string | null;
  /** Zusatzmodul ist im Tarif buchbar, aber nicht aktiv */
  addonAvailable: boolean;
};

/** Zusatzmodul-Schalter (setzt der Plattform-Betreiber bzw. später Stripe). */
export const voiceAddonActive = (settings: Record<string, unknown> | null | undefined) => settings?.voiceAddon === true;

export function voiceEntitlement(org: OrgBilling, settings: Record<string, unknown> | null | undefined, now: Date = new Date()): VoiceEntitlement {
  const e = entitlements(org, now);
  const addonAvailable = VOICE_ADDON_PLANS.includes(e.plan);
  const addon = addonAvailable && voiceAddonActive(settings);
  if (e.readOnly) return { enabled: false, includedMinutes: 0, source: null, reason: `${READONLY_REASON_LABELS[e.access.reason!]} Das KI-Telefon nimmt keine Termine an.`, addonAvailable };
  if (e.features.has("voice_agent")) return { enabled: true, includedMinutes: PLANS[e.plan].voiceMinutesIncluded, source: "plan", reason: null, addonAvailable: false };
  if (addon) return { enabled: true, includedMinutes: VOICE_ADDON_MINUTES, source: "addon", reason: null, addonAvailable };
  return {
    enabled: false,
    includedMinutes: 0,
    source: null,
    reason: addonAvailable
      ? `Das KI-Telefon ist im Tarif „${e.planLabel}“ als Zusatzmodul buchbar (${VOICE_ADDON_MINUTES} Minuten/Monat).`
      : `Das KI-Telefon ist im Tarif „${e.planLabel}“ nicht enthalten. Bitte unter Einstellungen → Abo & Tarif upgraden.`,
    addonAvailable,
  };
}

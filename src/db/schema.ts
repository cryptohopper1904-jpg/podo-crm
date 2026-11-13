/**
 * PodoHero – Datenbankschema (Drizzle ORM, PostgreSQL 16)
 *
 * Grundregeln:
 * - Jede fachliche Tabelle trägt `organization_id` (Mandant = Praxis). Zusätzlich zur
 *   App-seitigen Filterung schützt Row-Level-Security (siehe drizzle/0001_security.sql).
 * - Geldbeträge in Cent (integer), nie als Float.
 * - Medizinische Dokumentation (treatment_records, record_addenda) ist append-only
 *   (§ 630f BGB): DB-Trigger verhindern UPDATE/DELETE; Korrekturen nur als Nachtrag.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  doublePrecision,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const orgId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

// ───────────────────────── Enums ─────────────────────────
export const roleEnum = pgEnum("role", ["owner", "therapist", "reception", "trainee", "accountant"]);
export const channelEnum = pgEnum("channel", ["email", "whatsapp", "sms", "phone", "letter", "none", "kim"]);
export const insuranceTypeEnum = pgEnum("insurance_type", ["gkv", "pkv", "self", "beihilfe"]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "planned",
  "confirmed",
  "done",
  "cancelled",
  "no_show",
]);
export const appointmentSourceEnum = pgEnum("appointment_source", [
  "manual",
  "doctolib",
  "online",
  "phone",
  "whatsapp",
  "email",
  "voice_agent",
  /** Patientenportal (Buchung/Verschieben per persönlichem Link, Nachrücker von der Warteliste) */
  "portal",
  /** Kalender-Abo (iCal-Import) aus einem externen Kalender, der nicht Doctolib ist */
  "extern",
]);
/**
 * deposit = Quittung über eine Anzahlung (z. B. bar beim Termin), die später auf die Sammelrechnung der Person
 * angerechnet wird (invoices.collective_invoice_id). Kein eigener Umsatz neben der Sammelrechnung.
 */
export const invoiceKindEnum = pgEnum("invoice_kind", ["invoice", "receipt", "collective", "credit_note", "no_show_fee", "deposit"]);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "cancelled",
]);
export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "card",
  "transfer",
  "voucher",
  "payment_link",
]);
export const mediaKindEnum = pgEnum("media_kind", ["photo", "audio", "document"]);
export const mediaPurposeEnum = pgEnum("media_purpose", [
  "brace_before",
  "brace_progress",
  "brace_complication",
  "brace_after",
  "finding",
  "wound",
  "document",
  "prescription",
  "voice_report",
  "marketing",
]);
export const footSideEnum = pgEnum("foot_side", ["left", "right"]);
export const consentTypeEnum = pgEnum("consent_type", [
  "privacy_notice",
  "photo_documentation",
  "photo_marketing",
  "whatsapp",
  "email_reminders",
  "sms_reminders",
  "marketing",
  "review_request",
  "ai_processing",
  "call_recording",
  "no_show_terms",
]);
export const billingContactKindEnum = pgEnum("billing_contact_kind", [
  "guardian",
  "relative",
  "care_home",
  "other",
]);
export const integrationProviderEnum = pgEnum("integration_provider", [
  "lexoffice",
  "sumup",
  "doctolib",
  "google_business",
  "email_imap",
  "whatsapp",
  "sms",
  "voice_agent",
  "transcription",
  "llm",
  "calendar_ics",
  "stripe",
  "gkv_billing",
  "kim",
]);
export const integrationStatusEnum = pgEnum("integration_status", [
  "disconnected",
  "mock",
  "connected",
  "error",
]);
export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound"]);
export const messageStatusEnum = pgEnum("message_status", ["new", "suggested", "answered", "archived"]);

// ───────────────────────── Mandanten & Benutzer ─────────────────────────
export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  legalName: text("legal_name"),
  street: text("street"),
  zip: text("zip"),
  city: text("city"),
  phone: text("phone"),
  email: text("email"),
  taxNumber: text("tax_number"),
  vatId: text("vat_id"),
  iban: text("iban"),
  /** BIC (optional, für den GiroCode auf Rechnungen) */
  bic: text("bic"),
  bankName: text("bank_name"),
  /** Kontoinhaber:in (Empfängername im GiroCode); leer = rechtlicher Name bzw. Praxisname */
  accountHolder: text("account_holder"),
  /** § 19 UStG – Kleinunternehmerregelung */
  smallBusiness: boolean("small_business").notNull().default(false),
  /** Bundesland für Feiertage, z. B. "BB" */
  state: text("state").notNull().default("BB"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  // ── SaaS-Abo (Phase 3) ──
  /** trial | starter | praxis | plus | internal */
  plan: text("plan").notNull().default("trial"),
  /** trialing | active | past_due | canceled | paused | none */
  subscriptionStatus: text("subscription_status").notNull().default("trialing"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  seats: integer("seats").notNull().default(1),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  /** Onboarding-Fortschritt, z. B. { practice: true, services: true, team: false, import: false, integrations: false } */
  onboarding: jsonb("onboarding").$type<Record<string, boolean>>().notNull().default({}),
  /** Löschung beantragt (Kündigung): nach Frist + Aufbewahrungsprüfung endgültig */
  deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Praxis-Logos (Einstellungen → Praxisdaten): „compact“ = Zeichen (dezent auf Bögen/Quittungen),
 * „full“ = vollständiges Logo (Rechnungskopf, E-Mails). Datei verschlüsselt in der Ablage (src/lib/storage.ts),
 * nur PNG/JPEG (pdf-lib), je Praxis und Art höchstens eine Zeile.
 */
export const organizationLogos = pgTable(
  "organization_logos",
  {
    id: id(),
    organizationId: orgId(),
    /** compact | full */
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("organization_logos_org_kind").on(t.organizationId, t.kind)],
);

/**
 * Support-Freigaben (Break-Glass): Plattform-Betreiber sehen Praxisdaten NUR mit zeitlich begrenzter,
 * von der Praxis erteilter Freigabe. Jede Nutzung wird im Audit-Log der Praxis protokolliert.
 */
export const supportGrants = pgTable("support_grants", {
  id: id(),
  organizationId: orgId(),
  grantedBy: uuid("granted_by")
    .notNull()
    .references(() => users.id),
  /** Plattform-Admin, der zugreifen darf (null = jeder Plattform-Admin) */
  granteeUserId: uuid("grantee_user_id").references(() => users.id),
  reason: text("reason").notNull(),
  /** read | write */
  scope: text("scope").notNull().default("read"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Abo-Ereignisse von Stripe (Idempotenz + Nachvollziehbarkeit), plattformweit */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: id(),
    provider: text("provider").notNull().default("stripe"),
    externalId: text("external_id").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [uniqueIndex("billing_events_idem").on(t.provider, t.externalId)],
);

export const locations = pgTable("locations", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  street: text("street"),
  zip: text("zip"),
  city: text("city"),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  /** zuletzt akzeptierter TOTP-Zeitschritt – verhindert Wiederverwendung (Replay) */
  totpLastStep: integer("totp_last_step"),
  /** Betreiber der SaaS – hat KEINEN Datenzugriff ohne Freigabe (Break-Glass) */
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  /** Entsperr-PIN für den Übergabe-Modus (Hash wie Passwörter), null = Entsperren nur mit Passwort */
  unlockPinHash: text("unlock_pin_hash"),
  /** persönliche Einstellungen, z. B. zuletzt gesehene Neuigkeit (src/lib/changelog.ts) */
  prefs: jsonb("prefs").$type<UserPrefs>().notNull().default({}),
  createdAt: createdAt(),
});

export type UserPrefs = {
  /** Neuigkeiten: zuletzt angezeigter Eintrag (seenId) bzw. „bis zur nächsten Neuerung nicht mehr anzeigen“ (mutedId) */
  changelog?: { seenId?: string; mutedId?: string };
  /** Kalender: gewählte Ansicht („simple“ = einfache Liste, Standard; „full“ = Tag/Woche/Monat mit Zeitachse) */
  calendar?: {
    mode?: "simple" | "full";
    /** Anzeige-Optionen (nur Abweichungen vom Standard; Prüfung/Auflösung in src/lib/calendar-options.ts) */
    options?: {
      holidays?: boolean;
      schoolHolidays?: boolean;
      absences?: boolean;
      blocks?: boolean;
      cancelledSimple?: boolean;
      cancelledFull?: boolean;
      weekend?: "auto" | "alle" | "keine";
      workHours?: boolean;
      weekNumbers?: boolean;
      startHour?: number;
      endHour?: number;
    };
  };
  /** Ansicht für Navigation und Startseite (fehlt = „komplex“, src/lib/view-level.ts) */
  view?: "einfach" | "kompakt" | "komplex";
  /** Darstellung der Kataloge (Einstellungen → Leistungen, Produkte): Kacheln, Liste oder Kompakt (src/lib/catalog.ts) */
  catalog?: { services?: "kacheln" | "liste" | "kompakt"; products?: "kacheln" | "liste" | "kompakt" };
};

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    organizationId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    active: boolean("active").notNull().default(true),
    color: text("color"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_org_user").on(t.organizationId, t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 des Session-Tokens – das Token selbst steht nur im Cookie */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    /** false bis 2FA bestätigt ist */
    verified: boolean("verified").notNull().default(true),
    totpFailures: integer("totp_failures").notNull().default(0),
    /** Neuigkeiten-Popup in dieser Sitzung bereits gezeigt (einmal je Anmeldung) */
    changelogShownAt: timestamp("changelog_shown_at", { withTimezone: true }),
    /** Übergabe-Modus: Gerät an Patient:in übergeben – Sitzung gesperrt bis PIN/Passwort (src/lib/auth/handover.ts) */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** Rücksprung nach dem Entsperren (nur interne Pfade) */
    lockReturn: text("lock_return"),
    unlockFailures: integer("unlock_failures").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/**
 * „Passwort vergessen“: nur der sha256 des Tokens steht hier (Token selbst nur im Link der E-Mail),
 * 30 Minuten gültig, einmalig. Keine RLS (plattformweit wie sessions), nur die App-Rolle hat Rechte.
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdIp: text("created_ip"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("password_resets_token").on(t.tokenHash), index("password_resets_user").on(t.userId)],
);

// ───────────────────────── Patienten ─────────────────────────
export type RiskFlags = {
  diabetes?: boolean;
  diabetesType?: string;
  anticoagulation?: boolean;
  pavk?: boolean;
  neuropathy?: boolean;
  allergies?: string;
  mrsa?: boolean;
  other?: string;
};

export const billingContacts = pgTable("billing_contacts", {
  id: id(),
  organizationId: orgId(),
  kind: billingContactKindEnum("kind").notNull(),
  name: text("name").notNull(),
  street: text("street"),
  zip: text("zip"),
  city: text("city"),
  email: text("email"),
  phone: text("phone"),
  createdAt: createdAt(),
});

export const patients = pgTable(
  "patients",
  {
    id: id(),
    organizationId: orgId(),
    number: integer("number").notNull(),
    salutation: text("salutation"),
    title: text("title"),
    lastName: text("last_name").notNull(),
    firstName: text("first_name"),
    birthDate: date("birth_date"),
    street: text("street"),
    zip: text("zip"),
    city: text("city"),
    phoneMobile: text("phone_mobile"),
    phoneLandline: text("phone_landline"),
    email: text("email"),
    preferredChannel: channelEnum("preferred_channel").notNull().default("none"),
    insuranceType: insuranceTypeEnum("insurance_type").notNull().default("self"),
    insurerName: text("insurer_name"),
    insuranceNumber: text("insurance_number"),
    gpName: text("gp_name"),
    notes: text("notes"),
    riskFlags: jsonb("risk_flags").$type<RiskFlags>().notNull().default({}),
    /** Wunsch-Intervall in Wochen (für „überfällig“-Status und Rückholung) */
    visitIntervalWeeks: integer("visit_interval_weeks"),
    homeVisit: boolean("home_visit").notNull().default(false),
    careHomeId: uuid("care_home_id").references(() => billingContacts.id),
    billingContactId: uuid("billing_contact_id").references(() => billingContacts.id),
    householdKey: text("household_key"),
    /** Tour/Route für Hausbesuche */
    route: text("route"),
    /** Zusatzangaben aus Importen (Doctolib: maiden_name, occupation, referrer, gp_city, crucial_info, no_reminders) */
    extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default({}),
    /** z. B. { doctolib: "123", legacyExcel: 17 } */
    externalIds: jsonb("external_ids").$type<Record<string, string | number | undefined>>().notNull().default({}),
    source: text("source"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Kontaktdaten/Marketing gelöscht (Art. 17 DSGVO), Akte bleibt bis Fristende (§ 630f BGB, § 147 AO) – Gesamt-Review H3 */
    contactErasedAt: timestamp("contact_erased_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("patients_org_number").on(t.organizationId, t.number),
    index("patients_org_name").on(t.organizationId, t.lastName, t.firstName),
  ],
);

export const consents = pgTable("consents", {
  id: id(),
  organizationId: orgId(),
  patientId: uuid("patient_id")
    .notNull()
    .references(() => patients.id, { onDelete: "cascade" }),
  type: consentTypeEnum("type").notNull(),
  granted: boolean("granted").notNull(),
  version: text("version").notNull().default("1"),
  via: text("via"),
  recordedBy: uuid("recorded_by").references(() => users.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const anamneses = pgTable("anamneses", {
  id: id(),
  organizationId: orgId(),
  patientId: uuid("patient_id")
    .notNull()
    .references(() => patients.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  authorId: uuid("author_id").references(() => users.id),
  createdAt: createdAt(),
});

// ───────────────────────── Leistungen & Termine ─────────────────────────
export const services = pgTable(
  "services",
  {
    id: id(),
    organizationId: orgId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    priceCents: integer("price_cents").notNull(),
    /** 0 = steuerfreie Heilbehandlung § 4 Nr. 14 UStG (nur mit therapeutischem Ziel!), 19 = kosmetisch/Verkauf */
    vatRate: integer("vat_rate").notNull().default(0),
    durationMin: integer("duration_min").notNull().default(30),
    category: text("category").notNull().default("treatment"),
    gkvPosition: text("gkv_position"),
    requiresTherapeuticPurpose: boolean("requires_therapeutic_purpose").notNull().default(true),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("services_org_code").on(t.organizationId, t.code)],
);

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    organizationId: orgId(),
    locationId: uuid("location_id").references(() => locations.id),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "set null" }),
    therapistId: uuid("therapist_id").references(() => users.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: appointmentStatusEnum("status").notNull().default("planned"),
    source: appointmentSourceEnum("source").notNull().default("manual"),
    externalId: text("external_id"),
    title: text("title"),
    notes: text("notes"),
    homeVisit: boolean("home_visit").notNull().default(false),
    prescriptionId: uuid("prescription_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("appointments_org_time").on(t.organizationId, t.startsAt),
    /** erster Termin je Person (Auswertung: neue vs. wiederkehrende Patient:innen) */
    index("appointments_org_patient").on(t.organizationId, t.patientId, t.startsAt),
    uniqueIndex("appointments_external").on(t.organizationId, t.source, t.externalId),
  ],
);

export const appointmentServices = pgTable("appointment_services", {
  id: id(),
  organizationId: orgId(),
  appointmentId: uuid("appointment_id")
    .notNull()
    .references(() => appointments.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => services.id),
  quantity: numeric("quantity", { precision: 6, scale: 2 }).notNull().default("1"),
}, (t) => [index("appointment_services_appointment").on(t.organizationId, t.appointmentId)]);

export const waitlist = pgTable("waitlist", {
  id: id(),
  organizationId: orgId(),
  patientId: uuid("patient_id")
    .notNull()
    .references(() => patients.id, { onDelete: "cascade" }),
  /** Altbestand: Freitext-Wunsch (wird heuristisch gelesen). Neue Einträge nutzen die strukturierten Spalten. */
  wishes: text("wishes"),
  /** gewünschte Leistungen (leer = egal) */
  serviceIds: uuid("service_ids").array().notNull().default(sql`'{}'::uuid[]`),
  /** ISO-Wochentage 1 = Mo … 7 = So (leer = egal) */
  weekdays: smallint("weekdays").array().notNull().default(sql`'{}'::smallint[]`),
  /** morning | afternoon | evening (leer = egal) */
  dayparts: text("dayparts").array().notNull().default(sql`'{}'::text[]`),
  note: text("note"),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// ───────────────────────── Verordnungen (GKV, B-light) ─────────────────────────
export const prescriptions = pgTable("prescriptions", {
  id: id(),
  organizationId: orgId(),
  patientId: uuid("patient_id")
    .notNull()
    .references(() => patients.id, { onDelete: "cascade" }),
  issuedAt: date("issued_at").notNull(),
  doctorName: text("doctor_name"),
  doctorLanr: text("doctor_lanr"),
  /** Diagnosegruppe nach HeilM-RL, z. B. DF, NF, QF, UI1, UI2 */
  diagnosisGroup: text("diagnosis_group").notNull(),
  icd10: text("icd10"),
  remedy: text("remedy"),
  units: integer("units").notNull(),
  frequencyPerWeek: text("frequency_per_week"),
  homeVisit: boolean("home_visit").notNull().default(false),
  urgent: boolean("urgent").notNull().default(false),
  copaymentExempt: boolean("copayment_exempt").notNull().default(false),
  /** spätester Behandlungsbeginn (Regelwerk, versioniert in src/lib/rules) */
  startBy: date("start_by"),
  /** open | active | completed | billing_ready | billed | expired | cancelled */
  status: text("status").notNull().default("open"),
  doctorBsnr: text("doctor_bsnr"),
  /** Behandlungseinheiten je Position, z. B. [{ position: "78100", label: "Hornhautabtragung", units: 6 }] */
  positions: jsonb("positions").$type<{ position?: string; label: string; units: number }[]>().notNull().default([]),
  therapyReportRequested: boolean("therapy_report_requested").notNull().default(false),
  /** Zuzahlung erhalten (10 € + 10 %) */
  copaymentCents: integer("copayment_cents"),
  copaymentPaidAt: timestamp("copayment_paid_at", { withTimezone: true }),
  interruptionNote: text("interruption_note"),
  scanMediaId: uuid("scan_media_id"),
  /** Herkunft: paper (Muster 13), ocr (Foto + KI-Auslesung, bestätigt), everordnung (TI/FHIR) */
  source: text("source").notNull().default("paper"),
  /** eVerordnung: Task-/Verordnungs-ID bzw. Token aus der TI (eindeutig je Praxis) */
  externalRef: text("external_ref"),
  /** Rohdaten der Auslesung (OCR-Vorschlag bzw. FHIR-Bundle-Zusammenfassung) – nur zur Nachvollziehbarkeit */
  importData: jsonb("import_data"),
  rulesVersion: text("rules_version"),
  billedAt: timestamp("billed_at", { withTimezone: true }),
  billingBatchId: uuid("billing_batch_id"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
});

/** Abrechnungslauf für GKV-Verordnungen (Übergabe an ein Abrechnungszentrum, § 302 SGB V) */
export const billingBatches = pgTable("billing_batches", {
  id: id(),
  organizationId: orgId(),
  createdAt: createdAt(),
  createdBy: uuid("created_by").references(() => users.id),
  /** z. B. opta-data, azh, rzh, manual */
  partner: text("partner").notNull().default("manual"),
  status: text("status").notNull().default("draft"),
  prescriptionCount: integer("prescription_count").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  exportedAt: timestamp("exported_at", { withTimezone: true }),
  note: text("note"),
});

/** Einmal-Links für die Online-Anamnese / das Patientenportal (nur Hash des Tokens gespeichert) */
export const patientLinks = pgTable(
  "patient_links",
  {
    id: id(),
    organizationId: orgId(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    /** anamnesis | portal */
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Wartelisten-Angebot: der freie (abgesagte) Termin, der angeboten wird */
    appointmentId: uuid("appointment_id").references((): AnyPgColumn => appointments.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("patient_links_token").on(t.tokenHash),
    index("patient_links_org_appointment").on(t.organizationId, t.appointmentId),
    // höchstens EIN aktiver (nicht widerrufener, nicht benutzter) Link je Patient und Zweck
    uniqueIndex("patient_links_one_active")
      .on(t.organizationId, t.patientId, t.purpose)
      .where(sql`${t.revokedAt} is null and ${t.usedAt} is null`),
  ],
);

/** Versandprotokoll für Erinnerungen und Rückholungen (verhindert Doppelversand) */
export const reminderLog = pgTable(
  "reminder_log",
  {
    id: id(),
    organizationId: orgId(),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "cascade" }),
    /** reminder_24h | recall | brace_check | birthday */
    kind: text("kind").notNull(),
    channel: channelEnum("channel").notNull(),
    /** sent | skipped | failed */
    status: text("status").notNull(),
    detail: text("detail"),
    dedupeKey: text("dedupe_key").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reminder_log_dedupe").on(t.organizationId, t.dedupeKey)],
);

// ───────────────────────── Dokumentation (append-only) ─────────────────────────
export const sterileBatches = pgTable(
  "sterile_batches",
  {
    id: id(),
    organizationId: orgId(),
    code: text("code").notNull(),
    sterilizer: text("sterilizer"),
    cycleNo: text("cycle_no"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
    releasedBy: uuid("released_by").references(() => users.id),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    expiresAt: date("expires_at"),
    deviceId: uuid("device_id"),
    /** pending | released | rejected */
    result: text("result").notNull().default("pending"),
    indicatorOk: boolean("indicator_ok"),
    note: text("note"),
  },
  (t) => [uniqueIndex("sterile_batches_org_code").on(t.organizationId, t.code)],
);

/** Medizinprodukte/Geräte (MPBetreibV): Sterilisator, Thermodesinfektor, Fräse, Ultraschallbad … */
export const devices = pgTable("devices", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  /** sterilizer | thermo_disinfector | drill | ultrasonic | sealer | other */
  kind: text("kind").notNull().default("other"),
  manufacturer: text("manufacturer"),
  serialNumber: text("serial_number"),
  location: text("location"),
  /** Fristen: Wartung, Validierung (Aufbereitung), elektrische Prüfung (DGUV V3) */
  nextMaintenanceAt: date("next_maintenance_at"),
  nextValidationAt: date("next_validation_at"),
  nextElectricalCheckAt: date("next_electrical_check_at"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdAt: createdAt(),
});

/** Gerätebuch (append-only): Wartung, Validierung, Prüfung, Störung, Einweisung */
export const deviceEvents = pgTable("device_events", {
  id: id(),
  organizationId: orgId(),
  deviceId: uuid("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  occurredAt: date("occurred_at").notNull(),
  performedBy: text("performed_by"),
  note: text("note"),
  mediaId: uuid("media_id"),
  authorId: uuid("author_id").references(() => users.id),
  createdAt: createdAt(),
});

/** Verbrauchsmaterial mit Mindestbestand */
export const materials = pgTable("materials", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  unit: text("unit").notNull().default("Stück"),
  stock: integer("stock").notNull().default(0),
  minStock: integer("min_stock").notNull().default(0),
  supplier: text("supplier"),
  orderUrl: text("order_url"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

/** Arbeitszeiten je Behandler:in und Wochentag (1 = Montag … 7 = Sonntag) */
export const workingHours = pgTable("working_hours", {
  id: id(),
  organizationId: orgId(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  weekday: integer("weekday").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
});

/** Urlaub, Krankheit, Fortbildung */
export const absences = pgTable("absences", {
  id: id(),
  organizationId: orgId(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  /** vacation | sick | training | other */
  kind: text("kind").notNull().default("vacation"),
  note: text("note"),
  createdAt: createdAt(),
});

/**
 * Sperrzeiten im Kalender (Pause, Schulung, früher Feierabend, Wartung, Reinigung …): machen die Person
 * (user_id) bzw. die ganze Praxis (user_id NULL) in dieser Zeit „nicht verfügbar“. Zeiten in Berliner Ortszeit
 * (HH:MM, Ende bis 24:00); Wiederholung und Ausnahmen werden in src/lib/calendar-blocks.ts expandiert.
 */
export const calendarBlocks = pgTable(
  "calendar_blocks",
  {
    id: id(),
    organizationId: orgId(),
    /** NULL = ganze Praxis (alle Behandler:innen) */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** pause | schulung | feierabend | wartung | reinigung | sonstiges */
    kind: text("kind").notNull().default("pause"),
    title: text("title"),
    /** erstes Vorkommen (bzw. Datum bei „einmalig“) */
    startsOn: date("starts_on").notNull(),
    /** letztes mögliches Vorkommen (inklusive); NULL = ohne Ende */
    endsOn: date("ends_on"),
    allDay: boolean("all_day").notNull().default(false),
    startTime: text("start_time"),
    endTime: text("end_time"),
    /** none | daily (Mo–Fr) | weekly (an `weekdays`, alle `interval_weeks` Wochen) */
    repeat: text("repeat").notNull().default("none"),
    weekdays: smallint("weekdays").array().notNull().default(sql`'{}'::smallint[]`),
    intervalWeeks: smallint("interval_weeks").notNull().default(1),
    /** einzeln gelöschte Vorkommen einer Serie */
    exceptions: date("exceptions").array().notNull().default(sql`'{}'::date[]`),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("calendar_blocks_org_start").on(t.organizationId, t.startsOn)],
);

/** Markierung am Fuß. pos3d: optionale Position am 3D-Modell (Modellkoordinaten, normiert -1..1). */
export type FootPoint = { side: "left" | "right"; point: string; label?: string; note?: string; pos3d?: [number, number, number] };

export const treatmentRecords = pgTable(
  "treatment_records",
  {
    id: id(),
    organizationId: orgId(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    prescriptionId: uuid("prescription_id").references(() => prescriptions.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    treatedAt: timestamp("treated_at", { withTimezone: true }).notNull(),
    findings: text("findings"),
    servicesText: text("services_text"),
    material: text("material"),
    sterileBatchCode: text("sterile_batch_code"),
    reaction: text("reaction"),
    recommendation: text("recommendation"),
    footPoints: jsonb("foot_points").$type<FootPoint[]>().notNull().default([]),
    structured: jsonb("structured").$type<Record<string, unknown>>().notNull().default({}),
    /** „Pflichtfoto fehlt“ – Begründung statt Blockade */
    missingPhotoReason: text("missing_photo_reason"),
    aiAssisted: boolean("ai_assisted").notNull().default(false),
    countersignRequired: boolean("countersign_required").notNull().default(false),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("treatment_records_patient").on(t.organizationId, t.patientId, t.treatedAt)],
);

export const recordAddenda = pgTable("record_addenda", {
  id: id(),
  organizationId: orgId(),
  recordId: uuid("record_id")
    .notNull()
    .references(() => treatmentRecords.id, { onDelete: "restrict" }),
  authorId: uuid("author_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull().default("addendum"),
  text: text("text").notNull(),
  prevHash: text("prev_hash"),
  hash: text("hash").notNull(),
  createdAt: createdAt(),
});

export const braceEpisodes = pgTable("brace_episodes", {
  id: id(),
  organizationId: orgId(),
  patientId: uuid("patient_id")
    .notNull()
    .references(() => patients.id, { onDelete: "cascade" }),
  side: footSideEnum("side").notNull(),
  toe: integer("toe").notNull(),
  stage: text("stage"),
  braceType: text("brace_type"),
  startedAt: date("started_at").notNull(),
  endedAt: date("ended_at"),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

export const media = pgTable(
  "media",
  {
    id: id(),
    organizationId: orgId(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    recordId: uuid("record_id").references(() => treatmentRecords.id),
    braceEpisodeId: uuid("brace_episode_id").references(() => braceEpisodes.id),
    kind: mediaKindEnum("kind").notNull(),
    purpose: mediaPurposeEnum("purpose").notNull(),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    footSide: footSideEnum("foot_side"),
    toe: integer("toe"),
    view: text("view"),
    caption: text("caption"),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("media_patient").on(t.organizationId, t.patientId)],
);

// ───────────────────────── Rechnungen, Kasse, Gutscheine ─────────────────────────
export const numberSequences = pgTable(
  "number_sequences",
  {
    id: id(),
    organizationId: orgId(),
    key: text("key").notNull(),
    year: integer("year").notNull(),
    next: integer("next").notNull().default(1),
  },
  (t) => [uniqueIndex("number_sequences_key").on(t.organizationId, t.key, t.year)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    organizationId: orgId(),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "restrict" }),
    billingContactId: uuid("billing_contact_id").references(() => billingContacts.id),
    number: text("number"),
    kind: invoiceKindEnum("kind").notNull().default("invoice"),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    issuedAt: date("issued_at"),
    dueAt: date("due_at"),
    /**
     * Leistungsdatum bzw. erster Tag des Leistungszeitraums (§ 14 Abs. 4 Nr. 6 UStG, § 31 Abs. 4 UStDV) – beim Ausstellen
     * aus verknüpften Terminen/Doku-Einträgen und dem Formular-Datum festgeschrieben (danach per Trigger unveränderbar,
     * spätere Terminverschiebungen ändern den Beleg nicht). Anzahlung: Tag der verknüpften Behandlung. NULL = Altbeleg.
     */
    serviceDate: date("service_date"),
    /** letzter Tag des Leistungszeitraums; NULL = ein einzelner Tag */
    serviceDateTo: date("service_date_to"),
    /**
     * Leistungsangabe beim Ausstellen festgeschrieben (true für alle Belege ab Einführung, auch ohne Datum wie eine
     * Anzahlung ohne Terminbezug). false = Altbeleg (Bestand vor Migration 0037) → Neudruck exakt wie früher.
     */
    serviceDateFixed: boolean("service_date_fixed").notNull().default(true),
    netCents: integer("net_cents").notNull().default(0),
    vatCents: integer("vat_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    paidCents: integer("paid_cents").notNull().default(0),
    cancelsInvoiceId: uuid("cancels_invoice_id"),
    /** Anzahlung (kind = deposit): Sammelrechnung/Rechnung, auf die sie angerechnet wurde (null = noch offen) */
    collectiveInvoiceId: uuid("collective_invoice_id"),
    /** crm | excel-import | … */
    source: text("source").notNull().default("crm"),
    externalRef: text("external_ref"),
    externalSyncedAt: timestamp("external_synced_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentTo: text("sent_to"),
    paymentLinkUrl: text("payment_link_url"),
    checkoutRef: text("checkout_ref"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoices_org_number").on(t.organizationId, t.number),
    index("invoices_org_status").on(t.organizationId, t.status),
    index("invoices_org_collective").on(t.organizationId, t.collectiveInvoiceId),
    /** Auswertung nach Rechnungsdatum */
    index("invoices_org_issued").on(t.organizationId, t.issuedAt),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: id(),
    organizationId: orgId(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 8, scale: 2 }).notNull().default("1"),
    factor: numeric("factor", { precision: 5, scale: 2 }).notNull().default("1"),
    unitPriceCents: integer("unit_price_cents").notNull(),
    vatRate: integer("vat_rate").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    /** Bezug zur Behandlung (Sammelrechnung Pflegeheim: verhindert Doppelabrechnung) */
    treatmentRecordId: uuid("treatment_record_id").references(() => treatmentRecords.id),
    /** Bezug zum Termin (Rechnung aus dem Termin ohne Doku-Eintrag): verhindert Doppelabrechnung, Jahresend-Erinnerung */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    /** Art der Position: „service“ (Leistung oder Freitext, Altbestand) | „product“ (Produktverkauf, product_id gesetzt) */
    lineKind: text("line_kind").notNull().default("service"),
    productId: uuid("product_id").references(() => products.id),
    /** Produkt in der Behandlung angewendet/verbraucht → Nebenleistung der Heilbehandlung (0 %), siehe src/lib/product-vat.ts */
    inTreatment: boolean("in_treatment").notNull().default(false),
    /** angewendetes Produkt: Position (invoice_lines.position) der zugehörigen Behandlung auf demselben Beleg */
    treatmentPosition: integer("treatment_position"),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("invoice_lines_appointment").on(t.organizationId, t.appointmentId), index("invoice_lines_invoice").on(t.invoiceId)],
);

// ───────────────────────── Produkte & Warenwirtschaft ─────────────────────────
/** Lieferanten für Produkte (nur Geschäftsdaten) */
export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    /** unsere Kundennummer beim Lieferanten */
    customerNumber: text("customer_number"),
    email: text("email"),
    website: text("website"),
    phone: text("phone"),
    note: text("note"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("suppliers_org").on(t.organizationId)],
);

/**
 * Verkaufsprodukte (Salben, Cremes, Pflegeprodukte, Hilfsmittel). Preise brutto in Cent.
 * Bestand = Summe der Lagerbewegungen (stock_movements), kein eigenes Bestandsfeld.
 * Verbrauchsmaterial der Praxis (Hygiene) bleibt in `materials`.
 */
export const products = pgTable(
  "products",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    /** Kürzel für die Schnelleingabe in Rechnungspositionen (optional) */
    code: text("code"),
    /** Artikelnummer (optional) */
    sku: text("sku"),
    ean: text("ean"),
    /** salbe | creme | pflege | hilfsmittel | sonstiges */
    category: text("category").notNull().default("sonstiges"),
    priceCents: integer("price_cents").notNull(),
    purchasePriceCents: integer("purchase_price_cents"),
    /** regulärer Steuersatz beim Verkauf (19 %, ggf. 7 %); 0 % nur als Nebenleistung in der Behandlung */
    vatRate: integer("vat_rate").notNull().default(19),
    unit: text("unit").notNull().default("Stück"),
    trackStock: boolean("track_stock").notNull().default(false),
    minStock: integer("min_stock").notNull().default(0),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("products_org_code").on(t.organizationId, t.code), index("products_org").on(t.organizationId)],
);

/**
 * Lagerbewegungen (append-only): Wareneingang, Verkauf, Storno, Inventur, Bruch, Eigenverbrauch.
 * Menge mit Vorzeichen (+ Zugang, − Abgang). Unveränderbar per DB-Trigger; Korrekturen als neue Bewegung.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    /** receipt | sale | storno | inventory | breakage | own_use */
    kind: text("kind").notNull(),
    quantity: integer("quantity").notNull(),
    occurredOn: date("occurred_on").notNull(),
    /** Einkaufspreis je Einheit (Wareneingang, optional) */
    unitCostCents: integer("unit_cost_cents"),
    /** Lieferscheinnummer (Wareneingang, optional) */
    deliveryNote: text("delivery_note"),
    /** Lieferant beim Wareneingang (Lieferanten werden nur archiviert, nie gelöscht) */
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    /** Verkauf/Storno: zugehöriger Beleg */
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("stock_movements_product").on(t.organizationId, t.productId), index("stock_movements_invoice").on(t.organizationId, t.invoiceId)],
);

/**
 * Mahnwesen: Zahlungserinnerung / 1. Mahnung / 2. Mahnung zu einer Rechnung (src/lib/dunning.ts).
 * Unveränderbar (Trigger, drizzle/0034): nur der Versandvermerk (sent_*) darf genau einmal gesetzt werden.
 * Die Mahngebühr gehört NICHT zur Rechnung (GoBD) – sie steht nur hier und im Schreiben.
 * Das PDF wird bei Bedarf aus den gespeicherten Werten erzeugt (Text, Beträge, Fristen, Briefkopf sind eingefroren;
 * nur die Logos werden aktuell geladen).
 */
export const invoiceDunnings = pgTable(
  "invoice_dunnings",
  {
    id: id(),
    organizationId: orgId(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    /** reminder | dunning1 | dunning2 */
    stage: text("stage").notNull(),
    letterDate: date("letter_date").notNull(),
    /** neue Zahlungsfrist laut Schreiben */
    payBy: date("pay_by").notNull(),
    /** offener Rechnungsbetrag beim Erstellen (Gesamt − Zahlungen) */
    openCents: integer("open_cents").notNull(),
    /** Gebühr dieser Stufe (konkrete Kosten) */
    feeCents: integer("fee_cents").notNull().default(0),
    /** Summe aller Mahngebühren zu dieser Rechnung einschließlich dieser */
    feesTotalCents: integer("fees_total_cents").notNull().default(0),
    /** Brieftext mit ersetzten Platzhaltern – außer {frist}: die wird erst beim Erzeugen von PDF/E-Mail aus pay_by eingesetzt */
    body: text("body").notNull(),
    /** Briefkopf/Anschrift beim Erstellen (Praxis, Bankverbindung, Empfänger) – Nachdrucke entsprechen dem versendeten Schreiben (§ 147 AO) */
    letterhead: jsonb("letterhead").$type<Record<string, unknown>>().notNull(),
    /** email | post */
    sentVia: text("sent_via"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentTo: text("sent_to"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoice_dunnings_invoice_stage").on(t.invoiceId, t.stage),
    index("invoice_dunnings_org_invoice").on(t.organizationId, t.invoiceId),
  ],
);

export const vouchers = pgTable(
  "vouchers",
  {
    id: id(),
    organizationId: orgId(),
    code: text("code").notNull(),
    issuedAt: date("issued_at").notNull(),
    validUntil: date("valid_until").notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** Einzweck (single) / Mehrzweck (multi) – § 3 Abs. 13–15 UStG */
    purpose: text("purpose").notNull().default("multi"),
    /** bereits vor dem Import eingelöster Betrag (Altdaten) */
    openingRedeemedCents: integer("opening_redeemed_cents").notNull().default(0),
    note: text("note"),
    soldInvoiceId: uuid("sold_invoice_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("vouchers_org_code").on(t.organizationId, t.code)],
);

export const payments = pgTable("payments", {
  id: id(),
  organizationId: orgId(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "restrict" }),
  method: paymentMethodEnum("method").notNull(),
  amountCents: integer("amount_cents").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  voucherId: uuid("voucher_id").references(() => vouchers.id),
  externalRef: text("external_ref"),
  createdBy: uuid("created_by").references(() => users.id),
  /**
   * Kassenabschluss (Z-Bon), in dem die Zahlung erfasst ist. Wird genau einmal gesetzt (NULL → Abschluss);
   * danach – und für jede Zahlung eines abgeschlossenen Tages – verhindert ein DB-Trigger Änderung/Löschung.
   */
  cashClosingId: uuid("cash_closing_id").references((): AnyPgColumn => cashClosings.id),
}, (t) => [index("payments_org_closing").on(t.organizationId, t.cashClosingId, t.paidAt), index("payments_org_paid").on(t.organizationId, t.paidAt)]);

// ───────────────────────── Kasse (KassenSichV / GoBD, Phase 5) ─────────────────────────
/** Zählprotokoll: Stückzahl je Stückelung in Cent, z. B. { "5000": 2, "200": 3 } */
export type CashDenominations = Record<string, number>;

/** Summen eines Kassenabschlusses (in Cent) – Grundlage für Z-Bon und DSFinV-K */
export type CashClosingTotals = {
  /** alle Zahlungseingänge des Abschlusses je Zahlart (auch nicht kassenrelevante wie Überweisung) */
  byMethod: Record<string, number>;
  /** kassenrelevante Umsätze (Bar/Karte/Gutschein) je Steuersatz, brutto/netto/USt */
  byVat: { rate: number; grossCents: number; netCents: number; vatCents: number }[];
  /** Summe der Einlagen/Entnahmen je Art (vorzeichenbehaftet) */
  movements: Record<string, number>;
  /** Summen je DSFinV-K-Geschäftsvorfall und USt-Schlüssel */
  businessCases: { gvTyp: string; ustKey: number; grossCents: number; netCents: number; vatCents: number }[];
};

/** TSE-Angaben zum Abschluss (KassenSichV) – mode "none" = ohne TSE */
export type CashClosingTse = {
  mode: "fiskaly" | "none";
  /** true, wenn Zahlungen nur mit Test-Signaturen (Mock) versehen wurden */
  testSignatures?: boolean;
  tssSerial?: string | null;
  transactionNumber?: number | null;
  signatureCounter?: number | null;
  exportRef?: string | null;
  /** Meldung des Abschlusses an den TSE-/DSFinV-K-Dienst erfolgt nach dem Speichern (siehe cash_closing_registrations) */
  registration?: "pending";
  note?: string | null;
};

/**
 * Kassenabschlüsse (Z-Bon / Tagesabschluss). Append-only (DB-Trigger), je Praxis lückenlos nummeriert
 * (Advisory-Lock + Trigger-Prüfung) und per Hash-Kette verbunden (wie die Behandlungsdoku).
 */
export const cashClosings = pgTable(
  "cash_closings",
  {
    id: id(),
    organizationId: orgId(),
    /** Z-Nummer, je Praxis lückenlos ab 1 */
    number: integer("number").notNull(),
    /** Buchungstag (Europe/Berlin) */
    businessDate: date("business_date").notNull(),
    /** Stichzeitpunkt: alle bis dahin nicht abgeschlossenen Zahlungen/Bewegungen gehören zu diesem Abschluss */
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    openingCents: integer("opening_cents").notNull(),
    cashPaymentsCents: integer("cash_payments_cents").notNull(),
    movementsCents: integer("movements_cents").notNull(),
    expectedCashCents: integer("expected_cash_cents").notNull(),
    countedCashCents: integer("counted_cash_cents").notNull(),
    differenceCents: integer("difference_cents").notNull(),
    denominations: jsonb("denominations").$type<CashDenominations>().notNull(),
    totals: jsonb("totals").$type<CashClosingTotals>().notNull(),
    paymentCount: integer("payment_count").notNull(),
    movementCount: integer("movement_count").notNull(),
    /** fortlaufende Belegnummern (DSFinV-K BON_NR) der kassenrelevanten Vorgänge dieses Abschlusses */
    firstBonNr: integer("first_bon_nr").notNull(),
    lastBonNr: integer("last_bon_nr").notNull(),
    /** SHA-256 über die enthaltenen Zahlungen/Bewegungen (IDs, Beträge, Zeitpunkte) */
    itemsDigest: text("items_digest").notNull(),
    tse: jsonb("tse").$type<CashClosingTse>().notNull(),
    /**
     * Unveränderlicher Snapshot der Einzelaufzeichnungen (Bons inkl. Positionen, USt-Aufteilung, Gutscheine,
     * TSE-Daten) zum Abschlusszeitpunkt – Teil der Hash-Kette; DSFinV-K-Export und Z-Bon lesen nur daraus.
     * NULL nur bei Abschlüssen vor Migration 0016 (dort Rekonstruktion aus den Zahlungen).
     */
    bons: jsonb("bons").$type<unknown[]>(),
    differenceReason: text("difference_reason"),
    note: text("note"),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("cash_closings_org_number").on(t.organizationId, t.number),
    uniqueIndex("cash_closings_org_date").on(t.organizationId, t.businessDate),
  ],
);

/**
 * Kassenbuch: Einlagen/Entnahmen (Bargeld ohne Rechnung), vorzeichenbehaftet (+ in die Kasse, − aus der Kasse).
 * Append-only; Korrektur nur durch Gegenbuchung. cash_closing_id wird beim Abschluss einmalig gesetzt.
 */
export const cashMovements = pgTable(
  "cash_movements",
  {
    id: id(),
    organizationId: orgId(),
    /** private_deposit | private_withdrawal | transit_in | transit_out | payout | payin */
    kind: text("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    cashClosingId: uuid("cash_closing_id").references(() => cashClosings.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("cash_movements_org_closing").on(t.organizationId, t.cashClosingId, t.occurredAt)],
);

/**
 * TSE-Signaturen je Kassenvorgang (KassenSichV): Bar, Karte und Gutschein. Append-only (DB-Trigger), nur vom Server
 * geschrieben – payments.external_ref ist für TSE-Daten nicht maßgeblich (frei eingebbar, z. B. Belegnummer des Terminals).
 */
export const fiscalTransactions = pgTable(
  "fiscal_transactions",
  {
    id: id(),
    organizationId: orgId(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    vendor: text("vendor").notNull(),
    tssSerial: text("tss_serial").notNull(),
    txNumber: integer("tx_number").notNull(),
    signatureCounter: integer("signature_counter").notNull(),
    signature: text("signature").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    /** DSFinV-K TSE_TA_VORGANGSART */
    processType: text("process_type").notNull().default("Kassenbeleg-V1"),
    /** true = Test-/Mock-Signatur (keine gültige TSE) */
    isTest: boolean("is_test").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("fiscal_transactions_payment").on(t.paymentId), index("fiscal_transactions_org").on(t.organizationId, t.createdAt)],
);

/**
 * Meldung eines Kassenabschlusses an den TSE-/DSFinV-K-Dienst (z. B. fiskaly). Erst NACH dem Speichern des Abschlusses
 * (externer Dienst ist nicht Teil der DB-Transaktion), idempotent über die Abschluss-ID; append-only, je Abschluss einmal.
 */
export const cashClosingRegistrations = pgTable(
  "cash_closing_registrations",
  {
    id: id(),
    organizationId: orgId(),
    cashClosingId: uuid("cash_closing_id")
      .notNull()
      .references(() => cashClosings.id, { onDelete: "restrict" }),
    vendor: text("vendor").notNull(),
    closingRef: text("closing_ref").notNull(),
    tssSerial: text("tss_serial"),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cash_closing_registrations_closing").on(t.cashClosingId)],
);

// ───────────────────────── Kommunikation ─────────────────────────
export const messages = pgTable(
  "messages",
  {
    id: id(),
    organizationId: orgId(),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "set null" }),
    channel: channelEnum("channel").notNull(),
    direction: messageDirectionEnum("direction").notNull(),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    subject: text("subject"),
    body: text("body").notNull(),
    status: messageStatusEnum("status").notNull().default("new"),
    aiSuggestion: text("ai_suggestion"),
    externalId: text("external_id"),
    threadKey: text("thread_key"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_org_time").on(t.organizationId, t.receivedAt)],
);

export const reviews = pgTable("reviews", {
  id: id(),
  organizationId: orgId(),
  provider: text("provider").notNull().default("google"),
  externalId: text("external_id").notNull(),
  author: text("author"),
  rating: integer("rating"),
  text: text("text"),
  reply: text("reply"),
  aiSuggestion: text("ai_suggestion"),
  createdAtExternal: timestamp("created_at_external", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
});

// ───────────────────────── Integrationen ─────────────────────────
export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: id(),
    organizationId: orgId(),
    provider: integrationProviderEnum("provider").notNull(),
    status: integrationStatusEnum("status").notNull().default("disconnected"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** AES-256-GCM verschlüsselt (src/lib/crypto.ts) */
    secretEnc: text("secret_enc"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("integration_org_provider").on(t.organizationId, t.provider)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: integrationProviderEnum("provider").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    /** Rohdaten nur bis zur erfolgreichen Verarbeitung (danach NULL), höchstens 30 Tage – Gesamt-Review H4 */
    payload: jsonb("payload"),
    /** sha256 des Roh-Bodys (Nachweis/Duplikaterkennung ohne Inhalt) */
    payloadHash: text("payload_hash"),
    /** pending → processing → done | failed (Wiederholung mit Backoff) → dead (nach max. Versuchen) – Gesamt-Review H7 */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  // je Praxis eindeutig (gleiche Provider-Event-ID bei zwei Praxen darf nicht kollidieren)
  (t) => [uniqueIndex("webhook_events_idem_org").on(t.provider, t.organizationId, t.externalId), index("webhook_events_due").on(t.status, t.nextAttemptAt)],
);

export const syncLog = pgTable("sync_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  organizationId: orgId(),
  provider: integrationProviderEnum("provider").notNull(),
  direction: text("direction").notNull(),
  entity: text("entity"),
  entityId: text("entity_id"),
  ok: boolean("ok").notNull(),
  message: text("message"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// ───────────────────────── Praxis-Finanzen, Aufgaben, News ─────────────────────────
export const fixedCosts = pgTable("fixed_costs", {
  id: id(),
  organizationId: orgId(),
  category: text("category").notNull(),
  amountCents: integer("amount_cents").notNull(),
  /** monthly | quarterly | yearly */
  interval: text("interval").notNull().default("monthly"),
  startDate: date("start_date").notNull(),
  note: text("note"),
  active: boolean("active").notNull().default(true),
});

export const tasks = pgTable("tasks", {
  id: id(),
  organizationId: orgId(),
  title: text("title").notNull(),
  kind: text("kind").notNull().default("manual"),
  patientId: uuid("patient_id").references(() => patients.id, { onDelete: "cascade" }),
  assigneeId: uuid("assignee_id").references(() => users.id),
  dueAt: date("due_at"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const newsItems = pgTable(
  "news_items",
  {
    id: id(),
    source: text("source").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    summary: text("summary"),
    category: text("category").notNull().default("allgemein"),
    sponsored: boolean("sponsored").notNull().default(false),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("news_items_url").on(t.url)],
);

// ───────────────────────── Audit ─────────────────────────
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id"),
    userId: uuid("user_id"),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    ip: text("ip"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_org_time").on(t.organizationId, t.at)],
);

/** KI-Telefonagent: Anrufe (Pilot). Transkript nur mit Einwilligung / nach Hinweis gespeichert. */
export const voiceCalls = pgTable(
  "voice_calls",
  {
    id: id(),
    organizationId: orgId(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    /** gekürzt/maskiert gespeichert, z. B. +49 151 ••• 23 */
    callerMasked: text("caller_masked"),
    patientId: uuid("patient_id").references(() => patients.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationSec: integer("duration_sec"),
    /** booked | rescheduled | cancelled | info | callback | handover | failed */
    outcome: text("outcome"),
    summary: text("summary"),
    transcript: text("transcript"),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("voice_calls_ext").on(t.organizationId, t.provider, t.externalId)],
);

// ───────────────────────── Kalender-Abo (iCal-Import) ─────────────────────────
/**
 * Abonnierte externe Kalender (z. B. Google-Kalender, in den Docal.io/CalMedi Doctolib-Termine spiegeln).
 * Die private iCal-Adresse ist ein Zugangsgeheimnis: AES-256-GCM verschlüsselt (AAD = Praxis + Feed-ID).
 */
export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: id(),
    organizationId: orgId(),
    label: text("label").notNull(),
    /** verschlüsselte URL (src/lib/crypto.ts) */
    urlEnc: text("url_enc").notNull(),
    /** nicht geheimer Anzeigehinweis, z. B. „calendar.google.com/…/basic.ics“ */
    urlHint: text("url_hint").notNull(),
    therapistId: uuid("therapist_id").references(() => users.id, { onDelete: "set null" }),
    /** „doctolib“ oder „extern“ */
    source: appointmentSourceEnum("source").notNull().default("doctolib"),
    active: boolean("active").notNull().default(true),
    etag: text("etag"),
    lastModified: text("last_modified"),
    /** letzter ERFOLGREICHER Abruf */
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Zähler des letzten Laufs (keine Personendaten) */
    lastResult: jsonb("last_result").$type<Record<string, number>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("calendar_feeds_org").on(t.organizationId)],
);

/** Zuordnung Kalender-Ereignis (UID + Vorkommen) → Termin; Grundlage für idempotente Abgleiche. */
export const calendarFeedEvents = pgTable(
  "calendar_feed_events",
  {
    id: id(),
    organizationId: orgId(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => calendarFeeds.id, { onDelete: "cascade" }),
    /** UID bzw. UID#Vorkommen (Serien) */
    eventKey: text("event_key").notNull(),
    /** null = Termin wurde in PodoHero gelöscht (wird nicht neu angelegt) */
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    /** sha256 der Kalenderdaten des Ereignisses beim letzten Abruf */
    hash: text("hash").notNull(),
    /** sha256 der vom Abgleich gesetzten Terminfelder – weicht der Termin ab, wurde er in PodoHero geändert */
    appliedHash: text("applied_hash").notNull(),
    /** null | local_change (in PodoHero geändert, Kalender-Änderung nicht übernommen) | overlap (Überschneidung) | deleted_locally */
    conflict: text("conflict"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("calendar_feed_events_key").on(t.feedId, t.eventKey),
    index("calendar_feed_events_appointment").on(t.organizationId, t.appointmentId),
  ],
);

// ───────────────────────── Fahrten & Hausbesuchs-Touren ─────────────────────────
/**
 * Startorte für Fahrten zu Hausbesuchen (Praxis, Zuhause, Lager …). Gespeichert werden Adresse und die
 * geokodierten Koordinaten NUR dieser Startorte. Fahrzeug, km-Satz und Hin-/Rückweg-Regel stehen in
 * organizations.settings.trips.
 */
export const tripStartLocations = pgTable(
  "trip_start_locations",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    street: text("street"),
    zip: text("zip"),
    city: text("city"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("trip_start_locations_org").on(t.organizationId),
    // höchstens EIN Standard-Startort je Praxis
    uniqueIndex("trip_start_locations_one_default").on(t.organizationId).where(sql`${t.isDefault} and ${t.active}`),
  ],
);

/**
 * Fahrtenbuch-Hilfe (append-only, DB-Trigger): eine Zeile je Fahrt. Ziel ist IMMER pseudonymisiert
 * („Hausbesuch K-<Nummer>“), nie der Name. Korrekturen (Ankunft, km, Storno) nur als trip_corrections.
 * appointment_id bewusst ohne Fremdschlüssel: das Löschen eines Termins darf den Eintrag nicht ändern.
 */
export const trips = pgTable(
  "trips",
  {
    id: id(),
    organizationId: orgId(),
    driverId: uuid("driver_id").references(() => users.id),
    /** Tag der Fahrt (Europe/Berlin) */
    tripDate: date("trip_date").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    fromLabel: text("from_label").notNull(),
    toLabel: text("to_label").notNull(),
    purpose: text("purpose").notNull().default("Hausbesuch"),
    distanceM: integer("distance_m").notNull(),
    durationSec: integer("duration_sec"),
    /** route (Routing-Dienst) | estimate (Luftlinie × 1,3) | manual */
    distanceSource: text("distance_source").notNull(),
    provider: text("provider"),
    appointmentId: uuid("appointment_id"),
    vehicleLabel: text("vehicle_label"),
    plate: text("plate"),
    odometerStart: integer("odometer_start"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("trips_org_date").on(t.organizationId, t.tripDate), index("trips_org_appointment").on(t.organizationId, t.appointmentId)],
);

/** Nachträge zu Fahrten (append-only): Ankunft, Korrektur, Storno – mit Person und Zeitpunkt. */
export const tripCorrections = pgTable(
  "trip_corrections",
  {
    id: id(),
    organizationId: orgId(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "restrict" }),
    /** arrival | correction | void */
    kind: text("kind").notNull(),
    distanceM: integer("distance_m"),
    durationSec: integer("duration_sec"),
    purpose: text("purpose"),
    odometerStart: integer("odometer_start"),
    odometerEnd: integer("odometer_end"),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    voided: boolean("voided").notNull().default(false),
    reason: text("reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("trip_corrections_trip").on(t.organizationId, t.tripId)],
);

/**
 * Zwischenspeicher für Routing-Ergebnisse (30 Tage) je Praxis. Schlüssel = sha256 über Anbieter und gerundete
 * Koordinaten – keine Adressen/Koordinaten im Klartext. Fahrten ab „aktuellem Standort“ werden nie gespeichert.
 */
export const routeCache = pgTable(
  "route_cache",
  {
    id: id(),
    organizationId: orgId(),
    keyHash: text("key_hash").notNull(),
    provider: text("provider").notNull(),
    distanceM: integer("distance_m").notNull(),
    durationSec: integer("duration_sec").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("route_cache_org_key").on(t.organizationId, t.keyHash)],
);

/** Geokodierung (Photon) je Praxis: sha256 der normalisierten Adresse → Koordinaten (4 Nachkommastellen), 90 Tage. */
export const geocodeCache = pgTable(
  "geocode_cache",
  {
    id: id(),
    organizationId: orgId(),
    addressHash: text("address_hash").notNull(),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("geocode_cache_org_address").on(t.organizationId, t.addressHash)],
);

// ───────────────────────── Vertrieb (Plattform-Betreiber, keine Praxisdaten) ─────────────────────────
/**
 * Vertrieb: Praxen, die der Plattform-Betreiber anschreibt (B2B-Kontakte, keine Mandantendaten).
 * Kein organization_id, keine RLS (plattformweit wie sessions/password_resets); Zugriff nur serverseitig über
 * src/server/vertrieb.ts mit Prüfung Plattform-Admin + 2FA. Status/Schritt per CHECK abgesichert (0028).
 * `step` = Anzahl erfolgreich versendeter Mails der Sequenz (0–3).
 */
export const salesLeads = pgTable(
  "sales_leads",
  {
    id: id(),
    name: text("name").notNull(),
    contactPerson: text("contact_person"),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    street: text("street"),
    zip: text("zip"),
    city: text("city"),
    distanceKm: doublePrecision("distance_km"),
    source: text("source"),
    notes: text("notes"),
    status: text("status").notNull().default("neu"),
    step: smallint("step").notNull().default(0),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    /** Kampagne (höchstens eine je Lead): Vorlagen-Variante und Aktionscode für {{code}}/{{link}} */
    campaignId: uuid("campaign_id").references((): AnyPgColumn => salesCampaigns.id, { onDelete: "set null" }),
    /** Zeitpunkt der zuletzt manuell erfassten Antwort („Antwort erhalten“) */
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    /**
     * Dokumentierte Einwilligung in Werbe-E-Mails (§ 7 Abs. 2 Nr. 2 UWG, auch B2B): ohne consent_at wird NIE gesendet.
     * consent_note = wie/wann erteilt (Pflicht, CHECK in 0041). Wird beim Ändern der E-Mail-Adresse entfernt.
     */
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentNote: text("consent_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sales_leads_email").on(sql`lower(${t.email})`).where(sql`${t.email} is not null`),
    index("sales_leads_status").on(t.status),
    index("sales_leads_campaign").on(t.campaignId),
  ],
);

/**
 * Kampagnen des Vertriebs: gruppieren Leads, optional eigene Vorlagen-Variante (3 Mails; null = Standardvorlagen
 * aus sales_settings) und einen Aktionscode (promo_codes.campaign_id). Versand bleibt manuell (Vertriebsseite).
 */
export const salesCampaigns = pgTable("sales_campaigns", {
  id: id(),
  name: text("name").notNull(),
  notes: text("notes"),
  templates: jsonb("templates").$type<SalesTemplate[]>(),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Verlauf eines Leads (Notizen, Statuswechsel, „Antwort erhalten“, Kampagne) – Versand steht in sales_sends. */
export const salesLeadEvents = pgTable(
  "sales_lead_events",
  {
    id: id(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => salesLeads.id, { onDelete: "cascade" }),
    /** note | status | reply | campaign | consent */
    kind: text("kind").notNull(),
    text: text("text"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("sales_lead_events_lead").on(t.leadId, t.createdAt)],
);

/** Versandprotokoll der Sequenz (je Mail eine Zeile). Lead gelöscht → lead_id NULL (Tageslimit bleibt korrekt). */
export const salesSends = pgTable(
  "sales_sends",
  {
    id: id(),
    leadId: uuid("lead_id").references(() => salesLeads.id, { onDelete: "set null" }),
    step: smallint("step").notNull(),
    ok: boolean("ok").notNull(),
    mock: boolean("mock").notNull().default(false),
    messageId: text("message_id"),
    error: text("error"),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sales_sends_lead").on(t.leadId), index("sales_sends_sent_at").on(t.sentAt)],
);

/**
 * Sperrliste (Abmeldung/Widerspruch) als Prüfwert: HMAC der kleingeschriebenen Adresse (src/lib/vertrieb/blocklist.ts),
 * keine Klartext-Adressen. An gesperrte Adressen geht nie wieder eine Vertriebsmail – auch nach Löschen/Neu-Import.
 */
export const salesBlocklist = pgTable("sales_blocklist", {
  hash: text("hash").primaryKey(),
  /** email | host | namezip */
  kind: text("kind").notNull().default("email"),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
});

/** ALTBESTAND (bis 0042): Klartext-Sperrliste – wird beim ersten Zugriff in sales_blocklist überführt und geleert (src/server/blocklist.ts). */
export const salesSuppressions = pgTable("sales_suppressions", {
  email: text("email").primaryKey(),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
});

export type SalesTemplate = { subject: string; body: string };

/**
 * Nächtliche Praxissuche (OpenStreetMap, Ring um den Startort): Einstellungen + Fortschritt in einer jsonb-Spalte.
 * Struktur und Prüfung in src/lib/vertrieb/lead-search.ts (normalizeLeadSearch). Enthält nur Einstellungen, Zähler und Lead-IDs (Anreicherung), keine Lead-Inhalte.
 */
export type SalesLeadSearch = Record<string, unknown>;

/** Einstellungen des Vertriebs (genau eine Zeile, id = 1): Absender, Impressum, Vorlagen, Abstände. */
export const salesSettings = pgTable("sales_settings", {
  id: smallint("id").primaryKey().default(1),
  senderName: text("sender_name").notNull().default(""),
  senderEmail: text("sender_email").notNull().default(""),
  replyTo: text("reply_to").notNull().default(""),
  impressum: text("impressum").notNull().default(""),
  delay2Days: smallint("delay2_days").notNull().default(5),
  delay3Days: smallint("delay3_days").notNull().default(10),
  templates: jsonb("templates").$type<SalesTemplate[]>(),
  leadSearch: jsonb("lead_search").$type<SalesLeadSearch>(),
  /** Betreiber bestätigt: E-Mail-Versanddienstleister mit AVV ist in den Unterauftragnehmern eingetragen – sonst kein Versand */
  mailProcessorConfirmed: boolean("mail_processor_confirmed").notNull().default(false),
  /** Kanarienwert des Sperrlisten-Schlüssels (src/lib/vertrieb/blocklist.ts blocklistKeyCheck) – fail-closed bei Abweichung */
  blocklistKeyCheck: text("blocklist_key_check"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

// ───────────────────────── Aktionscodes (SaaS-Testphase, Plattform-Betreiber) ─────────────────────────
/**
 * Aktionscodes für eine verlängerte Testphase (z. B. 90 Tage) – NICHT die Gutscheine der Praxis (/gutscheine).
 * Plattformweit wie sales_*: keine RLS, Zugriff nur über src/server/promo-codes.ts (Konsole: Plattform-Admin + 2FA;
 * Einlösen: Registrierung bzw. Inhaber:in auf der Abo-Seite). Code normalisiert (A–Z, 0–9, „-“), per CHECK erzwungen (0040).
 * grant_plan: null = Testphase mit allen Funktionen, sonst Tarif-Umfang während der Testphase (starter|praxis|plus).
 */
export const promoCodes = pgTable(
  "promo_codes",
  {
    id: id(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    trialDays: smallint("trial_days").notNull(),
    grantPlan: text("grant_plan"),
    maxRedemptions: integer("max_redemptions"),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    campaignId: uuid("campaign_id").references(() => salesCampaigns.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => salesLeads.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("promo_codes_code").on(t.code), index("promo_codes_campaign").on(t.campaignId)],
);

/** Einlösungen: je Praxis höchstens EINE (unique), unveränderbar (Trigger, 0040); Obergrenze je Code per Trigger. */
export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: id(),
    codeId: uuid("code_id")
      .notNull()
      .references(() => promoCodes.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    redeemedBy: uuid("redeemed_by").references(() => users.id, { onDelete: "set null" }),
    /** signup | abo */
    via: text("via").notNull(),
    /** Tarif vor dem Einlösen (z. B. „free“: nach Ablauf automatisch zurück in den kostenlosen Tarif) */
    previousPlan: text("previous_plan"),
    trialEndsBefore: timestamp("trial_ends_before", { withTimezone: true }),
    trialEndsAfter: timestamp("trial_ends_after", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("promo_redemptions_org").on(t.organizationId), index("promo_redemptions_code").on(t.codeId)],
);

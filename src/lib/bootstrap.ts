/**
 * Bootstrap über Umgebungsvariablen – für frische Server ohne Shell-Zugang.
 * Wird von scripts/bootstrap.ts nach den Migrationen im migrate-Container ausgeführt. IDEMPOTENT:
 *
 *  1) Plattform-Admin (BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_PASSWORD)
 *     → users.is_platform_admin = true, KEINE Praxis-Mitgliedschaft. Die Plattform-Konsole verlangt 2FA,
 *       die beim ersten Login unter /login/2fa-einrichten eingerichtet wird.
 *     Existiert die Person schon, wird das Passwort NICHT geändert.
 *  2) Praxis (BOOTSTRAP_PRACTICE_JSON = Pfad oder JSON-Text; Passwort der Inhaber:in NUR aus
 *     BOOTSTRAP_PRACTICE_OWNER_PASSWORD, nie aus der Datei) → Praxis (Testphase 30 Tage), Inhaber:in,
 *     Leistungen, Einstellungen. Idempotent über den slug: existiert er, wird nichts verändert.
 *  3) Demo-Praxis für den Plattform-Admin (Standard AN, aus mit BOOTSTRAP_ADMIN_DEMO=false): Praxis
 *     „Demo-Praxis (Beispieldaten)“ (slug demo-praxis, Tarif „internal“ → läuft nie ab, settings.demo = true)
 *     mit den ERFUNDENEN Beispieldaten aus src/lib/demo-data.ts; der Admin wird aktive:r Inhaber:in.
 *     Existiert die Praxis, wird nur die Mitgliedschaft sichergestellt. Andere Praxen werden nie verändert.
 *
 * Nur öffentliche Geschäftsangaben bzw. erfundene Beispieldaten – keine echten Patientendaten.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "../db/schema";
import { hashPassword, passwordProblem } from "./auth/password";
import { DEMO_PRACTICE_FIELDS, seedDemoPracticeData } from "./demo-data";
import { DEMO_PRACTICE_NAME, DEMO_PRACTICE_SLUG, isDemoPractice } from "./demo-practice";

export { DEMO_PRACTICE_NAME, DEMO_PRACTICE_SLUG, isDemoPractice };
import { seedIntegrationDefaults } from "./org-defaults";
import { BILLING_MODES, type BillingMode } from "./features";
import { PLANS, TRIAL_DAYS } from "./plans";
import { LIMITS } from "./website";

type Db = NodePgDatabase<typeof schema>;
type Env = Record<string, string | undefined>;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit als HH:MM");

export const practiceSpecSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/, "slug: Kleinbuchstaben, Ziffern, Bindestrich").optional(),
    legalName: z.string().trim().max(200).optional(),
    street: z.string().trim().max(200),
    zip: z.string().trim().regex(/^\d{5}$/, "PLZ: 5 Ziffern"),
    city: z.string().trim().max(100),
    state: z.string().length(2).default("BB"),
    phone: z.string().trim().max(40),
    email: z.string().trim().toLowerCase().email(),
    website: z.string().url().optional(),
    openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Praxis-Modus (src/lib/features.ts): „private_only“ blendet alle Kassen-Themen aus */
    billingMode: z.enum(BILLING_MODES).optional(),
    owner: z
      .object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().min(2).max(120),
        /** wird IGNORIERT – Passwörter nur aus BOOTSTRAP_PRACTICE_OWNER_PASSWORD */
        password: z.unknown().optional(),
      })
      .strict(),
    practitioner: z.object({ name: z.string().trim().max(120), qualification: z.string().trim().max(200).optional() }).optional(),
    services: z
      .array(
        z.object({
          code: z.string().trim().regex(/^[A-Z0-9]{1,8}$/).optional(),
          name: z.string().trim().min(2).max(120),
          durationMin: z.number().int().min(0).max(480),
          /** null = Platzhalter (wird als 0 gespeichert und in den Einstellungen als „Preis bitte prüfen“ markiert) */
          priceCents: z.number().int().min(0).max(1_000_000).nullable(),
          vatRate: z.union([z.literal(0), z.literal(7), z.literal(19)]),
          category: z.enum(["treatment", "brace", "cosmetic", "travel", "product"]).default("treatment"),
          description: z.string().trim().max(LIMITS.serviceDescription).optional(),
          note: z.string().trim().max(200).optional(),
        }),
      )
      .max(60)
      .default([]),
    openingHours: z.array(z.object({ weekday: z.number().int().min(1).max(7), from: time, to: time })).max(21).default([]),
    homeVisitAreas: z.array(z.string().trim().min(1).max(LIMITS.area)).max(LIMITS.areas).default([]),
    websiteContent: z.object({ claim: z.string().max(LIMITS.claim).optional(), about: z.string().max(LIMITS.about).optional() }).optional(),
  })
  .strict();

export type PracticeSpec = z.infer<typeof practiceSpecSchema>;

export type BootstrapResult = {
  admin: "created" | "exists" | "promoted" | "skipped";
  practice: "created" | "exists" | "skipped";
  practiceSlug?: string;
  /** billingMode aus der Datei auf eine vorhandene Praxis angewendet (nur, wenn dort noch keiner gesetzt war) */
  billingMode?: "set" | "kept";
  /** Demo-Praxis des Plattform-Admins: angelegt / vorhanden (Mitgliedschaft sichergestellt) / übersprungen */
  demo: "created" | "exists" | "skipped";
  warnings: string[];
};


export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "praxis"
  );
}

/** BOOTSTRAP_PRACTICE_JSON: JSON-Text (beginnt mit „{“) oder Pfad zu einer Datei. */
export function loadPracticeSpec(value: string, cwd = process.cwd()): PracticeSpec {
  const text = value.trim().startsWith("{") ? value : readFileSync(path.resolve(cwd, value.trim()), "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BootstrapError("BOOTSTRAP_PRACTICE_JSON ist kein gültiges JSON.");
  }
  const parsed = practiceSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new BootstrapError(`BOOTSTRAP_PRACTICE_JSON ungültig: ${i?.path.join(".") || "(Wurzel)"}: ${i?.message ?? "?"}`);
  }
  return parsed.data;
}

/** Leistungs-Codes eindeutig vergeben (vorhandene aus der Datei bleiben). */
function serviceCodes(services: PracticeSpec["services"]): string[] {
  const used = new Set(services.map((s) => s.code).filter(Boolean) as string[]);
  return services.map((s, i) => {
    if (s.code) return s.code;
    const base = s.name.normalize("NFKD").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 2) || "L";
    let code = base;
    for (let n = 2; used.has(code); n++) code = `${base}${n}`;
    used.add(code);
    return code || `L${i + 1}`;
  });
}

async function bootstrapAdmin(db: Db, env: Env, warnings: string[]): Promise<BootstrapResult["admin"]> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return "skipped";
  if (!z.string().email().safeParse(email).success) throw new BootstrapError("BOOTSTRAP_ADMIN_EMAIL ist keine gültige E-Mail-Adresse.");
  const [existing] = await db.select({ id: schema.users.id, isPlatformAdmin: schema.users.isPlatformAdmin }).from(schema.users).where(eq(schema.users.email, email));
  if (existing) {
    // Passwort bleibt unverändert – nur die Rolle wird sichergestellt
    if (existing.isPlatformAdmin) return "exists";
    await db.update(schema.users).set({ isPlatformAdmin: true }).where(eq(schema.users.id, existing.id));
    await db.insert(schema.auditLog).values({ userId: existing.id, action: "bootstrap.platform_admin", meta: { promoted: true } });
    return "promoted";
  }
  const name = env.BOOTSTRAP_ADMIN_NAME?.trim();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  if (!name || name.length < 2) throw new BootstrapError("BOOTSTRAP_ADMIN_NAME fehlt.");
  const problem = passwordProblem(password);
  if (problem) throw new BootstrapError(`BOOTSTRAP_ADMIN_PASSWORD: ${problem}`);
  const [u] = await db
    .insert(schema.users)
    .values({ email, name, passwordHash: await hashPassword(password), isPlatformAdmin: true })
    .onConflictDoNothing({ target: schema.users.email })
    .returning({ id: schema.users.id });
  if (!u) return "exists"; // parallel angelegt
  await db.insert(schema.auditLog).values({ userId: u.id, action: "bootstrap.platform_admin", meta: { created: true } });
  warnings.push("Plattform-Admin angelegt – beim ersten Login 2FA einrichten. BOOTSTRAP_ADMIN_PASSWORD danach aus deploy/.env entfernen.");
  return "created";
}

async function bootstrapPractice(db: Db, env: Env, warnings: string[]): Promise<Pick<BootstrapResult, "practice" | "practiceSlug" | "billingMode">> {
  const value = env.BOOTSTRAP_PRACTICE_JSON;
  if (!value?.trim()) return { practice: "skipped" };
  const spec = loadPracticeSpec(value, env.BOOTSTRAP_CWD ?? process.cwd());
  if (spec.owner.password !== undefined) warnings.push("owner.password in BOOTSTRAP_PRACTICE_JSON wird ignoriert – Passwort nur über BOOTSTRAP_PRACTICE_OWNER_PASSWORD.");
  const slug = spec.slug ?? slugify(spec.name);

  const [existingOrg] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.slug, slug));
  if (existingOrg) {
    const billingMode = spec.billingMode ? await ensureBillingMode(db, existingOrg.id, spec.billingMode) : undefined;
    return { practice: "exists", practiceSlug: slug, ...(billingMode ? { billingMode } : {}) };
  }

  const [existingUser] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, spec.owner.email));
  let passwordHash: string | null = null;
  if (!existingUser) {
    const pw = env.BOOTSTRAP_PRACTICE_OWNER_PASSWORD ?? "";
    const problem = passwordProblem(pw);
    if (problem) throw new BootstrapError(`BOOTSTRAP_PRACTICE_OWNER_PASSWORD (für ${spec.owner.email}): ${problem}`);
    passwordHash = await hashPassword(pw);
  }
  const codes = serviceCodes(spec.services);
  const placeholders = spec.services.filter((s) => s.priceCents === null).map((s) => s.name);

  const created = await db.transaction(async (tx) => {
    // gleichzeitige Läufe serialisieren (zwei migrate-Container)
    await tx.execute(sql`select pg_advisory_xact_lock(4711002)`);
    const [again] = await tx.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.slug, slug));
    if (again) return false;
    const opening = spec.openingHours.length
      ? { from: spec.openingHours.map((h) => h.from).sort()[0], to: spec.openingHours.map((h) => h.to).sort().at(-1)! }
      : undefined;
    const [org] = await tx
      .insert(schema.organizations)
      .values({
        name: spec.name,
        slug,
        legalName: spec.legalName ?? null,
        street: spec.street,
        zip: spec.zip,
        city: spec.city,
        phone: spec.phone,
        email: spec.email,
        state: spec.state,
        plan: "trial",
        subscriptionStatus: "trialing",
        trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
        seats: PLANS.trial.includedSeats,
        settings: {
          ...(opening ? { opening } : {}),
          openingHours: spec.openingHours,
          homeVisitAreas: spec.homeVisitAreas,
          ...(spec.website ? { websiteUrl: spec.website } : {}),
          ...(spec.openingDate ? { openingDate: spec.openingDate } : {}),
          ...(spec.practitioner ? { practitioner: spec.practitioner } : {}),
          ...(spec.billingMode ? { billingMode: spec.billingMode } : {}),
          website: {
            enabled: false,
            claim: spec.websiteContent?.claim ?? "",
            about: spec.websiteContent?.about ?? "",
            showPrices: false,
            imprint: "",
            privacy: "",
            serviceDescriptions: Object.fromEntries(spec.services.flatMap((s, i) => (s.description ? [[codes[i], s.description]] : []))),
          },
          /** Leistungen mit Platzhalter-Preis – Hinweis in den Einstellungen */
          servicePriceNotes: Object.fromEntries(spec.services.flatMap((s, i) => (s.priceCents === null || s.note ? [[codes[i], s.note ?? "Preis bitte prüfen"]] : []))),
          bootstrap: { source: "env", at: new Date().toISOString() },
        },
      })
      .returning({ id: schema.organizations.id });
    let ownerId = existingUser?.id;
    if (!ownerId) {
      const [u] = await tx.insert(schema.users).values({ email: spec.owner.email, name: spec.owner.name, passwordHash: passwordHash! }).returning({ id: schema.users.id });
      ownerId = u.id;
    }
    const [m] = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, org.id), eq(schema.memberships.userId, ownerId)));
    if (!m) await tx.insert(schema.memberships).values({ organizationId: org.id, userId: ownerId, role: "owner" });
    // ab hier mandantengeschützte Tabellen (RLS)
    await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
    await tx.insert(schema.locations).values({ organizationId: org.id, name: "Hauptpraxis", street: spec.street, zip: spec.zip, city: spec.city });
    if (spec.services.length) {
      await tx.insert(schema.services).values(
        spec.services.map((s, i) => ({
          organizationId: org.id,
          code: codes[i],
          name: s.name,
          priceCents: s.priceCents ?? 0,
          vatRate: s.vatRate,
          durationMin: s.durationMin,
          category: s.category,
          requiresTherapeuticPurpose: s.vatRate === 0,
        })),
      );
    }
    await seedIntegrationDefaults(tx, org.id);
    await tx.insert(schema.auditLog).values({ organizationId: org.id, userId: ownerId, action: "bootstrap.practice", entity: "organization", entityId: org.id, meta: { services: spec.services.length, placeholderPrices: placeholders.length } });
    return true;
  });
  if (!created) return { practice: "exists", practiceSlug: slug };
  if (placeholders.length) warnings.push(`Platzhalter-Preise (0 €) – bitte unter Einstellungen → Leistungen prüfen: ${placeholders.join(", ")}`);
  if (!existingUser) warnings.push("Praxis-Inhaber:in angelegt – BOOTSTRAP_PRACTICE_OWNER_PASSWORD danach aus deploy/.env entfernen; 2FA unter Einstellungen → Sicherheit einrichten.");
  return { practice: "created", practiceSlug: slug };
}

/**
 * billingMode idempotent auf eine vorhandene Praxis anwenden: nur setzen, wenn settings.billingMode noch FEHLT –
 * eine spätere Änderung der Praxis in den Einstellungen wird nie überschrieben.
 */
async function ensureBillingMode(db: Db, orgId: string, mode: BillingMode): Promise<"set" | "kept"> {
  const updated = await db
    .update(schema.organizations)
    .set({ settings: sql`coalesce(${schema.organizations.settings}, '{}'::jsonb) || jsonb_build_object('billingMode', ${mode}::text)` })
    .where(and(eq(schema.organizations.id, orgId), sql`not (coalesce(${schema.organizations.settings}, '{}'::jsonb) ? 'billingMode')`))
    .returning({ id: schema.organizations.id });
  if (!updated.length) return "kept";
  await db.insert(schema.auditLog).values({ organizationId: orgId, action: "bootstrap.billing_mode", entity: "organization", entityId: orgId, meta: { to: mode } });
  return "set";
}

async function bootstrapDemo(db: Db, env: Env, warnings: string[]): Promise<BootstrapResult["demo"]> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || env.BOOTSTRAP_ADMIN_DEMO?.trim().toLowerCase() === "false") return "skipped";
  const [admin] = await db.select({ id: schema.users.id, isPlatformAdmin: schema.users.isPlatformAdmin }).from(schema.users).where(eq(schema.users.email, email));
  if (!admin?.isPlatformAdmin) return "skipped";
  return db.transaction(async (tx) => {
    // gleichzeitige Läufe serialisieren
    await tx.execute(sql`select pg_advisory_xact_lock(4711003)`);
    const [existing] = await tx
      .select({ id: schema.organizations.id, settings: schema.organizations.settings })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, DEMO_PRACTICE_SLUG));
    let orgId: string;
    let result: BootstrapResult["demo"];
    if (existing) {
      // Slug von einer echten Praxis belegt → nichts anfassen
      if (!isDemoPractice(existing.settings)) {
        warnings.push(`Slug „${DEMO_PRACTICE_SLUG}“ gehört zu einer Praxis ohne Demo-Kennzeichen – Demo-Praxis übersprungen.`);
        return "skipped";
      }
      orgId = existing.id;
      result = "exists";
    } else {
      const [org] = await tx
        .insert(schema.organizations)
        .values({
          name: DEMO_PRACTICE_NAME,
          slug: DEMO_PRACTICE_SLUG,
          ...DEMO_PRACTICE_FIELDS,
          plan: "internal",
          subscriptionStatus: "active",
          trialEndsAt: null,
          seats: 1,
          settings: { demo: true, bootstrap: { source: "env-demo", at: new Date().toISOString() } },
        })
        .returning({ id: schema.organizations.id });
      orgId = org.id;
      result = "created";
    }
    const [m] = await tx
      .select({ id: schema.memberships.id, role: schema.memberships.role, active: schema.memberships.active })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, admin.id)));
    if (!m) await tx.insert(schema.memberships).values({ organizationId: orgId, userId: admin.id, role: "owner" });
    else if (!m.active || m.role !== "owner") await tx.update(schema.memberships).set({ active: true, role: "owner" }).where(eq(schema.memberships.id, m.id));
    if (result === "created") {
      await seedDemoPracticeData(tx, orgId, admin.id);
      await tx.insert(schema.auditLog).values({ organizationId: orgId, userId: admin.id, action: "bootstrap.demo_practice", entity: "organization", entityId: orgId, meta: { created: true } });
    } else if (!m || !m.active || m.role !== "owner") {
      await tx.insert(schema.auditLog).values({ organizationId: orgId, userId: admin.id, action: "bootstrap.demo_membership", entity: "organization", entityId: orgId, meta: {} });
    }
    return result;
  });
}

/** Führt alle Schritte aus. Wirft BootstrapError bei ungültiger Konfiguration. */
export async function runBootstrap(db: Db, env: Env = process.env): Promise<BootstrapResult> {
  const warnings: string[] = [];
  const admin = await bootstrapAdmin(db, env, warnings);
  const practice = await bootstrapPractice(db, env, warnings);
  const demo = await bootstrapDemo(db, env, warnings);
  return { admin, ...practice, demo, warnings };
}

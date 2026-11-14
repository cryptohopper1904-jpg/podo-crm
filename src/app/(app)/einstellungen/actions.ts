"use server";

import { log } from "@/lib/log";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { memberships, organizations, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { requireAuth, revokeUserSessions } from "@/lib/auth/session";
import { generateTotpSecret, matchTotpStep } from "@/lib/auth/totp";
import { parseMoney } from "@/lib/format";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { seatCounts, seatProblem } from "@/lib/plans";
import { usedSeats } from "@/server/billing";
import { isValidBic, isValidIban, normalizeBic, normalizeIban } from "@/lib/epc-qr";
import { BOOKING_CHANNELS, LIMITS as DOC_LIMITS, MAX_DUE_DAYS } from "@/lib/practice-documents";
import { LOGO_KINDS, LogoError, removeLogo, uploadLogo } from "@/server/practice-logos";
import { setBillingMode } from "@/server/features";
import {
  createServiceCategory,
  deleteServiceCategory,
  moveServiceCategory,
  moveServicesToCategory,
  releaseArchivedCodes,
  renameServiceCategory,
  saveService,
  ServiceCatalogError,
  setServiceActive,
} from "@/server/service-catalog";
import { dunningSettingsInput, saveDunningSettings } from "@/server/dunning";
import { DUNNING_STAGES } from "@/lib/dunning";
import { isClosedWeek, validateWeek, weekSummary, weekToList } from "@/lib/opening-hours";
import { DEFAULT_PROFESSION_STATE, DEFAULT_REGULATIONS, isKnownLegalForm, isKnownProfession, registerApplicable, requiresRegister } from "@/lib/imprint";
import { AI_PROVIDER_MAX, aiCountry, aiReplySettings } from "@/lib/ai-replies";
import { avvReacceptance, LEGAL_VERSIONS, storedLegalAcceptance } from "@/lib/legal";

export type SettingsState = { error?: string; ok?: string; secret?: string } | undefined;
const opt = z.string().trim().max(300).optional().transform((v) => v || null);

export async function savePracticeAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const d = z
    .object({
      name: z.string().trim().min(2),
      legalName: opt, street: opt, zip: opt, city: opt, phone: opt, email: opt,
      state: z.string().length(2),
      smallBusiness: z.string().optional(),
      materialCost: z.string().optional(),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message };
  const { smallBusiness, materialCost, ...rest } = d.data;
  // settings atomar zusammenführen (||), statt gelesene Einstellungen zurückzuschreiben – sonst überschreibt ein
  // gleichzeitiges Speichern (z. B. Impressum, Fahrten) die Änderung des anderen (AppSec)
  await db
    .update(organizations)
    .set({
      ...rest,
      smallBusiness: smallBusiness === "on",
      settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify({ materialCostCents: parseMoney(materialCost ?? "") ?? 350 })}::jsonb`,
    })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.practice" });
  // Anschrift/Kontakt gehören zum Impressum → Hinweis „Online-Buchung gesperrt“ (Einstellungen, Heute) neu prüfen
  revalidatePath("/einstellungen", "layout");
  revalidatePath("/heute");
  return { ok: "Gespeichert." };
}

/** Einstellungen → Praxis → Impressum (§ 5 DDG): strukturierte Pflichtangaben in settings.imprint (src/lib/imprint.ts). */
export async function saveImprintAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const d = z
    .object({
      owner: z.string().trim().max(200, "Name ist zu lang."),
      professionChoice: z.string().trim().max(120).optional(),
      professionOther: z.string().trim().max(120, "Berufsbezeichnung ist zu lang.").optional(),
      professionState: z.string().trim().max(120).optional(),
      regulations: z.string().trim().max(500, "Berufsrechtliche Regelungen: höchstens 500 Zeichen.").optional(),
      authority: z.string().trim().max(500, "Aufsichtsbehörde: höchstens 500 Zeichen.").optional(),
      legalForm: z.string().trim().max(60).optional().refine((v) => !v || isKnownLegalForm(v), "Bitte eine Rechtsform aus der Liste wählen."),
      registerCourt: z.string().trim().max(120, "Registergericht ist zu lang.").optional(),
      registerNumber: z.string().trim().max(60, "Registernummer ist zu lang.").optional(),
      economicId: z.string().trim().max(40, "Wirtschafts-ID ist zu lang.").optional(),
      dpo: z.string().trim().max(500, "Datenschutzbeauftragte:r: höchstens 500 Zeichen.").optional(),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message };
  const v = d.data;
  const known = isKnownProfession(v.professionChoice ?? "");
  const profession = known ? v.professionChoice! : v.professionChoice ? (v.professionOther ?? "") : "";
  const legalForm = v.legalForm ?? "";
  const registered = requiresRegister(legalForm);
  const imprint = {
    owner: v.owner,
    profession,
    professionState: v.professionState || DEFAULT_PROFESSION_STATE,
    // PodG-Standardtext nur für die Berufsbezeichnungen nach PodG; bei Freitext nur eigene Angaben der Praxis
    regulations: known ? v.regulations || DEFAULT_REGULATIONS : v.regulations === DEFAULT_REGULATIONS ? "" : (v.regulations ?? ""),
    authority: v.authority ?? "",
    legalForm,
    // Pflicht bei registerpflichtiger Rechtsform, ohne Angabe der Rechtsform freiwillig; bei Rechtsform ohne Register
    // (Einzelpraxis, GbR) geleert (Code-Review N3)
    registerCourt: registerApplicable(legalForm) ? (v.registerCourt ?? "") : "",
    registerNumber: registerApplicable(legalForm) ? (v.registerNumber ?? "") : "",
    economicId: v.economicId ?? "",
    dpo: v.dpo ?? "",
  };
  // settings atomar zusammenführen (andere Schlüssel bleiben unverändert)
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify({ imprint })}::jsonb` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.imprint" });
  revalidatePath("/einstellungen", "layout");
  revalidatePath("/heute");
  const incomplete = !imprint.owner || !imprint.profession || (registered && (!imprint.registerCourt || !imprint.registerNumber));
  return { ok: incomplete ? "Gespeichert. Es fehlen noch Pflichtangaben – die Online-Buchung bleibt gesperrt." : "Gespeichert." };
}

/**
 * KI-Antwortvorschläge (Posteingang, Google-Bewertungen) an/aus – Standard aus. Einschalten nur durch die
 * Inhaber:in (Recht M-88-7) mit den Bestätigungen (AVV mit dem KI-Anbieter, Geheimhaltung nach § 203 Abs. 3 und 4
 * StGB, bei Drittland zusätzlich Angemessenheitsbeschluss/Standardvertragsklauseln) sowie Anbieter-Name und Land aus der
 * Liste; beides steht danach in den Datenschutzhinweisen der Online-Buchung. Ausschalten darf jede Person mit
 * settings.manage; dabei verfallen die Bestätigungen (nach erneutem Einschalten neu bestätigen, Recht N-88-7).
 * Nicht per Support-Freigabe: das sind Erklärungen der Praxis.
 */
export async function saveAiRepliesAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  if (auth.support) return { error: "Nur die Praxis selbst kann KI-Antwortvorschläge ein- oder ausschalten." };
  const enable = form.get("enabled") === "on";
  if (enable && auth.role !== "owner") return { error: "KI-Antwortvorschläge einschalten kann nur die Inhaberin bzw. der Inhaber der Praxis." };
  const provider = String(form.get("provider") ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const countryRaw = String(form.get("country") ?? "").trim();
  if (provider.length > AI_PROVIDER_MAX) return { error: `Anbieter: höchstens ${AI_PROVIDER_MAX} Zeichen.` };
  const country = aiCountry(countryRaw);
  const avv = form.get("avvConfirmed") === "on";
  const confidentiality = form.get("confidentialityConfirmed") === "on";
  const transfer = form.get("transferConfirmed") === "on";
  if (enable) {
    if (!provider || !countryRaw) return { error: "Bitte Anbieter und Land des KI-Dienstes angeben." };
    if (!country) return { error: "Bitte das Land der Verarbeitung aus der Liste wählen." };
    if (!avv || !confidentiality) return { error: "Bitte beide Punkte bestätigen (AVV und Geheimhaltung) – sonst bleiben KI-Antwortvorschläge aus." };
    if (!country.euEea && !transfer) {
      return { error: "Für ein Land außerhalb von EU/EWR bitte bestätigen, dass ein Angemessenheitsbeschluss oder Standardvertragsklauseln bestehen." };
    }
  }
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, auth.organization.id));
  const before = aiReplySettings(o?.settings);
  const now = new Date().toISOString();
  const aiReplies = enable
    ? { enabled: true, provider, country: country!.name, avvConfirmed: true, confidentialityConfirmed: true, transferConfirmed: !country!.euEea, at: now, by: auth.user.id }
    : // Anbieter/Land als Vorbelegung behalten, Bestätigungen nicht (gelten nur für die jeweilige Einschaltung)
      { enabled: false, provider: before.provider, country: before.country, avvConfirmed: false, confidentialityConfirmed: false, transferConfirmed: false, at: before.at, by: before.by, offAt: now, offBy: auth.user.id };
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify({ aiReplies })}::jsonb` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({
    organizationId: auth.organization.id,
    userId: auth.user.id,
    action: enable ? "settings.ai_replies.on" : "settings.ai_replies.off",
    meta: enable
      ? { provider, country: country!.name, avvConfirmed: true, confidentialityConfirmed: true, ...(country!.euEea ? {} : { transferConfirmed: true }) }
      : {},
  });
  revalidatePath("/einstellungen/praxis");
  revalidatePath("/posteingang");
  revalidatePath("/bewertungen");
  return { ok: enable ? "KI-Antwortvorschläge eingeschaltet. Die Datenschutzhinweise deiner Buchungsseite nennen jetzt den Anbieter." : "KI-Antwortvorschläge ausgeschaltet." };
}

/**
 * Nachträgliche Zustimmung zur aktuellen AVV durch die Inhaber:in (Hinweis in den Einstellungen). Gespeichert werden
 * Version, Zeitpunkt und Person (organizations.settings.legalAcceptance); erst danach läuft z. B. die automatische
 * Löschung unbestätigter Online-Anfragen (AVV § 3 Nr. 4).
 */
export async function acceptAvvAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  void form;
  const auth = await requireAuth("settings.manage");
  if (auth.role !== "owner" || auth.support) return { error: "Die AVV kann nur die Inhaberin bzw. der Inhaber der Praxis bestätigen." };
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, auth.organization.id));
  const prev = storedLegalAcceptance(o?.settings);
  const legalAcceptance = avvReacceptance(prev, auth.user.id);
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify({ legalAcceptance })}::jsonb` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "legal.avv_accepted", meta: { avv: LEGAL_VERSIONS.avv, previous: prev?.avv ?? null } });
  revalidatePath("/einstellungen", "layout");
  revalidatePath("/heute");
  revalidatePath("/posteingang");
  return { ok: `AVV Version ${LEGAL_VERSIONS.avv} akzeptiert.` };
}

/**
 * Einstellungen → Öffnungszeiten: Zeitfenster je Wochentag (settings.practiceHours, eine Quelle der Wahrheit für
 * Verfügbarkeit, Online-Buchung, KI-Telefon und Website). Der alte Mo–Fr-Bereich (settings.opening) entfällt dabei.
 */
export async function saveOpeningHoursAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("hours") ?? ""));
  } catch {
    return { error: "Öffnungszeiten konnten nicht gelesen werden." };
  }
  const v = validateWeek(raw);
  if (v.error !== undefined) return { error: v.error };
  const list = weekToList(v.week);
  await db
    .update(organizations)
    .set({ settings: sql`(coalesce(${organizations.settings}, '{}'::jsonb) - 'opening') || ${JSON.stringify({ practiceHours: list })}::jsonb` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.opening_hours", meta: { hours: weekSummary(v.week) } });
  revalidatePath("/einstellungen/oeffnungszeiten");
  return { ok: isClosedWeek(v.week) ? "Gespeichert – die Praxis hat derzeit keine Öffnungszeiten." : "Gespeichert." };
}

export async function inviteMemberAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("users.manage");
  const d = z
    .object({
      name: z.string().trim().min(2, "Name fehlt"),
      email: z.string().trim().toLowerCase().email("E-Mail ungültig"),
      role: z.enum(["owner", "therapist", "reception", "trainee", "accountant"]),
      password: z.string(),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message };
  const org = auth.organization.id;
  // Plätze laut Tarif (Vorabprüfung; verbindlich unten in der gesperrten Transaktion)
  const seatPre = seatProblem(auth.billing, await usedSeats(org), d.data.role);
  if (seatPre) return { error: seatPre };
  let [user] = await db.select().from(users).where(eq(users.email, d.data.email));
  if (!user) {
    const p = passwordProblem(d.data.password);
    if (p) return { error: `Startpasswort: ${p}` };
    [user] = await db.insert(users).values({ email: d.data.email, name: d.data.name, passwordHash: await hashPassword(d.data.password) }).returning();
  }
  const [exists] = await db.select().from(memberships).where(and(eq(memberships.organizationId, org), eq(memberships.userId, user.id)));
  if (exists) return { error: "Diese Person ist bereits im Team." };
  const seatErr = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seats:${org}`}))`);
    // Tarif frisch unter der Sperre lesen (nicht auth.billing vom Anfang der Anfrage – sonst Race mit Tarifwechsel)
    const problem = seatProblem(await currentSeatBilling(tx, org), await usedSeats(org, tx), d.data.role);
    if (problem) return problem;
    await tx.insert(memberships).values({ organizationId: org, userId: user.id, role: d.data.role });
    return null;
  });
  if (seatErr) return { error: seatErr };
  await audit({ organizationId: org, userId: auth.user.id, action: "member.add", entity: "user", entityId: user.id, meta: { role: d.data.role } });
  revalidatePath("/einstellungen/team");
  return { ok: `${d.data.name} wurde hinzugefügt. Bitte das Startpasswort sicher übergeben und beim ersten Login ändern lassen.` };
}

async function currentSeatBilling(tx: Tx, org: string) {
  const [o] = await tx.select({ plan: organizations.plan, seats: organizations.seats }).from(organizations).where(eq(organizations.id, org));
  return o ?? { plan: "starter", seats: 1 };
}

export async function updateMemberAction(form: FormData) {
  const auth = await requireAuth("users.manage");
  const org = auth.organization.id;
  const id = z.string().uuid().parse(form.get("id"));
  const role = z.enum(["owner", "therapist", "reception", "trainee", "accountant"]).optional().parse(form.get("role") || undefined);
  const active = form.get("active");
  const [m] = await db.select().from(memberships).where(and(eq(memberships.organizationId, org), eq(memberships.id, id)));
  if (!m || m.userId === auth.user.id) return; // eigene Rolle nicht ändern (Aussperren verhindern)
  const nextRole = role ?? m.role;
  const nextActive = active !== null ? active === "1" : m.active;
  const blocked = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seats:${org}`}))`);
    // Belegt die Person danach (neu) einen Platz? Dann Tarif-Plätze prüfen (z. B. Empfang → Podolog:in)
    const billing = await currentSeatBilling(tx, org);
    const takesSeat = nextActive && seatCounts(nextRole, billing.plan) && !(m.active && seatCounts(m.role, billing.plan));
    if (takesSeat && seatProblem(billing, await usedSeats(org, tx), nextRole)) return true;
    await tx
      .update(memberships)
      .set({ ...(role ? { role } : {}), ...(active !== null ? { active: active === "1" } : {}) })
      .where(and(eq(memberships.organizationId, org), eq(memberships.id, id)));
    return false;
  });
  if (blocked) redirect("/einstellungen/team?plaetze=voll");
  // Deaktiviert: laufende Sitzungen der Person in DIESER Praxis sofort beenden (andere Praxen bleiben unberührt)
  const revokedSessions = m.active && !nextActive ? await revokeUserSessions(m.userId, { organizationId: org }) : 0;
  await audit({ organizationId: org, userId: auth.user.id, action: "member.update", entity: "membership", entityId: id, meta: { role, active, revokedSessions } });
  revalidatePath("/einstellungen/team");
}

export async function saveServiceAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  // Prüfung, Kürzel-Regeln, Verweise und Audit: src/server/service-catalog.ts saveService
  let r: Awaited<ReturnType<typeof saveService>>;
  try {
    r = await saveService(auth, Object.fromEntries([...form.entries()].filter(([, v]) => v !== "")));
  } catch (e) {
    log.error("service.save_failed", { error: e });
    return { error: "Speichern hat nicht geklappt – bitte erneut versuchen." };
  }
  if ("error" in r) return { error: r.error };
  revalidatePath("/einstellungen/leistungen");
  return { ok: "Gespeichert." };
}

/**
 * Leistung archivieren bzw. wiederherstellen (services.active). Archivierte Leistungen erscheinen nicht mehr in
 * Termin-, Rechnungs- und Doku-Auswahl, Online-Buchung und Website; bestehende Termine/Rechnungen behalten sie.
 * Archivieren gibt das Kürzel frei („AN“ → „AN_archiv“); ist es beim Wiederherstellen vergeben, erscheint ein Hinweis.
 */
export async function setServiceActiveAction(form: FormData) {
  const auth = await requireAuth("settings.manage");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return;
  const active = form.get("active") === "1";
  const back = String(form.get("back") ?? "");
  let r: Awaited<ReturnType<typeof setServiceActive>>;
  try {
    r = await setServiceActive(auth, id.data, active);
  } catch (e) {
    if (!(e instanceof ServiceCatalogError)) throw e;
    // z. B. alle Archiv-Kürzel belegt: feste Meldung über einen Schlüssel (kein freier Text in der URL)
    const qs = new URLSearchParams(back.replace(/^\?/, ""));
    qs.set("fehler", "archiv-kuerzel");
    qs.set("edit", id.data);
    redirect(`/einstellungen/leistungen?${qs}`);
  }
  revalidatePath("/einstellungen/leistungen");
  // Hinweis nur als fester Schlüssel – das betroffene Kürzel ermittelt die Seite selbst aus der DB
  if (r?.codeConflict || r?.codeInvalid !== undefined) {
    const qs = new URLSearchParams(back.replace(/^\?/, ""));
    qs.set("hinweis", r.codeConflict ? "kuerzel-belegt" : "kuerzel-ungueltig");
    qs.set("edit", id.data);
    redirect(`/einstellungen/leistungen?${qs}`);
  }
}

/** Kürzel früher archivierter Leistungen freigeben (Hinweis in der Archiv-Ansicht) */
export async function releaseArchivedCodesAction(form: FormData) {
  const auth = await requireAuth("settings.manage");
  const back = String(form.get("back") ?? "");
  const r = await releaseArchivedCodes(auth);
  revalidatePath("/einstellungen/leistungen");
  const qs = new URLSearchParams(back.replace(/^\?/, ""));
  qs.set("freigegeben", String(r.released));
  if (r.skipped) qs.set("uebersprungen", String(r.skipped));
  redirect(`/einstellungen/leistungen?${qs}`);
}

// ── Kategorien der Leistungen ──
export type CategoryState = { error?: string; ok?: string } | undefined;
const KAT_PATH = "/einstellungen/leistungen/kategorien";

async function categoryCall(fn: () => Promise<unknown>, ok: string): Promise<CategoryState> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ServiceCatalogError) return { error: e.message };
    if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? "Eingaben prüfen." };
    throw e;
  }
  revalidatePath(KAT_PATH);
  revalidatePath("/einstellungen/leistungen");
  return { ok };
}

export async function createCategoryAction(_: CategoryState, form: FormData): Promise<CategoryState> {
  const auth = await requireAuth("settings.manage");
  return categoryCall(() => createServiceCategory(auth, { name: form.get("name"), kind: form.get("kind") || undefined }), "Kategorie angelegt.");
}

export async function renameCategoryAction(_: CategoryState, form: FormData): Promise<CategoryState> {
  const auth = await requireAuth("settings.manage");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Kategorie nicht gefunden." };
  return categoryCall(() => renameServiceCategory(auth, id.data, form.get("name")), "Umbenannt.");
}

export async function moveCategoryAction(form: FormData) {
  const auth = await requireAuth("settings.manage");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return;
  await moveServiceCategory(auth, id.data, form.get("dir") === "up" ? -1 : 1);
  revalidatePath(KAT_PATH);
  revalidatePath("/einstellungen/leistungen");
}

export async function moveServicesAction(_: CategoryState, form: FormData): Promise<CategoryState> {
  const auth = await requireAuth("settings.manage");
  const from = z.uuid().safeParse(form.get("id"));
  const to = z.uuid().safeParse(form.get("to"));
  if (!from.success || !to.success) return { error: "Bitte eine Ziel-Kategorie wählen." };
  return categoryCall(() => moveServicesToCategory(auth, from.data, to.data), "Leistungen verschoben.");
}

export async function deleteCategoryAction(_: CategoryState, form: FormData): Promise<CategoryState> {
  const auth = await requireAuth("settings.manage");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Kategorie nicht gefunden." };
  return categoryCall(() => deleteServiceCategory(auth, id.data), "Kategorie gelöscht.");
}

export async function startTotpAction(): Promise<SettingsState> {
  const auth = await requireAuth();
  if (auth.user.totpEnabled) return { error: "2FA ist bereits aktiv." };
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecretEnc: encryptSecret(secret), totpEnabled: false }).where(eq(users.id, auth.user.id));
  return { secret };
}

export async function confirmTotpAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth();
  const [u] = await db.select().from(users).where(eq(users.id, auth.user.id));
  if (!u.totpSecretEnc) return { error: "Bitte zuerst einrichten." };
  const step = matchTotpStep(decryptSecret(u.totpSecretEnc), String(form.get("code") ?? ""));
  if (step === null) return { error: "Code stimmt nicht." };
  await db.update(users).set({ totpEnabled: true, totpLastStep: step }).where(eq(users.id, auth.user.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "2fa.enabled" });
  revalidatePath("/einstellungen/sicherheit");
  return { ok: "Zwei-Faktor-Anmeldung ist aktiv." };
}

export async function changePasswordAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth();
  const [u] = await db.select().from(users).where(eq(users.id, auth.user.id));
  if (!(await verifyPassword(u.passwordHash, String(form.get("current") ?? "")))) return { error: "Aktuelles Passwort stimmt nicht." };
  const next = String(form.get("next") ?? "");
  const p = passwordProblem(next);
  if (p) return { error: p };
  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, auth.user.id));
  // Alle anderen Sitzungen beenden (z. B. auf einem verlorenen Gerät); die aktuelle bleibt bestehen
  const revokedSessions = await revokeUserSessions(auth.user.id, { exceptSessionId: auth.sessionId });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "password.changed", meta: { revokedSessions } });
  return { ok: "Passwort geändert." };
}

/** Weak PINs, die leicht zu erraten sind (gleiche Ziffern, auf-/absteigende Folgen) */
const COMMON_PINS = new Set(["1212", "2580", "0815", "4711", "1004", "2000", "6969", "1122", "1313", "2468", "1357", "0007", "123123", "112233", "121212", "696969"]);
const weakPin = (pin: string) =>
  /^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin) || COMMON_PINS.has(pin) || /^(19|20)\d{2}$/.test(pin);

/** Entsperr-PIN für den Übergabe-Modus setzen oder entfernen (nur eigenes Konto, mit Passwort bestätigt). */
export async function setUnlockPinAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth();
  const [u] = await db.select().from(users).where(eq(users.id, auth.user.id));
  if (!(await verifyPassword(u.passwordHash, String(form.get("current") ?? "")))) return { error: "Passwort stimmt nicht." };
  if (form.get("remove") === "1") {
    await db.update(users).set({ unlockPinHash: null }).where(eq(users.id, auth.user.id));
    await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "unlock_pin.removed" });
    return { ok: "PIN entfernt – Entsperren geht jetzt nur mit dem Passwort." };
  }
  const pin = String(form.get("pin") ?? "");
  if (!/^\d{4,8}$/.test(pin)) return { error: "Die PIN muss aus 4 bis 8 Ziffern bestehen." };
  if (weakPin(pin)) return { error: "Bitte keine leicht zu erratende PIN (z. B. 1111 oder 1234)." };
  await db.update(users).set({ unlockPinHash: await hashPassword(pin) }).where(eq(users.id, auth.user.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "unlock_pin.set" });
  return { ok: "PIN gespeichert." };
}

/**
 * 2FA-Pflicht für alle Rollen der Praxis (Gesamt-Review H1). Inhaber:innen haben immer Pflicht-2FA;
 * hier legt die Inhaber:in fest, ob auch Team-Mitglieder sie brauchen (src/lib/auth/two-factor.ts).
 */
export async function saveSecurityPolicyAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("users.manage");
  const require2faAllRoles = form.get("require2faAllRoles") === "on";
  await db
    .update(organizations)
    .set({ settings: sql`${organizations.settings} || jsonb_build_object('security', coalesce(${organizations.settings}->'security', '{}'::jsonb) || jsonb_build_object('require2faAllRoles', ${require2faAllRoles}::boolean))` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "security.2fa_policy", meta: { require2faAllRoles } });
  revalidatePath("/einstellungen/sicherheit");
  return { ok: require2faAllRoles ? "Zwei-Faktor-Anmeldung ist jetzt für das ganze Team Pflicht." : "Zwei-Faktor-Anmeldung ist nur für Inhaber:innen Pflicht." };
}

/** Praxis-Modus „nur Privat-/Selbstzahler“ (src/lib/features.ts) – nur settings.manage, protokolliert. */
export async function saveBillingModeAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const mode = form.get("privateOnly") === "on" ? "private_only" : "with_gkv";
  await setBillingMode(auth, mode, "settings");
  revalidatePath("/", "layout");
  return { ok: mode === "private_only" ? "Gespeichert – Kassen-Themen sind jetzt ausgeblendet." : "Gespeichert – Kassen-Themen sind wieder sichtbar." };
}

/** Bankverbindung und Steuerangaben für Rechnungen (Fußzeile, GiroCode) – nur settings.manage, protokolliert. */
export async function saveBankTaxAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const d = z
    .object({ accountHolder: opt, iban: opt, bic: opt, bankName: opt, taxNumber: opt, vatId: opt })
    .safeParse(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")));
  if (!d.success) return { error: d.error.issues[0]?.message };
  const v = d.data;
  if (v.iban && !isValidIban(v.iban)) return { error: "Die IBAN ist ungültig (Prüfziffer oder Länge stimmt nicht)." };
  if (v.bic && !isValidBic(v.bic)) return { error: "Die BIC ist ungültig (8 oder 11 Zeichen, z. B. COBADEFFXXX)." };
  const values = { ...v, iban: v.iban ? normalizeIban(v.iban) : null, bic: v.bic ? normalizeBic(v.bic) : null };
  await db.update(organizations).set(values).where(eq(organizations.id, auth.organization.id));
  // nur, WAS geändert wurde – keine Kontodaten im Protokoll
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.bank_tax", meta: { iban: !!values.iban, bic: !!values.bic, bankName: !!values.bankName, accountHolder: !!values.accountHolder, taxNumber: !!values.taxNumber, vatId: !!values.vatId } });
  revalidatePath("/einstellungen/praxis");
  return { ok: "Gespeichert." };
}

const httpUrl = z
  .string()
  .trim()
  .max(DOC_LIMITS.url)
  .optional()
  .transform((v) => v || null)
  .refine((v) => !v || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v), "Bitte einen vollständigen Link mit https:// angeben.");

/** Belege: Website, Berufsbezeichnung (Fußzeile), WhatsApp-Hinweis, Buchungsweg auf Rechnungen. */
export async function saveDocumentsAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const d = z
    .object({
      websiteUrl: httpUrl,
      dueDays: z.preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
        z.coerce.number({ error: "Bitte ein Zahlungsziel in Tagen angeben (0 = sofort)." }).int("Zahlungsziel: ganze Tage").min(0, "Zahlungsziel: mindestens 0 Tage").max(MAX_DUE_DAYS, `Zahlungsziel: höchstens ${MAX_DUE_DAYS} Tage`),
      ),
      qualification: z.string().trim().max(DOC_LIMITS.qualification, "Berufsbezeichnung: höchstens 200 Zeichen").optional().transform((v) => v || null),
      whatsapp: z.string().optional(),
      therapeuticDefault: z.string().optional(),
      bookingChannel: z.enum(BOOKING_CHANNELS).default("none"),
      doctolibUrl: httpUrl,
      customUrl: httpUrl,
      customLabel: z.string().trim().max(DOC_LIMITS.bookingLabel, "Beschriftung: höchstens 60 Zeichen").optional().transform((v) => v || null),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message };
  const v = d.data;
  if (v.bookingChannel === "doctolib" && !v.doctolibUrl) return { error: "Bitte den Doctolib-Link deiner Praxis angeben." };
  if (v.bookingChannel === "custom" && !v.customUrl) return { error: "Bitte den Buchungslink angeben." };
  const booking =
    v.bookingChannel === "doctolib"
      ? { channel: "doctolib", url: v.doctolibUrl }
      : v.bookingChannel === "custom"
        ? { channel: "custom", url: v.customUrl, ...(v.customLabel ? { label: v.customLabel } : {}) }
        : { channel: v.bookingChannel };
  const documents = { dueDays: v.dueDays, therapeuticDefault: v.therapeuticDefault === "on", qualification: v.qualification, whatsapp: v.whatsapp === "on", booking };
  await db
    .update(organizations)
    .set({
      settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('documents', ${JSON.stringify(documents)}::jsonb, 'websiteUrl', ${v.websiteUrl}::text)`,
    })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.documents", meta: { dueDays: v.dueDays, therapeuticDefault: documents.therapeuticDefault, bookingChannel: v.bookingChannel, whatsapp: documents.whatsapp, qualification: !!v.qualification, website: !!v.websiteUrl } });
  revalidatePath("/einstellungen/praxis");
  return { ok: "Gespeichert." };
}

/** Mahnwesen: Fristen, Gebühren (nur konkrete Kosten) und Textvorlagen je Stufe – nur settings.manage, protokolliert. */
export async function saveDunningSettingsAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const stages: Record<string, unknown> = {};
  for (const s of DUNNING_STAGES) {
    const feeRaw = String(form.get(`${s}.fee`) ?? "").trim();
    const fee = feeRaw === "" ? 0 : parseMoney(feeRaw);
    if (fee === null) return { error: "Gebühr: bitte einen Betrag wie 2,50 angeben." };
    stages[s] = { days: form.get(`${s}.days`), feeCents: fee, text: String(form.get(`${s}.text`) ?? "") };
  }
  const d = dunningSettingsInput.safeParse({ payDays: form.get("payDays"), stages });
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben prüfen." };
  await saveDunningSettings(auth, d.data);
  revalidatePath("/einstellungen/praxis");
  revalidatePath("/rechnungen/mahnungen");
  return { ok: "Gespeichert." };
}

/** Logo hochladen (kompakt oder vollständig) – PNG/JPEG bis 1 MB, verschlüsselt gespeichert. */
export async function uploadLogoAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const auth = await requireAuth("settings.manage");
  const kind = z.enum(LOGO_KINDS).safeParse(form.get("kind"));
  const file = form.get("file");
  if (!kind.success) return { error: "Ungültige Anfrage." };
  if (!(file instanceof File) || !file.size) return { error: "Bitte eine Bilddatei auswählen." };
  if (file.size > 1024 * 1024) return { error: "Das Logo ist zu groß (höchstens 1 MB)." };
  try {
    await uploadLogo(auth, kind.data, Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    if (e instanceof LogoError) return { error: e.message };
    throw e;
  }
  revalidatePath("/einstellungen/praxis");
  return { ok: "Logo gespeichert." };
}

export async function removeLogoAction(form: FormData) {
  const auth = await requireAuth("settings.manage");
  const kind = z.enum(LOGO_KINDS).parse(form.get("kind"));
  await removeLogo(auth, kind);
  revalidatePath("/einstellungen/praxis");
}

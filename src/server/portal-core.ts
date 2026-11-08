import "server-only";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { appointmentServices, appointments, invoices, messages, organizations, patientLinks, patients, payments, services, vouchers } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { dateDe, timeDe } from "@/lib/format";
import { voucherBalance } from "@/lib/invoice-math";
import {
  canCancelOnline,
  hashPortalToken,
  invoiceVisibleInPortal,
  isPortalToken,
  newPortalToken,
  PORTAL_DAYS,
  PORTAL_PURPOSE,
  portalLinkValid,
  type PortalLink,
} from "@/lib/portal";
import { createRateLimiter } from "@/lib/rate-limit";
import { invoicePdfForOrg } from "./invoice-delivery";

/** Drosselung je IP: Seitenaufrufe/Downloads und (strenger) ungültige Tokens. */
export const portalLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 60 });
export const portalFailLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 10 });

/** Praxis erzeugt einen Portal-Link (30 Tage). Ältere Portal-Links der Person werden widerrufen. */
export async function createPortalLink(auth: AuthContext, patientId: string) {
  assertCan(auth, "patients.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(patientId).success) throw new Error("Person nicht gefunden.");
  const [p] = await withOrg(org, (tx) => tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId), isNull(patients.archivedAt))));
  if (!p) throw new Error("Person nicht gefunden.");
  const token = newPortalToken();
  const expiresAt = new Date(Date.now() + PORTAL_DAYS * 86400_000);
  // patient_links hat keine RLS (Zugriff nur über den Token-Hash) → Mandant immer explizit setzen/filtern
  await db.transaction(async (tx) => {
    await tx
      .update(patientLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(patientLinks.organizationId, org), eq(patientLinks.patientId, patientId), eq(patientLinks.purpose, PORTAL_PURPOSE), isNull(patientLinks.revokedAt)));
    await tx.insert(patientLinks).values({ organizationId: org, patientId, purpose: PORTAL_PURPOSE, tokenHash: hashPortalToken(token), expiresAt, createdBy: auth.user.id });
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "portal.link_create", entity: "patient", entityId: patientId, meta: { expiresAt: expiresAt.toISOString() } });
  const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  return { url: `${base}/portal/${token}`, expiresAt };
}

/** Token → gültiger Link (nur über den Hash, ohne RLS); danach wird mit withOrg(link.organizationId) gearbeitet. */
export async function resolvePortalLink(token: string): Promise<(PortalLink & { id: string }) | null> {
  if (!isPortalToken(token)) return null;
  const [row] = await db
    .select({ id: patientLinks.id, organizationId: patientLinks.organizationId, patientId: patientLinks.patientId, purpose: patientLinks.purpose, expiresAt: patientLinks.expiresAt, revokedAt: patientLinks.revokedAt, usedAt: patientLinks.usedAt })
    .from(patientLinks)
    .where(eq(patientLinks.tokenHash, hashPortalToken(token)))
    .limit(1);
  if (!portalLinkValid(row)) return null;
  if (!row.usedAt) await db.update(patientLinks).set({ usedAt: new Date() }).where(eq(patientLinks.id, row.id));
  return row;
}

export type PortalView = NonNullable<Awaited<ReturnType<typeof loadPortalView>>>;

/** Daten für die Portalseite – bewusst sparsam: Vorname, künftige Termine, offene Rechnungen, Gutscheinguthaben. */
export async function loadPortalView(link: PortalLink & { id: string }) {
  const org = link.organizationId;
  const [o] = await db.select({ name: organizations.name, phone: organizations.phone, email: organizations.email }).from(organizations).where(eq(organizations.id, org));
  if (!o) return null;
  const data = await withOrg(org, async (tx) => {
    const [p] = await tx.select({ firstName: patients.firstName, archivedAt: patients.archivedAt }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, link.patientId)));
    if (!p || p.archivedAt) return null;
    const appts = await tx
      .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.patientId, link.patientId), gte(appointments.startsAt, new Date()), inArray(appointments.status, ["planned", "confirmed"])))
      .orderBy(asc(appointments.startsAt))
      .limit(20);
    const svc = appts.length
      ? await tx
          .select({ appointmentId: appointmentServices.appointmentId, name: services.name })
          .from(appointmentServices)
          .innerJoin(services, eq(services.id, appointmentServices.serviceId))
          .where(and(eq(appointmentServices.organizationId, org), inArray(appointmentServices.appointmentId, appts.map((a) => a.id))))
      : [];
    const invs = await tx
      .select({ id: invoices.id, number: invoices.number, kind: invoices.kind, issuedAt: invoices.issuedAt, dueAt: invoices.dueAt, totalCents: invoices.totalCents, paidCents: invoices.paidCents, paymentLinkUrl: invoices.paymentLinkUrl })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), eq(invoices.patientId, link.patientId), inArray(invoices.status, ["issued", "partially_paid"])))
      .orderBy(asc(invoices.issuedAt));
    // Gutscheine der Person = über eine ihrer Rechnungen verkauft
    const vs = await tx
      .select({ id: vouchers.id, code: vouchers.code, amountCents: vouchers.amountCents, validUntil: vouchers.validUntil })
      .from(vouchers)
      .innerJoin(invoices, eq(invoices.id, vouchers.soldInvoiceId))
      .where(and(eq(vouchers.organizationId, org), eq(invoices.patientId, link.patientId)));
    const used = vs.length
      ? await tx
          .select({ voucherId: payments.voucherId, amountCents: payments.amountCents })
          .from(payments)
          .where(and(eq(payments.organizationId, org), inArray(payments.voucherId, vs.map((v) => v.id))))
      : [];
    return {
      firstName: p.firstName,
      appointments: appts.map((a) => ({ ...a, services: svc.filter((s) => s.appointmentId === a.id).map((s) => s.name), cancellable: canCancelOnline(a.startsAt) })),
      invoices: invs.filter((i) => i.totalCents - i.paidCents > 0),
      vouchers: vs
        .map((v) => ({ code: v.code, validUntil: v.validUntil, balanceCents: voucherBalance(v.amountCents, used.filter((u) => u.voucherId === v.id)) }))
        .filter((v) => v.balanceCents > 0),
    };
  });
  if (!data) return null;
  await audit({ organizationId: org, action: "portal.view", entity: "patient", entityId: link.patientId });
  return { practice: o, ...data };
}

/** PDF für das Portal – nur, wenn die Rechnung der Person des Links gehört. */
export async function portalInvoicePdf(link: PortalLink, invoiceId: string) {
  if (!z.uuid().safeParse(invoiceId).success) return null;
  const [inv] = await withOrg(link.organizationId, (tx) =>
    tx
      .select({ organizationId: invoices.organizationId, patientId: invoices.patientId, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.organizationId, link.organizationId), eq(invoices.id, invoiceId))),
  );
  if (!invoiceVisibleInPortal(inv, link)) return null;
  const pdf = await invoicePdfForOrg(link.organizationId, invoiceId, { patientId: link.patientId });
  if (!pdf) return null;
  await audit({ organizationId: link.organizationId, action: "portal.invoice_pdf", entity: "invoice", entityId: invoiceId });
  return pdf;
}

export type PortalCancelResult = { ok: true; message: string } | { ok: false; error: string; phone?: string | null };

/** Absage durch die Person: ≥ 24 h vorher → Status „abgesagt“ + Nachricht im Posteingang; sonst Telefonnummer zeigen. */
export async function cancelPortalAppointment(link: PortalLink, appointmentId: string): Promise<PortalCancelResult> {
  const org = link.organizationId;
  const [o] = await db.select({ phone: organizations.phone }).from(organizations).where(eq(organizations.id, org));
  if (!z.uuid().safeParse(appointmentId).success) return { ok: false, error: "Termin nicht gefunden." };
  const res = await withOrg(org, async (tx) => {
    const [a] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, appointmentId), eq(appointments.patientId, link.patientId)))
      .for("update");
    if (!a || (a.status !== "planned" && a.status !== "confirmed")) return { ok: false as const, error: "Termin nicht gefunden oder bereits abgesagt." };
    if (!canCancelOnline(a.startsAt)) return { ok: false as const, error: "Eine Online-Absage ist nur bis 24 Stunden vor dem Termin möglich. Bitte rufen Sie uns an.", phone: o?.phone ?? null };
    await tx.update(appointments).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(appointments.organizationId, org), eq(appointments.id, a.id)));
    await tx.insert(messages).values({
      organizationId: org,
      patientId: link.patientId,
      channel: "none",
      direction: "inbound",
      subject: "Terminabsage über das Kundenportal",
      body: `Der Termin am ${dateDe(a.startsAt)} um ${timeDe(a.startsAt)} Uhr wurde über das Kundenportal abgesagt (${new Date().toISOString()}).`,
      status: "new",
      threadKey: `portal:${link.patientId}`,
    });
    return { ok: true as const, message: `Ihr Termin am ${dateDe(a.startsAt)} um ${timeDe(a.startsAt)} Uhr wurde abgesagt.` };
  });
  if (res.ok) await audit({ organizationId: org, action: "portal.appointment_cancel", entity: "appointment", entityId: appointmentId });
  return res;
}

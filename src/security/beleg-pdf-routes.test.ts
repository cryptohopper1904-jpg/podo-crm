/**
 * PDF-Routen des Beleg-Archivs: fehlt das archivierte PDF noch (ArchivePendingError), antworten Praxis- und
 * Portal-Route mit 503 + Retry-After – für den Browser als freundliche Hinweisseite statt roher JSON-Daten, für
 * andere Aufrufer als JSON. Die angemeldete Person wird an das Nachholen übergeben (Audit). Auth/Server gemockt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const getAuth = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getAuth: () => getAuth(), requestMeta: async () => ({ ip: "203.0.113.9", userAgent: "test" }) }));
vi.mock("@/lib/auth/access", () => ({ downloadAllowed: () => true, SUPPORT_DOWNLOAD_DENIED: "nein" }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/document-archive", () => {
  class ArchiveIntegrityError extends Error {}
  class ArchivePendingError extends ArchiveIntegrityError {
    constructor() {
      super("Das PDF dieses Belegs wird gerade erzeugt – bitte in einer Minute erneut versuchen.");
    }
  }
  return { ArchiveIntegrityError, ArchivePendingError };
});
const invoicePdfForOrg = vi.fn();
vi.mock("@/server/invoice-delivery", () => ({
  invoicePdfForOrg: (...a: unknown[]) => invoicePdfForOrg(...a),
  pdfResponseHeaders: (f: string) => ({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${f}"` }),
}));
const paymentReceiptPdfForOrg = vi.fn();
vi.mock("@/server/payment-receipts", () => ({ paymentReceiptPdfForOrg: (...a: unknown[]) => paymentReceiptPdfForOrg(...a) }));
const portalInvoicePdf = vi.fn();
vi.mock("@/server/portal-core", () => ({
  currentPortalLink: async () => ({ organizationId: "o1", patientId: "p1" }),
  portalFailLimiter: { exceeded: () => false, limited: () => false },
  portalLimiter: { limited: () => false },
  portalInvoicePdf: (...a: unknown[]) => portalInvoicePdf(...a),
}));

const { ArchivePendingError } = await import("@/server/document-archive");
const invoiceRoute = await import("@/app/api/invoices/[id]/pdf/route");
const receiptRoute = await import("@/app/api/invoices/[id]/zahlungsbelege/[receiptId]/pdf/route");
const portalRoute = await import("@/app/portal/rechnung/[id]/route");

const INV = "11111111-1111-4111-8111-111111111111";
const ZB = "22222222-2222-4222-8222-222222222222";
const req = (path: string, accept: string) => new NextRequest(`https://praxis.example${path}`, { headers: { accept } });
const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) }) as never;
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("Beleg-PDF-Routen: PDF noch nicht archiviert", () => {
  beforeEach(() => {
    getAuth.mockReset();
    getAuth.mockResolvedValue({ user: { id: "u1" }, organization: { id: "o1" }, can: () => true });
    invoicePdfForOrg.mockReset();
    paymentReceiptPdfForOrg.mockReset();
    portalInvoicePdf.mockReset();
  });

  it("Rechnung: 503 + Retry-After; Browser bekommt Hinweisseite mit „Erneut versuchen“, sonst JSON", async () => {
    invoicePdfForOrg.mockRejectedValue(new ArchivePendingError());
    const html = await invoiceRoute.GET(req(`/api/invoices/${INV}/pdf?download=1`, BROWSER), ctx({ id: INV }));
    expect(html.status).toBe(503);
    expect(html.headers.get("retry-after")).toBe("60");
    expect(html.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await html.text();
    expect(body).toContain("PDF wird erzeugt");
    expect(body).toContain("bitte in einer Minute erneut versuchen");
    expect(body).toContain(`href="/api/invoices/${INV}/pdf?download=1"`);
    expect(body).not.toContain('{"error"');
    // die angemeldete Person wird an das Nachholen übergeben (Audit-Eintrag mit Person)
    expect(invoicePdfForOrg).toHaveBeenCalledWith("o1", INV, { original: false, userId: "u1" });

    const json = await invoiceRoute.GET(req(`/api/invoices/${INV}/pdf`, "application/json"), ctx({ id: INV }));
    expect(json.status).toBe(503);
    expect(json.headers.get("retry-after")).toBe("60");
    expect(await json.json()).toEqual({ error: expect.stringContaining("wird gerade erzeugt") });
  });

  it("Zahlungsbeleg: 503 + Retry-After als Hinweisseite; Nutzer-ID ans Nachholen", async () => {
    paymentReceiptPdfForOrg.mockRejectedValue(new ArchivePendingError());
    const r = await receiptRoute.GET(req(`/api/invoices/${INV}/zahlungsbelege/${ZB}/pdf`, BROWSER), ctx({ id: INV, receiptId: ZB }));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await r.text()).toContain("PDF wird erzeugt");
    expect(paymentReceiptPdfForOrg).toHaveBeenCalledWith("o1", INV, ZB, "u1");
  });

  it("Patientenportal: 503 + Retry-After, Portal-Kopfzeilen bleiben (no-referrer, no-store)", async () => {
    portalInvoicePdf.mockRejectedValue(new ArchivePendingError());
    const r = await portalRoute.GET(req(`/portal/rechnung/${INV}`, BROWSER), ctx({ id: INV }));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain("Erneut versuchen");
  });

  it("Hinweisseite: Pfad wird escaped (kein Markup aus der URL)", async () => {
    invoicePdfForOrg.mockRejectedValue(new ArchivePendingError());
    const r = await invoiceRoute.GET(req(`/api/invoices/${INV}/pdf?x="><script>alert(1)</script>`, BROWSER), ctx({ id: INV }));
    const body = await r.text();
    expect(body).not.toContain("<script>alert");
  });
});

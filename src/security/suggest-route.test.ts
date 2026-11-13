/**
 * POST /api/patienten/vorschlaege: Größenbegrenzung des Anfragekörpers (Bytes, vor dem vollständigen Lesen),
 * JSON-Pflicht, Rechteprüfung. Auth und Suche gemockt – geprüft wird nur der Handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getAuth = vi.fn();
const suggestPatients = vi.fn(async () => ({ hits: [], more: false, didYouMean: null }));
vi.mock("@/lib/auth/session", () => ({ getAuth: () => getAuth() }));
vi.mock("@/server/patient-search", () => ({
  suggestLimiter: { limited: () => false },
  suggestPatients: (...a: unknown[]) => suggestPatients(...(a as [])),
}));

const { POST } = await import("@/app/api/patienten/vorschlaege/route");

const URL_ = "https://praxis.example/api/patienten/vorschlaege";
const req = (body: BodyInit | null, h: Record<string, string> = {}) =>
  new NextRequest(URL_, { method: "POST", body, headers: { "content-type": "application/json", ...h }, duplex: "half" } as unknown as ConstructorParameters<typeof NextRequest>[1]);

describe("Vorschlags-Route", () => {
  beforeEach(() => {
    getAuth.mockReset();
    suggestPatients.mockClear();
    getAuth.mockResolvedValue({ user: { id: "u1" }, can: (p: string) => p === "patients.read" });
  });

  it("ohne Anmeldung 401, ohne patients.read 403", async () => {
    getAuth.mockResolvedValueOnce(null);
    expect((await POST(req(JSON.stringify({ q: "Mu" })))).status).toBe(401);
    getAuth.mockResolvedValueOnce({ user: { id: "u1" }, can: () => false });
    expect((await POST(req(JSON.stringify({ q: "Mu" })))).status).toBe(403);
  });

  it("gültige Anfrage → Suche", async () => {
    const r = await POST(req(JSON.stringify({ q: "Muster" })));
    expect(r.status).toBe(200);
    expect(suggestPatients).toHaveBeenCalledOnce();
  });

  it("Content-Length > 1024 → 413 ohne Lesen", async () => {
    const r = await POST(req(JSON.stringify({ q: "Mu" }), { "content-length": "5000" }));
    expect(r.status).toBe(413);
    expect(suggestPatients).not.toHaveBeenCalled();
  });

  it("Körper > 1024 Bytes ohne Content-Length (Stream) → 413", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ q: "x".repeat(2000) }));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big.slice(0, 600));
        c.enqueue(big.slice(600));
        c.close();
      },
    });
    const r = await POST(req(stream));
    expect(r.status).toBe(413);
    expect(suggestPatients).not.toHaveBeenCalled();
  });

  it("Bytes statt Zeichen: 400 Umlaute (800 Bytes) gehen, 600 (1200 Bytes) nicht", async () => {
    const body = (n: number) => JSON.stringify({ q: "ä".repeat(n) });
    expect((await POST(req(body(400)))).status).toBe(200); // Suchtext zu lang → leere Antwort, aber kein 413
    expect((await POST(req(body(600)))).status).toBe(413);
  });

  it("kein JSON → 415", async () => {
    expect((await POST(req("q=Mu", { "content-type": "application/x-www-form-urlencoded" }))).status).toBe(415);
  });
});

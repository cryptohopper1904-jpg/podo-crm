/** /api/voice/[provider]: fail closed (Anbieter, org, Verbindung, Secret, Größe), Antwortformat. */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const conn = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const processed = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/server/integrations", () => ({
  loadConnection: vi.fn(async () => conn.current),
  logSync: vi.fn(async () => undefined),
}));
vi.mock("@/server/voice", () => ({
  processVoiceEvent: vi.fn(async (_org: string, _vendor: string, ev: { type: string; calls?: { toolCallId: string }[] }) => {
    processed.events.push(ev);
    return ev.type === "tool_calls" ? ev.calls!.map((c) => ({ toolCallId: c.toolCallId, result: "ok" })) : null;
  }),
}));

import { NextRequest } from "next/server";
import { encryptSecret } from "@/lib/secrets";
import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const SECRET = "s3cr3t-token-value";
const body = JSON.stringify({ message: { type: "tool-calls", call: { id: "c1" }, toolCallList: [{ id: "tc1", type: "function", function: { name: "praxis_info", arguments: {} } }] } });

let ip = 0;
function req(opts: { provider?: string; org?: string | null; secret?: string | null; body?: string; headers?: Record<string, string> } = {}) {
  const url = new URL(`https://praxis.example/api/voice/${opts.provider ?? "vapi"}`);
  if (opts.org !== null) url.searchParams.set("org", opts.org ?? ORG);
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ip % 250}`, ...(opts.headers ?? {}) };
  if (opts.secret !== null) headers["x-vapi-secret"] = opts.secret ?? SECRET;
  const r = new NextRequest(url, { method: "POST", body: opts.body ?? body, headers });
  return POST(r, { params: Promise.resolve({ provider: opts.provider ?? "vapi" }) } as never);
}

describe("POST /api/voice/[provider]", () => {
  beforeEach(() => {
    processed.events = [];
    conn.current = { provider: "voice_agent", status: "connected", config: { vendor: "vapi" }, secretEnc: encryptSecret(JSON.stringify({ webhookToken: SECRET }), ORG), organizationId: ORG };
  });

  it("gültiger Aufruf → Werkzeug-Ergebnisse im Vapi-Format", async () => {
    const res = await req();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ toolCallId: "tc1", result: "ok" }] });
  });

  it("falsches oder fehlendes Secret → 401, nichts verarbeitet", async () => {
    expect((await req({ secret: "falsch" })).status).toBe(401);
    expect((await req({ secret: null })).status).toBe(401);
    expect(processed.events).toHaveLength(0);
  });

  it("ohne hinterlegtes Geheimnis wird immer abgelehnt (auch mit leerem Header)", async () => {
    conn.current = { ...conn.current!, secretEnc: null };
    expect((await req({ secret: "" })).status).toBe(401);
    expect((await req()).status).toBe(401);
  });

  it("Geheimnis einer anderen Praxis passt nicht (AAD = Mandant)", async () => {
    conn.current = { ...conn.current!, secretEnc: encryptSecret(JSON.stringify({ webhookToken: SECRET }), "22222222-2222-4222-8222-222222222222") };
    expect((await req()).status).toBe(401);
  });

  it("unbekannter/nicht umgesetzter Anbieter, ungültige org, getrennte Verbindung, falscher Anbieter → 401", async () => {
    expect((await req({ provider: "retell" })).status).toBe(401);
    expect((await req({ provider: "../webhooks" })).status).toBe(401);
    expect((await req({ org: "nicht-uuid" })).status).toBe(401);
    expect((await req({ org: null })).status).toBe(401);
    conn.current = { ...conn.current!, status: "disconnected" };
    expect((await req()).status).toBe(401);
    conn.current = { ...conn.current!, status: "connected", config: { vendor: "retell" } };
    expect((await req()).status).toBe(401);
    conn.current = null;
    expect((await req()).status).toBe(401);
    expect(processed.events).toHaveLength(0);
  });

  it("Testmodus nur außerhalb von Produktion", async () => {
    conn.current = { ...conn.current!, status: "mock" };
    expect((await req()).status).toBe(200);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await req()).status).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("zu großer Body → 413, kaputtes JSON → 400", async () => {
    expect((await req({ body: "x".repeat(1024 * 1024 + 10) })).status).toBe(413);
    expect((await req({ body: "{kaputt" })).status).toBe(400);
  });

  it("Ende-Bericht → 200 ok", async () => {
    const res = await req({ body: JSON.stringify({ message: { type: "end-of-call-report", call: { id: "c1" }, durationSeconds: 10 } }) });
    expect(await res.json()).toEqual({ ok: true });
    expect(processed.events[0]).toMatchObject({ type: "call_ended", callId: "c1" });
  });

  it("viele Fehlversuche einer IP → 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await req({ secret: "falsch", headers: { "x-forwarded-for": "10.9.9.9" } })).status);
    expect(statuses).toContain(429);
  });
});

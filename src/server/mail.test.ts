/** Serverseite MailPort: Auswahl aus Verbindung/Umgebung, Drosselung je Praxis, Fehler → Audit ohne Passwort. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  conn: null as null | { status: string; config: Record<string, unknown>; secretEnc: string | null },
  audits: [] as { action: string; meta?: Record<string, unknown> }[],
  sync: [] as { ok: boolean; message?: string }[],
  resolved: [] as string[],
}));

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ name: "Testpraxis", email: "info@praxis.example" }] }) }) },
}));
vi.mock("./integrations", () => ({
  loadConnection: async () => (state.conn ? { provider: "email_imap", organizationId: "org-1", ...state.conn } : null),
  logSync: async (_org: string, _p: string, e: { ok: boolean; message?: string }) => {
    state.sync.push(e);
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: async (e: { action: string; meta?: Record<string, unknown> }) => {
    state.audits.push(e);
  },
}));
vi.mock("@/lib/secrets", () => ({ decryptSecret: (s: string) => s }));
vi.mock("@/integrations/net-guard", () => ({
  UnsafeTargetError: class extends Error {},
  resolvePublicAddress: async (h: string) => {
    state.resolved.push(h);
    if (h === "127.0.0.1") throw new Error("intern");
    return "93.184.216.34";
  },
}));

import { MailNotConfiguredError, MailSendError, MockMailAdapter, SmtpMailAdapter } from "@/integrations/mail/mail";
import { _resetMailRateLimit, _setTransportFactory, MAIL_RATE_PER_HOUR, mailMessagingPort, mailPortFor, sendMail } from "./mail";

const PASSWORD = "sehr-geheim-987";
const connected = (host = "smtp.example.org") => ({ status: "connected", config: { smtpHost: host, user: "praxis@example.org" }, secretEnc: JSON.stringify({ password: PASSWORD }) });
const msg = { to: "kundin@example.org", subject: "Hallo", text: "Text" };

describe("server/mail", () => {
  const env = { ...process.env };
  beforeEach(() => {
    state.conn = null;
    state.audits = [];
    state.sync = [];
    _resetMailRateLimit();
    delete process.env.INTEGRATIONS_MODE;
    delete process.env.SMTP_URL;
    delete process.env.SMTP_FROM;
  });
  afterEach(() => {
    process.env = { ...env };
    _setTransportFactory(undefined);
  });

  it("wählt SMTP der Praxis, sonst Plattform, sonst (Entwicklung) Mock", async () => {
    _setTransportFactory(() => ({ sendMail: async () => ({ messageId: "<1@x>" }), verify: async () => true }));
    state.conn = connected();
    const p1 = await mailPortFor("org-1");
    expect(p1).toBeInstanceOf(SmtpMailAdapter);
    expect(p1.source).toBe("org");
    state.conn = null;
    process.env.SMTP_URL = "smtp://mail.example";
    process.env.SMTP_FROM = "noreply@example.org";
    expect((await mailPortFor("org-1")).source).toBe("platform");
    delete process.env.SMTP_URL;
    expect(await mailPortFor("org-1")).toBeInstanceOf(MockMailAdapter);
    process.env.INTEGRATIONS_MODE = "mock";
    state.conn = connected();
    expect(await mailPortFor("org-1")).toBeInstanceOf(MockMailAdapter);
  });

  it("Praxis-SMTP: Host wird einmal aufgelöst, nodemailer verbindet mit der geprüften IP (DNS-Rebinding)", async () => {
    const opts: unknown[] = [];
    _setTransportFactory((o) => {
      opts.push(o);
      return { sendMail: async () => ({ messageId: "<1@x>" }), verify: async () => true };
    });
    state.resolved = [];
    state.conn = connected();
    await mailPortFor("org-1");
    expect(state.resolved).toEqual(["smtp.example.org"]);
    expect(opts[0]).toMatchObject({ host: "93.184.216.34", requireTLS: true, tls: { servername: "smtp.example.org", minVersion: "TLSv1.2" } });
  });

  it("interner SMTP-Host der Praxis wird abgelehnt (SSRF)", async () => {
    state.conn = connected("127.0.0.1");
    await expect(mailPortFor("org-1")).rejects.toBeInstanceOf(MailSendError);
  });

  it("Testmodus: Audit „mail.mock“ ohne Adresse/Inhalt", async () => {
    const r = await sendMail("org-1", msg, { purpose: "test" });
    expect(r.mock).toBe(true);
    expect(state.audits).toEqual([expect.objectContaining({ action: "mail.mock", meta: { purpose: "test", attachments: 0 } })]);
    expect(JSON.stringify(state.audits)).not.toContain("kundin@example.org");
  });

  it("Versandfehler: Audit + Sync-Protokoll mit sicherer Meldung, nie das Passwort", async () => {
    state.conn = connected();
    _setTransportFactory(() => ({
      sendMail: async () => Promise.reject(Object.assign(new Error(`535 auth failed for ${PASSWORD}`), { code: "EAUTH", responseCode: 535 })),
      verify: async () => true,
    }));
    await expect(sendMail("org-1", msg, { purpose: "invoice", entity: "invoice", entityId: "i1" })).rejects.toThrow(/Anmeldung am SMTP-Server/);
    expect(state.audits[0]).toMatchObject({ action: "mail.failed", meta: { purpose: "invoice", code: "EAUTH" } });
    expect(state.sync[0]).toMatchObject({ ok: false });
    expect(JSON.stringify([state.audits, state.sync])).not.toContain(PASSWORD);
  });

  it("nicht eingerichtet (Produktion) → sichtbarer Fehler + Audit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(sendMail("org-1", msg, { purpose: "reminder" })).rejects.toBeInstanceOf(MailNotConfiguredError);
    expect(state.audits[0].action).toBe("mail.failed");
    vi.unstubAllEnvs();
  });

  it(`Drosselung: höchstens ${MAIL_RATE_PER_HOUR} Mails je Praxis und Stunde`, async () => {
    for (let i = 0; i < MAIL_RATE_PER_HOUR; i++) await sendMail("org-1", msg, { purpose: "reminder" });
    await expect(sendMail("org-1", msg, { purpose: "reminder" })).rejects.toThrow(/Zu viele E-Mails/);
    expect(state.audits.at(-1)).toMatchObject({ action: "mail.failed", meta: { code: "RATE_LIMIT" } });
    // andere Praxis ist nicht betroffen
    await expect(sendMail("org-2", msg, { purpose: "reminder" })).resolves.toMatchObject({ mock: true });
  });

  it("MessagingPort-Hülle für Rechnungen/Erinnerungen behält die alte Schnittstelle", async () => {
    const sent: unknown[] = [];
    state.conn = connected();
    _setTransportFactory(() => ({
      sendMail: async (m) => {
        sent.push(m);
        return { messageId: "<42@smtp>" };
      },
      verify: async () => true,
    }));
    const port = await mailMessagingPort("org-1", { purpose: "invoice" });
    expect(port.isMock).toBe(false);
    const r = await port.send({ to: " kundin@example.org ", subject: "Rechnung", body: "Anbei", attachments: [{ filename: "R.pdf", contentType: "application/pdf", data: new Uint8Array([1]) }] });
    expect(r.externalId).toBe("<42@smtp>");
    expect(sent[0]).toMatchObject({ to: "kundin@example.org", subject: "Rechnung", text: "Anbei" });
  });
});

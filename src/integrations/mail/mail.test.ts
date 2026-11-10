/** MailPort: Auswahl des Adapters, SMTP-Adapter mit gemocktem nodemailer-Transport, sichere Fehlermeldungen. */
import { describe, expect, it, vi } from "vitest";
import { formatFrom, parseFrom, mailAdapterFor, safeExtraHeaders, MailNotConfiguredError, MailSendError, MockMailAdapter, parseSmtpUrl, resolveMailSettings, SmtpMailAdapter, smtpTransportOptions, toMailError, type TransportFactory } from "./mail";

const practice = { name: "Testpraxis Fuß", email: "info@praxis.example" };
const PASSWORD = "geheim-Passwort-123";
const orgConn = (status: string, config: Record<string, unknown> = {}, secret: Record<string, string> = { password: PASSWORD }) => ({
  status,
  config: { smtpHost: "smtp.example.org", user: "praxis@example.org", ...config },
  secret,
});

describe("resolveMailSettings (Adapterauswahl)", () => {
  it("INTEGRATIONS_MODE=mock und Verbindung im Testmodus → Mock", () => {
    expect(resolveMailSettings({ connection: orgConn("connected"), env: { INTEGRATIONS_MODE: "mock", SMTP_URL: "smtp://x" }, practice })).toEqual({ kind: "mock", reason: "env_mock" });
    expect(resolveMailSettings({ connection: orgConn("mock"), env: { SMTP_URL: "smtp://x", SMTP_FROM: "a@b.de" }, practice })).toEqual({ kind: "mock", reason: "connection_mock" });
  });

  it("verbundene Praxis-SMTP-Daten haben Vorrang vor dem Plattform-Standard", () => {
    const s = resolveMailSettings({ connection: orgConn("connected", { smtpPort: "465", fromAddress: "rechnung@praxis.example" }), env: { SMTP_URL: "smtp://platform", SMTP_FROM: "noreply@podocrm.example" }, practice });
    expect(s).toMatchObject({ kind: "smtp", source: "org", target: { host: "smtp.example.org", port: 465, secure: true, user: "praxis@example.org" }, from: '"Testpraxis Fuß" <rechnung@praxis.example>', replyTo: "info@praxis.example" });
    const d = resolveMailSettings({ connection: orgConn("connected"), env: {}, practice });
    expect(d).toMatchObject({ kind: "smtp", target: { port: 587, secure: false }, from: '"Testpraxis Fuß" <praxis@example.org>' });
  });

  it("unvollständige Praxisdaten → nicht eingerichtet (kein stiller Fallback)", () => {
    expect(resolveMailSettings({ connection: orgConn("connected", {}, {}), env: { SMTP_URL: "smtp://p", SMTP_FROM: "a@b.de" }, practice }).kind).toBe("unconfigured");
    expect(resolveMailSettings({ connection: orgConn("connected", { user: "kein-mail-name" }), env: {}, practice }).kind).toBe("unconfigured");
  });

  it("ohne Praxis-SMTP: Plattform-Standard aus SMTP_URL/SMTP_FROM, Absendername = Praxis", () => {
    const s = resolveMailSettings({ connection: null, env: { SMTP_URL: "smtps://u:p@mail.podocrm.example:465", SMTP_FROM: "noreply@podocrm.example" }, practice: { name: 'Praxis "<Böse>"', email: null } });
    expect(s).toMatchObject({ kind: "smtp", source: "platform", from: '"Praxis Böse" <noreply@podocrm.example>', replyTo: null });
    expect(resolveMailSettings({ connection: orgConn("disconnected"), env: { SMTP_URL: "smtp://x" }, practice }).kind).toBe("unconfigured"); // SMTP_FROM fehlt
  });

  it("gar nichts eingerichtet: Produktion → Fehler, Entwicklung → Mock", () => {
    expect(resolveMailSettings({ connection: null, env: { NODE_ENV: "production" }, practice }).kind).toBe("unconfigured");
    expect(resolveMailSettings({ connection: null, env: { NODE_ENV: "development" }, practice })).toEqual({ kind: "mock", reason: "dev_unconfigured" });
    expect(() => mailAdapterFor({ kind: "unconfigured", reason: "x" })).toThrow(MailNotConfiguredError);
    expect(mailAdapterFor({ kind: "mock", reason: "env_mock" })).toBeInstanceOf(MockMailAdapter);
  });
});

function fakeTransport(impl: { sendMail?: (m: unknown) => Promise<unknown>; verify?: () => Promise<unknown> } = {}) {
  const sent: Record<string, unknown>[] = [];
  const opts: unknown[] = [];
  const factory: TransportFactory = (o) => {
    opts.push(o);
    return {
      sendMail: vi.fn(async (m) => {
        sent.push(m as Record<string, unknown>);
        return ((await impl.sendMail?.(m)) as { messageId?: string }) ?? { messageId: "<abc@smtp.example.org>" };
      }),
      verify: vi.fn(async () => (impl.verify ? impl.verify() : true)),
    };
  };
  return { factory, sent, opts };
}

const orgSettings = resolveMailSettings({ connection: orgConn("connected"), env: {}, practice });
if (orgSettings.kind !== "smtp") throw new Error("setup");

describe("SmtpMailAdapter (nodemailer gemockt)", () => {
  it("baut den Transport mit TLS-Pflicht und sendet Text + Anhang", async () => {
    const t = fakeTransport();
    const port = mailAdapterFor(orgSettings, t.factory);
    expect(port).toBeInstanceOf(SmtpMailAdapter);
    expect(t.opts[0]).toMatchObject({ host: "smtp.example.org", port: 587, secure: false, requireTLS: true, auth: { user: "praxis@example.org", pass: PASSWORD }, tls: { minVersion: "TLSv1.2" } });
    const r = await port.send({ to: "kundin@example.org", subject: "Rechnung\r\nBcc: evil@x.de", text: "Hallo", attachments: [{ filename: "R1.pdf", contentType: "application/pdf", data: new Uint8Array([1, 2, 3]) }] });
    expect(r.messageId).toBe("<abc@smtp.example.org>");
    expect(t.sent[0]).toMatchObject({ from: '"Testpraxis Fuß" <praxis@example.org>', to: "kundin@example.org", replyTo: "info@praxis.example", subject: "Rechnung Bcc: evil@x.de", text: "Hallo" });
    const att = (t.sent[0].attachments as { content: Buffer; filename: string }[])[0];
    expect(att.filename).toBe("R1.pdf");
    expect([...att.content]).toEqual([1, 2, 3]);
  });

  it("Praxis-SMTP: Verbindung zur geprüften IP, Zertifikat/SNI gegen den Hostnamen", () => {
    const t = fakeTransport();
    mailAdapterFor(orgSettings, t.factory, { connectAddress: "93.184.216.34" });
    expect(t.opts[0]).toMatchObject({ host: "93.184.216.34", port: 587, requireTLS: true, tls: { minVersion: "TLSv1.2", servername: "smtp.example.org", rejectUnauthorized: true } });
  });

  it("Plattform-SMTP: SMTP_URL zerlegt, TLS-Pflicht (STARTTLS bzw. implizit) und TLS ≥ 1.2", () => {
    const t = fakeTransport();
    const s = resolveMailSettings({ connection: null, env: { SMTP_URL: "smtp://user%40x:p%3Ass@mail.example.org:2525", SMTP_FROM: "noreply@example.org" }, practice });
    if (s.kind !== "smtp") throw new Error();
    mailAdapterFor(s, t.factory);
    expect(t.opts[0]).toMatchObject({ host: "mail.example.org", port: 2525, secure: false, requireTLS: true, auth: { user: "user@x", pass: "p:ss" }, tls: { minVersion: "TLSv1.2", servername: "mail.example.org" } });
    expect(parseSmtpUrl("smtps://mail.example.org")).toMatchObject({ port: 465, secure: true });
    expect(() => parseSmtpUrl("http://mail.example.org")).toThrow(MailSendError);
    const platform = (url: string) => ({ kind: "smtp" as const, source: "platform" as const, url, from: "a@b.de", replyTo: null });
    // Klartext nur in Entwicklung zu localhost (Mailcatcher) – nie in Produktion
    expect(smtpTransportOptions(platform("smtp://localhost:1025"), { nodeEnv: "development" }).requireTLS).toBe(false);
    expect(smtpTransportOptions(platform("smtp://localhost:1025"), { nodeEnv: "production" }).requireTLS).toBe(true);
    expect(smtpTransportOptions(platform("smtp://mail.example.org"), { nodeEnv: "development" }).requireTLS).toBe(true);
  });

  it("Fehler werden zu sicheren Meldungen – nie mit Passwort oder Server-Antwort", async () => {
    const authErr = Object.assign(new Error(`Invalid login: 535 5.7.8 user praxis@example.org pass ${PASSWORD} rejected`), { code: "EAUTH", responseCode: 535, response: `535 ${PASSWORD}` });
    const t = fakeTransport({ sendMail: async () => Promise.reject(authErr) });
    const port = mailAdapterFor(orgSettings, t.factory);
    const err = await port.send({ to: "kundin@example.org", subject: "x", text: "y" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).message).toBe("Anmeldung am SMTP-Server fehlgeschlagen (Benutzer/Passwort prüfen). (SMTP 535)");
    expect((err as MailSendError).code).toBe("EAUTH");
    expect(JSON.stringify({ m: (err as Error).message, s: String(err) })).not.toContain(PASSWORD);
    expect(toMailError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })).message).toMatch(/Zeitüberschreitung/);
    expect(toMailError(new Error(`connect to smtp://u:${PASSWORD}@h failed`)).message).toBe("E-Mail-Versand fehlgeschlagen.");
    expect(toMailError({ code: "<script>" }).code).toBeNull();
  });

  it("ungültige Empfänger werden vor dem Versand abgelehnt; verify meldet Fehler sicher", async () => {
    const t = fakeTransport({ verify: async () => Promise.reject(Object.assign(new Error("boom"), { code: "ECONNECTION" })) });
    const port = new SmtpMailAdapter(orgSettings, t.factory);
    await expect(port.send({ to: "a@b", subject: "x", text: "y" })).rejects.toThrow(/ungültig/);
    await expect(port.send({ to: "a@b.de, c@d.de", subject: "x", text: "y" })).rejects.toThrow(/ungültig/);
    expect(t.sent).toHaveLength(0);
    await expect(port.verify()).rejects.toThrow(/nicht erreichbar/);
  });
});

describe("MockMailAdapter", () => {
  it("versendet nichts und liefert eine ID", async () => {
    const m = new MockMailAdapter();
    const r = await m.send({ to: "kundin@example.org", subject: "x", text: "y" });
    expect(r.messageId).toMatch(/^mock_mail_/);
    expect(m.sent).toHaveLength(1);
    expect(m.isMock).toBe(true);
  });
});

describe("Plattform-Konto-E-Mails", () => {
  it("SMTP_FROM als „Name <adresse>“ und Plattform-Mails trotz Testmodus der Schnittstellen", () => {
    const env = { INTEGRATIONS_MODE: "mock", SMTP_URL: "smtps://resend:k@smtp.resend.com:465", SMTP_FROM: "PodoHero <noreply@algoverdict.com>" };
    const s = resolveMailSettings({ connection: null, env, practice: { name: "PodoHero", email: null }, platform: true });
    expect(s).toMatchObject({ kind: "smtp", source: "platform", from: '"PodoHero" <noreply@algoverdict.com>' });
    // Praxis-Mails bleiben im Testmodus
    expect(resolveMailSettings({ connection: null, env, practice: { name: "Praxis", email: null } }).kind).toBe("mock");
    expect(parseFrom("kaputt <keine-adresse>")).toBeNull();
    expect(parseFrom("a@b.de")).toEqual({ name: null, address: "a@b.de" });
  });
});


describe("Absender-Überschreibung und Zusatz-Kopfzeilen (Vertrieb)", () => {
  it("nimmt msg.from und nur erlaubte Kopfzeilen ohne Zeilenumbrüche", async () => {
    const t = fakeTransport();
    const port = mailAdapterFor(orgSettings, t.factory);
    await port.send({
      to: "praxis@example.org",
      subject: "Hallo",
      text: "x",
      from: formatFrom('Max "Boss" Muster\r\nBcc: a@b.de', "max@podo.example"),
      headers: { "List-Unsubscribe": "<https://x.example/abmelden/t>\r\nBcc: evil@x.de", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", Bcc: "evil@x.de", From: "evil@x.de" },
    });
    expect(t.sent[0].from).toBe('"Max Boss MusterBcc: a@b.de" <max@podo.example>');
    expect(t.sent[0].headers).toEqual({ "List-Unsubscribe": "<https://x.example/abmelden/t> Bcc: evil@x.de", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });

  it("formatFrom lehnt ungültige Adressen ab, safeExtraHeaders ohne Werte → undefined", () => {
    expect(() => formatFrom("X", "keine-adresse")).toThrow(MailSendError);
    expect(formatFrom("", "a@b.de")).toBe("a@b.de");
    expect(safeExtraHeaders({ Bcc: "x@y.de" })).toBeUndefined();
    expect(safeExtraHeaders(undefined)).toBeUndefined();
  });
});

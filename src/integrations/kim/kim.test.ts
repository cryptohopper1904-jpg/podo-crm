/** KIM: MIME-Parser, POP3-/SMTP-Client gegen In-Memory-Server, Adapter, Mock (nur erfundene Daten). */
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { KimAdapter, KimMock, KIM_MOCK_MESSAGES } from "./kim";
import { decodeEncodedWords, parseHeaderParams, parseMime } from "./mime";
import { assertKimPort, resolvePublic } from "./net";
import { Pop3Client, Pop3Error } from "./pop3";
import { buildMail, SimpleSmtpTransport, type SmtpEnvelope } from "./smtp";
import { attachmentNote, extractKimHints, isValidKvnr, rankSuggestions } from "@/lib/kim-hints";

const CRLF = "\r\n";

const ARZTBRIEF = [
  "Return-Path: <praxis.dr.beispiel@kim-anbieter.example>",
  "From: =?UTF-8?Q?Praxis_Dr=2E_Beispiel?= <praxis.dr.beispiel@kim-anbieter.example>",
  "To: podologie.test@kim-anbieter.example",
  "Subject: =?UTF-8?B?QXJ6dGJyaWVmOiBKw7xyZ2VuIFRlc3Rtw7xsbGVy?=",
  "Date: Mon, 02 Nov 2026 10:15:00 +0100",
  "Message-ID: <abc-123@kim-anbieter.example>",
  "X-KIM-Dienstkennung: eArztbrief;Brief;V1.2",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="XYZ"',
  "",
  "Präambel wird ignoriert",
  "--XYZ",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=iso-8859-1",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Sehr geehrte Damen und Herren,=0D=0Aanbei der Befund f=FCr Herrn J=FCrgen Testm=FCller (KVNR A123456780), geb. 03.04.1951.=",
  " Weiter.",
  "--ALT",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>HTML-Version</p>",
  "--ALT--",
  "--XYZ",
  "Content-Type: application/pdf; name=\"brief.pdf\"",
  "Content-Disposition: attachment; filename*=UTF-8''Arztbrief_M%C3%BCller.pdf",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-1.4 erfundener Inhalt").toString("base64"),
  "--XYZ--",
  "Epilog",
  "",
].join(CRLF);

describe("MIME-Parser", () => {
  it("liest Kopfzeilen, text/plain (Latin-1, QP) und Anhangsnamen", () => {
    const m = parseMime(ARZTBRIEF);
    expect(m.messageId).toBe("abc-123@kim-anbieter.example");
    expect(m.subject).toBe("Arztbrief: Jürgen Testmüller");
    expect(m.from).toBe("Praxis Dr. Beispiel <praxis.dr.beispiel@kim-anbieter.example>");
    expect(m.date?.toISOString()).toBe("2026-11-02T09:15:00.000Z");
    expect(m.kimService).toBe("eArztbrief;Brief;V1.2");
    expect(m.text).toContain("Befund für Herrn Jürgen Testmüller");
    expect(m.text).not.toContain("HTML-Version");
    expect(m.text).not.toContain("Präambel");
    expect(m.attachments).toEqual([{ filename: "Arztbrief_Müller.pdf", contentType: "application/pdf", size: 26 }]);
  });

  it("einfache Mail ohne MIME, HTML-only und kaputte Kodierungen werfen nicht", () => {
    const simple = parseMime("Subject: Hallo\r\nFrom: a@b.example\r\n\r\nNur Text\r\n");
    expect(simple).toMatchObject({ subject: "Hallo", text: "Nur Text", messageId: null, attachments: [] });
    const html = parseMime('Content-Type: text/html; charset="utf-8"\r\n\r\n<div>Zeile 1<br>Zeile &amp; 2</div><script>x()</script>');
    expect(html.text).toBe("Zeile 1\nZeile & 2");
    const broken = parseMime("Content-Type: text/plain; charset=gibtsnicht\r\nContent-Transfer-Encoding: base64\r\n\r\n%%%");
    expect(broken.text).toBe("");
    expect(parseMime("Content-Type: multipart/mixed\r\n\r\nohne boundary").text).toBe("");
  });

  it("Encoded-Words und Parameter", () => {
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Gr=FC=DFe?= =?UTF-8?B?w6TDtg==?=")).toBe("Grüßeäö");
    expect(parseHeaderParams('attachment; filename="a;b.pdf"').params.filename).toBe("a;b.pdf");
    expect(parseHeaderParams("attachment; filename*0=\"teil1\"; filename*1=\"teil2.pdf\"").params.filename).toBe("teil1teil2.pdf");
  });

  it("buildMail → parseMime (Rundreise inkl. Umlaute und Anhang)", () => {
    const { raw, messageId } = buildMail({
      from: "praxis@kim.example",
      to: "arzt@kim.example",
      subject: "Therapiebericht Größe",
      text: "Grüße\n.Zeile mit Punkt",
      attachments: [{ filename: "bericht.pdf", contentType: "application/pdf", data: new Uint8Array([1, 2, 3]) }],
      inReplyTo: "orig@kim.example",
    });
    const m = parseMime(raw);
    expect(m.messageId).toBe(messageId);
    expect(m.subject).toBe("Therapiebericht Größe");
    expect(m.inReplyTo).toBe("orig@kim.example");
    expect(m.text).toBe("Grüße\n.Zeile mit Punkt");
    expect(m.attachments).toEqual([{ filename: "bericht.pdf", contentType: "application/pdf", size: 3 }]);
  });
});

/** In-Memory-POP3-Server (RFC 1939, nur was der Client braucht). */
function fakePop3(mails: string[], opts: { password?: string; noUidl?: boolean; dropAfterGreeting?: boolean } = {}) {
  const log: string[] = [];
  const deleted = new Set<number>();
  let committed = false;
  const connect = async () => {
    let buf = "";
    let authed = false;
    let userOk = false;
    const d: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        buf += chunk.toString("latin1");
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const [cmd, ...args] = line.split(" ");
          log.push(cmd === "PASS" ? "PASS ***" : line);
          const reply = (s: string) => d.push(s);
          if (cmd === "USER") {
            userOk = args[0] === "praxis";
            reply("+OK\r\n");
          }
          else if (cmd === "PASS") {
            authed = userOk && args.join(" ") === (opts.password ?? "geheim");
            reply(authed ? "+OK angemeldet\r\n" : "-ERR [AUTH] falsch für praxis\r\n");
          } else if (!authed) reply("-ERR nicht angemeldet\r\n");
          else if (cmd === "STAT") reply(`+OK ${mails.length} ${mails.reduce((s, m) => s + m.length, 0)}\r\n`);
          else if (cmd === "UIDL") {
            if (opts.noUidl) reply("-ERR nicht unterstützt\r\n");
            else reply(`+OK\r\n${mails.map((_, n) => `${n + 1} uid-${n + 1}`).join("\r\n")}\r\n.\r\n`);
          } else if (cmd === "RETR") {
            const m = mails[Number(args[0]) - 1];
            if (!m) reply("-ERR keine Nachricht\r\n");
            else reply(`+OK ${m.length} Oktette\r\n${m.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")}\r\n.\r\n`);
          } else if (cmd === "DELE") {
            deleted.add(Number(args[0]));
            reply("+OK gelöscht\r\n");
          }
          else if (cmd === "QUIT") {
            committed = true;
            reply("+OK bye\r\n");
            d.push(null);
          }
          else reply("-ERR unbekannt\r\n");
        }
        cb();
      },
    });
    setImmediate(() => {
      d.push("+OK Fake-KIM-Clientmodul bereit\r\n");
      if (opts.dropAfterGreeting) d.push(null);
    });
    return d;
  };
  return { connect, log, deleted, committed: () => committed };
}

const mail2 = ["Subject: Zweite", "Message-ID: <m2@kim.example>", "From: b@kim.example", "", "..Zeile beginnt mit Punkt", ".", "Ende"].join(CRLF);
const mailNoId = ["Subject: Ohne ID", "From: c@kim.example", "", "Text"].join(CRLF);

describe("POP3-Client (In-Memory-Server)", () => {
  it("USER/PASS/STAT/UIDL/RETR/QUIT, Dot-Stuffing wird entfernt", async () => {
    const srv = fakePop3([ARZTBRIEF, mail2]);
    const c = new Pop3Client({ connect: srv.connect, user: "praxis", password: "geheim" });
    await c.connect();
    expect(await c.stat()).toMatchObject({ count: 2 });
    expect([...(await c.uidl())!.entries()]).toEqual([[1, "uid-1"], [2, "uid-2"]]);
    const raw = (await c.retr(2)).toString("latin1");
    // Rundreise: Server stopft Punkte, Client entfernt sie wieder → Originalinhalt
    expect(raw).toBe(`${mail2}\r\n`);
    await c.quit();
    expect(srv.log).toEqual(["USER praxis", "PASS ***", "STAT", "UIDL", "RETR 2", "QUIT"]);
  });

  it("falsches Passwort → Pop3Error ohne Serverdetails in der Meldung", async () => {
    const srv = fakePop3([], { password: "anders" });
    const c = new Pop3Client({ connect: srv.connect, user: "praxis", password: "geheim" });
    const err = await c.connect().catch((e) => e);
    expect(err).toBeInstanceOf(Pop3Error);
    expect(err.message).toBe("POP3-Anmeldung fehlgeschlagen");
    expect(err.message).not.toContain("praxis");
  });

  it("Verbindungsabbruch, Zeitlimit, Größenlimit und Befehls-Injektion", async () => {
    const dropped = new Pop3Client({ connect: fakePop3([], { dropAfterGreeting: true }).connect, user: "praxis", password: "geheim" });
    await expect(dropped.connect()).rejects.toThrow(/geschlossen/);

    const silent = new Pop3Client({ connect: async () => new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }), user: "x", password: "y", timeoutMs: 30 });
    await expect(silent.connect()).rejects.toThrow(/Zeitüberschreitung/);

    const big = new Pop3Client({ connect: fakePop3([ARZTBRIEF]).connect, user: "praxis", password: "geheim", maxMessageBytes: 100 });
    await big.connect();
    await expect(big.retr(1)).rejects.toThrow(/zu groß/);
    big.close();

    const inj = new Pop3Client({ connect: fakePop3([]).connect, user: "praxis\r\nDELE 1", password: "geheim" });
    await expect(inj.connect()).rejects.toThrow(/Ungültiges Zeichen/);
  });
});

describe("KIM-Adapter", () => {
  const smtpSent: SmtpEnvelope[] = [];
  const base = { user: "praxis", password: "geheim", address: "podologie.test@kim-anbieter.example", smtpTransport: { send: async (e: SmtpEnvelope) => void smtpSent.push(e) } };

  it("fetchInbox: parst Nachrichten, Ersatz-ID ohne Message-ID, löscht standardmäßig NICHT", async () => {
    const srv = fakePop3([ARZTBRIEF, mailNoId]);
    const kim = new KimAdapter({ ...base, pop3Connect: srv.connect });
    const list = await kim.fetchInbox();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      messageId: "abc-123@kim-anbieter.example",
      from: "praxis.dr.beispiel@kim-anbieter.example",
      subject: "Arztbrief: Jürgen Testmüller",
      kimService: "eArztbrief;Brief;V1.2",
    });
    expect(list[1].messageId).toBe("uidl:uid-2");
    expect(srv.deleted.size).toBe(0);
    expect(srv.log).not.toContain("DELE 1");
    expect(srv.committed()).toBe(true);
  });

  it("deleteAfterFetch löscht nach dem Abruf; ohne UIDL Inhalts-Hash als ID; limit", async () => {
    const srv = fakePop3([mailNoId, mail2], { noUidl: true });
    const kim = new KimAdapter({ ...base, pop3Connect: srv.connect, deleteAfterFetch: true });
    const list = await kim.fetchInbox({ limit: 1 });
    expect(list).toHaveLength(1);
    expect(list[0].messageId).toMatch(/^mock_kim_[0-9a-f]{16}$/);
    expect([...srv.deleted]).toEqual([1]);
  });

  it("send: Text-Nachricht an gültige Adresse über den Transport", async () => {
    const kim = new KimAdapter({ ...base, pop3Connect: fakePop3([]).connect });
    const res = await kim.send("arzt@kim-anbieter.example", "Re: Rückfrage", "Danke!", [], { inReplyTo: "abc@x" });
    expect(smtpSent.at(-1)).toMatchObject({ from: base.address, to: ["arzt@kim-anbieter.example"] });
    expect(parseMime(smtpSent.at(-1)!.raw)).toMatchObject({ messageId: res.messageId, text: "Danke!", inReplyTo: "abc@x", subject: "Re: Rückfrage" });
    await expect(kim.send("kein-kim", "x", "y")).rejects.toThrow(/ungültig/);
  });

  it("ohne Zugangsdaten nicht konfiguriert; ping zählt Nachrichten", async () => {
    expect(() => new KimAdapter({ user: "x" })).toThrow(/nicht konfiguriert/);
    expect(() => new KimAdapter({ ...base, address: "kaputt" })).toThrow(/ungültig/);
    const kim = new KimAdapter({ ...base, pop3Connect: fakePop3([mail2]).connect });
    expect(await kim.ping()).toEqual({ messages: 1 });
  });

  it("Mock liefert 2 erfundene Beispielnachrichten", async () => {
    const m = new KimMock();
    expect(await m.fetchInbox()).toHaveLength(2);
    expect(KIM_MOCK_MESSAGES[0].from).toContain("beispiel");
    expect((await m.send("arzt@kim.example", "s", "b")).messageId).toMatch(/^mock_kim-out_/);
  });
});

describe("SMTP-Client (In-Memory-Server)", () => {
  function fakeSmtp(auth = "AUTH PLAIN LOGIN") {
    const log: string[] = [];
    let data = "";
    const connect = async () => {
      let buf = "";
      let inData = false;
      const d: Duplex = new Duplex({
        read() {},
        write(chunk: Buffer, _e, cb) {
          buf += chunk.toString("latin1");
          let i: number;
          while ((i = buf.indexOf("\r\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (inData) {
              if (line === ".") {
                inData = false;
                d.push("250 OK queued\r\n");
              }
              else data += `${line}\r\n`;
              continue;
            }
            log.push(line.startsWith("AUTH PLAIN") ? "AUTH PLAIN ***" : line);
            if (line.startsWith("EHLO")) d.push(`250-kim.example\r\n250-${auth}\r\n250 8BITMIME\r\n`);
            else if (line.startsWith("AUTH PLAIN")) d.push(Buffer.from(line.slice(11), "base64").toString() === "\u0000praxis\u0000geheim" ? "235 ok\r\n" : "535 nein\r\n");
            else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) d.push("250 ok\r\n");
            else if (line === "DATA") {
              inData = true;
              d.push("354 go\r\n");
            }
            else if (line === "QUIT") {
              d.push("221 bye\r\n");
              d.push(null);
            }
            else d.push("500 ?\r\n");
          }
          cb();
        },
      });
      setImmediate(() => d.push("220 Fake-KIM-SMTP\r\n"));
      return d;
    };
    return { connect, log, data: () => data };
  }

  it("EHLO, AUTH PLAIN, MAIL/RCPT/DATA mit Dot-Stuffing, QUIT", async () => {
    const srv = fakeSmtp();
    const t = new SimpleSmtpTransport({ connect: srv.connect, user: "praxis", password: "geheim" });
    await t.send({ from: "a@kim.example", to: ["b@kim.example"], raw: "Subject: x\r\n\r\n.Punkt\r\nText" });
    expect(srv.log).toEqual(["EHLO podocrm.local", "AUTH PLAIN ***", "MAIL FROM:<a@kim.example>", "RCPT TO:<b@kim.example>", "DATA", "QUIT"]);
    expect(srv.data()).toBe("Subject: x\r\n\r\n..Punkt\r\nText\r\n");
  });

  it("falsche Anmeldung, fehlendes AUTH und ungültige Adressen", async () => {
    await expect(new SimpleSmtpTransport({ connect: fakeSmtp().connect, user: "praxis", password: "x" }).send({ from: "a@kim.example", to: ["b@kim.example"], raw: "x" })).rejects.toThrow(/Anmeldung abgelehnt/);
    await expect(new SimpleSmtpTransport({ connect: fakeSmtp("SIZE 1").connect, user: "praxis", password: "geheim" }).send({ from: "a@kim.example", to: ["b@kim.example"], raw: "x" })).rejects.toThrow(/keine unterstützte Anmeldung/);
    await expect(new SimpleSmtpTransport({ connect: fakeSmtp().connect, user: "p", password: "g" }).send({ from: "a@kim.example", to: ["b@kim.example>\r\nRCPT TO:<c@x.de"], raw: "x" })).rejects.toThrow(/Ungültige Adresse/);
  });
});

describe("Netz: SSRF-Schutz für KIM-Hosts", () => {
  it("nur öffentliche Ziele und erlaubte Ports", async () => {
    await expect(resolvePublic("kim.example.com", async () => [{ address: "10.0.0.5" }])).rejects.toThrow(/private/);
    await expect(resolvePublic("localhost")).rejects.toThrow();
    expect(await resolvePublic("kim.example.com", async () => [{ address: "93.184.216.34" }])).toBe("93.184.216.34");
    expect(() => assertKimPort(25)).toThrow();
    expect(() => assertKimPort(995)).not.toThrow();
    expect(() => assertKimPort(8995)).not.toThrow();
  });
});

describe("KIM-Zuordnungshinweise", () => {
  it("KVNR-Prüfziffer", () => {
    expect(isValidKvnr("A123456780")).toBe(true);
    expect(isValidKvnr("A123456781")).toBe(false);
    expect(isValidKvnr("a123456780")).toBe(false);
  });

  it("extrahiert KVNR, Geburtsdatum und Namen; Vorschläge nur mit ausreichenden Merkmalen", () => {
    const h = extractKimHints("Arztbrief: Jürgen Testmüller", "Befund für Herrn Jürgen Testmüller (KVNR A123456780), geb. 03.04.1951.");
    expect(h.kvnrs).toEqual(["A123456780"]);
    expect(h.birthDates).toEqual(["1951-04-03"]);
    expect(h.nameTokens).toContain("testmüller");
    expect(h.nameTokens).not.toContain("befund");
    const p = (o: Partial<{ id: string; firstName: string; lastName: string; birthDate: string; insuranceNumber: string }>) => ({
      id: o.id ?? "x", number: 1, firstName: o.firstName ?? null, lastName: o.lastName ?? "Andere", birthDate: o.birthDate ?? null, insuranceNumber: o.insuranceNumber ?? null,
    });
    const ranked = rankSuggestions(h, [
      p({ id: "nur-nachname", lastName: "Testmüller" }),
      p({ id: "kvnr", insuranceNumber: "A123456780" }),
      p({ id: "name-geb", firstName: "Jürgen", lastName: "Testmüller", birthDate: "1951-04-03" }),
    ]);
    expect(ranked.map((r) => r.patient.id)).toEqual(["kvnr", "name-geb"]);
    expect(ranked[1].reasons).toEqual(["Vor- und Nachname", "Geburtsdatum"]);
  });

  it("Anhänge als Hinweiszeile", () => {
    expect(attachmentNote([])).toBe("");
    expect(attachmentNote([{ filename: "a.pdf", contentType: "application/pdf", size: 4096 }])).toContain("a.pdf (4 KB)");
  });
});

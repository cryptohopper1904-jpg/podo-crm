/**
 * Gesamt-Review M1: Öffentliche Buchung /buchen prüft serverseitig Freigabe, Leistungsliste, Arbeitszeiten,
 * Abwesenheiten und Buchungsfenster – nur exakt angebotene Startzeiten (wie Portal und Telefon).
 * AppSec L1: Praxis mit abgelaufenem Abo/Testphase oder beantragter Löschung ist von außen nicht mehr buchbar.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// bookAction außerhalb eines Requests: Kopfzeilen für requestMeta() (Drosselung, Audit)
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "198.51.100.7" }) }));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Öffentliche Buchung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let pb: typeof import("./portal-booking");
  let fmt: typeof import("@/lib/format");
  // Montag, 4. März 2030, 07:00 Berlin
  const now = new Date("2030-03-04T06:00:00Z");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    pb = await import("./portal-booking");
    fmt = await import("@/lib/format");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function practice(settings: Record<string, unknown> = {}) {
    const org = await f.org({
      settings: {
        onlineBooking: { enabled: true, ...settings },
        imprint: { owner: "Petra Test", profession: "Podologin" },
        // AVV 0.3 akzeptiert (Standardweisung zur Löschung, § 3 Nr. 4) – sonst überspringt der Löschlauf die Praxis
        legalAcceptance: { agb: "0.3", avv: "0.3", version: "agb-0.3+avv-0.3", at: "2026-11-14T00:00:00.000Z", by: "test" },
      },
    });
    // Impressums-Pflichtangaben (§ 5 DDG) – ohne sie ist /buchen gesperrt
    await f.pool.query("update organizations set state = 'BB', street = 'Teststraße 1', zip = '16540', city = 'Hohen Neuendorf', email = 'praxis@example.org' where id = $1", [org]);
    const u = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist')", [org, u]);
    const ids = await f.asOrg(org, async (c) => {
      for (let wd = 1; wd <= 5; wd++) await c.query("insert into working_hours (organization_id, user_id, weekday, start_time, end_time) values ($1,$2,$3,'09:00','12:00')", [org, u, wd]);
      await c.query("insert into absences (organization_id, user_id, starts_on, ends_on, kind) values ($1,$2,'2030-03-06','2030-03-06','vacation')", [org, u]);
      const pk = (await c.query("insert into services (organization_id, code, name, price_cents, duration_min, category) values ($1,'PK','Komplexbehandlung',6500,60,'treatment') returning id", [org])).rows[0].id as string;
      const kos = (await c.query("insert into services (organization_id, code, name, price_cents, duration_min, category) values ($1,'KOS','Kosmetik',4000,30,'cosmetic') returning id", [org])).rows[0].id as string;
      return { pk, kos };
    });
    return { org, user: u, ...ids };
  }
  const at = (d: string, t: string) => fmt.berlinToUtc(d, t);

  it("freier Slot innerhalb der Arbeitszeit: ok", async () => {
    const p = await practice();
    expect(await pb.checkPublicSlot(p.org, p.pk, at("2030-03-05", "09:00"), now)).toMatchObject({ ok: true, service: { id: p.pk } });
  });

  it("Urlaub, außerhalb der Arbeitszeit, Wochenende, krumme Startzeit, zu weit in der Zukunft: abgelehnt", async () => {
    const p = await practice();
    for (const [d, t] of [["2030-03-06", "09:00"], ["2030-03-05", "14:00"], ["2030-03-09", "09:00"], ["2030-03-05", "09:10"], ["2030-03-05", "03:00"], ["2030-04-30", "09:00"]]) {
      expect((await pb.checkPublicSlot(p.org, p.pk, at(d, t), now)).ok, `${d} ${t}`).toBe(false);
    }
  });

  it("Leistungsliste und Freigabe werden serverseitig geprüft", async () => {
    const p = await practice({ serviceCodes: ["KOS"] });
    expect(await pb.checkPublicSlot(p.org, p.pk, at("2030-03-05", "09:00"), now)).toEqual({ ok: false, error: "Diese Leistung ist online nicht buchbar." });
    expect((await pb.checkPublicSlot(p.org, p.kos, at("2030-03-05", "09:00"), now)).ok).toBe(true);
    const off = await practice({ enabled: false });
    expect((await pb.checkPublicSlot(off.org, off.pk, at("2030-03-05", "09:00"), now)).ok).toBe(false);
    expect(await pb.publicBookingOptions(off.org, now)).toBeNull();
  });

  it("angezeigte Zeiten berücksichtigen Abwesenheiten und belegte Termine", async () => {
    const p = await practice();
    await f.asOrg(p.org, (c) => c.query("insert into appointments (organization_id, starts_at, ends_at, status) values ($1,$2,$3,'planned')", [p.org, at("2030-03-05", "09:00"), at("2030-03-05", "10:00")]));
    const o = await pb.publicBookingOptions(p.org, now);
    expect(o?.days.map((d) => d.date)).not.toContain("2030-03-06");
    const tue = o?.days.find((d) => d.date === "2030-03-05");
    expect(tue?.slots[60]).toEqual(["10:00", "10:30", "11:00"]);
    expect((await pb.checkPublicSlot(p.org, p.pk, at("2030-03-05", "09:00"), now)).ok).toBe(false);
  });

  describe("AppSec L1: gesperrte oder gekündigte Praxis", () => {
    const slot = () => at("2030-03-05", "09:00");

    it("Testphase abgelaufen (Nur-Lesen): keine Optionen, Slot-Prüfung abgelehnt", async () => {
      const p = await practice();
      await f.pool.query("update organizations set plan = 'trial', subscription_status = 'trialing', trial_ends_at = '2030-03-01T00:00:00Z' where id = $1", [p.org]);
      expect(await pb.publicBookingOptions(p.org, now)).toBeNull();
      expect(await pb.checkPublicSlot(p.org, p.pk, slot(), now)).toEqual({ ok: false, error: "Die Online-Buchung ist derzeit nicht verfügbar." });
    });

    it("Abo gekündigt und Kulanz vorbei: keine Optionen, Slot-Prüfung abgelehnt", async () => {
      const p = await practice();
      await f.pool.query("update organizations set plan = 'praxis', subscription_status = 'canceled', current_period_end = '2030-01-01T00:00:00Z' where id = $1", [p.org]);
      expect(await pb.publicBookingOptions(p.org, now)).toBeNull();
      expect((await pb.checkPublicSlot(p.org, p.pk, slot(), now)).ok).toBe(false);
    });

    it("Löschung beantragt: keine Optionen, Slot-Prüfung abgelehnt", async () => {
      const p = await practice();
      await f.pool.query("update organizations set deletion_requested_at = now() where id = $1", [p.org]);
      expect(await pb.publicBookingOptions(p.org, now)).toBeNull();
      expect(await pb.checkPublicSlot(p.org, p.pk, slot(), now)).toEqual({ ok: false, error: "Die Online-Buchung ist derzeit nicht verfügbar." });
    });

    it("AppSec H-2: /buchen in allen Tarifen – Kostenlos und Basis ohne Patientenportal bleiben buchbar", async () => {
      for (const plan of ["free", "starter"]) {
        const p = await practice();
        await f.pool.query("update organizations set plan = $2, subscription_status = 'active' where id = $1", [p.org, plan]);
        expect((await pb.publicBookingOptions(p.org, now))?.days.length, plan).toBeGreaterThan(0);
        expect((await pb.checkPublicSlot(p.org, p.pk, slot(), now)).ok, plan).toBe(true);
        expect(await pb.publicBookingAvailable(p.org, now), plan).toBe(true);
      }
    });

    it("normale Praxis unverändert buchbar", async () => {
      const p = await practice();
      expect((await pb.publicBookingOptions(p.org, now))?.days.length).toBeGreaterThan(0);
      expect((await pb.checkPublicSlot(p.org, p.pk, slot(), now)).ok).toBe(true);
    });
  });

  it("Rechtsbefund H2: Impressum/Datenschutz der Praxis auch ohne Website; Links auf Ersatzseiten, nach Löschantrag keine Daten", async () => {
    const web = await import("./website");
    const p = await practice();
    const [{ slug }] = (await f.pool.query("select slug from organizations where id = $1", [p.org])).rows;
    const legal = await web.loadPracticeLegal(slug);
    expect(legal).toMatchObject({ slug, name: "Testpraxis Fuß", websitePublished: false });
    expect(web.practiceLegalLinks(legal!)).toEqual({ imprint: `/buchen/${slug}/impressum`, privacy: `/buchen/${slug}/datenschutz` });
    expect(web.practiceLegalLinks({ slug, websitePublished: true })).toEqual({ imprint: `/p/${slug}/impressum`, privacy: `/p/${slug}/datenschutz` });
    expect(await pb.publicBookingAvailable(p.org, now)).toBe(true);
    await f.pool.query("update organizations set deletion_requested_at = now() where id = $1", [p.org]);
    expect(await pb.publicBookingAvailable(p.org, now)).toBe(false);
    expect(await web.loadPracticeLegal(slug)).toBeNull();
  });

  describe("Rechtsprüfung H1/H2: Impressum und Datenschutz", () => {
    it("fehlende Impressums-Pflichtangaben sperren /buchen (Optionen, Slot-Prüfung, Verfügbarkeit)", async () => {
      for (const sqlText of [
        "update organizations set settings = settings - 'imprint' where id = $1",
        "update organizations set settings = jsonb_set(settings, '{imprint,profession}', '\"\"') where id = $1",
        "update organizations set email = null where id = $1",
        "update organizations set street = null where id = $1",
      ]) {
        const p = await practice();
        expect(await pb.publicBookingAvailable(p.org, now), "vorher").toBe(true);
        await f.pool.query(sqlText, [p.org]);
        expect(await pb.publicBookingOptions(p.org, now), sqlText).toBeNull();
        expect((await pb.checkPublicSlot(p.org, p.pk, at("2030-03-05", "09:00"), now)).ok, sqlText).toBe(false);
        expect(await pb.publicBookingAvailable(p.org, now), sqlText).toBe(false);
      }
    });

    it("Datenschutzblock enthält Verantwortlichen aus den Stammdaten, Impressum die Pflichtangaben", async () => {
      const web = await import("./website");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { PrivacyContent, ImprintContent } = await import("@/app/p/[slug]/_site/legal-content");
      const p = await practice();
      await f.pool.query("update organizations set legal_name = 'Podologie Test GmbH', phone = '030 1234567' where id = $1", [p.org]);
      const [{ slug }] = (await f.pool.query("select slug from organizations where id = $1", [p.org])).rows;
      const legal = (await web.loadPracticeLegal(slug))!;
      const privacy = renderToStaticMarkup(createElement(PrivacyContent, { site: legal }));
      expect(privacy).toContain("Online-Terminanfrage");
      expect(privacy).toContain("Verantwortlich für die Verarbeitung Ihrer Terminanfrage ist Podologie Test GmbH, Teststraße 1, 16540 Hohen Neuendorf, praxis@example.org, 030 1234567.");
      expect(privacy).toContain("durch PodoHero als Auftragsverarbeiter der Praxis");
      expect(privacy).toContain(
        "Anfragen, die nicht zu einem Termin oder einer Behandlung geführt haben, löschen wir 6 Monate nach Eingang automatisch. Kopien in verschlüsselten Datensicherungen werden spätestens 30 Tage danach überschrieben.",
      );
      expect(privacy).toContain("10 Jahre nach § 630f Abs. 3 BGB");
      // KI-Antwortvorschläge aus (Standard): kein Drittland
      expect(privacy).toContain("Eine Übermittlung in Länder außerhalb der EU bzw. des EWR findet nicht statt.");
      expect(privacy).not.toContain("KI-Dienst");
      expect(privacy).toContain("Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (sicherer Betrieb der Website); die Protokolldaten werden nach 7 Tagen gelöscht.");
      expect(privacy).not.toContain("Datenschutzbeauftragte");
      expect(privacy).not.toContain("wird hier noch ergänzt");
      const imprint = renderToStaticMarkup(createElement(ImprintContent, { site: legal }));
      expect(imprint).toContain("Vertretungsberechtigte Person: Petra Test");
      expect(imprint).toContain("Berufsbezeichnung: Podologin (verliehen in Deutschland)");
      expect(imprint).toContain("Podologengesetz (PodG)");
      expect(imprint).not.toContain("ergänzt hier noch");
    });

    it("Recht H-88-4: KI-Antwortvorschläge an → Anbieter und Land im Art.-13-Block; unvollständig gespeichert → wie aus", async () => {
      const web = await import("./website");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { PrivacyContent } = await import("@/app/p/[slug]/_site/legal-content");
      const p = await practice();
      const [{ slug }] = (await f.pool.query("select slug from organizations where id = $1", [p.org])).rows;
      const setAi = (a: Record<string, unknown>) => f.pool.query("update organizations set settings = settings || jsonb_build_object('aiReplies', $2::jsonb) where id = $1", [p.org, JSON.stringify(a)]);
      const render = async () => renderToStaticMarkup(createElement(PrivacyContent, { site: (await web.loadPracticeLegal(slug))! }));
      await setAi({ enabled: true, provider: "Beispiel-KI <b>Inc.</b>", country: "USA", avvConfirmed: true, confidentialityConfirmed: true, transferConfirmed: true });
      const on = await render();
      expect(on).toContain("Für Antwortvorschläge auf Ihre Nachricht nutzt die Praxis den KI-Dienst Beispiel-KI &lt;b&gt;Inc.&lt;/b&gt; (USA) als Auftragsverarbeiter.");
      // Recht H-88-5: Wortlaut zur Übermittlung und zur Grenze der automatischen Entfernung
      expect(on).toContain(
        "Dabei wird der Inhalt Ihrer Nachricht an Beispiel-KI &lt;b&gt;Inc.&lt;/b&gt; in den USA übermittelt. Ihr Name, Ihre Telefonnummer und Ihre E-Mail-Adresse werden vorher automatisch entfernt. Namen oder andere persönliche Angaben, die Sie selbst in den Nachrichtentext schreiben, können dabei nicht in jedem Fall erkannt werden.",
      );
      expect(on).toContain("Bitte geben Sie im Freitext keine Diagnosen an.");
      // Recht M-88-6: Garantie-Satz nur bei Drittland
      expect(on).toContain("Standardvertragsklauseln nach Art. 46 Abs. 2 lit. c DSGVO; eine Kopie der Garantien erhalten Sie bei der Praxis.");
      expect(on).not.toContain("findet nicht statt");
      expect((await web.loadPracticeLegal(slug))!.aiReplies).toEqual({ provider: "Beispiel-KI <b>Inc.</b>", country: "USA", countryIn: "in den USA", thirdCountry: true });
      await setAi({ enabled: true, provider: "Mistral AI", country: "Frankreich", avvConfirmed: true, confidentialityConfirmed: true });
      const eu = await render();
      expect(eu).toContain("Dabei wird der Inhalt Ihrer Nachricht an Mistral AI in Frankreich übermittelt.");
      expect(eu).not.toContain("Standardvertragsklauseln");
      expect(eu).not.toContain("außerhalb der EU");
      // Drittland ohne Bestätigung der Garantien oder ohne Bestätigung § 203 (z. B. von Hand gesetzt) gilt als aus
      await setAi({ enabled: true, provider: "X", country: "USA", avvConfirmed: true, confidentialityConfirmed: true });
      expect(await render()).toContain("Eine Übermittlung in Länder außerhalb der EU bzw. des EWR findet nicht statt.");
      await setAi({ enabled: true, provider: "X", country: "Frankreich", avvConfirmed: true });
      expect(await render()).toContain("Eine Übermittlung in Länder außerhalb der EU bzw. des EWR findet nicht statt.");
      await setAi({ enabled: false, provider: "X", country: "Frankreich", avvConfirmed: true, confidentialityConfirmed: true });
      expect(await render()).not.toContain("KI-Dienst");
    });

    it("Recht H-88-6: fester Löschzeitraum im Datenschutztext nur, wenn der Löschlauf aktiv ist (AVV ab RETENTION_MIN_AVV)", async () => {
      const web = await import("./website");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { PrivacyContent } = await import("@/app/p/[slug]/_site/legal-content");
      const p = await practice();
      const [{ slug }] = (await f.pool.query("select slug from organizations where id = $1", [p.org])).rows;
      const render = async () => renderToStaticMarkup(createElement(PrivacyContent, { site: (await web.loadPracticeLegal(slug))! }));
      const SIX = "Anfragen, die nicht zu einem Termin oder einer Behandlung geführt haben, löschen wir 6 Monate nach Eingang automatisch.";
      const OTHERWISE = "Anfragen, die nicht zu einem Termin oder einer Behandlung geführt haben, löscht die Praxis, sobald sie für die Bearbeitung Ihrer Anfrage nicht mehr erforderlich sind.";
      const BACKUP = "Kopien in verschlüsselten Datensicherungen werden spätestens 30 Tage danach überschrieben.";
      const accept = (avv: string | null) =>
        f.pool.query(
          avv ? "update organizations set settings = settings || jsonb_build_object('legalAcceptance', jsonb_build_object('avv', $2::text)) where id = $1" : "update organizations set settings = settings - 'legalAcceptance' where id = $1",
          avv ? [p.org, avv] : [p.org],
        );
      for (const avv of ["0.3", "0.4"]) {
        await accept(avv);
        const t = await render();
        expect(t, avv).toContain(`${SIX} ${BACKUP}`);
        expect(t, avv).not.toContain(OTHERWISE);
        expect((await web.loadPracticeLegal(slug))!.onlineRequestRetention, avv).toBe(true);
      }
      for (const avv of [null, "0.2"]) {
        await accept(avv);
        const t = await render();
        expect(t, String(avv)).toContain(`${OTHERWISE} ${BACKUP}`);
        expect(t, String(avv)).not.toContain("6 Monate nach Eingang");
        expect((await web.loadPracticeLegal(slug))!.onlineRequestRetention, String(avv)).toBe(false);
      }
    });

    it("Art.-13-Block nur bei aktiver Online-Buchung; Website-Knopf „Termin buchen“ folgt derselben Regel", async () => {
      const web = await import("./website");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { PrivacyContent } = await import("@/app/p/[slug]/_site/legal-content");
      const p = await practice();
      const [{ slug }] = (await f.pool.query("select slug from organizations where id = $1", [p.org])).rows;
      await f.pool.query("update organizations set settings = settings || '{\"website\": {\"enabled\": true}}'::jsonb, plan = 'praxis', subscription_status = 'active' where id = $1", [p.org]);
      const render = async () => renderToStaticMarkup(createElement(PrivacyContent, { site: (await web.loadPracticeLegal(slug))! }));
      expect(await render()).toContain("Online-Terminanfrage");
      expect((await web.loadPublicSite(slug))?.onlineBooking).toBe(true);
      // Impressumsangabe fehlt → Buchung gesperrt → kein Art.-13-Block, kein Buchen-Knopf auf der Website
      await f.pool.query("update organizations set settings = jsonb_set(settings, '{imprint,owner}', '\"\"') where id = $1", [p.org]);
      expect((await web.loadPracticeLegal(slug))!.onlineBooking).toBe(false);
      expect(await render()).not.toContain("Online-Terminanfrage");
      expect(await render()).toContain("Protokolldaten werden nach 7 Tagen gelöscht");
      expect((await web.loadPublicSite(slug))?.onlineBooking).toBe(false);
    });

    it("Impressum: Einzelpraxis „Inhaberin/Inhaber“, Register bei GmbH, keine Steuernummer, kein PodG-Text bei Freitext, Datenschutzbeauftragte:r", async () => {
      const web = await import("./website");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { ImprintContent, PrivacyContent } = await import("@/app/p/[slug]/_site/legal-content");
      const p = await practice();
      const [{ slug }] = (await f.pool.query("select slug from organizations where id = $1", [p.org])).rows;
      const setImprint = (i: Record<string, unknown>) =>
        f.pool.query("update organizations set tax_number = '123/456/78901', settings = jsonb_set(settings, '{imprint}', $2::jsonb) where id = $1", [p.org, JSON.stringify(i)]);
      const render = async () => {
        const legal = (await web.loadPracticeLegal(slug))!;
        return { imprint: renderToStaticMarkup(createElement(ImprintContent, { site: legal })), privacy: renderToStaticMarkup(createElement(PrivacyContent, { site: legal })), legal };
      };

      await setImprint({ owner: "Petra Test", profession: "Podologin", legalForm: "Einzelpraxis", dpo: "Datenschutz Muster, dsb@example.org" });
      let r = await render();
      expect(r.imprint).toContain("Inhaberin/Inhaber: Petra Test");
      expect(r.imprint).not.toContain("Vertretungsberechtigte Person");
      expect(r.imprint).not.toContain("Steuernummer");
      expect(r.imprint).not.toContain("123/456/78901");
      expect(r.imprint).toContain("Datenschutz Muster, dsb@example.org");
      expect(r.privacy).toContain("Datenschutzbeauftragte:r:</strong> Datenschutz Muster, dsb@example.org");

      // GmbH ohne Registerangaben: Pflichtangabe fehlt → Buchung gesperrt
      await setImprint({ owner: "Petra Test", profession: "Podologin", legalForm: "GmbH" });
      expect(await pb.publicBookingAvailable(p.org, now)).toBe(false);
      await setImprint({ owner: "Petra Test", profession: "Podologin", legalForm: "GmbH", registerCourt: "Amtsgericht Neuruppin", registerNumber: "HRB 12345", economicId: "DE123456789-00001" });
      expect(await pb.publicBookingAvailable(p.org, now)).toBe(true);
      r = await render();
      expect(r.imprint).toContain("Rechtsform: GmbH");
      expect(r.imprint).toContain("Vertretungsberechtigte Person: Petra Test");
      expect(r.imprint).toContain("Registergericht: Amtsgericht Neuruppin");
      expect(r.imprint).toContain("Registernummer: HRB 12345");
      expect(r.imprint).toContain("Wirtschafts-Identifikationsnummer: DE123456789-00001");

      // Freitext-Berufsbezeichnung: kein PodG-Standardtext (auch nicht, wenn er noch gespeichert ist)
      await setImprint({ owner: "Petra Test", profession: "Fußpflegerin", regulations: "Podologengesetz (PodG) und Ausbildungs- und Prüfungsverordnung für Podologen (PodAPrV), abrufbar unter gesetze-im-internet.de" });
      r = await render();
      expect(r.imprint).toContain("Berufsbezeichnung: Fußpflegerin");
      expect(r.imprint).not.toContain("PodG");
      expect(r.imprint).not.toContain("Berufsrechtliche Regelungen");
    });
  });

  describe("Aufbewahrung: Online-Anfragen 6 Monate nach Eingang löschen (Code-Review/AppSec/Recht)", () => {
    // Termine und Nachrichten direkt anlegen; „created“ als SQL-Ausdruck (Eingang)
    const OLD = "now() - interval '7 months'";
    type Opts = { marker?: boolean; source?: string; status?: string; patientId?: string | null; created?: string; msg?: boolean };
    async function request(org: string, o: Opts = {}) {
      return f.asOrg(org, async (c) => {
        const id = (await c.query("select gen_random_uuid() as id")).rows[0].id as string;
        const key = `online-request:${id}`;
        await c.query(
          `insert into appointments (id, organization_id, patient_id, starts_at, ends_at, status, source, external_id, created_at)
           values ($1,$2,$3, now() - interval '200 days', now() - interval '200 days' + interval '1 hour', $4, $5, $6, ${o.created ?? OLD})`,
          [id, org, o.patientId ?? null, o.status ?? "planned", o.source ?? "online", o.marker === false ? null : key],
        );
        if (o.msg !== false) {
          await c.query(`insert into messages (organization_id, channel, direction, subject, body, thread_key, received_at) values ($1,'email','inbound','Neue Online-Buchung (unbestätigt)',$2,$3, ${o.created ?? OLD})`, [org, `anfrage ${id}`, key]);
        }
        return id;
      });
    }
    const apptIds = async (org: string) => (await f.asOrg(org, (c) => c.query("select id from appointments where organization_id = $1", [org]))).rows.map((r) => r.id as string);
    const msgBodies = async (org: string) => (await f.asOrg(org, (c) => c.query("select body from messages where organization_id = $1", [org]))).rows.map((r) => r.body as string);
    let ret: typeof import("./online-request-retention");
    beforeAll(async () => {
      ret = await import("./online-request-retention");
    });

    it("löscht nur gekennzeichnete, alte, nicht übernommene Anfragen samt ihrer Nachricht; Audit mit Zählern", async () => {
      const p = await practice();
      const planned = await request(p.org);
      const cancelled = await request(p.org, { status: "cancelled" });
      const fresh = await request(p.org, { created: "now() - interval '5 months'" });
      expect(await ret.purgeStaleOnlineRequests(p.org)).toEqual({ appointments: 2, messages: 2 });
      expect(await apptIds(p.org)).toEqual([fresh]);
      expect(await msgBodies(p.org)).toEqual([`anfrage ${fresh}`]);
      const audit = (await f.asOrg(p.org, (c) => c.query("select action, meta, user_id from audit_log where organization_id = $1 and action = 'retention.online_requests'", [p.org]))).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].user_id).toBeNull();
      expect(Object.keys(audit[0].meta).sort()).toEqual(["appointments", "cutoff", "messages"]);
      expect(audit[0].meta).toMatchObject({ appointments: 2, messages: 2 });
      expect(audit[0].meta.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect([planned, cancelled].every((id) => !JSON.stringify(audit[0].meta).includes(id))).toBe(true);
    });

    it("Idempotenz: zweiter Lauf löscht nichts und schreibt kein weiteres Audit", async () => {
      const p = await practice();
      await request(p.org);
      expect(await ret.purgeStaleOnlineRequests(p.org)).toEqual({ appointments: 1, messages: 1 });
      expect(await ret.purgeStaleOnlineRequests(p.org)).toEqual({ appointments: 0, messages: 0 });
      const n = (await f.asOrg(p.org, (c) => c.query("select count(*)::int as n from audit_log where organization_id = $1 and action = 'retention.online_requests'", [p.org]))).rows[0].n;
      expect(n).toBe(1);
    });

    it("Negativfälle bleiben: erledigt, bestätigt, nicht erschienen, mit Akte, andere Quelle, ohne Kennzeichen (manuell/Altbestand)", async () => {
      const p = await practice();
      const patient = await f.patient(p.org);
      const keep = [
        await request(p.org, { status: "done" }),
        await request(p.org, { status: "confirmed" }),
        await request(p.org, { status: "no_show" }),
        await request(p.org, { patientId: patient }),
        await request(p.org, { source: "phone" }),
        // von der Praxis manuell mit Quelle „online“ angelegt bzw. Anfrage aus der Zeit vor dem Kennzeichen
        await request(p.org, { marker: false }),
      ];
      expect(await ret.purgeStaleOnlineRequests(p.org)).toEqual({ appointments: 0, messages: 0 });
      expect((await apptIds(p.org)).sort()).toEqual([...keep].sort());
      expect(await msgBodies(p.org)).toHaveLength(keep.length);
    });

    it("Behandlungsdokumentation oder Rechnungsposition am Termin: bleibt", async () => {
      const p = await practice();
      const patient = await f.patient(p.org);
      const withDoc = await request(p.org);
      const withLine = await request(p.org);
      await f.asOrg(p.org, async (c) => {
        await c.query("insert into treatment_records (organization_id, patient_id, author_id, appointment_id, treated_at, hash) values ($1,$2,$3,$4,now(),'h')", [p.org, patient, p.user, withDoc]);
        const inv = (await c.query("insert into invoices (organization_id, patient_id, status, kind) values ($1,$2,'draft','invoice') returning id", [p.org, patient])).rows[0].id;
        await c.query("insert into invoice_lines (organization_id, invoice_id, appointment_id, description, quantity, factor, unit_price_cents, vat_rate, total_cents, position) values ($1,$2,$3,'Behandlung','1','1',1000,0,1000,1)", [p.org, inv, withLine]);
      });
      expect(await ret.purgeStaleOnlineRequests(p.org)).toEqual({ appointments: 0, messages: 0 });
      expect((await apptIds(p.org)).sort()).toEqual([withDoc, withLine].sort());
    });

    it("Nachrichten: zugeordnete, ausgehende, mit external_id und Bestandsnachrichten ohne thread_key bleiben", async () => {
      const p = await practice();
      const patient = await f.patient(p.org);
      const id = await request(p.org, { msg: false });
      const key = `online-request:${id}`;
      await f.asOrg(p.org, (c) =>
        c.query(
          `insert into messages (organization_id, patient_id, channel, direction, subject, body, thread_key, external_id, received_at) values
            ($1, $2,   'email', 'inbound',  'Neue Online-Buchung (unbestätigt)', 'zugeordnet', $3, null, ${OLD}),
            ($1, null, 'email', 'outbound', 'Re: Ihre Anfrage',                   'antwort',    $3, null, ${OLD}),
            ($1, null, 'email', 'inbound',  'Neue Online-Buchung (unbestätigt)', 'extern',     $3, 'imap:1', ${OLD}),
            ($1, null, 'email', 'inbound',  'Neue Online-Buchung (unbestätigt)', 'bestand',    null, null, ${OLD}),
            ($1, null, 'email', 'inbound',  'Neue Online-Buchung (unbestätigt)', 'geloescht',  $3, null, ${OLD})`,
          [p.org, patient, key],
        ),
      );
      // ausgehende Antwort ohne Person (mit Versand-ID) gehört zur gelöschten Anfrage und wird mitgelöscht
      expect(await ret.purgeStaleOnlineRequests(p.org)).toEqual({ appointments: 1, messages: 2 });
      expect((await msgBodies(p.org)).sort()).toEqual(["bestand", "extern", "zugeordnet"]);
    });

    it("verwaiste Nachrichten (Termin gelöscht): nach Stichtag am Eingang mitgelöscht, sonst bleiben sie", async () => {
      const p = await practice();
      const patient = await f.patient(p.org);
      const gone = (await f.asOrg(p.org, (c) => c.query("select gen_random_uuid() as id"))).rows[0].id as string;
      const key = `online-request:${gone}`;
      const kept = await request(p.org, { status: "confirmed" }); // Termin existiert noch → keine Waise
      await f.asOrg(p.org, (c) =>
        c.query(
          `insert into messages (organization_id, patient_id, channel, direction, subject, body, thread_key, external_id, received_at) values
            ($1, null, 'email', 'inbound',  'Neue Online-Buchung (unbestätigt)', 'waise-alt',        $3, null,     ${OLD}),
            ($1, null, 'email', 'outbound', 'Re: Ihre Anfrage',                   'waise-antwort',    $3, 'smtp:1', ${OLD}),
            ($1, null, 'email', 'inbound',  'Neue Online-Buchung (unbestätigt)', 'waise-neu',        $3, null,     now() - interval '5 months'),
            ($1, $2,   'email', 'inbound',  'Neue Online-Buchung (unbestätigt)', 'waise-zugeordnet', $3, null,     ${OLD}),
            ($1, null, 'email', 'inbound',  'Neue Online-Buchung (unbestätigt)', 'waise-extern',     $3, 'imap:2', ${OLD})`,
          [p.org, patient, key],
        ),
      );
      expect(await ret.purgeStaleOnlineRequests(p.org)).toEqual({ appointments: 0, messages: 2 });
      expect((await msgBodies(p.org)).sort()).toEqual([`anfrage ${kept}`, "waise-extern", "waise-neu", "waise-zugeordnet"].sort());
      const audit = (await f.asOrg(p.org, (c) => c.query("select meta from audit_log where organization_id = $1 and action = 'retention.online_requests'", [p.org]))).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].meta).toMatchObject({ appointments: 0, messages: 2 });
    });

    it("Lauf über alle Praxen: ohne akzeptierte AVV 0.3 wird nichts gelöscht (übersprungen)", async () => {
      const p = await practice();
      const id = await request(p.org);
      await f.pool.query("update organizations set settings = jsonb_set(settings, '{legalAcceptance,avv}', '\"0.2\"') where id = $1", [p.org]);
      const all = await ret.purgeStaleOnlineRequestsAll();
      expect(all.skipped).toBeGreaterThanOrEqual(1);
      expect(await apptIds(p.org)).toEqual([id]);
      await f.pool.query("update organizations set settings = settings - 'legalAcceptance' where id = $1", [p.org]);
      await ret.purgeStaleOnlineRequestsAll();
      expect(await apptIds(p.org)).toEqual([id]);
      await f.pool.query("update organizations set settings = jsonb_set(settings, '{legalAcceptance}', '{\"avv\":\"0.3\",\"agb\":\"0.3\"}') where id = $1", [p.org]);
      await ret.purgeStaleOnlineRequestsAll();
      expect(await apptIds(p.org)).toEqual([]);
    });

    it("Nachricht einer anderen (nicht gelöschten) Anfrage bleibt, auch wenn sie alt ist", async () => {
      const p = await practice();
      const confirmed = await request(p.org, { status: "confirmed" });
      await request(p.org);
      expect(await ret.purgeStaleOnlineRequests(p.org)).toEqual({ appointments: 1, messages: 1 });
      expect(await msgBodies(p.org)).toEqual([`anfrage ${confirmed}`]);
    });

    it("andere Praxis (RLS): Lauf für Praxis A lässt Praxis B unberührt; Lauf über alle Praxen zählt beide", async () => {
      const a = await practice();
      const b = await practice();
      await request(a.org);
      const bId = await request(b.org);
      expect(await ret.purgeStaleOnlineRequests(a.org)).toEqual({ appointments: 1, messages: 1 });
      expect(await apptIds(b.org)).toEqual([bId]);
      const all = await ret.purgeStaleOnlineRequestsAll();
      expect(all.errors).toBe(0);
      expect(all.appointments).toBeGreaterThanOrEqual(1);
      expect(await apptIds(b.org)).toEqual([]);
    });

    it("echte /buchen-Anfrage trägt das Kennzeichen an Termin und Nachricht", async () => {
      const { bookAction } = await import("@/app/buchen/[slug]/actions");
      const p = await practice();
      const [{ slug }] = (await f.pool.query("select slug from organizations where id = $1", [p.org])).rows;
      const opts = (await pb.publicBookingOptions(p.org))!;
      const day = opts.days.find((d) => (d.slots[30] ?? []).length);
      expect(day, "freier Tag").toBeTruthy();
      const form = new FormData();
      for (const [k, v] of Object.entries({ slug, serviceId: p.kos, date: day!.date, time: day!.slots[30][0], firstName: "Olga", lastName: "Test", phone: "0151 7654321", noShow: "on" })) form.set(k, v);
      const r = await bookAction(undefined, form);
      expect(r?.error).toBeUndefined();
      const [appt] = (await f.asOrg(p.org, (c) => c.query("select id, external_id, source from appointments where organization_id = $1", [p.org]))).rows;
      expect(appt.external_id).toBe(`online-request:${appt.id}`);
      expect(appt.source).toBe("online");
      const [msg] = (await f.asOrg(p.org, (c) => c.query("select thread_key, direction, external_id, meta from messages where organization_id = $1", [p.org]))).rows;
      // Name strukturiert (für das Schwärzen vor einem KI-Antwortvorschlag)
      expect(msg).toEqual({ thread_key: `online-request:${appt.id}`, direction: "inbound", external_id: null, meta: { onlineRequest: { firstName: "Olga", lastName: "Test" } } });
    });
  });
});

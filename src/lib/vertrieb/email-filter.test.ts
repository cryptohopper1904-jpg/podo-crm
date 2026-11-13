import { describe, expect, it } from "vitest";
import { acceptedEmails, classifyEmail, decodeEntities, deobfuscate, extractEmails, pickBestEmail } from "./email-filter";

const PETRA = "Podologie Petra Müller";

describe("classifyEmail – Funktionspostfächer; Namensbezug nie aus OSM/ohne eigene Website", () => {
  it("akzeptiert typische Praxis-Adressen", () => {
    for (const e of [
      "info@praxis.example",
      "praxis@fuss.example",
      "kontakt@podo.example",
      "termin@x.example",
      "termine@x.example",
      "mail@x.example",
      "office@x.example",
      "empfang@x.example",
      "service@x.example",
      "podologie@x.example",
      "fusspflege@x.example",
      "hallo@x.example",
      "team@x.example",
      "INFO@Praxis.Example",
      "info.podologie@x.example",
      "podologiepraxis@x.example",
      "info2024@x.example",
      "info-potsdam@x.example",
      "praxis.kernfuss@kernfuss.example",
    ]) {
      const v = classifyEmail(e, { practiceName: PETRA, city: "Potsdam", websiteHost: "www.kernfuss.example" });
      expect(v, e).toMatchObject({ ok: true, kind: "role" });
    }
  });

  it("verwirft Adressen mit Personenbezug (auch zusammen mit Funktionswörtern)", () => {
    for (const e of [
      "anna.mueller@praxis.example",
      "a.mueller@praxis.example",
      "mueller@praxis.example",
      "mueller-podologie@praxis.example",
      "podologie-mueller@praxis.example",
      "praxis.petra@praxis.example",
      "petra.praxis@praxis.example",
      "info.mueller@praxis.example",
      "infomueller@praxis.example",
      "praxismueller@praxis.example",
      "praxis-mueller@praxis.example",
      "fusspflege.petra.mueller@praxis.example",
      "kontakt.anna@praxis.example",
      "termine-schmidt@praxis.example",
      "hi.anna@praxis.example",
      "team-petra@praxis.example",
      "mail.petra@praxis.example",
      "informatik@praxis.example",
      "annaschulz@praxis.example",
      "a_schulz@praxis.example",
    ]) {
      expect(classifyEmail(e, { practiceName: PETRA, city: "Potsdam", websiteHost: "praxis.example" }).ok, e).toBe(false);
    }
    expect(classifyEmail("schmidt@praxis.example", "Fußpflege Schmidt-Weber")).toMatchObject({ ok: false, reason: expect.stringMatching(/Namen/) });
  });

  it("verwirft noreply, Datenschutz, Platzhalter-Domains und Dateinamen", () => {
    for (const e of ["noreply@praxis.example", "no-reply@praxis.de", "datenschutz@praxis.de", "webmaster@praxis.de", "bewerbung@praxis.de", "info@example.com", "info@ihre-domain.de", "logo@2x.png", "kein-at-zeichen"]) {
      expect(classifyEmail(e, "Praxis").ok, e).toBe(false);
    }
  });
});

describe("Geschäftsadressen mit Namen (Standard an; nur eigene Website, eigene Domain)", () => {
  const own = { practiceName: PETRA, websiteHost: "www.podo-mueller.example", crawled: true };

  it("akzeptiert Namensbezug auf der Domain der Praxis-Website", () => {
    for (const e of ["praxis.petra@podo-mueller.example", "mueller-podologie@podo-mueller.example", "info.mueller@podo-mueller.example", "praxismueller@podo-mueller.example"]) {
      expect(classifyEmail(e, own), e).toMatchObject({ ok: true, kind: "named" });
    }
    expect(classifyEmail("info@podo-mueller.example", own)).toMatchObject({ ok: true, kind: "role" });
  });

  it("verwirft Fremd-/Freemail-Domains, OSM-Herkunft und Postfächer ohne Praxisbezug", () => {
    expect(classifyEmail("praxis.petra@andere.example", own).ok).toBe(false);
    expect(classifyEmail("praxis.petra@gmx.de", own).ok).toBe(false);
    expect(classifyEmail("praxis.petra@podo-mueller.example", { ...own, crawled: false }).ok).toBe(false);
    // ausdrücklich ausgeschaltet → nur Funktionspostfächer (die Negativliste von oben gilt auch auf eigener Domain)
    for (const e of ["praxis.petra@podo-mueller.example", "mueller-podologie@podo-mueller.example", "infomueller@podo-mueller.example", "team-petra@podo-mueller.example"]) {
      expect(classifyEmail(e, { ...own, allowNamed: false }).ok, e).toBe(false);
    }
    expect(classifyEmail("info@podo-mueller.example", { ...own, allowNamed: false })).toMatchObject({ ok: true, kind: "role" });
    expect(classifyEmail("petra.mueller@podo-mueller.example", own).ok).toBe(false);
    expect(classifyEmail("anna@podo-mueller.example", own).ok).toBe(false);
  });

  it("Funktionspostfach wird vor Namensadresse gewählt", () => {
    expect(acceptedEmails(["praxis.petra@podo-mueller.example", "kontakt@podo-mueller.example"], own)).toEqual([
      { email: "kontakt@podo-mueller.example", kind: "role" },
      { email: "praxis.petra@podo-mueller.example", kind: "named" },
    ]);
  });
});

describe("Verschleierungen und Extraktion", () => {
  it("löst gängige Schreibweisen auf", () => {
    expect(deobfuscate("info [at] praxis [dot] de")).toBe("info@praxis.de");
    expect(deobfuscate("info(at)praxis.de")).toBe("info@praxis.de");
    expect(deobfuscate("info {ät} praxis (punkt) de")).toBe("info@praxis.de");
    expect(deobfuscate("Schreiben Sie an info at praxis dot de!")).toBe("Schreiben Sie an info@praxis.de!");
    expect(deobfuscate("Wir sind at home")).toBe("Wir sind at home");
    expect(deobfuscate("Termine at Praxis.de")).toBe("Termine at Praxis.de");
    expect(decodeEntities("info&#64;praxis&#x2E;de &commat;")).toBe("info@praxis.de @");
  });

  it("findet mailto-Links und Text, ignoriert Skripte", () => {
    const html = `
      <a href="mailto:Info%40Praxis.example?subject=Termin">Mail</a>
      <p>Termine: termine [at] praxis [dot] example</p>
      <p>kontakt&#64;praxis.example</p>
      <script>var x = "tracking@sentry.io";</script>
      <img src="logo@2x.png">`;
    expect(extractEmails(html).sort()).toEqual(["info@praxis.example", "kontakt@praxis.example", "termine@praxis.example"]);
  });

  it("wählt die beste zulässige Adresse; von der Website nur eigene Domain oder Freemail", () => {
    const c = ["anna.mueller@praxis.de", "kontakt@praxis.de", "info@anbieter.example", "info@praxis.de"];
    expect(pickBestEmail(c, { practiceName: PETRA, websiteHost: "www.praxis.de" })).toBe("info@praxis.de");
    expect(acceptedEmails(c, { practiceName: PETRA, websiteHost: "praxis.de" }).map((x) => x.email)).toEqual(["info@praxis.de", "kontakt@praxis.de", "info@anbieter.example"]);
    expect(acceptedEmails(c, { practiceName: PETRA, websiteHost: "praxis.de", crawled: true }).map((x) => x.email)).toEqual(["info@praxis.de", "kontakt@praxis.de"]);
    expect(pickBestEmail(["info@webagentur.example", "praxis@gmx.de"], { websiteHost: "praxis.de", crawled: true })).toBe("praxis@gmx.de");
    expect(pickBestEmail(["anna.mueller@praxis.de"], { practiceName: PETRA, websiteHost: "praxis.de" })).toBeNull();
  });
});

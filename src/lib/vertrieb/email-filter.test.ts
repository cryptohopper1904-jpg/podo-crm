import { describe, expect, it } from "vitest";
import { acceptedEmails, classifyEmail, decodeEntities, deobfuscate, extractEmails, pickBestEmail } from "./email-filter";

describe("classifyEmail – nur Funktionspostfächer", () => {
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
      "praxis-mueller@x.example",
      "podologiepraxis@x.example",
      "info2024@x.example",
    ]) {
      expect(classifyEmail(e, "Podologie Müller").ok, e).toBe(true);
    }
  });

  it("verwirft Adressen, die nach einer Person aussehen", () => {
    expect(classifyEmail("anna.mueller@praxis.example", "Podologie Müller")).toMatchObject({ ok: false });
    expect(classifyEmail("a.mueller@praxis.example", "Podologie Müller")).toMatchObject({ ok: false });
    expect(classifyEmail("mueller@praxis.example", "Podologie Müller")).toMatchObject({ ok: false, reason: expect.stringMatching(/Praxisnamen/) });
    expect(classifyEmail("schmidt@praxis.example", "Fußpflege Schmidt-Weber")).toMatchObject({ ok: false, reason: expect.stringMatching(/Praxisnamen/) });
    expect(classifyEmail("anna.schulz@gmail.example", "Fußpflege am Markt")).toMatchObject({ ok: false });
    expect(classifyEmail("a_schulz@praxis.example", "Fußpflege am Markt")).toMatchObject({ ok: false });
    expect(classifyEmail("annaschulz@praxis.example", "Fußpflege am Markt").ok).toBe(false);
  });

  it("verwirft noreply, Datenschutz, Platzhalter-Domains und Dateinamen", () => {
    for (const e of ["noreply@praxis.example", "no-reply@praxis.de", "datenschutz@praxis.de", "webmaster@praxis.de", "bewerbung@praxis.de", "info@example.com", "info@ihre-domain.de", "logo@2x.png", "kein-at-zeichen"]) {
      expect(classifyEmail(e, "Praxis").ok, e).toBe(false);
    }
  });
});

describe("Verschleierungen und Extraktion", () => {
  it("löst gängige Schreibweisen auf", () => {
    expect(deobfuscate("info [at] praxis [dot] de")).toBe("info@praxis.de");
    expect(deobfuscate("info(at)praxis.de")).toBe("info@praxis.de");
    expect(deobfuscate("info {ät} praxis (punkt) de")).toBe("info@praxis.de");
    expect(deobfuscate("Schreiben Sie an info at praxis dot de!")).toBe("Schreiben Sie an info@praxis.de!");
    expect(deobfuscate("Wir sind at home")).toBe("Wir sind at home");
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

  it("wählt die beste zulässige Adresse (eigene Domain, info vor kontakt)", () => {
    const c = ["anna.mueller@praxis.de", "kontakt@praxis.de", "info@anbieter.example", "info@praxis.de"];
    expect(pickBestEmail(c, "Podologie Müller", "www.praxis.de")).toBe("info@praxis.de");
    expect(acceptedEmails(c, "Podologie Müller", "praxis.de")).toEqual(["info@praxis.de", "kontakt@praxis.de", "info@anbieter.example"]);
    expect(pickBestEmail(["anna.mueller@praxis.de"], "Podologie Müller", "praxis.de")).toBeNull();
  });
});

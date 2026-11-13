/**
 * Regressionstests aus dem Appsec-Review (feindliche Eingaben, 200 KB): jede Funktion muss linear bleiben.
 * Grenze 50 ms je Fall (gemessen nach einem Aufwärmlauf, damit JIT-Kompilierung nicht mitzählt).
 */
import { describe, expect, it } from "vitest";
import { acceptedEmails, decodeEntities, deobfuscate, extractEmails, normalizeEmailAddress, registrableDomain, sameSite } from "./email-filter";
import { anchors, stripHtml, wildcardMatch } from "./html-scan";
import { findContactLink, isPlatformHost, looksLikeChallenge, normalizeWebsite, robotsAllows } from "./lead-search";

const N = 200 * 1024;
const ms = (f: () => unknown) => {
  f();
  const s = performance.now();
  f();
  return performance.now() - s;
};

const longPath = "/" + "a".repeat(2047);
const rule = "Disallow: /" + "*a".repeat(16) + "a".repeat(512 - 34) + "b\n";
const robots = "User-agent: *\n" + rule.repeat(Math.floor(N / rule.length));
const rule2 = "Disallow: /*" + "a".repeat(509) + "b\n";
const robots2 = "User-agent: *\n" + rule2.repeat(Math.floor(N / rule2.length));

const CASES: [string, () => unknown][] = [
  ["mailto dots trailing", () => extractEmails("<a href=mailto:a" + ".".repeat(N - 20) + "x>")],
  ["mailto ;,; trailing", () => extractEmails("mailto:" + ".,;:".repeat(N / 4) + "x")],
  ["normalize 50k dots", () => normalizeEmailAddress("a" + ".".repeat(50_000) + "x")],
  ["text many @ digits", () => extractEmails("1.".repeat(32) + "@" + ("1.".repeat(100) + "@").repeat(N / 203))],
  ["text @ a-labels", () => extractEmails(("a".repeat(60) + "@" + "a-".repeat(120) + " ").repeat(N / 306))],
  ["text @ labels 1char", () => extractEmails(("a.".repeat(30) + "@" + "a.".repeat(125) + "1 ").repeat(N / 320))],
  ["deob at-chain", () => deobfuscate(("xx at " + "ab dot ".repeat(50) + "zz! ").repeat(N / 360))],
  ["deob at at at", () => deobfuscate(" at".repeat(N / 3))],
  ["deob dot at dot", () => deobfuscate(("ab at " + "at dot ".repeat(200) + "q ").repeat(N / 1410))],
  ["deob brackets", () => deobfuscate(" ( ".repeat(N / 3))],
  ["deob [ at", () => deobfuscate("[ at ".repeat(N / 5))],
  ["deob whitespace runs", () => deobfuscate(" ".repeat(N) + "(")],
  ["entities", () => decodeEntities("&#x1111111".repeat(N / 10))],
  ["strip open script", () => stripHtml("<script>" + "<".repeat(N))],
  ["anchors many", () => anchors(("<a href=" + "h".repeat(2000) + ">" + "x".repeat(10)).repeat(N / 2020))],
  ["anchors href spaces", () => anchors(("<a href" + " ".repeat(2040) + ">").repeat(N / 2050))],
  ["anchors hrefhref", () => anchors(("<a " + "href ".repeat(400) + ">").repeat(N / 2005))],
  ["anchors no </a", () => anchors(("<a x>" + "<".repeat(1995)).repeat(N / 2000))],
  ["contactlink", () => findContactLink(("<a href=/impressum" + "x".repeat(1900) + ">kontakt</a>").repeat(N / 1930), "https://x.de/")],
  ["robots 200KB worst, path 2K", () => robotsAllows(robots, longPath)],
  ["robots 200KB worst, path 16K", () => robotsAllows(robots, "/" + "a".repeat(16000))],
  ["robots 1-star, path 2K", () => robotsAllows(robots2, longPath)],
  ["robots comment/colon lines", () => robotsAllows(("a" + " ".repeat(1000) + "x\n").repeat(N / 1003), "/")],
  ["robots 500KB #", () => robotsAllows("#".repeat(500_000), "/")],
  ["challenge", () => looksLikeChallenge(200, new Headers(), "<title>" + " ".repeat(20000))],
  ["normalizeWebsite", () => normalizeWebsite("a.".repeat(149) + "1")],
  ["isPlatformHost", () => isPlatformHost("a-".repeat(5000) + ".googlex.de")],
];

describe("ReDoS-Regression (Appsec): < 50 ms je feindlicher Eingabe", () => {
  for (const [name, f] of CASES) {
    it(name, () => {
      expect(ms(f)).toBeLessThan(50);
    });
  }

  it("Grenzen: lange Pfade/zu viele Schritte gelten als verboten, Satzzeichen am Ende entfernt", () => {
    expect(robotsAllows("User-agent: *\nAllow: /", "/" + "a".repeat(3000))).toBe(false);
    expect(robotsAllows(robots, longPath)).toBe(false);
    expect(wildcardMatch("/*a*b", "/" + "a".repeat(100), { steps: 10 })).toBeNull();
    expect(normalizeEmailAddress("info@praxis.de.;")).toBe("info@praxis.de");
    expect(normalizeEmailAddress("x".repeat(321))).toBeNull();
    expect(extractEmails(`<a href="mailto:info@praxis.de">x</a> und kontakt@praxis.de.`).sort()).toEqual(["info@praxis.de", "kontakt@praxis.de"]);
  });
});

describe("Domain-Regeln (Appsec M1/N1/N2)", () => {
  const ctx = (o: object) => ({ practiceName: "Podologische Praxis am Markt", city: "Potsdam", websiteHost: "www.petra-schmidt.de", ...o });

  it("Domainname der Website zählt nur bei eigener Domain und ohne Vornamen", () => {
    for (const e of ["info.petraschmidt@gmx.de", "praxis-petraschmidt@web.de", "petraschmidt.info@t-online.de", "info.schmidt@gmx.de", "praxis.petra@gmx.de", "info.petra@fremd.de"]) {
      expect(acceptedEmails([e], ctx({ crawled: true })), e).toEqual([]);
      expect(acceptedEmails([e], ctx({ crawled: false })), e).toEqual([]);
    }
    expect(acceptedEmails(["info.podokern@podokern.de"], { websiteHost: "podokern.de", crawled: true })).toEqual([{ email: "info.podokern@podokern.de", kind: "role" }]);
    expect(acceptedEmails(["info.podokern@gmx.de"], { websiteHost: "podokern.de", crawled: true })).toEqual([]);
  });

  it("Füllwörter allein sind kein Funktionspostfach", () => {
    for (const e of ["de@gmx.de", "am.im@gmx.de", "und@praxis.de", "fuer.de@praxis.de"]) expect(acceptedEmails([e], { websiteHost: "praxis.de" }), e).toEqual([]);
    expect(acceptedEmails(["praxis.am.potsdam@praxis.de"], { websiteHost: "praxis.de", city: "Potsdam" })).toHaveLength(1);
  });

  it("nur eigene Domain oder Unterdomain, nie übergeordnete/Plattform-Domain", () => {
    expect(registrableDomain("www.praxis.co.uk")).toBe("praxis.co.uk");
    expect(registrableDomain("mueller.wixsite.com")).toBe("mueller.wixsite.com");
    expect(sameSite("praxis.de", "www.praxis.de")).toBe(true);
    expect(sameSite("mail.praxis.de", "praxis.de")).toBe(true);
    expect(sameSite("google.com", "sites.google.com")).toBe(false);
    expect(sameSite("wixsite.com", "mueller.wixsite.com")).toBe(false);
    expect(sameSite("co.uk", "mueller.co.uk")).toBe(false);
    expect(acceptedEmails(["praxis.anna@google.com"], { practiceName: "Podologie Anna", websiteHost: "sites.google.com", crawled: true })).toEqual([]);
    expect(acceptedEmails(["praxis.mueller@wixsite.com"], { practiceName: "Podologie Müller", websiteHost: "mueller.wixsite.com", crawled: true })).toEqual([]);
    expect(acceptedEmails(["praxis.mueller@co.uk"], { practiceName: "Podologie Müller", websiteHost: "mueller.co.uk", crawled: true })).toEqual([]);
  });
});

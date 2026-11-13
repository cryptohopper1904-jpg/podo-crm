import { describe, expect, it } from "vitest";
import {
  buildDedupeKeys,
  buildOverpassQuery,
  duplicateBeforeEmail,
  duplicateEmail,
  findContactLink,
  haversineKm,
  inRing,
  isPodiatry,
  looksLikeChallenge,
  nextRing,
  normalizeLeadSearch,
  normalizeWebsite,
  parseCoordinates,
  parseOverpass,
  rememberLead,
  robotsAllows,
  websiteHostKey,
} from "./lead-search";

const center = { lat: 52.4, lon: 13.0 };
/** Punkt ~d km nördlich des Zentrums */
const north = (km: number) => ({ lat: center.lat + km / 111.195, lon: center.lon });

describe("Ring-Logik", () => {
  it("nächster Ring, Ende am Höchstradius", () => {
    expect(nextRing({ doneKm: 0, ringKm: 10, maxKm: 150 })).toEqual({ innerKm: 0, outerKm: 10 });
    expect(nextRing({ doneKm: 10, ringKm: 10, maxKm: 150 })).toEqual({ innerKm: 10, outerKm: 20 });
    expect(nextRing({ doneKm: 140, ringKm: 15, maxKm: 150 })).toEqual({ innerKm: 140, outerKm: 150 });
    expect(nextRing({ doneKm: 150, ringKm: 10, maxKm: 150 })).toBeNull();
  });

  it("Entfernung und Ringgrenzen", () => {
    expect(haversineKm(center, north(10))).toBeCloseTo(10, 1);
    expect(haversineKm({ lat: 52.52, lon: 13.405 }, { lat: 48.137, lon: 11.575 })).toBeCloseTo(504, -1);
    expect(inRing(0, { innerKm: 0, outerKm: 10 })).toBe(true);
    expect(inRing(10, { innerKm: 0, outerKm: 10 })).toBe(true);
    expect(inRing(10, { innerKm: 10, outerKm: 20 })).toBe(false);
    expect(inRing(10.1, { innerKm: 10, outerKm: 20 })).toBe(true);
  });

  it("Einstellungen robust lesen, Koordinaten erkennen", () => {
    expect(normalizeLeadSearch(null)).toMatchObject({ enabled: false, center: null, ringKm: 10, maxKm: 150, doneKm: 0 });
    expect(normalizeLeadSearch({ enabled: true, center: { lat: 99, lon: 0 }, ringKm: 1000 })).toMatchObject({ enabled: true, center: null, ringKm: 10 });
    expect(parseCoordinates("52.39, 13.06")).toEqual({ lat: 52.39, lon: 13.06 });
    expect(parseCoordinates("14467 Potsdam")).toBeNull();
    expect(parseCoordinates("95, 13")).toBeNull();
  });
});

describe("Overpass", () => {
  it("Abfrage enthält Tags, Namensmuster und Außenradius", () => {
    const q = buildOverpassQuery(center, 20);
    expect(q).toContain('nwr["healthcare"="podiatrist"](around:20000,52.40000,13.00000);');
    expect(q).toContain('["name"~"podolog|fu(ß|ss)pflege",i]');
    expect(q).toMatch(/\[timeout:\d+\]/);
  });

  it("Fachfilter: Podologie ja, Nagelstudio nein", () => {
    expect(isPodiatry({ healthcare: "podiatrist", name: "Praxis A" })).toBe(true);
    expect(isPodiatry({ "healthcare:speciality": "podiatry", name: "Praxis B" })).toBe(true);
    expect(isPodiatry({ name: "Medizinische Fußpflege C" })).toBe(true);
    expect(isPodiatry({ name: "FUSSPFLEGE D" })).toBe(true);
    expect(isPodiatry({ shop: "beauty", beauty: "nails", name: "Nails & Fußpflege" })).toBe(false);
    expect(isPodiatry({ shop: "beauty", name: "Kosmetikstudio" })).toBe(false);
  });

  it("übersetzt Elemente in Praxen im Ring", () => {
    const p5 = north(5);
    const p15 = north(15);
    const json = {
      elements: [
        { type: "node", id: 1, lat: p5.lat, lon: p5.lon, tags: { healthcare: "podiatrist", name: "Podologie Nah", email: "info@nah.example; anna@nah.example", website: "www.nah.example", "addr:postcode": "14467", "addr:city": "Potsdam" } },
        { type: "way", id: 2, center: p15, tags: { name: "Fußpflege Fern", "contact:website": "http://fern.example/start" } },
        { type: "node", id: 3, lat: p5.lat, lon: p5.lon, tags: { shop: "beauty", beauty: "nails", name: "Nagelstudio Fußpflege" } },
        { type: "node", id: 4, lat: p5.lat, lon: p5.lon, tags: { healthcare: "podiatrist" } },
        { type: "node", id: 1, lat: p5.lat, lon: p5.lon, tags: { healthcare: "podiatrist", name: "Podologie Nah" } },
      ],
    };
    const r1 = parseOverpass(json, center, { innerKm: 0, outerKm: 10 });
    expect(r1).toEqual([{ osmId: "node/1", name: "Podologie Nah", emails: ["info@nah.example", "anna@nah.example"], website: "https://www.nah.example/", zip: "14467", city: "Potsdam", distanceKm: 5 }]);
    const r2 = parseOverpass(json, center, { innerKm: 10, outerKm: 20 });
    expect(r2.map((p) => [p.name, p.website, p.distanceKm])).toEqual([["Fußpflege Fern", "https://fern.example/start", 15]]);
    expect(parseOverpass({ remark: "x" }, center, { innerKm: 0, outerKm: 10 })).toEqual([]);
  });

  it("Websites normalisieren", () => {
    expect(normalizeWebsite("praxis.example")).toBe("https://praxis.example/");
    expect(normalizeWebsite("http://praxis.example/#x")).toBe("https://praxis.example/");
    expect(normalizeWebsite("https://user:pw@praxis.example")).toBeNull();
    expect(normalizeWebsite("ftp://praxis.example")).toBeNull();
    expect(normalizeWebsite("https://localhost")).toBeNull();
    expect(websiteHostKey("https://WWW.Praxis.example/x")).toBe("praxis.example");
  });
});

describe("Dubletten", () => {
  it("E-Mail (Groß/Klein), Website-Host, Name+PLZ, Sperrliste", () => {
    const k = buildDedupeKeys([{ email: "Info@Alt.example", website: "https://www.alt.example/", name: "Podologie Alt", zip: "11111" }], ["gesperrt@x.example"]);
    expect(duplicateEmail(k, "info@alt.example")).toMatch(/E-Mail/);
    expect(duplicateEmail(k, "GESPERRT@x.example")).toMatch(/Sperrliste/);
    expect(duplicateEmail(k, "info@neu.example")).toBeNull();
    expect(duplicateEmail(k, null)).toBeNull();
    expect(duplicateBeforeEmail(k, { name: "Andere", zip: "2", website: "http://alt.example" })).toMatch(/Website/);
    expect(duplicateBeforeEmail(k, { name: " podologie  ALT ", zip: "11111", website: null })).toMatch(/Name und PLZ/);
    expect(duplicateBeforeEmail(k, { name: "Podologie Alt", zip: "22222", website: null })).toBeNull();
    rememberLead(k, { name: "Neu", zip: null, website: "https://neu.example", email: "info@neu.example" });
    expect(duplicateEmail(k, "info@neu.example")).not.toBeNull();
    expect(duplicateBeforeEmail(k, { name: "Neu", zip: null, website: null })).not.toBeNull();
  });
});

describe("robots.txt, Kontaktlink, Challenge", () => {
  it("wertet Gruppen und längste Regel aus", () => {
    const r = "User-agent: *\nDisallow: /intern/\nAllow: /intern/impressum\n\nUser-agent: BadBot\nDisallow: /\n";
    expect(robotsAllows(r, "/")).toBe(true);
    expect(robotsAllows(r, "/intern/x")).toBe(false);
    expect(robotsAllows(r, "/intern/impressum")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /", "/impressum")).toBe(false);
    expect(robotsAllows("User-agent: PodoHero-Praxissuche\nDisallow: /\n\nUser-agent: *\nAllow: /", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow:", "/x")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /*.php$", "/index.php")).toBe(false);
    expect(robotsAllows("", "/x")).toBe(true);
  });

  it("findet Impressum (bevorzugt) auf derselben Website", () => {
    const html = `<a href="/kontakt">Kontakt</a> <a href="https://andere.example/impressum">Impressum</a> <a href="impressum.html"><span>Impressum</span></a>`;
    expect(findContactLink(html, "https://www.praxis.example/")).toBe("https://www.praxis.example/impressum.html");
    expect(findContactLink(`<a href="/kontakt/">Kontakt</a>`, "https://praxis.example/")).toBe("https://praxis.example/kontakt/");
    expect(findContactLink(`<a href="mailto:info@x.de">Kontakt</a>`, "https://praxis.example/")).toBeNull();
  });

  it("erkennt Bot-Abwehr", () => {
    const h = new Headers();
    expect(looksLikeChallenge(403, h, "")).toBe(true);
    expect(looksLikeChallenge(200, new Headers({ "cf-mitigated": "challenge" }), "")).toBe(true);
    expect(looksLikeChallenge(200, h, "<title>Just a moment...</title>")).toBe(true);
    expect(looksLikeChallenge(200, h, "<title>Praxis</title><div class='g-recaptcha'></div>")).toBe(false);
  });
});

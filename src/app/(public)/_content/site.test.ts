import { describe, expect, it } from "vitest";
import { absoluteUrl, pageMeta, publicSiteMetadata, signupOpen, siteIndexable, siteUrl, trialRequestHref } from "./site";

/** Canonical/Open Graph/robots der öffentlichen Website kommen zur Laufzeit aus PUBLIC_URL und PUBLIC_SITE_INDEX. */
describe("Website: Basis-URL und Indexierung", () => {
  it("Canonical wird gegen PUBLIC_URL aufgelöst (metadataBase + relativer Pfad)", () => {
    const env = { PUBLIC_URL: "https://www.podo.example/", PUBLIC_SITE_INDEX: "true", NODE_ENV: "production" };
    const base = publicSiteMetadata(env).metadataBase;
    expect(base?.toString()).toBe("https://www.podo.example/");
    const canonical = pageMeta({ title: "Vergleich", description: "x", path: "/vergleich/pododesk" }).alternates.canonical;
    expect(new URL(canonical, base!).toString()).toBe("https://www.podo.example/vergleich/pododesk");
    expect(absoluteUrl("/wissen", env)).toBe("https://www.podo.example/wissen");
  });

  it("indexiert nur mit PUBLIC_SITE_INDEX=true UND gültiger PUBLIC_URL", () => {
    expect(publicSiteMetadata({ PUBLIC_URL: "https://www.podo.example", PUBLIC_SITE_INDEX: "true" }).robots).toEqual({ index: true, follow: true });
    expect(publicSiteMetadata({ PUBLIC_URL: "https://www.podo.example" }).robots).toEqual({ index: false, follow: false });
    expect(siteIndexable({ PUBLIC_SITE_INDEX: "true" })).toBe(false);
    expect(siteIndexable({ PUBLIC_SITE_INDEX: "true", PUBLIC_URL: "kein-url" })).toBe(false);
  });

  it("ohne PUBLIC_URL: Platzhalter statt Absturz (Build bricht nicht), keine Indexierung", () => {
    expect(siteUrl({ NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(siteUrl({ NODE_ENV: "production" })).toBe("http://localhost:3000");
    expect(publicSiteMetadata({ NODE_ENV: "production", PUBLIC_SITE_INDEX: "true" }).robots).toEqual({ index: false, follow: false });
  });
});

describe("Website: Testangebot nur bei offener Registrierung (Rechtsprüfung R1)", () => {
  it("signupOpen nur mit ALLOW_SIGNUP=true", () => {
    expect(signupOpen({ ALLOW_SIGNUP: "true" })).toBe(true);
    expect(signupOpen({})).toBe(false);
    expect(signupOpen({ ALLOW_SIGNUP: "1" })).toBe(false);
  });
  it("Testzugang anfragen: mailto nur mit gültiger PUBLIC_CONTACT_EMAIL, sonst Impressum", () => {
    expect(trialRequestHref({ PUBLIC_CONTACT_EMAIL: "info@podo.example" })).toBe("mailto:info@podo.example?subject=Testzugang%20PodoHero");
    expect(trialRequestHref({ PUBLIC_CONTACT_EMAIL: "kein mail" })).toBe("/impressum");
    expect(trialRequestHref({})).toBe("/impressum");
    // kein Einschleusen weiterer mailto-Header über einen Tippfehler in der Variable
    expect(trialRequestHref({ PUBLIC_CONTACT_EMAIL: "info@podo.example?bcc=x@y.de" })).toBe("/impressum");
  });
});

describe("Website: kein fest verdrahteter Registrierungs-Link (Rechtsprüfung R1)", () => {
  it("öffentliche Seiten verlinken /einrichtung nie unbedingt – nur über signupOpen()/TrialButton", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(process.cwd(), "src/app/(public)");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"));
    // aktion/[code]: Link erscheint nur mit gültigem Angebot, und Angebote gibt es nur bei signupOpen()
    const hits = files.filter((f) => !f.startsWith("aktion") && /href=(["`]|\{\s*["`])\/einrichtung/.test(readFileSync(join(root, f), "utf8")));
    expect(hits).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { absoluteUrl, pageMeta, publicSiteMetadata, siteIndexable, siteUrl } from "./site";

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

import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "./robots";

/** Praxis-Websites (/p/) müssen auffindbar bleiben – auch solange die PodoHero-Website selbst noch nicht indexiert wird. */
describe("robots.txt", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ohne PUBLIC_SITE_INDEX: PodoHero-Website gesperrt, Praxis-Websites erlaubt", () => {
    vi.stubEnv("PUBLIC_SITE_INDEX", "");
    expect(robots().rules).toEqual({ userAgent: "*", allow: "/p/", disallow: "/" });
  });

  it("mit PUBLIC_SITE_INDEX: Website erlaubt, App/API/persönliche Links gesperrt", () => {
    vi.stubEnv("PUBLIC_SITE_INDEX", "true");
    vi.stubEnv("PUBLIC_URL", "https://www.podo.example");
    const rules = robots().rules as { allow: string; disallow: string[] };
    expect(rules.allow).toBe("/");
    expect(rules.disallow).toEqual(expect.arrayContaining(["/api/", "/portal", "/anamnese/"]));
  });
});

import { describe, expect, it } from "vitest";
import { backHref, returnPath, withReturn } from "./back-link";

describe("backHref (sichere Rücksprung-Auswahl)", () => {
  it("übernimmt `von` derselben Elternseite mit Filtern", () => {
    expect(backHref("/kunden", "/kunden?q=Erika%20M&status=active")).toBe("/kunden?q=Erika%20M&status=active");
    expect(backHref("/kalender?datum=2026-11-13", "/kalender?datum=2026-11-10&ansicht=woche")).toBe("/kalender?datum=2026-11-10&ansicht=woche");
  });

  it("fällt ohne oder mit leerem/falschem Typ auf den Standard-Elternpfad zurück", () => {
    expect(backHref("/kunden", undefined)).toBe("/kunden");
    expect(backHref("/kunden", "")).toBe("/kunden");
    expect(backHref("/kunden", ["/kunden?q=a"])).toBe("/kunden");
  });

  it("lehnt andere Elternseiten ab (auch Unterpfade und Präfixe)", () => {
    expect(backHref("/kunden", "/rechnungen?status=open")).toBe("/kunden");
    expect(backHref("/kunden", "/kunden/neu")).toBe("/kunden");
    expect(backHref("/kunden", "/kundenx?q=a")).toBe("/kunden");
    expect(backHref("/kunden", "/kunden/../einstellungen")).toBe("/kunden");
  });

  it("verhindert offene Redirects", () => {
    for (const bad of [
      "https://evil.example/kunden",
      "//evil.example/kunden",
      "/\\evil.example",
      "javascript:alert(1)",
      "kunden?q=a",
      "/kunden?q=<script>",
      "/kunden#x",
      `/kunden?q=${"a".repeat(400)}`,
    ]) {
      expect(backHref("/kunden", bad)).toBe("/kunden");
    }
  });
});

describe("returnPath / withReturn", () => {
  it("baut Pfad + Query ohne leere Werte, Leerzeichen als %20", () => {
    expect(returnPath("/kunden", { q: "Erika M", status: "" })).toBe("/kunden?q=Erika%20M");
    expect(returnPath("/kunden", { q: "", status: undefined })).toBe("/kunden");
    expect(returnPath("/kunden", { q: "Müller" })).toBe("/kunden?q=M%C3%BCller");
  });

  it("hängt `von` nur bei gefilterter Liste an und übersteht den Hin- und Rückweg", () => {
    expect(withReturn("/kunden/1", "/kunden")).toBe("/kunden/1");
    const from = returnPath("/kunden", { q: "Erika M", status: "active" });
    const link = withReturn("/kunden/1", from);
    expect(link).toBe(`/kunden/1?von=${encodeURIComponent(from)}`);
    const von = new URL(link, "http://x").searchParams.get("von");
    expect(backHref("/kunden", von)).toBe(from);
    expect(withReturn("/kalender/neu?datum=1", "/kalender?datum=2")).toBe(`/kalender/neu?datum=1&von=${encodeURIComponent("/kalender?datum=2")}`);
  });
});

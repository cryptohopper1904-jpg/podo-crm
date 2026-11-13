import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref } from "./markdown";

describe("Markdown (Rechtstexte)", () => {
  it("lässt rohes HTML als Text stehen", () => {
    const [p] = parseMarkdown("Hallo <script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(p).toEqual({ type: "paragraph", children: [{ type: "text", value: "Hallo <script>alert(1)</script> <img src=x onerror=alert(1)>" }] });
  });

  it("verwirft unsichere Linkziele", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("/agb")).toBe("/agb");
    expect(safeHref("mailto:a@b.de")).toBe("mailto:a@b.de");
    expect(parseInline("[klick](javascript:alert(1))")).toEqual([{ type: "text", value: "klick" }, { type: "text", value: ")" }]);
    expect(parseInline("[AGB](/agb)")).toEqual([{ type: "link", href: "/agb", children: [{ type: "text", value: "AGB" }] }]);
  });

  it("markiert Platzhalter", () => {
    expect(parseInline("Betreiber: [FIRMENNAME], [ANSCHRIFT]")).toEqual([
      { type: "text", value: "Betreiber: " },
      { type: "placeholder", value: "[FIRMENNAME]" },
      { type: "text", value: ", " },
      { type: "placeholder", value: "[ANSCHRIFT]" },
    ]);
  });

  it("parst Überschriften, Listen, Tabellen und Zitate", () => {
    const blocks = parseMarkdown("# Titel\n\n> **Entwurf**\n\n- eins\n- zwei\n\n1. a\n2. b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\nText *kursiv* und `code`.");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "quote", "list", "list", "table", "hr", "paragraph"]);
    expect(blocks[0]).toMatchObject({ level: 1, id: "titel" });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ value: "eins" }], [{ value: "zwei" }]] });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[4]).toMatchObject({ head: [[{ value: "A" }], [{ value: "B" }]], rows: [[[{ value: "1" }], [{ value: "2" }]]] });
  });

  it("vergibt eindeutige Anker", () => {
    const blocks = parseMarkdown("## Löschung\n\n## Löschung");
    expect(blocks.map((b) => (b.type === "heading" ? b.id : ""))).toEqual(["loeschung", "loeschung-2"]);
  });

  it("entfernt HTML-Kommentare (interne TODOs), auch mehrzeilig", () => {
    const blocks = parseMarkdown("Name\n<!-- TODO: Telefon ergänzen -->\n\n<!--\nTODO: USt-IdNr.\n-->\nE-Mail");
    expect(JSON.stringify(blocks)).not.toContain("TODO");
    expect(blocks).toHaveLength(2);
  });
});

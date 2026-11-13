import { describe, expect, it } from "vitest";
import { brandedMailHtml, LOGO_CID } from "./mail-html";

describe("brandedMailHtml", () => {
  it("bettet das Logo per CID ein und escaped den Text", () => {
    const html = brandedMailHtml("Guten Tag,\n\nIhr Termin <b>morgen</b> & mehr: https://example.org/x.", { practiceName: "Praxis \"A\"", logo: { width: 720, height: 364 } });
    expect(html).toContain(`src="cid:${LOGO_CID}"`);
    expect(html).toContain('width="142" height="72"');
    expect(html).toContain("&lt;b&gt;morgen&lt;/b&gt; &amp; mehr");
    expect(html).toContain('<a href="https://example.org/x">https://example.org/x</a>.');
    expect(html).toContain('alt="Praxis &quot;A&quot;"');
    expect(html).not.toContain("<b>");
  });
  it("ohne Logo nur der Text", () => {
    expect(brandedMailHtml("Hallo", { practiceName: "P", logo: null })).not.toContain("<img");
  });
});

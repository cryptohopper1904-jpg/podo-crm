/**
 * HTML-Fassung einer Praxis-E-Mail mit Logo im Kopf (Inline-Bild per CID, keine externen Bilder/Tracking).
 * Der Inhalt ist exakt der Text-Teil – nur escaped, Absätze und Links lesbar gemacht.
 */
export const LOGO_CID = "praxis-logo@podohero";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** http(s)-Links im (bereits escapten) Text anklickbar machen */
const linkify = (escaped: string) => escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}">${u}</a>`);

export function brandedMailHtml(text: string, opts: { practiceName: string; logo: { width: number; height: number } | null }): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${linkify(esc(p)).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  let logo = "";
  if (opts.logo) {
    const h = Math.min(72, opts.logo.height);
    const w = Math.round((opts.logo.width / opts.logo.height) * h);
    logo = `<div style="margin:0 0 20px"><img src="cid:${LOGO_CID}" alt="${esc(opts.practiceName)}" width="${w}" height="${h}" style="display:block;border:0;max-width:100%;height:auto"></div>\n`;
  }
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:24px;background:#ffffff;color:#1f2933;font:15px/1.5 Arial,Helvetica,sans-serif"><div style="max-width:600px">\n${logo}${paragraphs}\n</div></body></html>`;
}

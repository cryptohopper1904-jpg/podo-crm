/**
 * Praxissuche: E-Mail-Adressen aus öffentlichen Webseiten herauslesen und NUR Funktionspostfächer
 * (info@, praxis@, kontakt@ …) übernehmen. Adressen, die nach einer Person aussehen (anna.mueller@,
 * a.mueller@, mueller@ bei „Podologie Müller“), werden verworfen – es werden keine Personendaten gespeichert.
 * Reine Funktionen ohne Netz (Tests: email-filter.test.ts).
 */

/** Lokalteile, die eindeutig ein Funktionspostfach der Praxis sind. */
const ROLE_WORDS = new Set([
  "info",
  "infos",
  "praxis",
  "kontakt",
  "contact",
  "termin",
  "termine",
  "terminvergabe",
  "terminanfrage",
  "mail",
  "email",
  "office",
  "empfang",
  "rezeption",
  "anmeldung",
  "service",
  "podologie",
  "podo",
  "podologe",
  "podologin",
  "fusspflege",
  "fusspflegepraxis",
  "hallo",
  "hello",
  "hi",
  "team",
  "anfrage",
  "anfragen",
  "post",
  "verwaltung",
  "buero",
  "sekretariat",
  "zentrale",
  "willkommen",
  "welcome",
  "therapie",
]);

/** Wortanfänge, die ebenfalls auf ein Funktionspostfach hindeuten (z. B. „podologiepraxis“, „info2024“). */
const ROLE_STEMS = ["info", "praxis", "kontakt", "termin", "podolog", "fusspfleg", "fussprax", "empfang", "anmeld"];

/** Funktionspostfächer, die nicht für eine Ansprache gedacht sind. */
const BLOCKED_WORDS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "nichtantworten",
  "datenschutz",
  "dsb",
  "privacy",
  "webmaster",
  "postmaster",
  "hostmaster",
  "abuse",
  "bewerbung",
  "bewerbungen",
  "jobs",
  "karriere",
  "newsletter",
  "unsubscribe",
  "abmelden",
  "rechnung",
  "rechnungen",
  "buchhaltung",
]);

/** Platzhalter- und Dienstleister-Domains, die in Seitenvorlagen auftauchen. */
const BLOCKED_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "example.de",
  "beispiel.de",
  "domain.de",
  "domain.com",
  "ihre-domain.de",
  "ihredomain.de",
  "musterdomain.de",
  "mustermann.de",
  "muster.de",
  "wixpress.com",
  "sentry.io",
  "sentry-next.wixpress.com",
  "jimdo.com",
  "godaddy.com",
];

const FILE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp", "css", "js", "pdf"]);

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.[a-z]{2,24}/gi;

export const ROLE_PRIORITY = ["info", "praxis", "kontakt", "termin", "termine", "empfang", "mail", "office", "podologie", "fusspflege", "hallo", "team", "service"];

/** „Müller“ → „mueller“, „Fußpflege“ → „fusspflege“ (für Vergleiche mit E-Mail-Lokalteilen). */
export function translit(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

export function normalizeEmailAddress(raw: string): string | null {
  const e = raw.trim().toLowerCase().replace(/^mailto:/, "").replace(/[.,;:]+$/, "");
  if (e.length > 254) return null;
  const m = e.match(EMAIL_RE);
  if (!m || m[0] !== e) return null;
  const tld = e.slice(e.lastIndexOf(".") + 1);
  if (FILE_TLDS.has(tld)) return null;
  return e;
}

const NAMED_ENTITIES: Record<string, string> = { commat: "@", period: ".", amp: "&", nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", hyphen: "-", lowbar: "_", dot: "." };

/** HTML-Entities, die für E-Mail-Adressen relevant sind (&#64; &#x40; &commat; …). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/**
 * Häufige Verschleierungen auflösen: „info [at] praxis [dot] de“, „info(at)praxis.de“, „info {ät} praxis (punkt) de“,
 * „info at praxis dot de“. Keine Umgehung technischer Schutzmaßnahmen – nur Text, der für Menschen lesbar dasteht.
 */
export function deobfuscate(text: string): string {
  let t = text
    .replace(/\s*[[({<]\s*(?:at|ät|@|et)\s*[\])}>]\s*/gi, "@")
    .replace(/\s*[[({<]\s*(?:dot|punkt|\.)\s*[\])}>]\s*/gi, ".");
  // ohne Klammern nur in eindeutiger Form „wort at domain dot tld“
  t = t.replace(/\b([a-z0-9][a-z0-9._-]{0,63})\s+(?:at|ät)\s+([a-z0-9-]+(?:\s*(?:\.|\bdot\b|\bpunkt\b)\s*[a-z0-9-]+)+)\b/gi, (_m, local: string, dom: string) => {
    const d = dom.replace(/\s*(?:\bdot\b|\bpunkt\b|\.)\s*/gi, ".");
    return /\.[a-z]{2,24}$/i.test(d) ? `${local}@${d}` : _m;
  });
  return t;
}

/** Alle E-Mail-Adressen einer HTML-Seite (mailto-Links + sichtbarer Text, verschleierte Formen aufgelöst), höchstens 50. */
export function extractEmails(html: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const e = normalizeEmailAddress(raw);
    if (e) out.add(e);
  };
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    let v = m[1];
    try {
      v = decodeURIComponent(v);
    } catch {
      /* roh weiterverwenden */
    }
    add(decodeEntities(v));
  }
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
  for (const m of deobfuscate(text).matchAll(EMAIL_RE)) add(m[0]);
  return [...out].slice(0, 50);
}

export type EmailVerdict = { ok: true; email: string } | { ok: false; email: string; reason: string };

const tokensOf = (local: string) => local.split(/[._+\-\d]+/).filter(Boolean);

/** Wörter des Praxisnamens (≥ 3 Zeichen, ohne Fachbegriffe), transliteriert – mögliche Familiennamen. */
function nameWords(practiceName: string): Set<string> {
  const generic = new Set([...ROLE_WORDS, "medizinische", "med", "praxis", "fuer", "und", "der", "die", "das", "gmbh", "ug", "zentrum", "studio", "podologische", "mobile"]);
  return new Set(
    translit(practiceName)
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !generic.has(w)),
  );
}

/**
 * Entscheidet, ob eine Adresse ein unpersönliches Funktionspostfach der Praxis ist.
 * Regel: Der Lokalteil muss ein Funktionswort enthalten (info, praxis, kontakt, termin …). Alles andere –
 * insbesondere vorname.nachname@, v.nachname@ oder nachname@ (Name aus dem Praxisnamen) – wird verworfen.
 */
export function classifyEmail(raw: string, practiceName = ""): EmailVerdict {
  const email = normalizeEmailAddress(raw);
  if (!email) return { ok: false, email: raw, reason: "ungültig" };
  const [local, domain] = email.split("@");
  if (BLOCKED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return { ok: false, email, reason: "Platzhalter-/Dienstleister-Domain" };
  const tokens = tokensOf(local);
  if (BLOCKED_WORDS.has(local) || tokens.some((t) => BLOCKED_WORDS.has(t)) || /no-?reply|do-?not-?reply/.test(local)) {
    return { ok: false, email, reason: "kein Ansprechpostfach (z. B. noreply, datenschutz)" };
  }
  const isRole = tokens.some((t) => ROLE_WORDS.has(t) || ROLE_STEMS.some((s) => t.startsWith(s)));
  if (isRole) return { ok: true, email };
  const names = nameWords(practiceName);
  if (tokens.some((t) => names.has(t))) return { ok: false, email, reason: "enthält einen Namen aus dem Praxisnamen (Person)" };
  if (/^[a-z]+[._-][a-z]+$/.test(local) || /^[a-z][._-]?[a-z]{2,}$/.test(local)) return { ok: false, email, reason: "sieht nach Vor-/Nachname aus" };
  return { ok: false, email, reason: "kein Funktionspostfach erkennbar" };
}

const rolePriority = (email: string) => {
  const tokens = tokensOf(email.split("@")[0]);
  const idx = tokens.map((t) => ROLE_PRIORITY.indexOf(t)).filter((i) => i >= 0);
  return idx.length ? Math.min(...idx) : ROLE_PRIORITY.length;
};

/** Domain der Adresse gehört zur Website der Praxis (www. ignoriert, Subdomains erlaubt)? */
export function sameSite(emailDomain: string, websiteHost: string | null | undefined): boolean {
  if (!websiteHost) return false;
  const h = websiteHost.toLowerCase().replace(/^www\./, "");
  const d = emailDomain.toLowerCase();
  return d === h || h.endsWith(`.${d}`) || d.endsWith(`.${h}`);
}

/** Alle zulässigen Adressen, beste zuerst (Domain der Website vor fremden Domains, info@ vor praxis@ vor kontakt@ …). */
export function acceptedEmails(candidates: string[], practiceName: string, websiteHost?: string | null): string[] {
  const ok = [...new Set(candidates.flatMap((c) => {
    const v = classifyEmail(c, practiceName);
    return v.ok ? [v.email] : [];
  }))];
  return ok
    .map((e, i) => ({ e, i, site: sameSite(e.split("@")[1], websiteHost) ? 0 : 1, prio: rolePriority(e) }))
    .sort((a, b) => a.site - b.site || a.prio - b.prio || a.i - b.i)
    .map((x) => x.e);
}

export function pickBestEmail(candidates: string[], practiceName: string, websiteHost?: string | null): string | null {
  return acceptedEmails(candidates, practiceName, websiteHost)[0] ?? null;
}

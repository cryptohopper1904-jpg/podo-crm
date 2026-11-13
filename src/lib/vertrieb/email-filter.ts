/**
 * Praxissuche: E-Mail-Adressen aus öffentlichen Webseiten herauslesen und NUR Funktionspostfächer
 * (info@, praxis@, kontakt@ …) übernehmen. Adressen mit Personenbezug (anna.mueller@, a.mueller@, mueller@,
 * mueller-podologie@, praxis.petra@ …) werden verworfen. Reine Funktionen ohne Netz (Tests: email-filter.test.ts).
 *
 * Regel (streng): Zuerst Namensprüfung – enthält der Lokalteil einen Namen aus dem Praxisnamen (außer
 * Fachbegriffen) oder einen gängigen Vornamen → verwerfen. Danach muss JEDES Teilstück des Lokalteils ein
 * erlaubtes Funktions-/Fachwort (feste Liste, keine beliebigen Wortanfänge), eine Zahl oder der Ort bzw. der
 * Domainname der Website sein.
 */

import { stripHtml } from "./html-scan";

/** Erlaubte Teilstücke (explizite Varianten, keine Präfix-Regel). */
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
  "terminanfragen",
  "mail",
  "email",
  "office",
  "empfang",
  "rezeption",
  "anmeldung",
  "service",
  "podologie",
  "podologische",
  "podologisch",
  "podo",
  "fusspflege",
  "fuss",
  "fusspflegepraxis",
  "podologiepraxis",
  "praxisfuerpodologie",
  "praxisfuerfusspflege",
  "hallo",
  "hello",
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

/** Füllwörter: als Teilstück erlaubt („praxis.am.markt“), zählen aber nicht als Funktionswort (de@ allein reicht nicht). */
const FILLER_WORDS = new Set(["fuer", "und", "am", "im", "de", "med", "medizinische", "zentrum"]);

/** Fachbegriffe, die im Praxisnamen stehen dürfen, ohne als Personenname zu gelten. */
const TRADE_WORDS = new Set([...ROLE_WORDS, ...FILLER_WORDS, "praxis", "podologin", "podologe", "podologen", "medizinische", "mobile", "mobil", "gmbh", "ug", "studio", "der", "die", "das", "bei", "an", "zur", "zum", "fuesse", "gesunde", "gesundheit"]);

/** Funktionspostfächer, die nicht für eine Ansprache gedacht sind. */
const BLOCKED_WORDS = new Set([
  "noreply",
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

/** Gängige Vornamen (Auswahl) – ein solches Teilstück gilt als Personenbezug, auch wenn es der Domain entspricht. */
const FIRST_NAMES = new Set(
  (
    "anna anne anja andrea angelika anke antje astrid barbara beate bettina birgit brigitte carina carmen caroline christa christiane christina christine " +
    "claudia corinna cornelia daniela diana doris dorothea elena elisabeth elke ellen emma erika eva franziska frauke gabi gabriele gisela gudrun hanna hannah " +
    "heike helga hildegard ilona ines ingrid irene iris jana jasmin jennifer jessica johanna julia juliane jutta karin katharina kathrin katja kerstin kirsten " +
    "klara kristin laura lea lena lisa luisa manuela maren maria marie marina marion marlene martina melanie michaela miriam monika nadine natalie nicole " +
    "nina olga petra rebecca regina renate rita ronja rosemarie ruth sabine sabrina sandra sara sarah silke silvia simone sonja stefanie stephanie susanne " +
    "svenja svetlana tanja tatjana theresa ulrike ursula ute vanessa vera verena viktoria yvonne " +
    "alexander andreas axel bernd christian daniel david dennis dieter dirk eric erik felix florian frank georg gerhard hans harald heiko helmut jan jens " +
    "joerg johannes jonas juergen kai karl klaus lars lukas marc marco marcus mario markus martin matthias max michael nils oliver patrick paul peter " +
    "philipp rainer ralf ralph rene robert sebastian simon stefan stephan sven thomas thorsten tim tobias torsten uwe volker werner wolfgang"
  ).split(" "),
);

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
  "jimdo.com",
  "godaddy.com",
];

/** Freemail-Anbieter, deren Adressen auch von der Website übernommen werden dürfen (sonst nur die eigene Domain). */
export const FREEMAIL_DOMAINS = new Set([
  "t-online.de",
  "gmx.de",
  "gmx.net",
  "gmx.at",
  "gmx.ch",
  "web.de",
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.de",
  "hotmail.com",
  "hotmail.de",
  "live.de",
  "icloud.com",
  "me.com",
  "posteo.de",
  "mailbox.org",
  "freenet.de",
  "arcor.de",
  "yahoo.com",
  "yahoo.de",
]);

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

/** Längenprüfung VOR jeder RegExp (fremde Eingabe); Satzzeichen am Ende per Schleife statt RegExp. */
export function normalizeEmailAddress(raw: string): string | null {
  if (raw.length > 320) return null;
  let e = raw.trim().toLowerCase();
  if (e.startsWith("mailto:")) e = e.slice(7);
  let end = e.length;
  while (end > 0 && ".,;:".includes(e[end - 1])) end--;
  e = e.slice(0, end);
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
  // Leerraum auf je ein Zeichen begrenzen (kein „\s*“ vor der Klammer → keine Rückverfolgung über Leerraum-Läufe)
  let t = text
    .replace(/\s+/g, " ")
    .replace(/ ?[[({<] ?(?:at|ät|@) ?[\])}>] ?/gi, "@")
    .replace(/ ?[[({<] ?(?:dot|punkt|\.) ?[\])}>] ?/gi, ".");
  // ohne Klammern nur in der eindeutigen Form „wort at domain dot tld“ (ausgeschriebenes „dot“/„punkt“, bekannte Endung)
  // Literal „ at “ zuerst (schnelle Suche), Lokalteil per Lookbehind – keine Prüfung an jeder Textstelle
  t = t.replace(/ at (?<=\b[a-z0-9][a-z0-9._-]{1,63} at )([a-z0-9-]{2,63}(?: (?:dot|punkt) [a-z0-9-]{2,63}){0,3}) (?:dot|punkt) (de|com|net|org|eu|info|at|ch|example)\b/g, (_m, dom: string, tld: string) => `@${dom.replace(/ (?:dot|punkt) /g, ".")}.${tld}`);
  return t;
}

const EMAIL_AT_START = new RegExp(`^(?:${EMAIL_RE.source})`, "i");
const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isLocalChar = (c: number) => isAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;

/** Alle E-Mail-Adressen einer HTML-Seite (mailto-Links + sichtbarer Text, verschleierte Formen aufgelöst), höchstens 50. */
export function extractEmails(html: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const e = normalizeEmailAddress(raw);
    if (e) out.add(e);
  };
  for (const m of html.matchAll(/mailto:([^"'?>\s]{1,320})/gi)) {
    let v = m[1];
    try {
      v = decodeURIComponent(v);
    } catch {
      /* roh weiterverwenden */
    }
    add(decodeEntities(v));
  }
  // linear (indexOf-Schleife) statt rückverfolgender RegExp über die ganze Seite (ReDoS)
  const text = decodeEntities(stripHtml(html)).replace(/\s+/g, " ");
  // Regex nur in einem Fenster um jedes „@“ (höchstens 500) – sonst prüft sie an jeder Textstelle bis zu 64 Zeichen
  const plain = deobfuscate(text);
  for (let at = plain.indexOf("@"), k = 0; at >= 0 && k < 500; at = plain.indexOf("@", at + 1), k++) {
    // Anfang des Lokalteils rückwärts suchen (höchstens 64 Zeichen), dann genau EIN verankerter Versuch
    let start = at;
    while (start > 0 && at - start < 64 && isLocalChar(plain.charCodeAt(start - 1))) start--;
    while (start < at && !isAlnum(plain.charCodeAt(start))) start++;
    if (start === at) continue;
    const seg = plain.slice(start, at + 256);
    const m = EMAIL_AT_START.exec(seg);
    if (m) add(m[0]);
  }
  return [...out].slice(0, 50);
}

export type EmailKind = "role" | "named";
export type EmailVerdict = { ok: true; email: string; kind: EmailKind } | { ok: false; email: string; reason: string };

/** Kontext der Praxis: Name (Personenbezug), Ort und Website-Host (erlaubte Teilstücke). */
export type EmailContext = {
  practiceName?: string;
  city?: string | null;
  websiteHost?: string | null;
  /** Adresse stammt von der eigenen Website/dem Impressum (nicht aus OSM) */
  crawled?: boolean;
  /**
   * Einstellung „Auch Geschäftsadressen mit Namen übernehmen“ (Standard: an; nur `false` schaltet ab):
   * zusätzlich Adressen mit Namensbezug (praxis.petra@, mueller-podologie@) – NUR von der eigenen Website
   * und NUR mit der Domain dieser Website. Aus OSM, von Fremd- oder Freemail-Domains nie.
   */
  allowNamed?: boolean;
};

const splitTokens = (local: string) => local.split(/[._+-]+/).filter(Boolean);
const lettersOnly = (s: string) => translit(s).replace(/[^a-z]/g, "");
const stripDigits = (t: string) => t.replace(/\d+$/, "");

/** Wörter des Praxisnamens (≥ 3 Buchstaben, ohne Fachbegriffe), transliteriert – mögliche Vor-/Familiennamen. */
function nameWords(practiceName: string): string[] {
  return [...new Set(translit(practiceName).split(/[^a-z]+/).filter((w) => w.length >= 3 && !TRADE_WORDS.has(w)))];
}

/** Zusätzlich erlaubte Teilstücke: Ort (ganz und in Teilen) und Domainname der Website (ohne Endung). */
function placeTokens(ctx: EmailContext): Set<string> {
  const s = new Set<string>();
  if (ctx.city) {
    s.add(lettersOnly(ctx.city));
    for (const w of translit(ctx.city).split(/[^a-z]+/)) if (w.length >= 3) s.add(w);
  }
  s.delete("");
  return s;
}

/**
 * Domainname der Website als erlaubtes Teilstück – NUR wenn die Adresse selbst die Domain der Website hat
 * (sonst würde info.petraschmidt@gmx.de bei Website petra-schmidt.de als Funktionspostfach durchgehen) und der
 * Name keinen Vornamen bzw. Namen aus dem Praxisnamen enthält.
 */
function siteLabelToken(ctx: EmailContext, emailDomain: string, names: string[]): string | null {
  if (!ctx.websiteHost || !sameSite(emailDomain, ctx.websiteHost)) return null;
  const reg = registrableDomain(ctx.websiteHost);
  const label = (reg.split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");
  if (!label) return null;
  if (names.some((n) => label.includes(n)) || [...FIRST_NAMES].some((n) => n.length >= 4 && label.includes(n))) return null;
  return label;
}

/**
 * Entscheidet, ob eine Adresse übernommen werden darf.
 *  - kind „role“: reines Funktionspostfach (Standard, siehe Regel oben)
 *  - kind „named“: Geschäftsadresse mit Namensbezug – nur wenn `allowNamed` nicht false ist, nur von der eigenen Website (`crawled`)
 *    und nur mit deren Domain (keine Freemail-/Fremddomain); mindestens ein Funktionswort ist trotzdem Pflicht.
 * `context` darf als String (nur Praxisname) übergeben werden.
 */
export function classifyEmail(raw: string, context: string | EmailContext = {}): EmailVerdict {
  const ctx: EmailContext = typeof context === "string" ? { practiceName: context } : context;
  const email = normalizeEmailAddress(raw);
  if (!email) return { ok: false, email: raw, reason: "ungültig" };
  const [local, domain] = email.split("@");
  if (BLOCKED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return { ok: false, email, reason: "Platzhalter-/Dienstleister-Domain" };
  const tokens = splitTokens(local);
  const letters = local.replace(/[^a-z]/g, "");
  if (!tokens.length) return { ok: false, email, reason: "ungültig" };
  if (/no-?reply|do-?not-?reply/.test(local) || tokens.some((t) => BLOCKED_WORDS.has(t))) {
    return { ok: false, email, reason: "kein Ansprechpostfach (z. B. noreply, datenschutz)" };
  }
  const names = nameWords(ctx.practiceName ?? "");
  const place = placeTokens(ctx);
  const label = siteLabelToken(ctx, domain, names);
  if (label) place.add(label);
  const isRole = (t: string) => ROLE_WORDS.has(stripDigits(t));
  const isPlain = (t: string) => /^\d+$/.test(t) || isRole(t) || FILLER_WORDS.has(t) || place.has(stripDigits(t));
  const hasRole = tokens.some(isRole) || [...ROLE_WORDS].some((r) => r.length >= 4 && tokens.some((t) => t !== r && t.includes(r)));

  // 1. Namensprüfung (auch zusammengeschrieben: „infomueller“, „praxismueller“)
  const nameHit = names.some((w) => letters.includes(w)) || tokens.some((t) => FIRST_NAMES.has(stripDigits(t)));
  if (!nameHit) {
    // 2. jedes Teilstück erlaubt?
    if (tokens.every(isPlain) && tokens.some(isRole)) return { ok: true, email, kind: "role" };
    return { ok: false, email, reason: "kein reines Funktionspostfach" };
  }
  // Namensbezug: nur im Modus „Geschäftsadressen mit Namen“, nur eigene Website + eigene Domain
  if (ctx.allowNamed === false) return { ok: false, email, reason: "enthält einen Namen (Person)" };
  if (!ctx.crawled) return { ok: false, email, reason: "Adresse mit Namen nur von der eigenen Website" };
  if (!sameSite(domain, ctx.websiteHost) || FREEMAIL_DOMAINS.has(domain)) return { ok: false, email, reason: "Adresse mit Namen nur mit der Domain der Praxis-Website" };
  if (!hasRole) return { ok: false, email, reason: "persönliches Postfach ohne Praxisbezug" };
  const isNameToken = (t: string) => {
    const w = stripDigits(t);
    if (FIRST_NAMES.has(w) || names.includes(w)) return true;
    // zusammengeschrieben: Funktionswort + Name („praxismueller“) oder umgekehrt
    return [...ROLE_WORDS].some((r) => r.length >= 4 && (w.startsWith(r) || w.endsWith(r)) && names.concat([...FIRST_NAMES]).some((n) => w === r + n || w === n + r));
  };
  if (!tokens.every((t) => isPlain(t) || isNameToken(t))) return { ok: false, email, reason: "kein Praxispostfach" };
  return { ok: true, email, kind: "named" };
}

const rolePriority = (email: string) => {
  const tokens = splitTokens(email.split("@")[0]);
  const idx = tokens.map((t) => ROLE_PRIORITY.indexOf(t)).filter((i) => i >= 0);
  return idx.length ? Math.min(...idx) : ROLE_PRIORITY.length;
};

/** Zweistufige Endungen (Auswahl) – „praxis.co.uk“ ist die Domain, nicht „co.uk“. */
const TWO_LEVEL_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "me.uk", "com.au", "net.au", "org.au", "co.at", "or.at", "co.nz", "com.br", "co.jp", "com.tr", "com.pl", "co.za", "com.cn"]);
/** Gemeinsame Hosts: jede Unterdomain ist eine eigene Website (sites.google.com, x.wixsite.com …). */
const SHARED_HOSTS = ["sites.google.com", "wixsite.com", "jimdofree.com", "jimdo.com", "jimdosite.com", "business.site", "blogspot.com", "github.io", "webnode.page", "webnode.com", "weebly.com", "wordpress.com", "squarespace.com", "netlify.app", "vercel.app", "one.com", "ionos.de", "strato.de"];

/**
 * Domain der Website, zu der Adressen gehören dürfen: letzte zwei Teile (bzw. drei bei co.uk & Co.);
 * auf gemeinsamen Hosts der volle Hostname (nie die Plattform-Domain selbst).
 */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const shared = SHARED_HOSTS.find((s) => h === s || h.endsWith(`.${s}`));
  if (shared) return h;
  const parts = h.split(".");
  const n = parts.length >= 3 && TWO_LEVEL_SUFFIXES.has(parts.slice(-2).join(".")) ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** Domain der Adresse gehört zur Website der Praxis: deren Domain oder eine Unterdomain davon – nie eine übergeordnete. */
export function sameSite(emailDomain: string, websiteHost: string | null | undefined): boolean {
  if (!websiteHost) return false;
  const reg = registrableDomain(websiteHost);
  const d = emailDomain.toLowerCase();
  if (SHARED_HOSTS.includes(reg) || TWO_LEVEL_SUFFIXES.has(reg) || !reg.includes(".")) return false;
  return d === reg || d.endsWith(`.${reg}`);
}

export type AcceptOptions = EmailContext;
export type AcceptedEmail = { email: string; kind: EmailKind };

/**
 * Alle zulässigen Adressen, beste zuerst: Funktionspostfach vor Namensbezug, Domain der Website vor fremden
 * Domains, info@ vor praxis@ vor kontakt@ … Von der Website (`crawled`) nur eigene Domain oder Freemail –
 * keine Fremddomains (z. B. Webagentur im Footer); Fremddomains nur aus OSM.
 */
export function acceptedEmails(candidates: string[], opts: AcceptOptions = {}): AcceptedEmail[] {
  const seen = new Set<string>();
  const ok: AcceptedEmail[] = [];
  for (const c of candidates) {
    const v = classifyEmail(c, opts);
    if (!v.ok || seen.has(v.email)) continue;
    const domain = v.email.split("@")[1];
    if (opts.crawled && !sameSite(domain, opts.websiteHost) && !FREEMAIL_DOMAINS.has(domain)) continue;
    seen.add(v.email);
    ok.push({ email: v.email, kind: v.kind });
  }
  return ok
    .map((x, i) => ({ x, i, k: x.kind === "role" ? 0 : 1, site: sameSite(x.email.split("@")[1], opts.websiteHost) ? 0 : 1, prio: rolePriority(x.email) }))
    .sort((a, b) => a.k - b.k || a.site - b.site || a.prio - b.prio || a.i - b.i)
    .map((y) => y.x);
}

export function pickBestEmail(candidates: string[], opts: AcceptOptions = {}): string | null {
  return acceptedEmails(candidates, opts)[0]?.email ?? null;
}

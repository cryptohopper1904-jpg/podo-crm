"use client";

/**
 * Live-Patientensuche in der Kopfzeile (ARIA 1.2 Combobox mit Listbox).
 * Ab SUGGEST_MIN_CHARS Zeichen entprellt Vorschläge von /api/patienten/vorschlaege (ältere Anfragen werden
 * abgebrochen); ohne direkten Treffer „Meintest du: …“ mit ähnlichen Namen.
 * Tastatur: ↑/↓ wählen, Enter öffnet die Akte (ohne Auswahl: Ergebnisliste /kunden?q=…), Esc schließt/leert.
 * Unter md: Lupen-Schaltfläche, die das Suchfeld als Leiste unter der Kopfzeile öffnet.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { cx } from "@/components/ui";
import { SUGGEST_MAX_CHARS, SUGGEST_MIN_CHARS } from "@/lib/patient-search";

const ENDPOINT = "/api/patienten/vorschlaege";
const DEBOUNCE_MS = 200;

type Suggestion = {
  id: string;
  number: number;
  lastName: string;
  firstName: string | null;
  birthDate: string | null;
  city: string | null;
  deceased: boolean;
};
type Result = { hits: Suggestion[]; more: boolean; didYouMean: { query: string; patients: Suggestion[] } | null };
type Option = { kind: "patient"; p: Suggestion; fuzzy: boolean } | { kind: "query"; q: string } | { kind: "all" };

const birth = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : null);
const resultsUrl = (q: string) => `/kunden?q=${encodeURIComponent(q.trim())}`;

/**
 * `pickHref`: Auswahl-Modus (z. B. Patient:in für einen Beleg wählen) – ein Treffer führt zu `pickHref + id` statt zur
 * Akte; ohne Auswahl öffnet Enter keine Ergebnisliste, und „Alle Treffer“ entfällt.
 */
function SearchBox({
  inputId,
  autoFocus,
  onDone,
  pickHref,
  label = "Patient suchen",
}: {
  inputId: string;
  autoFocus?: boolean;
  onDone?: () => void;
  pickHref?: string;
  label?: string;
}) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<AbortController | null>(null);

  function cancelSearch() {
    clearTimeout(debounce.current);
    inflight.current?.abort();
    inflight.current = null;
  }

  function search(raw: string) {
    cancelSearch();
    const q = raw.replace(/\s+/g, " ").trim();
    if (q.length < SUGGEST_MIN_CHARS || q.length > SUGGEST_MAX_CHARS) {
      setResult(null);
      setLoading(false);
      setFailed(false);
      setOpen(false);
      setActive(-1);
      return;
    }
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    debounce.current = setTimeout(async () => {
      try {
        // POST: Suchtext nicht in URL/Proxy-Logs
        const res = await fetch(ENDPOINT, {
          method: "POST",
          signal: ctrl.signal,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ q }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as Result;
        if (ctrl.signal.aborted) return;
        setResult({ hits: json.hits ?? [], more: !!json.more, didYouMean: json.didYouMean ?? null });
        setFailed(false);
      } catch {
        if (ctrl.signal.aborted) return;
        setResult(null);
        setFailed(true);
      }
      setLoading(false);
      setActive(-1);
      setOpen(document.activeElement === inputRef.current);
    }, DEBOUNCE_MS);
  }

  useEffect(
    () => () => {
      clearTimeout(blurTimer.current);
      clearTimeout(debounce.current);
      inflight.current?.abort();
    },
    [],
  );

  const options: Option[] = [];
  if (result) {
    for (const p of result.hits) options.push({ kind: "patient", p, fuzzy: false });
    if (result.didYouMean) {
      options.push({ kind: "query", q: result.didYouMean.query });
      for (const p of result.didYouMean.patients) options.push({ kind: "patient", p, fuzzy: true });
    }
    if (result.hits.length && !pickHref) options.push({ kind: "all" });
  }

  function reset() {
    cancelSearch();
    setOpen(false);
    setActive(-1);
    setLoading(false);
  }

  function choose(o: Option) {
    if (o.kind === "query") {
      setValue(o.q);
      search(o.q);
      inputRef.current?.focus();
      return;
    }
    const href = o.kind === "patient" ? (pickHref ? `${pickHref}${encodeURIComponent(o.p.id)}` : `/kunden/${o.p.id}`) : resultsUrl(value);
    reset();
    if (o.kind === "patient") {
      setValue("");
      setResult(null);
    }
    onDone?.();
    router.push(href);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!options.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % options.length : i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && options[active]) {
        e.preventDefault();
        choose(options[active]);
      }
      // ohne Auswahl: Formular-Absenden → bisherige Ergebnisseite (onSubmit)
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (open) {
        setOpen(false);
        setActive(-1);
      } else if (value) {
        setValue("");
        setResult(null);
        cancelSearch();
      } else {
        onDone?.();
      }
    }
  }

  const q = value.trim();
  const hasQuery = q.length >= SUGGEST_MIN_CHARS;
  const empty = !!result && !loading && options.length === 0;
  const showPanel = open && hasQuery && (options.length > 0 || empty || failed);
  const expanded = showPanel && options.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const status = loading
    ? ""
    : failed
      ? "Suche gerade nicht möglich"
      : empty
        ? "Keine Treffer"
        : result
          ? `${result.hits.length}${result.more ? "+" : ""} Treffer${result.didYouMean ? `, Meintest du: ${result.didYouMean.query}` : ""}`
          : "";

  return (
    <form
      action={pickHref ? undefined : "/kunden"}
      role="search"
      className="relative w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (!q || pickHref) return;
        reset();
        onDone?.();
        router.push(resultsUrl(q));
      }}
    >
      <label className="sr-only" htmlFor={inputId}>{label}</label>
      <Search size={18} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <input
        ref={inputRef}
        id={inputId}
        name="q"
        type="search"
        value={value}
        placeholder="Patient suchen …"
        maxLength={SUGGEST_MAX_CHARS}
        autoFocus={autoFocus}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        aria-describedby={`${listId}-status`}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="words"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => {
          setValue(e.target.value);
          search(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          clearTimeout(blurTimer.current);
          if (result || failed) setOpen(true);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        className="h-11 w-full rounded-xl border border-border bg-bg pl-10 pr-3.5 text-[15px] placeholder:text-muted focus:border-primary focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <div
        hidden={!showPanel}
        // Fokus bleibt im Eingabefeld (Maus und Touch), damit onBlur die Liste nicht vor dem Klick schließt
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        className="absolute left-0 right-0 z-40 mt-1 max-h-[min(28rem,70vh)] overflow-auto overscroll-contain rounded-xl border border-border bg-surface p-1 text-text shadow-lg"
      >
        {empty || failed ? (
          <p className="px-3 py-2.5 text-sm text-muted">{failed ? (pickHref ? "Suche gerade nicht möglich – bitte später erneut versuchen." : "Suche gerade nicht möglich – Enter öffnet die Patientenliste.") : "Keine Treffer – andere Schreibweise versuchen."}</p>
        ) : null}
        <ul id={listId} role="listbox" aria-label="Patientenvorschläge">
          {options.map((o, i) => {
            const isActive = i === active;
            const base = "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[15px] leading-snug";
            const tone = isActive ? "bg-primary-soft text-primary-soft-text" : "hover:bg-surface-2";
            const common = {
              id: optionId(i),
              role: "option" as const,
              "aria-selected": isActive,
              onClick: () => choose(o),
              onPointerEnter: (e: PointerEvent) => {
                if (e.pointerType === "mouse") setActive(i);
              },
            };
            if (o.kind === "query") {
              return (
                <li key={`q-${o.q}`} {...common} className={cx(base, tone, i > 0 && "mt-1 border-t border-border pt-2.5")}>
                  <span>
                    <span className="text-muted">Meintest du: </span>
                    <span className="font-semibold">{o.q}</span>
                    <span className="text-muted">?</span>
                  </span>
                </li>
              );
            }
            if (o.kind === "all") {
              return (
                <li key="all" {...common} className={cx(base, tone, "mt-1 border-t border-border pt-2.5 text-sm font-semibold text-primary")}>
                  {result?.more ? "Alle Treffer anzeigen" : "In der Patientenliste anzeigen"}
                </li>
              );
            }
            const p = o.p;
            const meta = [birth(p.birthDate) ? `geb. ${birth(p.birthDate)}` : null, `Nr. ${p.number}`, p.city].filter(Boolean).join(" · ");
            return (
              <li key={`${o.fuzzy ? "f" : "h"}-${p.id}`} {...common} className={cx(base, tone)}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">
                    {p.lastName}
                    {p.firstName ? `, ${p.firstName}` : ""}
                    {p.deceased ? <span className="ml-2 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted">verstorben</span> : null}
                  </span>
                  <span className={cx("truncate text-sm", isActive ? "opacity-80" : "text-muted")}>{meta}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <span id={`${listId}-status`} className="sr-only" aria-live="polite">
        {open && hasQuery ? status : ""}
      </span>
    </form>
  );
}

/** Kopfzeile: ab md Suchfeld, darunter Lupe → Suchleiste unter der Kopfzeile */
export function PatientSearch() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <>
      <div className="ml-auto hidden max-w-sm flex-1 md:block">
        <SearchBox inputId="q" />
      </div>
      <button
        type="button"
        aria-label={mobileOpen ? "Suche schließen" : "Patient suchen"}
        aria-expanded={mobileOpen}
        aria-controls="patient-search-mobile"
        onClick={() => setMobileOpen((v) => !v)}
        className="ml-auto inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2 md:hidden"
      >
        {mobileOpen ? <X size={19} aria-hidden /> : <Search size={19} aria-hidden />}
      </button>
      {mobileOpen ? (
        <div id="patient-search-mobile" className="absolute left-0 right-0 top-full border-b border-border bg-surface px-4 py-3 shadow-sm md:hidden">
          <SearchBox inputId="q-mobile" autoFocus onDone={() => setMobileOpen(false)} />
        </div>
      ) : null}
    </>
  );
}

/** Patient:in für einen Vorgang wählen (gleiche Live-Suche wie in der Kopfzeile); Auswahl öffnet `hrefPrefix + id`. */
export function PatientPicker({ hrefPrefix, label = "Patient:in suchen", inputId = "patient-pick" }: { hrefPrefix: string; label?: string; inputId?: string }) {
  return <SearchBox inputId={inputId} pickHref={hrefPrefix} label={label} />;
}

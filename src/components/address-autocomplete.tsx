"use client";

/**
 * Adress-Autovervollständigung (ARIA 1.2 Combobox mit Listbox) für Straße + Hausnummer.
 * Füllt bei Auswahl PLZ und Ort im selben Formular (Felder per name). Freie Eingabe bleibt immer möglich.
 * Kein Fehler-Spam: Ist der Dienst aus/nicht erreichbar, gibt es einfach keine Vorschläge.
 */
import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { cx, Input } from "@/components/ui";
import { typedHouseNumber, type AddressSuggestion } from "@/lib/address/photon";

const ENDPOINT = "/api/adresse/vorschlaege";
const DEBOUNCE_MS = 250;
/** Für die Sitzung abschalten, wenn der Dienst deaktiviert ist (ADDRESS_PROVIDER=off) */
let providerDisabled = false;

function formField(input: HTMLInputElement | null, name: string): HTMLInputElement | null {
  const el = input?.form?.elements.namedItem(name);
  return el instanceof HTMLInputElement ? el : null;
}

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: "application/json" }, credentials: "same-origin" });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    if (json.disabled) providerDisabled = true;
    return json;
  } catch {
    return null;
  }
}

type InputProps = Omit<ComponentProps<"input">, "name" | "defaultValue" | "value" | "onChange" | "role">;

export function AddressAutocomplete({
  name = "street",
  defaultValue,
  zipName = "zip",
  cityName = "city",
  className,
  ...props
}: InputProps & { name?: string; defaultValue?: string; zipName?: string; cityName?: string }) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue ?? "");
  const [items, setItems] = useState<AddressSuggestion[]>([]);
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

  /** Entprellte Abfrage; ältere Anfragen werden abgebrochen */
  function search(raw: string) {
    cancelSearch();
    const q = raw.trim();
    if (providerDisabled || q.length < 3 || q.length > 120) {
      setItems([]);
      setOpen(false);
      return;
    }
    const ctrl = new AbortController();
    inflight.current = ctrl;
    debounce.current = setTimeout(async () => {
      const json = await getJson(`${ENDPOINT}?q=${encodeURIComponent(q)}`, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const list = Array.isArray(json?.suggestions) ? (json.suggestions as AddressSuggestion[]) : [];
      setItems(list);
      setActive(-1);
      setOpen(list.length > 0 && document.activeElement === inputRef.current);
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

  function select(s: AddressSuggestion) {
    const number = s.houseNumber ?? typedHouseNumber(value);
    const street = number ? `${s.street} ${number}` : `${s.street} `;
    setValue(street);
    setOpen(false);
    setItems([]);
    setActive(-1);
    cancelSearch();
    const zip = formField(inputRef.current, zipName);
    const city = formField(inputRef.current, cityName);
    if (zip && s.zip) zip.value = s.zip;
    if (city && s.city) city.value = s.city;
    // Ohne Hausnummer: Cursor ans Ende, damit sie direkt eingetippt werden kann
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(street.length, street.length);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (!items.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        select(items[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    }
  }

  const expanded = open && items.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div className="relative">
      <Input
        {...props}
        ref={inputRef}
        name={name}
        value={value}
        className={className}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="next"
        onChange={(e) => {
          setValue(e.target.value);
          search(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          clearTimeout(blurTimer.current);
          if (items.length) setOpen(true);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Adressvorschläge"
        hidden={!expanded}
        // verhindert, dass das Eingabefeld beim Tippen/Klicken in die Liste den Fokus verliert
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-auto rounded-xl border border-border bg-surface p-1 shadow-lg"
      >
        {items.map((s, i) => (
          <li
            key={s.label}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            onClick={() => select(s)}
            onPointerEnter={(e) => {
              if (e.pointerType === "mouse") setActive(i);
            }}
            className={cx(
              "flex min-h-11 cursor-pointer flex-col justify-center rounded-lg px-3 py-2 text-[15px] leading-snug",
              i === active ? "bg-primary-soft text-primary-soft-text" : "hover:bg-surface-2",
            )}
          >
            <span className="font-medium">
              {s.street}
              {s.houseNumber ? ` ${s.houseNumber}` : ""}
            </span>
            <span className="text-sm text-muted">
              {[s.zip, s.city].filter(Boolean).join(" ")}
              {s.district ? ` (${s.district})` : ""}
            </span>
          </li>
        ))}
      </ul>
      <span className="sr-only" aria-live="polite">
        {expanded ? `${items.length} Adressvorschläge, mit Pfeiltasten auswählen` : ""}
      </span>
    </div>
  );
}

/**
 * PLZ-Feld: Bei 5 Ziffern wird der Ort ergänzt, wenn er eindeutig ist und das Ortsfeld noch leer ist
 * (oder zuvor automatisch gefüllt wurde).
 */
export function ZipInput({ cityName = "city", onChange, ...props }: Omit<ComponentProps<"input">, "type"> & { cityName?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const ctrl = useRef<AbortController | null>(null);
  const autoFilled = useRef<string | null>(null);

  useEffect(() => () => ctrl.current?.abort(), []);

  return (
    <Input
      inputMode="numeric"
      autoComplete="postal-code"
      {...props}
      ref={ref}
      onChange={(e) => {
        onChange?.(e);
        const zip = e.target.value.trim();
        ctrl.current?.abort();
        if (providerDisabled || !/^\d{5}$/.test(zip)) return;
        const c = new AbortController();
        ctrl.current = c;
        void getJson(`${ENDPOINT}?plz=${zip}`, c.signal).then((json) => {
          if (c.signal.aborted || !json) return;
          const cities = Array.isArray(json.cities) ? (json.cities as string[]) : [];
          const city = formField(ref.current, cityName);
          if (!city || cities.length !== 1) return;
          if (city.value.trim() === "" || city.value === autoFilled.current) {
            city.value = cities[0];
            autoFilled.current = cities[0];
          }
        });
      }}
    />
  );
}

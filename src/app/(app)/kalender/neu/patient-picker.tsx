"use client";

import { X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { fieldCls, fieldLabelCls, hintCls, SearchInput } from "@/components/ui";
import { matchPatients, type PickerPatient } from "@/lib/calendar-patient-search";

const display = (p: PickerPatient) => `${p.lastName}${p.firstName ? `, ${p.firstName}` : ""}`;

/**
 * Patient:in für einen neuen Termin – ein Feld: tippen (Name oder Nummer), Vorschlag antippen. Danach steht die
 * Auswahl als Zeile mit „ändern“ da. Tastatur: Pfeil hoch/runter, Enter wählt, Escape schließt die Vorschläge.
 * Termine ohne Patient:in (Pause, Schulung …) über den Reiter „Sperrzeit“.
 */
export function PatientPicker({ patients, defaultId, name, error, hint }: { patients: PickerPatient[]; defaultId: string; name: string; error?: string | null; hint: string }) {
  const [picked, setPicked] = useState<PickerPatient | null>(() => patients.find((p) => p.id === defaultId) ?? null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-liste`;
  const hits = useMemo(() => matchPatients(patients, query), [patients, query]);
  const show = open && query.trim().length > 0;

  const choose = (p: PickerPatient) => {
    setPicked(p);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className={fieldCls}>
      {picked ? (
        <span id={`${id}-label`} className={fieldLabelCls}>
          Patient:in
        </span>
      ) : (
        <label htmlFor={`${id}-suche`} className={fieldLabelCls}>
          Patient:in
        </label>
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        <input type="hidden" name={name} value={picked?.id ?? ""} />
        {picked ? (
          <div role="group" aria-labelledby={`${id}-label`} className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface-2 py-1 pr-1 pl-3.5">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
              {display(picked)} <span className="font-normal text-muted">#{picked.number}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setOpen(true);
                requestAnimationFrame(() => input.current?.focus());
              }}
              className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-3 text-sm font-semibold text-primary hover:bg-surface"
            >
              <X size={16} aria-hidden /> ändern<span className="sr-only"> (Patient:in)</span>
            </button>
          </div>
        ) : (
          <div className="relative">
            <SearchInput
              ref={input}
              id={`${id}-suche`}
              role="combobox"
              aria-expanded={show && hits.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={show && hits[active] ? `${listId}-${hits[active].id}` : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-hinweis`}
              placeholder="Name oder Nummer"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={(e) => {
                // Enter schickt nie das Formular ab, solange die Vorschläge offen sind (auch ohne Treffer)
                if (show && !hits.length && e.key === "Enter") e.preventDefault();
                if (!show || !hits.length) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => (a + 1) % hits.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => (a - 1 + hits.length) % hits.length);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  choose(hits[active]);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
            />
            {show && hits.length ? (
              <ul id={listId} role="listbox" aria-label="Vorschläge" className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg">
                {hits.map((p, i) => (
                  <li
                    key={p.id}
                    id={`${listId}-${p.id}`}
                    role="option"
                    aria-selected={i === active}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => choose(p)}
                    className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 text-[15px] ${i === active ? "bg-primary-soft text-primary-soft-text" : "hover:bg-surface-2"}`}
                  >
                    <span className="min-w-0 truncate font-semibold">{display(p)}</span>
                    <span className="shrink-0 text-sm text-muted">#{p.number}</span>
                  </li>
                ))}
              </ul>
            ) : show ? (
              <p aria-hidden className="absolute inset-x-0 top-full z-30 mt-1 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-muted shadow-lg">
                Keine Patient:in gefunden.
              </p>
            ) : null}
          </div>
        )}
        <span role="status" className="sr-only">
          {show ? (hits.length ? `${hits.length} Vorschl${hits.length === 1 ? "ag" : "äge"}` : "Keine Patient:in gefunden.") : ""}
        </span>
        {error ? <span className="text-[13px] leading-5 font-medium text-danger">{error}</span> : null}
        <span id={`${id}-hinweis`} className={hintCls}>
          {hint}
        </span>
      </div>
    </div>
  );
}

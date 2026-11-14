"use client";

import { UserPlus, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { fieldCls, fieldLabelCls, hintCls, SearchInput } from "@/components/ui";
import { matchPatients, splitNewName, type PickerPatient } from "@/lib/calendar-patient-search";
import { NewPatientInline } from "./new-patient-inline";

const display = (p: PickerPatient) => `${p.lastName}${p.firstName ? `, ${p.firstName}` : ""}`;

/**
 * Patient:in für einen neuen Termin – ein Feld: tippen (Name oder Nummer), Vorschlag antippen. Danach steht die
 * Auswahl als Zeile mit „ändern“ da. Tastatur: Pfeil hoch/runter, Enter wählt. Escape schließt zuerst die
 * Vorschläge, dann leert es das Feld – erst danach erreicht es das Fenster „Neuer Termin“ (das sich dann schließt).
 * Termine ohne Patient:in (Pause, Schulung …) über den Reiter „Sperrzeit“.
 * `canCreate` (patients.write): „+ Neue:n Patient:in … anlegen“ steht immer als letzte Zeile der Vorschläge (auch
 * wenn es Treffer gibt – Namensgleichheit ist häufig) bzw. ohne Treffer unter dem Feld; es öffnet ein kleines
 * Formular darunter, die neue Person ist danach ausgewählt (ohne Seitenwechsel).
 */
export function PatientPicker({
  patients: given,
  defaultId,
  name,
  error,
  hint,
  canCreate = false,
}: {
  patients: PickerPatient[];
  defaultId: string;
  name: string;
  error?: string | null;
  hint: string;
  canCreate?: boolean;
}) {
  const [added, setAdded] = useState<PickerPatient[]>([]);
  const patients = useMemo(() => [...added, ...given], [added, given]);
  const [creating, setCreating] = useState<{ firstName: string; lastName: string } | null>(null);
  const [picked, setPicked] = useState<PickerPatient | null>(() => given.find((p) => p.id === defaultId) ?? null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-liste`;
  const hits = useMemo(() => matchPatients(patients, query), [patients, query]);
  const show = open && query.trim().length > 0;
  const newName = splitNewName(query);
  /** letzte Zeile „+ Neue:n Patient:in anlegen“ in der Vorschlagsliste (nur wenn es Treffer gibt) */
  const createRow = canCreate && !!newName.lastName && hits.length > 0;
  const rowCount = hits.length + (createRow ? 1 : 0);
  const createId = `${listId}-neu`;
  const startCreate = () => {
    setCreating(splitNewName(query));
    setOpen(false);
  };

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
              aria-expanded={show && rowCount > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={show && rowCount ? (hits[active] ? `${listId}-${hits[active].id}` : createRow && active === hits.length ? createId : undefined) : undefined}
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
                if (e.key === "Escape") {
                  // innen zuerst: Vorschläge schließen, dann Suchtext leeren – erst danach schließt Escape das Fenster
                  if (show && rowCount) setOpen(false);
                  else if (query) setQuery("");
                  else return;
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                // Enter schickt nie das Formular ab, solange die Vorschläge offen sind (auch ohne Treffer);
                // ohne Treffer öffnet Enter „Neue:n Patient:in anlegen“
                if (show && !hits.length && e.key === "Enter") {
                  e.preventDefault();
                  if (canCreate && newName.lastName) startCreate();
                }
                if (!show || !rowCount) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => (a + 1) % rowCount);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => (a - 1 + rowCount) % rowCount);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (hits[active]) choose(hits[active]);
                  else if (createRow) startCreate();
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
                {createRow ? (
                  <li
                    id={createId}
                    role="option"
                    aria-selected={active === hits.length}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={startCreate}
                    className={`mt-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-t border-border px-3 text-[15px] font-semibold text-primary ${active === hits.length ? "bg-primary-soft" : "hover:bg-primary-soft"}`}
                  >
                    <UserPlus size={18} aria-hidden className="shrink-0" />
                    <span className="min-w-0 truncate">Neue:n Patient:in „{query.trim()}“ anlegen</span>
                  </li>
                ) : null}
              </ul>
            ) : query.trim() && !creating ? (
              // ohne Treffer: fester Hinweis unter dem Feld (bleibt auch ohne Fokus stehen)
              <div className="mt-1 flex flex-col gap-1 rounded-xl border border-border bg-surface p-1">
                <p aria-hidden className="px-3 py-2 text-sm text-muted">
                  Keine Patient:in gefunden.
                </p>
                {canCreate && newName.lastName ? (
                  <button
                    type="button"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={startCreate}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-[15px] font-semibold text-primary hover:bg-primary-soft"
                  >
                    <UserPlus size={18} aria-hidden className="shrink-0" />
                    <span className="min-w-0">
                      Neue:n Patient:in „{query.trim()}“ anlegen
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
        {creating && !picked ? (
          <NewPatientInline
            initial={creating}
            known={patients}
            onCreated={(p) => {
              if (!patients.some((x) => x.id === p.id)) setAdded((a) => [p, ...a]);
              setCreating(null);
              choose(p);
            }}
            onCancel={() => {
              setCreating(null);
              requestAnimationFrame(() => input.current?.focus());
            }}
          />
        ) : null}
        <span role="status" className="sr-only">
          {show ? (hits.length ? `${hits.length} Vorschl${hits.length === 1 ? "ag" : "äge"}${createRow ? ", danach „Neu anlegen“" : ""}` : `Keine Patient:in gefunden.${canCreate ? " Neu anlegen möglich." : ""}`) : ""}
        </span>
        {error ? <span className="text-[13px] leading-5 font-medium text-danger">{error}</span> : null}
        <span id={`${id}-hinweis`} className={hintCls}>
          {hint}
        </span>
      </div>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "@/components/toaster";
import { changeAppointmentStatusAction, type AppointmentStatus } from "./actions";

const DONE_TEXT: Partial<Record<AppointmentStatus, string>> = { cancelled: "abgesagt", no_show: "als „nicht erschienen“ markiert" };

/**
 * „Nicht da“ / „Absagen“ für einen Termin (Terminzeile, Terminseite). Ein Fehltipp ändert den Status nicht still:
 * Danach erscheint eine Meldung mit „Rückgängig“ (stellt den vorherigen Status wieder her, solange niemand den Termin
 * inzwischen geändert hat). Die Warteliste bekommt den frei gewordenen Termin erst nach der Rückgängig-Frist angeboten.
 * Rendert die Knöpfe ohne eigene Hülle (Fragment), damit sie in das Raster der Terminzeile passen.
 */
export function StatusButtons({
  id,
  label,
  noShow,
  cancel,
  className,
}: {
  id: string;
  /** für die Meldung, z. B. „10:00 Erika Beispiel“ */
  label: string;
  noShow: boolean;
  cancel: boolean;
  className: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const change = (status: AppointmentStatus) =>
    start(async () => {
      const res = await changeAppointmentStatusAction({ id, status }).catch(() => ({ ok: false as const, error: "Keine Verbindung – bitte erneut versuchen." }));
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      router.refresh();
      const prev = res.prev;
      toast(`Termin ${label} ${DONE_TEXT[status] ?? "geändert"}.`, {
        action: {
          label: "Rückgängig",
          onClick: () =>
            void changeAppointmentStatusAction({ id, status: prev, expected: status }).then(
              (undo) => {
                if (undo.ok) toast(`Termin ${label} wiederhergestellt.`, { tone: "info" });
                else toast(undo.error, { tone: "error" });
                router.refresh();
              },
              () => toast("Keine Verbindung – bitte erneut versuchen.", { tone: "error" }),
            ),
        },
      });
    });

  return (
    <>
      {noShow ? (
        <button type="button" className={className} disabled={pending} onClick={() => change("no_show")} title="Nicht erschienen (Ausfallhonorar möglich) – lässt sich danach rückgängig machen">
          Nicht da
        </button>
      ) : null}
      {cancel ? (
        <button type="button" className={className} disabled={pending} onClick={() => change("cancelled")} title="Termin absagen – lässt sich danach rückgängig machen">
          Absagen
        </button>
      ) : null}
    </>
  );
}

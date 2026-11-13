"use client";

import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/ui";
import { uploadLogoAction } from "../actions";

/** Upload-Feld für ein Praxis-Logo (PNG/JPEG, max. 1 MB). */
export function LogoUpload({ kind, label }: { kind: "compact" | "full"; label: string }) {
  return (
    <ActionForm action={uploadLogoAction} submit="Hochladen" className="flex flex-col gap-3">
      <input type="hidden" name="kind" value={kind} />
      <Field label={label} hint="PNG oder JPEG, höchstens 1 MB. Am besten mit transparentem oder weißem Hintergrund.">
        <input type="file" name="file" accept="image/png,image/jpeg" required className="text-sm file:mr-3 file:h-11 file:rounded-xl file:border file:border-border file:bg-surface-2 file:px-4 file:font-semibold" />
      </Field>
    </ActionForm>
  );
}

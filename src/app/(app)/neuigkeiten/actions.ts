"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { changelogViewer, saveChangelogDismissal } from "@/server/changelog";

const input = z.object({ shownId: z.string().min(1).max(40), mute: z.boolean() });

/** Neuigkeiten-Popup geschlossen (eigene Einstellung der angemeldeten Person; nicht im Support-Modus). */
export async function dismissChangelogAction(shownId: string, mute: boolean): Promise<void> {
  const row = await getSession();
  if (!row?.session.verified) return;
  const d = input.safeParse({ shownId, mute });
  if (!d.success) return;
  const v = await changelogViewer();
  if (!v || v.support) return;
  await saveChangelogDismissal(row.user.id, v.viewer, d.data.shownId, d.data.mute);
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { DAYPARTS, type Daypart } from "@/lib/waitlist";
import { addWaitlistEntry, resolveWaitlistEntry } from "@/server/waitlist";

/** Wartelisten-Eintrag mit Wünschen (Leistung, Wochentage, Tageszeit) anlegen. */
export async function addWaitlistAction(form: FormData) {
  const auth = await requireAuth("appointments.write");
  const patientId = z.uuid().parse(form.get("patientId"));
  await addWaitlistEntry(auth, patientId, {
    serviceIds: form.getAll("serviceId").map(String).filter((s) => z.uuid().safeParse(s).success),
    weekdays: form.getAll("weekday").map(Number),
    dayparts: form.getAll("daypart").map(String).filter((d): d is Daypart => (DAYPARTS as readonly string[]).includes(d)),
    note: String(form.get("note") ?? "").slice(0, 500),
  });
  revalidatePath(`/kunden/${patientId}`);
}

export async function resolveWaitlistAction(form: FormData) {
  const auth = await requireAuth("appointments.write");
  await resolveWaitlistEntry(auth, String(form.get("id") ?? ""));
  revalidatePath(`/kunden/${String(form.get("patientId") ?? "")}`);
}

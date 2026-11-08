"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { parseAnamnesis } from "@/lib/anamnesis";
import { createAnamnesisLink, revokeAnamnesisLink, saveAnamnesis } from "@/server/anamnesis";

export type AnamnesisFormState = { error?: string } | undefined;
export type LinkState = { error?: string; url?: string; expiresAt?: string } | undefined;

export async function saveAnamnesisAction(_: AnamnesisFormState, form: FormData): Promise<AnamnesisFormState> {
  const auth = await requireAuth("medical.write");
  const patientId = z.string().uuid().safeParse(form.get("patientId"));
  if (!patientId.success) return { error: "Ungültige Anfrage." };
  const parsed = parseAnamnesis(Object.fromEntries(form), "practice");
  if (!parsed.ok) return { error: parsed.error };
  const id = await saveAnamnesis(auth, patientId.data, parsed.data, { updateRiskFlags: form.get("updateRiskFlags") === "on" });
  if (!id) return { error: "Kunde nicht gefunden." };
  revalidatePath(`/kunden/${patientId.data}`);
  redirect(`/kunden/${patientId.data}/anamnese?gespeichert=1`);
}

async function baseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function createLinkAction(_: LinkState, form: FormData): Promise<LinkState> {
  const auth = await requireAuth("patients.write");
  const patientId = z.string().uuid().safeParse(form.get("patientId"));
  if (!patientId.success) return { error: "Ungültige Anfrage." };
  const res = await createAnamnesisLink(auth, patientId.data);
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${patientId.data}/anamnese`);
  return { url: `${await baseUrl()}/anamnese/${res.token}`, expiresAt: res.expiresAt.toISOString() };
}

export async function revokeLinkAction(form: FormData) {
  const auth = await requireAuth("patients.write");
  const patientId = z.string().uuid().parse(form.get("patientId"));
  const linkId = z.string().uuid().parse(form.get("linkId"));
  await revokeAnamnesisLink(auth, patientId, linkId);
  revalidatePath(`/kunden/${patientId}/anamnese`);
}

"use server";

import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/session";
import { isCatalogView, type CatalogKey } from "@/lib/catalog";
import { saveCatalogView } from "@/server/catalog-prefs";

const BACK: Record<CatalogKey, string> = { services: "/einstellungen/leistungen", products: "/produkte" };

/** Darstellung „Kacheln / Liste / Kompakt“ umschalten und je Person merken (users.prefs.catalog) – persönlich, kein Praxis-Recht nötig. */
export async function setCatalogViewAction(form: FormData) {
  const auth = await requireAuth();
  const key = form.get("key") === "products" ? "products" : "services";
  const view = form.get("view");
  if (isCatalogView(view)) await saveCatalogView(auth.user.id, key, view);
  // nur zurück auf die eigene Katalogseite (kein offener Redirect), Filter bleiben erhalten
  const qs = String(form.get("qs") ?? "");
  const safeQs = /^[\w%=&+.,\-*~äöüÄÖÜß ]*$/.test(qs) ? qs : "";
  redirect(`${BACK[key]}${safeQs ? `?${safeQs}` : ""}`);
}

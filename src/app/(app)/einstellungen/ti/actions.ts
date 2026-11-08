"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { integrationConnections } from "@/db/schema";
import { KIM_CONNECTION_PROVIDER } from "@/integrations/kim/provider";
import { testConnection } from "@/integrations/test-connection";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { TI_ITEM_STATES, TI_ITEMS, type TiItemState } from "@/lib/ti-checklist";
import { loadConnection, logSync } from "@/server/integrations";
import { loadKimConnection } from "@/server/kim";
import { saveTiSettings } from "@/server/ti";

type State = { error?: string; ok?: string } | undefined;

export async function saveTiChecklistAction(_: State, form: FormData): Promise<State> {
  const auth = await requireAuth("settings.manage");
  const items: Record<string, { state: TiItemState; note: string }> = {};
  for (const i of TI_ITEMS) {
    const st = String(form.get(`state_${i.key}`) ?? "open");
    items[i.key] = {
      state: (TI_ITEM_STATES as readonly string[]).includes(st) ? (st as TiItemState) : "open",
      note: String(form.get(`note_${i.key}`) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200),
    };
  }
  await saveTiSettings(auth, { items, provider: String(form.get("provider") ?? "").trim().slice(0, 120) });
  revalidatePath("/einstellungen/ti");
  return { ok: "Gespeichert." };
}

/** KIM-Verbindung testen: Anmeldung am POP3-Postfach des Clientmoduls (liest keine Nachrichten). */
export async function testKimAction(_: State, form: FormData): Promise<State> {
  void form;
  const auth = await requireAuth("settings.manage");
  const org = auth.organization.id;
  const stored = await loadConnection(org, KIM_CONNECTION_PROVIDER);
  const conn = await loadKimConnection(org);
  if (!conn) return { error: "KIM ist nicht eingerichtet – bitte unter Einstellungen → Schnittstellen → KIM die Zugangsdaten eintragen." };
  const res = await testConnection(KIM_CONNECTION_PROVIDER, conn);
  await logSync(org, KIM_CONNECTION_PROVIDER, { direction: "test", ok: res.ok, message: `KIM: ${res.detail}` });
  if (stored) {
    await withOrg(org, (tx) =>
      tx
        .update(integrationConnections)
        .set(
          res.ok
            ? { lastError: null, lastSyncAt: new Date(), ...(stored.status === "error" ? { status: "connected" as const } : {}) }
            : { lastError: res.detail, ...(stored.status === "connected" ? { status: "error" as const } : {}) },
        )
        .where(and(eq(integrationConnections.organizationId, org), eq(integrationConnections.provider, KIM_CONNECTION_PROVIDER))),
    );
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "integration.test", entity: "integration", entityId: "kim", meta: { ok: res.ok } });
  revalidatePath("/einstellungen/ti");
  return res.ok ? { ok: res.message } : { error: res.message };
}

"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { integrationConnections } from "@/db/schema";
import { PROVIDER_CATALOG } from "@/integrations/catalog";
import { testConnection } from "@/integrations/test-connection";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { loadConnection, logSync } from "@/server/integrations";

export type IntegrationState = { error?: string; ok?: string } | undefined;

const providerSchema = z.enum(PROVIDER_CATALOG.map((p) => p.provider) as [string, ...string[]]);

export async function saveIntegrationAction(_: IntegrationState, form: FormData): Promise<IntegrationState> {
  const auth = await requireAuth("integrations.manage");
  const org = auth.organization.id;
  const provider = providerSchema.safeParse(form.get("provider"));
  const status = z.enum(["disconnected", "mock", "connected"]).safeParse(form.get("status"));
  if (!provider.success || !status.success) return { error: "Ungültige Eingabe." };
  const info = PROVIDER_CATALOG.find((p) => p.provider === provider.data)!;

  const [existing] = await withOrg(org, (tx) =>
    tx
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.organizationId, org), eq(integrationConnections.provider, info.provider))),
  );

  // Geheimnisse: nur neu eingegebene Felder überschreiben, bestehende behalten
  let secret: Record<string, string> = {};
  if (existing?.secretEnc) {
    try {
      secret = JSON.parse(decryptSecret(existing.secretEnc, org));
    } catch {
      secret = {};
    }
  }
  let secretChanged = false;
  for (const f of info.secretFields) {
    const v = String(form.get(`secret_${f.name}`) ?? "").trim();
    if (v) {
      secret[f.name] = v;
      secretChanged = true;
    }
    if (form.get(`clear_${f.name}`) === "on") {
      delete secret[f.name];
      secretChanged = true;
    }
  }
  const config: Record<string, unknown> = { ...(existing?.config ?? {}) };
  for (const f of info.configFields) {
    const v = String(form.get(`config_${f.name}`) ?? "").trim().slice(0, 300);
    if (v) config[f.name] = v;
    else delete config[f.name];
  }
  if (info.provider === "llm" || info.provider === "transcription") {
    config.dataProcessingApproved = form.get("dataProcessingApproved") === "on";
  }

  const values = {
    status: status.data,
    config,
    secretEnc: Object.keys(secret).length ? encryptSecret(JSON.stringify(secret), org) : null,
    lastError: status.data === "connected" ? existing?.lastError ?? null : null,
    updatedAt: new Date(),
  };
  await withOrg(org, (tx) =>
    tx
      .insert(integrationConnections)
      .values({ organizationId: org, provider: info.provider, ...values })
      .onConflictDoUpdate({ target: [integrationConnections.organizationId, integrationConnections.provider], set: values }),
  );
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "integration.save",
    entity: "integration",
    entityId: info.provider,
    meta: { status: status.data, secretChanged, configKeys: Object.keys(config) },
  });
  revalidatePath("/einstellungen/schnittstellen");
  return { ok: `${info.label} gespeichert.` };
}

export async function testIntegrationAction(_: IntegrationState, form: FormData): Promise<IntegrationState> {
  const auth = await requireAuth("integrations.manage");
  const org = auth.organization.id;
  const provider = providerSchema.safeParse(form.get("provider"));
  if (!provider.success) return { error: "Ungültige Schnittstelle." };
  const p = provider.data as (typeof PROVIDER_CATALOG)[number]["provider"];
  const conn = await loadConnection(org, p);
  const res = await testConnection(p, conn ?? { status: "disconnected", organizationId: org });
  await logSync(org, p, { direction: "test", ok: res.ok, message: res.message });
  if (conn) {
    await withOrg(org, (tx) =>
      tx
        .update(integrationConnections)
        .set(
          res.ok
            ? { lastError: null, lastSyncAt: new Date(), ...(conn.status === "error" ? { status: "connected" as const } : {}) }
            : { lastError: res.message, ...(conn.status === "connected" ? { status: "error" as const } : {}) },
        )
        .where(and(eq(integrationConnections.organizationId, org), eq(integrationConnections.provider, p))),
    );
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "integration.test", entity: "integration", entityId: p, meta: { ok: res.ok } });
  revalidatePath("/einstellungen/schnittstellen");
  return res.ok ? { ok: res.message } : { error: res.message };
}

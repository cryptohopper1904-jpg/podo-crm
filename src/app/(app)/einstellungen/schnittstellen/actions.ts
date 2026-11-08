"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { integrationConnections } from "@/db/schema";
import { PROVIDER_CATALOG, TOKEN_WEBHOOK_PROVIDERS } from "@/integrations/catalog";
import { assertPublicHost, assertPublicUrl, UnsafeTargetError } from "@/integrations/net-guard";
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
  const oldConfig = (existing?.config ?? {}) as Record<string, unknown>;
  const config: Record<string, unknown> = { ...oldConfig };
  for (const f of info.configFields) {
    const v = String(form.get(`config_${f.name}`) ?? "").trim().slice(0, 300);
    if (v) config[f.name] = v;
    else delete config[f.name];
  }

  // SSRF-Schutz: frei wählbare Ziele müssen öffentliche https-Adressen bzw. Hosts sein
  try {
    if (typeof config.baseUrl === "string") config.baseUrl = (await assertPublicUrl(config.baseUrl)).toString().replace(/\/$/, "");
    for (const k of ["smtpHost", "imapHost"]) if (typeof config[k] === "string") await assertPublicHost(config[k] as string);
  } catch (e) {
    return { error: e instanceof UnsafeTargetError ? e.message : "Ziel-Adresse nicht erlaubt." };
  }
  // Ziel geändert → bisher hinterlegte Zugangsdaten verwerfen (sonst könnte man sie an einen fremden Server umleiten)
  const targetChanged = ["baseUrl", "smtpHost", "imapHost"].some((k) => (oldConfig[k] ?? null) !== (config[k] ?? null));
  if (targetChanged && existing?.secretEnc) {
    const fresh: Record<string, string> = {};
    for (const f of info.secretFields) {
      const v = String(form.get(`secret_${f.name}`) ?? "").trim();
      if (v) fresh[f.name] = v;
    }
    if (secret.webhookToken) fresh.webhookToken = secret.webhookToken;
    secret = fresh;
    secretChanged = true;
  }

  // Webhook-Token für Anbieter ohne eigene Signatur (lexoffice, SMS, Telefonagent)
  if (TOKEN_WEBHOOK_PROVIDERS.includes(info.provider) && (!secret.webhookToken || form.get("rotateWebhookToken") === "on")) {
    secret.webhookToken = randomBytes(32).toString("base64url");
    secretChanged = true;
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
  return { ok: targetChanged && existing?.secretEnc ? `${info.label} gespeichert. Ziel geändert – bitte Zugangsdaten neu eingeben.` : `${info.label} gespeichert.` };
}

export async function testIntegrationAction(_: IntegrationState, form: FormData): Promise<IntegrationState> {
  const auth = await requireAuth("integrations.manage");
  const org = auth.organization.id;
  const provider = providerSchema.safeParse(form.get("provider"));
  if (!provider.success) return { error: "Ungültige Schnittstelle." };
  const p = provider.data as (typeof PROVIDER_CATALOG)[number]["provider"];
  const conn = await loadConnection(org, p);
  const res = await testConnection(p, conn ?? { status: "disconnected", organizationId: org });
  await logSync(org, p, { direction: "test", ok: res.ok, message: res.detail });
  if (conn) {
    await withOrg(org, (tx) =>
      tx
        .update(integrationConnections)
        .set(
          res.ok
            ? { lastError: null, lastSyncAt: new Date(), ...(conn.status === "error" ? { status: "connected" as const } : {}) }
            : { lastError: res.detail, ...(conn.status === "connected" ? { status: "error" as const } : {}) },
        )
        .where(and(eq(integrationConnections.organizationId, org), eq(integrationConnections.provider, p))),
    );
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "integration.test", entity: "integration", entityId: p, meta: { ok: res.ok } });
  revalidatePath("/einstellungen/schnittstellen");
  return res.ok ? { ok: res.message } : { error: res.message };
}

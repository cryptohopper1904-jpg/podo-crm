/**
 * Legt eine Demo-Praxis mit ERFUNDENEN Daten an (keine echten Patienten!).
 * Aufruf: pnpm db:seed   (nutzt DATABASE_URL = App-Rolle; RLS über app.org_id)
 * Login danach: demo@podocrm.local – Passwort siehe src/lib/demo-seed.ts (Gesamt-Review K1):
 *   - SEED_DEMO_PASSWORD gesetzt → dieses Passwort
 *   - PUBLIC_URL ist eine echte Domain → Zufallspasswort, wird EINMAL hier ausgegeben (migrate-Log)
 *   - sonst (localhost/IP) → demo-passwort-123
 * Die Inhaber:in muss beim ersten Login 2FA einrichten (Pflicht für Inhaber:innen, Gesamt-Review H1).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { hash } from "@node-rs/argon2";
import * as s from "../src/db/schema";
import { DEMO_PRACTICE_FIELDS, seedDemoPracticeData } from "../src/lib/demo-data";
import { DEMO_EMAIL, resolveDemoPassword } from "../src/lib/demo-seed";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema: s });
  const email = DEMO_EMAIL;
  const demo = resolveDemoPassword(process.env);
  const [existing] = await db.select().from(s.users).where(eq(s.users.email, email));
  if (existing) {
    console.log("Demo existiert bereits.");
    await pool.end();
    return;
  }
  await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(s.organizations)
      .values({ name: "Podologie Demo", slug: `demo-${Date.now().toString(36)}`, ...DEMO_PRACTICE_FIELDS })
      .returning();
    const [user] = await tx.insert(s.users).values({ email, name: "Dana Demo", passwordHash: await hash(demo.password) }).returning();
    await tx.insert(s.memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
    await seedDemoPracticeData(tx, org.id, user.id);
  });
  if (demo.source === "well-known") {
    console.log(`Demo-Praxis angelegt: ${email} / ${demo.password}  (bekanntes Passwort – nur lokal/IP)`);
  } else if (demo.source === "generated") {
    // Einziges Mal, dass dieses Passwort sichtbar ist (nicht gespeichert, nur als Hash in der DB)
    console.log(`Demo-Praxis angelegt: ${email} / ${demo.password}`);
    console.log("ACHTUNG: Zufallspasswort – nur in diesem Log. Bitte jetzt notieren; beim ersten Login wird 2FA eingerichtet.");
  } else {
    console.log(`Demo-Praxis angelegt: ${email} / (Passwort aus SEED_DEMO_PASSWORD)`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

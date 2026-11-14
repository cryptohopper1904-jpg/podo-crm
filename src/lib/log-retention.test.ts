import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * deploy/log-retention.sh (Code-Review S2/N1, AppSec L-3) mit einer docker-Attrappe: Schlägt `docker ps` fehl oder
 * findet es keine Container dieser Installation, bleibt die bestehende logrotate-Konfiguration unverändert. Sonst stehen
 * nur die Container mit passendem Compose-Ordner darin (Label und Skript-Ordner beide per pwd -P aufgelöst).
 */
const SCRIPT = path.join(process.cwd(), "deploy/log-retention.sh");
const DEPLOY = path.dirname(SCRIPT);
const tmp = mkdtempSync(path.join(tmpdir(), "log-retention-"));
const bin = path.join(tmp, "bin");
const cronDir = path.join(tmp, "cron.daily");
const confDir = path.join(tmp, "logrotate.d");
const conf = path.join(confDir, "podohero-docker");
const labels = path.join(tmp, "labels");
const OLD = "# alte Konfiguration\n";
const OURS = "a".repeat(64);
const OTHER = "b".repeat(64);

mkdirSync(bin);
mkdirSync(cronDir);
mkdirSync(confDir);
// Label über einen Symlink auf den deploy-Ordner (pwd -P muss beide Seiten gleich auflösen)
symlinkSync(DEPLOY, path.join(tmp, "deploy-link"));
mkdirSync(path.join(tmp, "andere-installation"));
writeFileSync(
  path.join(bin, "docker"),
  `#!/bin/sh
case "$1" in
  info) echo /var/lib/docker ;;
  ps) [ "\${FAKE_PS_FAIL:-}" = 1 ] && exit 1; printf '%s' "\${FAKE_PS_OUT:-}" ;;
  inspect) grep "^$4 " "${labels}" | cut -d' ' -f2- ;;
esac
`,
);
chmodSync(path.join(bin, "docker"), 0o755);
writeFileSync(labels, `${OURS} ${path.join(tmp, "deploy-link")}\n${OTHER} ${path.join(tmp, "andere-installation")}\n`);

function run(env: Record<string, string>) {
  writeFileSync(conf, OLD);
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PODOHERO_LOGROTATE_CONF: conf, PODOHERO_CRON_DAILY: cronDir, ...env },
  });
}

describe("deploy/log-retention.sh", () => {
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("docker ps schlägt fehl: Konfiguration bleibt, Warnung, Exit 0", () => {
    const r = run({ FAKE_PS_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/docker ps fehlgeschlagen/);
    expect(readFileSync(conf, "utf8")).toBe(OLD);
  });

  it("keine Container (leere Liste oder nur fremde Installation): Konfiguration bleibt, Warnung", () => {
    for (const out of ["", `${OTHER}\n`]) {
      const r = run({ FAKE_PS_OUT: out });
      expect(r.status, out).toBe(0);
      expect(r.stderr, out).toMatch(/keine PodoHero-Container gefunden/);
      expect(readFileSync(conf, "utf8"), out).toBe(OLD);
    }
  });

  it("nur Container dieser Installation (Label über Symlink) kommen in die Konfiguration; täglicher Lauf eingerichtet", () => {
    const r = run({ FAKE_PS_OUT: `${OURS}\n${OTHER}\nkeine-id\n` });
    expect(r.status).toBe(0);
    const c = readFileSync(conf, "utf8");
    expect(c).toContain(`"/var/lib/docker/containers/${OURS}/${OURS}-json.log" {`);
    expect(c).not.toContain(OTHER);
    expect(c).toMatch(/maxage 7/);
    expect(readFileSync(path.join(cronDir, "0podohero-log-retention"), "utf8")).toContain("log-retention.sh");
  });
});

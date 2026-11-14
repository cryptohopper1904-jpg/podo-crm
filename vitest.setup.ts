/**
 * Gemeinsame Testumgebung: Seit dem Beleg-Archiv (Migration 0049) schreibt jedes Ausstellen ein verschlüsseltes PDF in
 * die Dateiablage. Damit DB-Tests weder das Repository (data/storage) füllen noch am fehlenden Schlüssel scheitern:
 * eigenes, temporäres STORAGE_DIR je Testdatei (danach gelöscht) und ein fester Test-Schlüssel, falls keiner gesetzt ist.
 * Ausdrücklich gesetzte Werte (z. B. in einem Test) haben Vorrang.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
if (!process.env.STORAGE_DIR) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "podo-vitest-storage-"));
  process.env.STORAGE_DIR = dir;
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
}

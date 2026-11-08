/**
 * Defense in Depth: Die Serverfunktionen prüfen Rechte selbst – auch wenn eine Seite/Action
 * versehentlich nur getAuth() statt requireAuth(...) nutzt. Die Prüfung greift vor jedem DB-Zugriff.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { can, type Role } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import {
  adjustStock,
  addDeviceEvent,
  completeChecklistItem,
  createBatch,
  decideBatch,
  getBatchByCode,
  listBatches,
  saveChecklist,
  saveDevice,
  saveMaterial,
  traceBatch,
} from "./hygiene";
import { addAbsence, appointmentsInAbsences, deleteAbsence, saveWorkingHours, teamOverview } from "./staff";

const ID = "00000000-0000-4000-8000-000000000001";
const as = (role: Role) =>
  ({
    sessionId: "s",
    user: { id: ID, email: "t@example.org", name: "T", totpEnabled: false },
    organization: { id: ID, name: "Praxis", slug: "p", smallBusiness: false, state: "BB" },
    role,
    can: (p) => can(role, p),
  }) as AuthContext;

const batch = { code: "ST-20261108-01", deviceId: null, cycleNo: null, indicatorOk: true, expiresAt: null, note: null };
const device = {
  name: "Autoklav", kind: "sterilizer" as const, manufacturer: null, serialNumber: null, location: null,
  nextMaintenanceAt: null, nextValidationAt: null, nextElectricalCheckAt: null, active: true, notes: null,
};

describe("Hygiene-Rechte in der Serverschicht", () => {
  const reception = as("reception");
  it("Empfang kann keine Chargen anlegen", async () => {
    await expect(createBatch(reception, batch)).rejects.toThrow(/Kein Zugriff/);
  });
  it("Empfang kann keine Chargen freigeben oder sperren", async () => {
    await expect(decideBatch(reception, ID, "released", { indicatorConfirmed: true })).rejects.toThrow(/Kein Zugriff/);
    await expect(decideBatch(reception, ID, "rejected", { indicatorConfirmed: false, note: "x" })).rejects.toThrow(/Kein Zugriff/);
  });
  it("Empfang kann keine Rückverfolgung (Patientenliste) lesen", async () => {
    await expect(traceBatch(reception, "ST-1")).rejects.toThrow(/Kein Zugriff/);
    await expect(listBatches(reception)).rejects.toThrow(/Kein Zugriff/);
    await expect(getBatchByCode(reception, "ST-1")).rejects.toThrow(/Kein Zugriff/);
  });
  it("Steuerberatung: kein Material, keine Geräte", async () => {
    const acc = as("accountant");
    await expect(saveMaterial(acc, null, { name: "X", unit: "Stück", stock: 1, minStock: 0, supplier: null, orderUrl: null, active: true })).rejects.toThrow(/Kein Zugriff/);
    await expect(adjustStock(acc, ID, 1)).rejects.toThrow(/Kein Zugriff/);
    await expect(saveDevice(acc, null, device)).rejects.toThrow(/Kein Zugriff/);
  });
  it("Empfang: kein Gerätebuch, keine Checkliste", async () => {
    await expect(addDeviceEvent(reception, { deviceId: ID, kind: "maintenance", occurredAt: "2026-11-08", performedBy: null, note: null, nextDueAt: null })).rejects.toThrow(/Kein Zugriff/);
    await expect(completeChecklistItem(reception, "daily", "x")).rejects.toThrow(/Kein Zugriff/);
  });
  it("Checkliste ändern nur mit settings.manage (nicht Podolog:in)", async () => {
    await expect(saveChecklist(as("therapist"), { daily: [], weekly: [] })).rejects.toThrow(/Kein Zugriff/);
  });
  it("Azubi darf anlegen, aber nicht freigeben", async () => {
    const r = await decideBatch(as("trainee"), ID, "released", { indicatorConfirmed: true });
    expect(r.error).toMatch(/Inhaber|Podolog/);
  });
});

describe("Team-Rechte in der Serverschicht", () => {
  it("nur users.manage darf Arbeitszeiten und Abwesenheiten ändern", async () => {
    const t = as("therapist");
    await expect(saveWorkingHours(t, ID, {})).rejects.toThrow(/Kein Zugriff/);
    await expect(addAbsence(t, { userId: ID, kind: "vacation", startsOn: "2026-11-09", endsOn: "2026-11-09", note: null })).rejects.toThrow(/Kein Zugriff/);
    await expect(deleteAbsence(t, ID)).rejects.toThrow(/Kein Zugriff/);
  });
  it("Steuerberatung sieht die Team-Planung nicht", async () => {
    const acc = as("accountant");
    await expect(teamOverview(acc, "2026-11-01", "2026-11-30")).rejects.toThrow(/Kein Zugriff/);
    await expect(appointmentsInAbsences(acc)).rejects.toThrow(/Kein Zugriff/);
  });
});

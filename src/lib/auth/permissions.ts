/**
 * Rollen- und Rechtekonzept (siehe docs/PLAN.md 4.10).
 * Empfang sieht keine medizinischen Inhalte, Steuerberater nur Finanzen.
 */
export const ROLES = ["owner", "therapist", "reception", "trainee", "accountant"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Inhaber:in",
  therapist: "Podolog:in",
  reception: "Empfang/Verwaltung",
  trainee: "Azubi/Praktikant:in",
  accountant: "Steuerberatung",
};

export const PERMISSIONS = [
  "patients.read",
  "patients.write",
  "medical.read",
  "medical.write",
  "appointments.read",
  "appointments.write",
  "invoices.read",
  "invoices.write",
  "finance.read",
  "messages.read",
  "messages.write",
  "settings.manage",
  "users.manage",
  "integrations.manage",
  "import.run",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  therapist: [
    "patients.read",
    "patients.write",
    "medical.read",
    "medical.write",
    "appointments.read",
    "appointments.write",
    "invoices.read",
    "invoices.write",
    "messages.read",
    "messages.write",
  ],
  reception: [
    "patients.read",
    "patients.write",
    "appointments.read",
    "appointments.write",
    "invoices.read",
    "invoices.write",
    "messages.read",
    "messages.write",
  ],
  trainee: ["patients.read", "medical.read", "medical.write", "appointments.read"],
  accountant: ["invoices.read", "finance.read"],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return MATRIX[role];
}

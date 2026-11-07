import type { RiskFlags } from "@/db/schema";
import { Badge } from "./ui";

export function RiskBadges({ flags, compact = false }: { flags: RiskFlags; compact?: boolean }) {
  const items: string[] = [];
  if (flags.diabetes) items.push(compact ? "Diabetes" : `Diabetes${flags.diabetesType ? ` (${flags.diabetesType})` : ""}`);
  if (flags.anticoagulation) items.push("Blutverdünner");
  if (flags.pavk) items.push("pAVK");
  if (flags.neuropathy) items.push("Neuropathie");
  if (flags.mrsa) items.push("MRSA");
  if (flags.allergies) items.push(compact ? "Allergie" : `Allergie: ${flags.allergies}`);
  if (!items.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {items.map((i) => (
        <Badge key={i} tone="accent">{i}</Badge>
      ))}
    </span>
  );
}

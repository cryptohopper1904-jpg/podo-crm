import { loginChangelog } from "@/server/changelog";
import { ChangelogDialog } from "./changelog-dialog";

/** Popup „Neu in PodoHero“ – einmal je Anmeldung (Server-Komponente fürs App-Layout). */
export async function LoginChangelog() {
  const selection = await loginChangelog();
  return selection ? <ChangelogDialog selection={selection} /> : null;
}

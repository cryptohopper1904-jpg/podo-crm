#!/usr/bin/env bash
# Deploy-Key für ein privates GitHub-Repository einrichten (nur Lesezugriff).
# Danach holt der Server Code und Updates per SSH statt anonym über HTTPS –
# Voraussetzung, damit das Repository auf „privat“ gestellt werden kann.
#
# Ablauf (als root auf dem Server):
#   1. bash /opt/podo-crm/deploy/setup-deploy-key.sh
#      → erzeugt den Schlüssel (falls noch keiner da ist) und zeigt den öffentlichen Teil an.
#   2. Den angezeigten Schlüssel auf GitHub eintragen:
#      Repository podo-crm → Settings → Deploy keys → Add deploy key,
#      Titel z. B. den Servernamen, „Allow write access“ NICHT anhaken.
#   3. Das Skript erneut aufrufen. Es prüft den Zugang und stellt /opt/podo-crm auf SSH um.
#   4. Erst danach das Repository auf GitHub auf „privat“ stellen.
#
# Gefahrlos mehrfach ausführbar. Der private Schlüssel verlässt den Server nicht.
set -euo pipefail
OWNER_REPO="${PODO_GITHUB_REPO:-cryptohopper1904-jpg/podo-crm}"
APP_DIR="${PODO_APP_DIR:-/opt/podo-crm}"
KEY=/root/.ssh/podo_crm_deploy
ALIAS=github-podo-crm
SSH_URL="git@$ALIAS:$OWNER_REPO.git"
MARK="# podo-crm deploy key"

say() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "Bitte als root ausführen (sudo -i)."
command -v ssh-keygen >/dev/null || die "ssh-keygen fehlt (Paket openssh-client)."

install -d -m 700 /root/.ssh
if [ ! -f "$KEY" ]; then
  say "Neuen Deploy-Key erzeugen"
  ssh-keygen -q -t ed25519 -N "" -C "podo-crm deploy $(hostname -s)" -f "$KEY"
fi
chmod 600 "$KEY"

if ! grep -qF "$MARK" /root/.ssh/config 2>/dev/null; then
  cat >> /root/.ssh/config <<CONF

$MARK
Host $ALIAS
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
CONF
  chmod 600 /root/.ssh/config
fi

say "Zugang zu $OWNER_REPO prüfen"
if ! GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote -q "$SSH_URL" HEAD >/dev/null 2>&1; then
  echo
  echo "Der Schlüssel ist auf GitHub noch nicht eingetragen (oder ohne Zugriff auf $OWNER_REPO)."
  echo "Bitte unter github.com/$OWNER_REPO/settings/keys → „Add deploy key“ eintragen,"
  echo "Schreibzugriff NICHT erlauben, und dieses Skript danach erneut aufrufen:"
  echo
  cat "$KEY.pub"
  echo
  exit 2
fi
echo "Zugang ok."

if [ -d "$APP_DIR/.git" ]; then
  OLD=$(git -C "$APP_DIR" remote get-url origin)
  if [ "$OLD" != "$SSH_URL" ]; then
    git -C "$APP_DIR" remote set-url origin "$SSH_URL"
    say "$APP_DIR holt Updates jetzt per SSH (vorher: $OLD)"
  fi
  git -C "$APP_DIR" fetch -q origin || die "git fetch über SSH fehlgeschlagen."
fi

say "Fertig. Updates laufen über den Deploy-Key – das Repository kann jetzt auf privat gestellt werden."

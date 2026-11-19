#!/usr/bin/env bash
# Deploy-Key für ein privates GitHub-Repository einrichten (nur Lesezugriff).
# Danach holt der Server Code und Updates per SSH statt anonym über HTTPS –
# Voraussetzung, damit das Repository auf „privat“ gestellt werden kann.
#
# Ablauf (als root auf dem Server; auf einem frischen Server das Skript vorher per scp nach /root kopieren):
#   1. bash setup-deploy-key.sh
#      → erzeugt den Schlüssel (falls noch keiner da ist) und zeigt den öffentlichen Teil an.
#   2. Den angezeigten Schlüssel auf GitHub eintragen:
#      Repository podo-crm → Settings → Deploy keys → Add deploy key,
#      Titel z. B. den Servernamen, „Allow write access“ NICHT anhaken.
#   3. Das Skript erneut aufrufen. Es prüft den Zugang und stellt /opt/podo-crm (falls vorhanden) auf SSH um.
#   4. Erst wenn alle Server umgestellt sind, das Repository auf GitHub auf „privat“ stellen.
#
# Gefahrlos mehrfach ausführbar. Der hier erzeugte private Schlüssel bleibt auf diesem Server.
# Der SSH-Konfigurationsblock steht auch in deploy/cloud/hetzner-user-data.sh – beide synchron halten.
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
command -v git >/dev/null || die "git fehlt (apt-get install -y git)."

install -d -m 700 /root/.ssh
if [ ! -f "$KEY" ]; then
  say "Neuen Deploy-Key erzeugen"
  ssh-keygen -q -t ed25519 -N "" -C "podo-crm deploy $(hostname -s)" -f "$KEY"
fi
chmod 600 "$KEY"
# Öffentlichen Teil nachbilden, falls nur der private Schlüssel da ist (z. B. aus der Cloud-Installation)
[ -f "$KEY.pub" ] || ssh-keygen -y -f "$KEY" > "$KEY.pub" || die "$KEY ist kein gültiger privater Schlüssel."

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
fi
chmod 600 /root/.ssh/config

say "Zugang zu $OWNER_REPO prüfen"
rc=0
err=$(GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" timeout 30 git ls-remote -q "$SSH_URL" HEAD 2>&1 >/dev/null) || rc=$?
if [ "$rc" -ne 0 ]; then
  if printf '%s' "$err" | grep -qiE 'permission denied \(publickey\)|repository not found|could not read from remote'; then
    echo
    echo "Der Schlüssel ist auf GitHub noch nicht eingetragen (oder ohne Zugriff auf $OWNER_REPO)."
    echo "Bitte unter github.com/$OWNER_REPO/settings/keys → „Add deploy key“ eintragen,"
    echo "Schreibzugriff NICHT erlauben, und dieses Skript danach erneut aufrufen:"
    echo
    cat "$KEY.pub"
    echo
    exit 2
  fi
  [ "$rc" -eq 124 ] && err="Zeitüberschreitung nach 30 s (Netzwerk/Firewall, Port 22 zu github.com?)"
  die "Verbindung zu GitHub fehlgeschlagen (Code $rc): $err"
fi
echo "Zugang ok."

if [ -d "$APP_DIR/.git" ]; then
  OLD=$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)
  if [ -z "$OLD" ]; then
    git -C "$APP_DIR" remote add origin "$SSH_URL"
    say "$APP_DIR: Remote origin auf SSH angelegt"
  elif [ "$OLD" != "$SSH_URL" ]; then
    git -C "$APP_DIR" remote set-url origin "$SSH_URL"
    say "$APP_DIR holt Updates jetzt per SSH (vorher: $OLD)"
  fi
  git -C "$APP_DIR" fetch -q origin || die "git fetch über SSH fehlgeschlagen."
else
  echo "Kein $APP_DIR vorhanden – bei einer Neuinstallation klont install-subdomain.sh jetzt per SSH."
fi

say "Fertig. Dieser Server holt Code über den Deploy-Key."

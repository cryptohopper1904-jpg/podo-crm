#!/usr/bin/env bash
# PodoCRM: Wiederherstellungs-Test (einmal im Quartal, siehe docs/BETRIEB.md).
# Spielt das neueste verschlüsselte Backup in einen WEGWERF-Postgres-Container ein (die laufende
# Installation wird nicht angefasst), prüft es und räumt danach alles weg.
#
#   bash deploy/restore-test.sh                       # neuestes Backup aus dem Volume „backups“
#   bash deploy/restore-test.sh --file /pfad/db-….dump.gpg   # z. B. aus dem Offsite-Speicher
#
# Prüfungen: Entschlüsselung + pg_restore fehlerfrei · Tabellen vorhanden · Zeilenzahlen · Stand der
#   Migrationen · Hash-Ketten der Behandlungsdoku und der Kassenabschlüsse (Verkettung und lückenlose Z-Nummern
#   per SQL, Inhalts-Hashes per Skript scripts/verify-hash-chains.ts) · Datei-Backup lesbar (Anzahl Dateien,
#   ohne Entpacken auf Platte).
# Ausgabe enthält nur Zähler und IDs, keine Patientendaten.
#
# Optionen: --file DATEI  --skip-files (Datei-Backup nicht prüfen)  --skip-recompute (kein Inhalts-Hash)
#           --keep (Wegwerf-Container stehen lassen, zum Nachsehen)
set -euo pipefail

main() {
  # shellcheck source=deploy/lib.sh
  source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
  local FILE="" SKIP_FILES=0 SKIP_RECOMPUTE=0
  KEEP=0 # global: wird vom EXIT-Trap nach dem Ende von main() gelesen
  while [ $# -gt 0 ]; do
    case "$1" in
      --file) FILE="${2:?--file braucht eine Datei}"; shift 2 ;;
      --skip-files) SKIP_FILES=1; shift ;;
      --skip-recompute) SKIP_RECOMPUTE=1; shift ;;
      --keep) KEEP=1; shift ;;
      -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "Unbekannte Option: $1 (siehe --help)" ;;
    esac
  done

  podo_detect
  cd "$APP_DIR"
  require_docker
  local FAILS=0
  ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
  bad()  { printf '  \033[31m✖\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

  say "1/5 Backup auswählen"
  if [ -z "$FILE" ]; then
    backup_running || die "backup-Container läuft nicht. Mit --file eine Backup-Datei angeben."
    FILE=$(latest_db_backup)
    [ -n "$FILE" ] || die "Kein Datenbank-Backup im Volume \"backups\" gefunden."
  else
    FILE=$(backup_path "$FILE")
  fi
  info "Datei: $FILE"
  if backup_running && [[ "$FILE" == /backups/* ]]; then
    local age_h
    # shellcheck disable=SC2016  # wird im Container ausgewertet
    age_h=$("${COMPOSE[@]}" exec -T backup sh -c 'echo $(( ($(date +%s) - $(stat -c %Y "$1")) / 3600 ))' sh "$FILE" | tr -d '\r')
    info "Alter: ${age_h} h"
    if [ "$age_h" -le 26 ]; then ok "Backup ist aktuell (≤ 26 h)"; else bad "Backup ist älter als 26 h – läuft der backup-Dienst?"; fi
  fi

  say "2/5 Wegwerf-Datenbank starten"
  # global (nicht local): cleanup() läuft als EXIT-Trap nach dem Ende von main()
  ID="podo-restoretest-$(date +%s)"
  NET="$ID-net"; CT="$ID-db"
  PW=$(openssl rand -hex 16 2>/dev/null || date +%s%N)
  # shellcheck disable=SC2329  # per trap aufgerufen
  cleanup() {
    if [ "$KEEP" = 1 ]; then
      warn "Container bleibt stehen: docker exec -it $CT psql -U podo_owner -d podo_restore"
      warn "Aufräumen: docker rm -fv $CT && docker network rm $NET"
      return
    fi
    docker rm -fv "$CT" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  docker network create "$NET" >/dev/null
  docker run -d --name "$CT" --network "$NET" -e POSTGRES_USER=podo_owner -e POSTGRES_PASSWORD="$PW" \
    -e POSTGRES_DB=podo_restore postgres:16-alpine >/dev/null
  local i
  for i in $(seq 1 30); do
    docker exec "$CT" pg_isready -q -U podo_owner -d podo_restore 2>/dev/null && break
    [ "$i" = 30 ] && die "Wegwerf-Datenbank startet nicht."
    sleep 2
  done
  sleep 2 # Initialisierung (Neustart des Servers im Container) abwarten
  docker exec "$CT" psql -q -U podo_owner -d podo_restore -c "CREATE ROLE podo_app NOLOGIN NOSUPERUSER NOBYPASSRLS" >/dev/null
  ok "Container $CT läuft"

  say "3/5 Entschlüsseln und einspielen"
  if decrypt_backup "$FILE" | docker exec -i "$CT" pg_restore -U podo_owner -d podo_restore --exit-on-error; then
    ok "pg_restore ohne Fehler"
  else
    bad "pg_restore fehlgeschlagen (falsche Passphrase, beschädigte Datei?)"
    say "Ergebnis: FEHLGESCHLAGEN"
    exit 1
  fi
  local Q=(docker exec "$CT" psql -X -At -v ON_ERROR_STOP=1 -U podo_owner -d podo_restore -c)

  say "4/5 Plausibilität prüfen"
  local tables; tables=$("${Q[@]}" "select count(*) from information_schema.tables where table_schema='public'")
  if [ "$tables" -ge 30 ]; then ok "$tables Tabellen"; else bad "nur $tables Tabellen (erwartet ≥ 30)"; fi
  info "Zeilen je Tabelle:"
  "${Q[@]}" "select t, coalesce((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I', t), false, true, '')))[1]::text, '–')
             from unnest(array['organizations','users','patients','appointments','treatment_records','record_addenda','media',
                               'anamneses','prescriptions','invoices','payments','vouchers','cash_closings','cash_movements',
                               'fiscal_transactions','audit_log']) t
             where to_regclass(t) is not null" | awk -F'|' '{ printf "    %-20s %s\n", $1, $2 }'
  local orgs; orgs=$("${Q[@]}" "select count(*) from organizations")
  if [ "$orgs" -ge 1 ]; then ok "$orgs Praxis/Praxen"; else bad "keine Praxis in der Sicherung"; fi

  local applied expected
  applied=$("${Q[@]}" "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo 0)
  expected=$(grep -c '"tag"' "$APP_DIR/drizzle/meta/_journal.json" || echo 0)
  if [ "$applied" = "$expected" ]; then ok "Migrationen: $applied von $expected (passt zum Code-Stand)"
  elif [ "$applied" -lt "$expected" ]; then ok "Migrationen: $applied von $expected – Sicherung ist älter als der Code, migrate spielt den Rest nach"
  else bad "Migrationen: $applied, Code kennt nur $expected – Sicherung ist neuer als der Code-Stand"; fi

  # Hash-Kette, Teil 1 (SQL): je Patient genau ein Anfang, jeder Vorgänger existiert, keine Verzweigung
  local chain
  chain=$("${Q[@]}" "
    with r as (select organization_id o, patient_id p, hash, prev_hash from treatment_records)
    select
      (select count(*) from (select o, p from r group by o, p having count(*) filter (where prev_hash is null) <> 1) x),
      (select count(*) from r where prev_hash is not null and not exists
         (select 1 from r r2 where r2.o = r.o and r2.p = r.p and r2.hash = r.prev_hash)),
      (select count(*) from (select o, p, prev_hash from r group by o, p, prev_hash having count(*) > 1) y),
      (select count(*) from treatment_records)")
  local starts missing forks total
  IFS='|' read -r starts missing forks total <<<"$chain"
  if [ "$starts" = 0 ] && [ "$missing" = 0 ] && [ "$forks" = 0 ]; then
    ok "Hash-Kette verkettet: $total Behandlungseinträge, keine Lücke, keine Verzweigung"
  else
    bad "Hash-Kette: $starts Patient:innen ohne/mit mehreren Anfängen, $missing fehlende Vorgänger, $forks Verzweigungen"
  fi

  # Kassenabschlüsse (Z-Bons), Teil 1 (SQL): je Praxis Z 1…n ohne Lücke/Doppel, Kette ohne Bruch/Verzweigung,
  # fortlaufende Belegnummern
  if [ "$("${Q[@]}" "select to_regclass('cash_closings') is not null")" = t ]; then
    local zc
    zc=$("${Q[@]}" "
      with c as (select organization_id o, number n, hash, prev_hash, first_bon_nr f, last_bon_nr l,
                        lag(hash) over w as lh, lag(last_bon_nr) over w as ll, row_number() over w as rn
                   from cash_closings window w as (partition by organization_id order by number))
      select
        (select count(*) from c where n <> rn),
        (select count(*) from c where prev_hash is distinct from lh),
        (select count(*) from c where f <> coalesce(ll, 0) + 1 or l < f - 1),
        (select count(*) from cash_closings),
        (select count(distinct organization_id) from cash_closings)")
    local zgaps zlinks zbons ztotal zorgs
    IFS='|' read -r zgaps zlinks zbons ztotal zorgs <<<"$zc"
    if [ "$zgaps" = 0 ] && [ "$zlinks" = 0 ] && [ "$zbons" = 0 ]; then
      ok "Kassenabschlüsse: $ztotal Z-Bons ($zorgs Praxen), Z-Nummern lückenlos, Kette und Belegnummern fortlaufend"
    else
      bad "Kassenabschlüsse: $zgaps Z-Nummern-Lücken, $zlinks Kettenbrüche, $zbons Belegnummern-Lücken"
    fi
  else
    info "Kassenabschlüsse: Tabelle nicht vorhanden (Sicherung vor Phase 5)"
  fi

  # Hash-Ketten, Teil 2: Inhalts-Hashes neu berechnen (Behandlungsdoku und Kassenabschlüsse) (gleicher Code wie die App, src/lib/records.ts)
  if [ "$SKIP_RECOMPUTE" = 1 ]; then
    info "Inhalts-Hashes: übersprungen (--skip-recompute)"
  else
    info "Prüf-Image bauen (deploy/Dockerfile.migrate, nutzt den Build-Cache) …"
    if docker build -q -f "$APP_DIR/deploy/Dockerfile.migrate" -t podo-crm-tools:restore-test "$APP_DIR" >/dev/null; then
      if docker run --rm --network "$NET" -e DATABASE_URL="postgres://podo_owner:$PW@$CT:5432/podo_restore" \
          podo-crm-tools:restore-test pnpm exec tsx scripts/verify-hash-chains.ts | sed 's/^/    /'; then
        ok "Inhalts-Hashes reproduzierbar (Behandlungsdoku, Kassenabschlüsse)"
      else
        bad "Inhalts-Hashes: Abweichungen (siehe oben)"
      fi
    else
      bad "Prüf-Image konnte nicht gebaut werden (mit --skip-recompute überspringen)"
    fi
  fi

  say "5/5 Datei-Backup prüfen"
  if [ "$SKIP_FILES" = 1 ] || [ -n "${FILE##/backups/*}" ]; then
    info "übersprungen$([ "$SKIP_FILES" = 1 ] && echo ' (--skip-files)' || echo ' (bei --file nur Datenbank)')"
  else
    local ff count
    ff=$(latest_files_backup)
    if [ -z "$ff" ]; then
      bad "kein Datei-Backup gefunden"
    elif count=$(decrypt_backup "$ff" | tar -tzf - | { grep -vc '/$' || true; }); then
      ok "$(basename "$ff"): lesbar, $count Dateien"
    else
      bad "$(basename "$ff") nicht lesbar"
    fi
  fi

  echo
  if [ "$FAILS" = 0 ]; then
    say "Ergebnis: Wiederherstellung erfolgreich getestet ($(date +%d.%m.%Y)). Bitte im Betriebsprotokoll notieren."
  else
    printf '\n\033[1;31m✖ Ergebnis: %s Prüfung(en) fehlgeschlagen – Backup-Konzept prüfen!\033[0m\n' "$FAILS"
    exit 1
  fi
}

main "$@"
exit 0

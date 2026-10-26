#!/bin/bash
# Restauration ISPAT Gestion à partir d'une sauvegarde de scripts/sauvegarde.sh.
# Usage : scripts/restaurer.sh /root/sauvegardes/ispat-gestion/base_AAAA-MM-JJ_HHMM.dump [media_AAAA-MM-JJ_HHMM.tar.gz]
# ATTENTION : remplace TOUTES les données actuelles (base et, si fourni, fichiers).
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BASE="${1:?Indiquer le fichier base_*.dump}"
MEDIA="${2:-}"
NOM="${DB_NAME:-ispat_gestion}"
ROLE="${DB_USER:-ispat}"
[ -f "$BASE" ] || { echo "Fichier introuvable : $BASE"; exit 1; }
[ -z "$MEDIA" ] || [ -f "$MEDIA" ] || { echo "Fichier introuvable : $MEDIA"; exit 1; }

read -r -p "Remplacer toutes les données de $NOM par $(basename "$BASE") ? Taper OUI : " reponse
[ "$reponse" = "OUI" ] || { echo "Abandon."; exit 1; }

echo "Arrêt de l'application…"
docker compose stop web api

echo "Recréation de la base…"
docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$NOM' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"$NOM\";" \
  -c "CREATE DATABASE \"$NOM\" OWNER \"$ROLE\" ENCODING 'UTF8' TEMPLATE template0;"
docker compose exec -T db pg_restore -U postgres -d "$NOM" --no-owner --role="$ROLE" --exit-on-error < "$BASE"

if [ -n "$MEDIA" ]; then
  echo "Restauration des fichiers…"
  docker compose run --rm --no-deps -T --entrypoint sh api -c 'rm -rf /data/media/* && tar -C /data -xzf -' < "$MEDIA"
fi

echo "Redémarrage…"
docker compose up -d
echo "Restauration terminée."

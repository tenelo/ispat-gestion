#!/bin/bash
# Mise à jour ISPAT Gestion après remplacement des dossiers ispat_api/ et ispat_web/ (garder .env).
# Usage : scripts/mettre_a_jour.sh [patch.sql ...]
#   Les fichiers ispat_patch_*.sql livrés avec une mise à jour sont passés en arguments.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

echo "1. Sauvegarde préalable"
scripts/sauvegarde.sh

for patch in "$@"; do
  echo "2. Correctif SQL : $patch"
  docker compose exec -T db psql -U "${DB_USER:-ispat}" -d "${DB_NAME:-ispat_gestion}" -v ON_ERROR_STOP=1 -q < "$patch"
done

echo "3. Reconstruction des images"
docker compose build

echo "4. Redémarrage (migrations Django appliquées au démarrage de l'API)"
docker compose up -d
docker image prune -f >/dev/null

echo "5. État"
docker compose ps

#!/bin/bash
# Sauvegarde ISPAT Gestion : base PostgreSQL (format custom) + fichiers (photos, pièces, bulletins).
# Usage : /root/docker/ispat-gestion/scripts/sauvegarde.sh
# Cron (tous les jours à 2 h 15) :
#   15 2 * * * /root/docker/ispat-gestion/scripts/sauvegarde.sh >> /var/log/ispat-sauvegarde.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
DOSSIER="${DOSSIER_SAUVEGARDES:-/root/sauvegardes/ispat-gestion}"
GARDER="${JOURS_CONSERVATION:-14}"
DATE="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$DOSSIER"
chmod 700 "$DOSSIER"

echo "$(date '+%F %T') sauvegarde ISPAT Gestion → $DOSSIER"

# 1. Base (cohérente même pendant l'utilisation)
docker compose exec -T db pg_dump -U postgres -d "${DB_NAME:-ispat_gestion}" -Fc --no-owner \
  > "$DOSSIER/base_$DATE.dump.part"
mv "$DOSSIER/base_$DATE.dump.part" "$DOSSIER/base_$DATE.dump"

# 2. Fichiers
docker compose exec -T api tar -C /data -czf - media > "$DOSSIER/media_$DATE.tar.gz.part"
mv "$DOSSIER/media_$DATE.tar.gz.part" "$DOSSIER/media_$DATE.tar.gz"

# 3. Rotation
find "$DOSSIER" -name 'base_*.dump'      -mtime +"$GARDER" -delete
find "$DOSSIER" -name 'media_*.tar.gz'   -mtime +"$GARDER" -delete

ls -lh "$DOSSIER/base_$DATE.dump" "$DOSSIER/media_$DATE.tar.gz" | awk '{print "  " $5 "  " $9}'
echo "$(date '+%F %T') terminé"

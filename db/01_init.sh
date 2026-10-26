#!/bin/sh
# Premier démarrage du conteneur PostgreSQL uniquement (volume vide) :
#   1. rôle applicatif + base,  2. schéma ispat,  3. offre de formation.
# Les extensions pg_trgm et unaccent sont « trusted » : le propriétaire de la base peut les créer.
set -eu

echo "ISPAT : création du rôle ${DB_USER} et de la base ${DB_NAME}"
psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
     -v role="${DB_USER}" -v mdp="${DB_PASSWORD}" -v base="${DB_NAME}" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'mdp';
CREATE DATABASE :"base" OWNER :"role" ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE :"base" FROM PUBLIC;
SQL

charger() {
  echo "ISPAT : chargement de $1"
  psql -v ON_ERROR_STOP=1 -q --username "${DB_USER}" --dbname "${DB_NAME}" -f "$1" >/dev/null
}

charger /sql/ispat_gestion_schema.sql
charger /sql/ispat_donnees_003_offre_formation.sql
echo "ISPAT : base prête"

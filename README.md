# ISPAT Gestion

Application de gestion de l'ISPAT (Institut Supérieur Privé d'Agriculture et Technologie, Ferkessédougou) :
scolarité, comptabilité, notes et moyennes, bulletins, gestion commerciale.
Application web installable (PWA), utilisable avec et sans connexion, reliée au site WordPress pour les
pré-inscriptions en ligne.

En production : https://ispat-gest.tenelo.cloud

## Contenu

| Dossier / fichier | Rôle |
|---|---|
| `ispat_api/` | API Django + Django REST Framework (JWT, droits par rôle, synchronisation hors ligne, PDF) |
| `ispat_web/` | Application Angular (PWA, Angular Material, base locale IndexedDB) |
| `sql/` | Schéma PostgreSQL (`ispat`) et offre de formation, chargés au premier démarrage |
| `docker-compose.yml` | Conteneurs `db-ispat` (PostgreSQL 16), `ispat-api` (Gunicorn), `ispat-app` (Nginx) |
| `api/`, `web/`, `db/` | Dockerfiles, démarrage de l'API, configuration Nginx, initialisation de la base |
| `hote/` | Site Nginx du serveur (reverse proxy HTTPS) |
| `scripts/` | Sauvegarde, restauration, mise à jour |
| `DEPLOIEMENT.md` | Déploiement Docker sur le VPS, pas à pas |
| `INSTALLATION_A_Z.md` | Installation complète et paramétrage de l'établissement |

## Démarrage rapide (serveur)

```bash
cp .env.exemple .env && chmod 600 .env   # puis renseigner domaine, mots de passe, secrets
docker compose up -d --build
docker compose exec api python manage.py creer_admin --login admin --nom NOM --prenoms "Prénoms"
```

Le fichier `.env` (secrets) n'est jamais versionné.

## Développement

- API : voir `ispat_api/README.md`.
- Application : voir `ispat_web/LISEZMOI.md` (`npm install`, `npm start`).

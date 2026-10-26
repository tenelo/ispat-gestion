# ISPAT Gestion — Déploiement Docker sur le VPS (HTTPS)

Architecture habituelle du VPS : un dossier par projet dans `/root/docker/`, Nginx du serveur en
reverse proxy, certificats Let's Encrypt (Certbot).

```
Navigateur ──HTTPS──> Nginx du serveur (Certbot) ──> 127.0.0.1:8090
                                                       └─ conteneur web  (Nginx : Angular + /api/)
                                                            └─ conteneur api (Django + Gunicorn) ── volume media
                                                                 └─ conteneur db (PostgreSQL 16) ── volume db_data
```

Rien n'est exposé sur Internet à part le domaine en HTTPS : la base et l'API restent dans le réseau Docker
interne, et le conteneur web n'écoute que sur `127.0.0.1`.

## Contenu du dossier

| Élément | Rôle |
|---|---|
| `docker-compose.yml` | les 3 services, volumes `db_data` (base) et `media` (photos, pièces, bulletins) |
| `.env.exemple` | paramètres à copier en `.env` (domaine, mots de passe, secret WordPress) |
| `api/` | image de l'API (Dockerfile, démarrage : attente base → migrations → Gunicorn) |
| `web/` | image de l'application (compilation Angular → Nginx), `config.json` modifiable sans recompiler |
| `db/01_init.sh` | premier démarrage : rôle `ispat`, base, schéma, offre de formation |
| `sql/` | `ispat_gestion_schema.sql`, `ispat_donnees_003_offre_formation.sql` |
| `hote/nginx-ispat-gestion.conf` | site Nginx du serveur (domaine → port 8090) |
| `scripts/` | `sauvegarde.sh`, `restaurer.sh`, `mettre_a_jour.sh` |
| `ispat_api/`, `ispat_web/` | code source de l'API et de l'application |

## Installation (première fois)

1. **DNS** — chez le gestionnaire du domaine, créer un enregistrement **A** :
   `gestion.ispat` (ou le sous-domaine choisi) → IP publique du VPS. Vérifier depuis le PC :
   `nslookup gestion.ispat.tenelo.cloud`.

2. **Vérifier le port local libre** sur le VPS (8090 par défaut) :
   ```bash
   ss -ltnp | grep ':8090 ' || echo "8090 libre"
   ```
   S'il est pris, choisir un autre port pour `PORT_WEB` (étape 5) et dans `hote/nginx-ispat-gestion.conf`.

3. **Copier le dossier** sur le VPS (WinSCP ou `scp`) puis le décompresser :
   ```bash
   cd /root/docker
   unzip ispat-gestion.zip          # crée /root/docker/ispat-gestion/
   cd ispat-gestion
   chmod +x db/01_init.sh api/entrypoint.sh scripts/*.sh
   ```

4. **Générer les secrets** (trois valeurs différentes) :
   ```bash
   for i in 1 2 3; do openssl rand -base64 48 | tr -d '/+=' | cut -c1-48; done
   ```

5. **Créer le fichier `.env`** :
   ```bash
   cp .env.exemple .env && chmod 600 .env && nano .env
   ```
   Renseigner `DOMAINE`, `DB_PASSWORD`, `DB_SUPERUSER_PASSWORD`, `DJANGO_SECRET_KEY` (secrets de l'étape 4),
   et `PORT_WEB` si modifié. `ISPAT_WP_SECRET` peut rester vide pour l'instant (étape 12).

6. **Construire et démarrer** (la première construction prend quelques minutes : compilation Angular) :
   ```bash
   docker compose up -d --build
   docker compose ps                 # db, api, web : « healthy » / « running »
   docker compose logs db | grep ISPAT   # « ISPAT : base prête »
   ```

7. **Contrôle local** :
   ```bash
   curl -s http://127.0.0.1:8090/api/sante/     # {"statut":"ok", ...}
   ```

8. **Créer le compte administrateur** (le mot de passe est demandé deux fois) :
   ```bash
   docker compose exec api python manage.py creer_admin --login admin --nom OUATTARA --prenoms "Tenelo Étienne"
   ```

9. **Site Nginx du serveur** — remplacer le domaine (et le port si modifié) dans le fichier, puis :
   ```bash
   cp hote/nginx-ispat-gestion.conf /etc/nginx/sites-available/ispat-gestion
   ln -s /etc/nginx/sites-available/ispat-gestion /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   ```

10. **HTTPS** (obligatoire : sans HTTPS, l'application ne s'installe pas sur PC et ne fonctionne pas hors ligne) :
    ```bash
    certbot --nginx -d gestion.ispat.tenelo.cloud
    ```
    Choisir la redirection HTTP → HTTPS. Le renouvellement automatique est déjà géré par Certbot.

11. **Premier accès** : ouvrir `https://gestion.ispat.tenelo.cloud`, se connecter avec `admin`, puis suivre
    la partie H d'`INSTALLATION_A_Z.md` (année active, classes, tarifs, matières, utilisateurs et rôles).

12. **Liaison avec le site WordPress** (pré-inscriptions en ligne) :
    1. générer un secret (étape 4) et le mettre dans `.env` : `ISPAT_WP_SECRET=...` ;
    2. `docker compose up -d` (prise en compte) ;
    3. dans le `wp-config.php` du site ISPAT, **avant** la ligne « C'est tout, ne touchez pas… » :
       ```php
       define( 'ISPAT_API_URL', 'https://gestion.ispat.tenelo.cloud' );
       define( 'ISPAT_API_SECRET', 'la même valeur que ISPAT_WP_SECRET' );
       ```
    4. facultatif : `ISPAT_WP_IPS=` IP publique du serveur WordPress (si le site est sur le même VPS : l'IP
       publique du VPS), puis `docker compose up -d`.

13. **Sauvegardes automatiques** (tous les jours à 2 h 15, conservation 14 jours) :
    ```bash
    scripts/sauvegarde.sh             # test immédiat
    crontab -e
    # ajouter :
    15 2 * * * /root/docker/ispat-gestion/scripts/sauvegarde.sh >> /var/log/ispat-sauvegarde.log 2>&1
    ```
    Copier régulièrement `/root/sauvegardes/ispat-gestion/` hors du VPS (PC, Google Drive…).

## Exploitation

| Besoin | Commande (dans `/root/docker/ispat-gestion`) |
|---|---|
| État des services | `docker compose ps` |
| Journaux de l'API | `docker compose logs -f --tail 100 api` |
| Redémarrer | `docker compose restart` |
| Arrêter / démarrer | `docker compose down` / `docker compose up -d` (les données restent dans les volumes) |
| Console PostgreSQL | `docker compose exec db psql -U ispat -d ispat_gestion` |
| Sauvegarde manuelle | `scripts/sauvegarde.sh` |
| Restaurer | `scripts/restaurer.sh /root/sauvegardes/ispat-gestion/base_….dump [media_….tar.gz]` |
| Mise à jour du code | remplacer `ispat_api/` et `ispat_web/` (garder `.env`), puis `scripts/mettre_a_jour.sh [ispat_patch_xxx.sql]` |
| Intervalle de synchronisation des postes | modifier `web/config.json`, puis `docker compose restart web` |

**Ne jamais lancer `docker compose down -v`** : l'option `-v` supprime les volumes, donc la base et les fichiers.

## Passage sur le VPS de l'ISPAT (plus tard)

1. `scripts/sauvegarde.sh` sur l'ancien VPS ;
2. installer Docker, Nginx et Certbot sur le nouveau, copier le dossier `ispat-gestion` (avec `.env`) ;
3. `docker compose up -d --build`, puis `scripts/restaurer.sh base_….dump media_….tar.gz` ;
4. pointer le DNS du nouveau domaine, refaire les étapes 9–10, mettre `DOMAINE` à jour dans `.env`
   (puis `docker compose up -d`) et `ISPAT_API_URL` dans le `wp-config.php`.

## En cas de problème

| Symptôme | Vérification |
|---|---|
| `api` reste « unhealthy » | `docker compose logs api` : mot de passe base, `DJANGO_SECRET_KEY` vide |
| « Bad Request (400) » | `DOMAINE` du `.env` différent du domaine tapé dans le navigateur |
| 502 Bad Gateway | `docker compose ps` : conteneur `web` ou `api` arrêté ; port de `hote/…conf` ≠ `PORT_WEB` |
| Base vide / `ISPAT : base prête` absent | le volume `db_data` existait déjà : l'initialisation ne se fait qu'au premier démarrage |
| Pré-inscriptions du site refusées (401/403) | secrets différents entre `.env` et `wp-config.php`, horloge du serveur WordPress, `ISPAT_WP_IPS` |
| Application non installable sur PC | site ouvert en HTTP au lieu de HTTPS |

# ISPAT Gestion — installation et mise en service de A à Z

Architecture finale :

```
 PC de l'école (Chrome/Edge)            Serveur (VPS Ubuntu 24.04)                     Site WordPress (existant)
 ┌──────────────────────────┐   HTTPS   ┌──────────────────────────────────────────┐    ┌───────────────────────┐
 │ ISPAT Gestion (PWA)      │ ────────► │ Nginx  https://gestion.ispat.ci          │◄── │ formulaire de          │
 │ base locale IndexedDB    │           │  ├─ /        application Angular         │    │ pré-inscription        │
 │ fonctionne hors ligne    │           │  └─ /api/    Gunicorn → Django (API)     │    │ (signé HMAC, /api/wp/) │
 └──────────────────────────┘           │              └─ PostgreSQL (schéma ispat)│    └───────────────────────┘
                                         └──────────────────────────────────────────┘
```

Fichiers livrés utilisés ici :

| Fichier | Contenu |
|---|---|
| `ispat_gestion_schema.sql` | base complète (tables, déclencheurs, vues, rôles, droits) |
| `ispat_donnees_003_offre_formation.sql` | 17 filières et niveaux BT1–BT3, BTS1–BTS2 |
| `ispat_api.zip` | API Django (étapes 2 à 10) |
| `ispat_web.zip` | application Angular PWA (étape 11) |
| `ispat_theme_ajout_preinscription.zip` | ajout au thème WordPress (pré-inscription en ligne) |
| `ispat_patch_00X_*.sql` | **uniquement** pour une base créée avant ces correctifs ; inutiles sur une base neuve |

Remplacer partout `gestion.ispat.ci` par le domaine choisi et `ispat.ci` par celui du site.

---

## Partie A — Préparer le serveur

1. **Commander un VPS** Ubuntu 24.04 (2 Go de RAM suffisent au départ) et noter son adresse IP.
2. **DNS** : chez le gestionnaire du domaine, créer l'enregistrement `A` `gestion.ispat.ci` → IP du VPS.
3. **Se connecter** au VPS (`ssh root@IP`) et installer les paquets :
   ```bash
   apt update && apt upgrade -y
   apt install -y postgresql postgresql-contrib nginx python3-venv python3-pip unzip certbot python3-certbot-nginx
   timedatectl set-timezone Africa/Abidjan
   ```
4. **Créer l'utilisateur système** qui fera tourner l'API et les dossiers :
   ```bash
   adduser --system --group --home /opt/ispat ispat
   mkdir -p /var/lib/ispat/media /var/www/ispat-gestion
   chown -R ispat:www-data /var/lib/ispat
   ```

## Partie B — Base de données PostgreSQL

5. **Créer le rôle et la base** (choisir un mot de passe fort) :
   ```bash
   sudo -u postgres psql -c "CREATE ROLE ispat LOGIN PASSWORD 'MOT_DE_PASSE_BASE';"
   sudo -u postgres psql -c "CREATE DATABASE ispat_gestion OWNER ispat;"
   ```
6. **Charger le schéma puis l'offre de formation** (copier les deux fichiers .sql sur le serveur, par ex. avec WinSCP) :
   ```bash
   psql -h 127.0.0.1 -U ispat -d ispat_gestion -v ON_ERROR_STOP=1 -f ispat_gestion_schema.sql
   psql -h 127.0.0.1 -U ispat -d ispat_gestion -v ON_ERROR_STOP=1 -f ispat_donnees_003_offre_formation.sql
   ```
   Les patchs 001, 002, 004 sont déjà inclus dans ce schéma : ne pas les appliquer sur une base neuve.

## Partie C — API Django

7. **Copier et décompresser l'API** :
   ```bash
   unzip ispat_api.zip -d /opt/ispat/        # donne /opt/ispat/ispat_api
   cd /opt/ispat/ispat_api
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt gunicorn
   ```
8. **Générer deux secrets** (l'un pour Django, l'autre partagé avec WordPress) :
   ```bash
   python3 -c "import secrets; print(secrets.token_urlsafe(50))"   # DJANGO_SECRET_KEY
   python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # ISPAT_WP_SECRET
   ```
9. **Créer `/opt/ispat/ispat_api/.env`** (à partir de `.env.example`) :
   ```ini
   DJANGO_SECRET_KEY=<premier secret>
   DJANGO_DEBUG=False
   DJANGO_ALLOWED_HOSTS=gestion.ispat.ci
   DB_NAME=ispat_gestion
   DB_USER=ispat
   DB_PASSWORD=MOT_DE_PASSE_BASE
   DB_HOST=127.0.0.1
   DB_PORT=5432
   CORS_ALLOWED_ORIGINS=https://gestion.ispat.ci
   MEDIA_ROOT=/var/lib/ispat/media
   ISPAT_WP_SECRET=<second secret>
   ISPAT_DERRIERE_PROXY=True
   JWT_ACCESS_MINUTES=60
   JWT_REFRESH_DAYS=7
   ```
   Puis protéger le fichier : `chown ispat:ispat .env && chmod 600 .env`.
10. **Tables techniques et premier administrateur** :
    ```bash
    sudo -u ispat .venv/bin/python manage.py migrate
    sudo -u ispat .venv/bin/python manage.py creer_admin --login admin --nom OUATTARA --prenoms "Tenelo Étienne"
    ```
    (le mot de passe est demandé au clavier).
11. **Service permanent** : copier `ispat_web/deploiement/ispat-api.service` dans `/etc/systemd/system/`, puis :
    ```bash
    chown -R ispat:www-data /opt/ispat
    systemctl daemon-reload && systemctl enable --now ispat-api
    curl http://127.0.0.1:8000/api/sante/          # doit répondre {"statut":"ok", ...}
    ```

## Partie D — Application Angular

12. **Compiler sur ton PC** (Node.js 22 LTS installé) :
    ```bash
    cd ispat_web
    npm ci
    npm run build
    ```
    Le résultat est dans `dist/ispat-gestion/browser/`.
13. **Copier le contenu** de `dist/ispat-gestion/browser/` dans `/var/www/ispat-gestion/` sur le serveur
    (WinSCP ou `scp -r dist/ispat-gestion/browser/* root@IP:/var/www/ispat-gestion/`).
    Laisser `config.json` tel quel (`"apiUrl": ""` : l'API est sur le même domaine).

## Partie E — Nginx et HTTPS

14. **Configurer Nginx** :
    ```bash
    cp nginx-ispat-gestion.conf /etc/nginx/sites-available/ispat-gestion
    ln -s /etc/nginx/sites-available/ispat-gestion /etc/nginx/sites-enabled/
    ```
    Pour le premier passage, commenter le bloc `listen 443` (le certificat n'existe pas encore), puis
    `nginx -t && systemctl reload nginx`.
15. **Certificat HTTPS gratuit** (obligatoire pour l'installation sur PC et le hors ligne) :
    ```bash
    certbot --nginx -d gestion.ispat.ci
    ```
    Décommenter ensuite le bloc 443 si certbot ne l'a pas complété, `nginx -t && systemctl reload nginx`.
    Le renouvellement est automatique.
16. **Vérifier** : `https://gestion.ispat.ci/api/sante/` répond `{"statut":"ok"}` et
    `https://gestion.ispat.ci` affiche la page de connexion verte.

## Partie F — Liaison avec le site WordPress

17. **Sauvegarder le thème actuel** (dossier `wp-content/themes/ispat`) avant toute copie.
18. **Copier l'ajout** `ispat_theme_ajout_preinscription.zip` dans `wp-content/themes/` : 4 fichiers nouveaux
    (`inc/preinscription.php`, `page-templates/preinscription.php`, `assets/css/preinscription.css`,
    `assets/js/preinscription.js`) et 5 fichiers mis à jour (`functions.php`, `page-templates/admissions.php`,
    `single-filiere.php`, `style.css`, `LISEZMOI.md`). Si tu as modifié ces 5 fichiers depuis, reporter
    seulement les lignes ajoutées.
19. **Dans `wp-config.php`**, au-dessus de « C'est tout, ne touchez pas à ce qui suit » :
    ```php
    define( 'ISPAT_API_URL', 'https://gestion.ispat.ci' );
    define( 'ISPAT_API_SECRET', '<second secret, identique à ISPAT_WP_SECRET>' );
    ```
20. **Tâche planifiée** (relances des envois en attente), dans le cron de l'hébergement WordPress :
    `*/15 * * * * wget -q -O - https://ispat.ci/wp-cron.php?doing_wp_cron >/dev/null 2>&1`
21. **Tester** : remplir `https://ispat.ci/pre-inscription/` avec une pièce jointe → la demande apparaît dans
    le menu WordPress « Pré-inscriptions » avec l'état **Transmise**, puis dans l'application
    (Gestion commerciale → Pré-inscriptions) au prochain passage en ligne.

## Partie G — Installer l'application sur les PC de l'école

22. Sur chaque PC, ouvrir `https://gestion.ispat.ci` dans **Chrome** ou **Edge**.
23. Se connecter **une première fois avec le réseau** : les données du rôle sont copiées sur le poste
    (indicateur « Synchronisation… » puis « En ligne »).
24. Cliquer sur **« Installer l'application »** (barre verte) : ISPAT Gestion s'ajoute au menu Démarrer et au
    bureau, et s'ouvre dans sa propre fenêtre, même sans connexion.
25. Une personne par compte : la déconnexion efface les données du poste (avertissement si des saisies
    n'ont pas encore été envoyées).

## Partie H — Paramétrage de l'établissement (compte `admin`, menu Administration)

26. **Référentiels → Années académiques** : créer l'année (ex. 2026-2027, cocher « Rendre active ») ;
    les semestres 1 et 2 sont créés automatiquement. Les années suivantes : bouton « Recopier les classes
    et tarifs » depuis l'année précédente.
27. **Référentiels → Classes, Matières** (les 17 filières et les niveaux sont déjà chargés), puis
    **Barème des frais** (montants par type de frais, filière, niveau, statut).
28. **Utilisateurs et rôles** : créer un compte par personne (Direction, Directeur des études, Comptable,
    Scolarité, Enseignant, Commercial). L'onglet « Droits des rôles » permet d'ajuster ce que chaque rôle voit.
29. **Référentiels → Enseignants** (lier chaque enseignant à son compte) puis **Attribution des cours**
    (l'enseignant ne voit que ses classes).
30. **Paramètres** : nom de l'établissement (bulletins, reçus), pondération contrôle continu / examen,
    moyenne de validation, règle de la 2e session.

## Partie I — Sauvegardes et mises à jour

31. **Sauvegarde quotidienne** (base + fichiers), par exemple dans `/etc/cron.d/ispat-sauvegarde` :
    ```
    30 2 * * * postgres pg_dump -Fc ispat_gestion > /var/backups/ispat_$(date +\%u).dump
    45 2 * * * root tar czf /var/backups/ispat_media_$(date +\%u).tgz /var/lib/ispat/media
    ```
    (7 jours glissants ; copier régulièrement `/var/backups` hors du serveur).
32. **Mettre à jour l'API** : remplacer les fichiers du code (garder `.env`), puis
    `.venv/bin/pip install -r requirements.txt && sudo -u ispat .venv/bin/python manage.py migrate && systemctl restart ispat-api`.
    Appliquer les éventuels fichiers `ispat_patch_*.sql` livrés avec la mise à jour.
33. **Mettre à jour l'application** : `npm run build` puis recopier `dist/ispat-gestion/browser/`.
    Les PC reçoivent la nouvelle version automatiquement (message « Mettre à jour »).

## En cas de problème

| Symptôme | Vérification |
|---|---|
| Page blanche ou erreur 502 | `systemctl status ispat-api`, `journalctl -u ispat-api -n 50` |
| « Serveur injoignable » dans l'application | `curl https://gestion.ispat.ci/api/sante/` |
| Pré-inscriptions « En attente » dans WordPress | même secret des deux côtés ; horloges à l'heure (écart < 5 min) ; `ISPAT_API_URL` correcte |
| Bouton « Installer » absent | HTTPS actif ; Chrome ou Edge ; application déjà installée ? |
| Saisies bloquées « Refusée » / « Conflit » | écran **Synchronisation** de l'application |

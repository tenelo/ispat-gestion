# ISPAT Gestion — application Angular (PWA)

Application de gestion de l'ISPAT, installable sur PC et utilisable **avec ou sans connexion**.
Angular 22 (composants autonomes, signaux, sans zone.js), Angular Material (thème vert ISPAT `#0F5A46`,
accent orange `#F07D16`), base locale IndexedDB (Dexie), service worker Angular.

## Démarrage en développement

Prérequis : Node.js 22 (ou plus récent), l'API Django lancée sur `http://127.0.0.1:8000`.

```bash
npm install
npm start                 # http://localhost:4200 ; /api est renvoyé vers 127.0.0.1:8000 (proxy.conf.json)
npm test                  # tests unitaires (Vitest)
```

En développement le service worker est désactivé : le hors ligne se teste sur la version compilée.

## Compilation pour la production

```bash
npm run build             # résultat : dist/ispat-gestion/browser/
```

Copier **le contenu** de `dist/ispat-gestion/browser/` sur le serveur (ex. `/var/www/ispat-gestion/`).
Modèle de configuration Nginx : `deploiement/nginx-ispat-gestion.conf`.

### `config.json` (modifiable après déploiement, sans recompiler)

```json
{ "apiUrl": "", "intervalleSynchroMinutes": 5 }
```

* `apiUrl` vide : l'API est sur le même domaine (`https://gestion.ispat.ci/api/...`), cas recommandé.
* API sur un autre domaine : `"apiUrl": "https://api.ispat.ci"` et ajouter l'adresse de l'application
  dans `CORS_ALLOWED_ORIGINS` du `.env` de l'API.

## Fonctionnement hors ligne

1. **Première connexion** : elle nécessite le réseau. L'application copie sur le poste les données autorisées
   pour le rôle de l'utilisateur (un enseignant ne reçoit que ses classes, sans téléphones ; un commercial ne
   reçoit pas les étudiants, etc.).
2. **Ensuite** : l'application s'ouvre sans réseau (service worker), la session est conservée, les recherches
   (matricule, nom sans accents) et les saisies se font sur le poste.
3. **Saisies** : enregistrées immédiatement sur le poste (pastille orange « À envoyer »), puis envoyées
   automatiquement : au retour du réseau, après chaque saisie, et toutes les 5 minutes.
4. **Conflits** (fiche modifiée par quelqu'un d'autre, doublon refusé par le serveur) : écran
   **Synchronisation**, au choix « Garder ma saisie », « Enregistrer quand même » (doublon assumé) ou
   « Garder la version du serveur ».
5. **Déconnexion** : efface les données du poste (poste partagé). Si des saisies n'ont pas été envoyées,
   l'application avertit avant de les perdre. Un autre utilisateur ne peut pas se connecter tant que les
   saisies du précédent ne sont pas envoyées.
6. **Session expirée** (7 jours sans réseau) : bandeau « Se reconnecter » ; les saisies en attente sont gardées.

## Écrans disponibles

| Compartiment | Écran | Hors ligne |
|---|---|---|
| Administration | Utilisateurs et rôles, Référentiels, Paramètres | non (consultation et modification en ligne) |
| Scolarité | Inscriptions (liste, compteurs, filtres) | oui |
| Scolarité | Nouvelle inscription : nouvel étudiant ou réinscription, contacts, photo (webcam ou fichier), pièces | oui, photo et pièces comprises |
| Scolarité | Dossier étudiant : identité, contacts, changement de classe, ajout de pièces | oui |
| Scolarité | Validation (matricule + frais), annulation, abandon, vérification des pièces | non |
| Scolarité | Listes de classe, par sexe, par statut (+ effectifs, impression) | oui ; exports Excel / CSV en ligne |
| Scolarité | Liste de notation | non |
| Comptabilité | Versements : encaissement (situation de l'étudiant, objet, payeur, mode, référence), journal | oui ; reçu PDF, annulation et export en ligne |
| Comptabilité | Entrées et sorties de caisse (saisie, modification) | oui ; justificatif, annulation, journal de caisse et synthèse en ligne |
| Comptabilité | Frais annexes et remises, affectation à une classe | non |
| Comptabilité | Prises en charge (montant ou taux) | non |
| Comptabilité | Situation financière par classe et par étudiant, détail, exports | non |
| Notes et moyennes | Saisie des notes : évaluations, grille clavier, collage depuis Excel | oui |
| Notes et moyennes | Validation et modification des notes d'examen (motif, historique) | non |
| Notes et moyennes | Validation et modification des moyennes et décisions (motif, historique) | non |
| Bulletins | Semestre 1, semestre 2, examen session 1 et 2 : provisoires, officiels numérotés, archives | non |
| Gestion commerciale | Prospection (saisie de prospects, relances) | oui |
| Gestion commerciale | Pré-inscriptions (site web, guichet, prospection) : dossier, pièces, acceptation, rejet, inscription | non |
| Gestion commerciale | Listes des prospects par ville, école, genre, filière, statut (+ export) | non |
| Gestion commerciale | Inscription des prospects (pré-inscription ou inscription en attente de validation) | non |
| Gestion commerciale | Analyse : taux de pré-inscription, d'inscription, de conversion, par axe (+ export) | non |

Les photos et pièces jointes saisies hors ligne sont gardées sur le poste et envoyées après l'inscription
(écran Synchronisation : « Photos et pièces jointes à envoyer »).

## Installer l'application sur un PC

Ouvrir l'adresse de l'application dans **Chrome** ou **Edge** (HTTPS obligatoire), se connecter, puis cliquer
sur **« Installer l'application »** dans la barre verte (ou l'icône d'installation dans la barre d'adresse).
ISPAT Gestion apparaît alors dans le menu Démarrer et sur le bureau, et s'ouvre dans sa propre fenêtre.
Les mises à jour sont automatiques : un message « Nouvelle version disponible » propose de recharger.

## Organisation du code

```
src/app/
  core/
    config.service.ts        lecture de config.json
    db.ts                    base locale IndexedDB (tables synchronisées + file d'envoi)
    auth/                    session, jetons JWT, gardes de routes, intercepteur
    sync/sync.service.ts     envoi (push) et réception (pull) ; résolution des conflits
    reseau.service.ts        en ligne / hors ligne / serveur injoignable
    navigation.ts            menu par compartiment et droits requis (codes module.ressource.action)
    recherche-locale.ts      recherche d'étudiants hors ligne
    installation.service.ts  bouton « Installer l'application »
  layout/shell.*             barre du haut, menu latéral filtré selon les droits
  pages/                     connexion, tableau de bord, synchronisation, prospection, …
  shared/confirmation.ts     boîte de confirmation
scripts/icones.py            réduit la police d'icônes aux icônes utilisées (4 Mo -> 60 Ko)
deploiement/                 modèles Nginx et systemd
```

### Ajouter un écran

1. Déclarer l'entrée dans `core/navigation.ts` (chemin, libellé, icône, droits) — c'est déjà fait pour tous
   les écrans demandés par l'ISPAT.
2. Créer le composant dans `pages/` et l'ajouter à `ECRANS` dans `app.routes.ts`.
3. Lire les données locales avec `db.table_('...')` et relire quand `sync.revision()` change.
4. Enregistrer avec `sync.enregistrer({ table, action, id, donnees, libelle }, ligneLocale)` : la saisie
   fonctionne alors en ligne comme hors ligne.
5. Nouvelle icône utilisée : relancer `npm run icones` (Python + `pip install fonttools brotli`).

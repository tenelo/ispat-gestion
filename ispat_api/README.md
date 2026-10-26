# ISPAT Gestion — API Django

Backend de l'application de gestion ISPAT (Angular PWA).
Base : PostgreSQL, schéma `ispat` créé par `ispat_gestion_schema.sql`.

## Principes

1. Les tables métier sont créées et maintenues **par le script SQL**. Les modèles Django sont en `managed = False` : Django ne les modifie jamais.
2. Les tables techniques Django (`django_migrations`, `auth_group`, …) vont dans le schéma `public` (`search_path = public, ispat`).
3. Chaque requête HTTP est une transaction (`ATOMIC_REQUESTS`). L'API y transmet :
   - `app.user_id` → `created_by`, `updated_by`, `journal_audit` ;
   - `app.motif` (en-tête `X-Motif`) → obligatoire pour modifier une note ou une moyenne validée.
4. Droits : codes `module.ressource.action` de la table `ispat.permission`. Une vue sans `permissions_requises` est refusée.
5. Suppression : toujours logique (`deleted_at`), pour la synchronisation hors ligne.

## Installation (développement)

1. Créer la base et l'utilisateur PostgreSQL :
   ```sql
   CREATE ROLE ispat LOGIN PASSWORD '...';
   CREATE DATABASE ispat_gestion OWNER ispat;
   ```
2. Charger le schéma :
   ```bash
   psql -U ispat -d ispat_gestion -f ispat_gestion_schema.sql
   ```
3. Environnement Python :
   ```bash
   python -m venv .venv
   .venv\Scripts\activate          # Windows  (Linux : source .venv/bin/activate)
   pip install -r requirements.txt
   ```
4. Configuration : copier `.env.example` en `.env` et renseigner les valeurs.
5. Tables techniques Django :
   ```bash
   python manage.py migrate
   ```
6. Premier administrateur :
   ```bash
   python manage.py creer_admin --login admin --nom OUATTARA --prenoms "Tenelo Étienne" --email ...
   ```
7. Lancer :
   ```bash
   python manage.py runserver
   ```

## Points d'accès disponibles

| Méthode | URL | Rôle |
|---|---|---|
| GET  | `/api/sante/` | Disponibilité API + base (détection en ligne / hors ligne) |
| POST | `/api/auth/connexion/` | `{login, password}` → `{access, refresh, utilisateur{roles, permissions}}` |
| POST | `/api/auth/rafraichir/` | `{refresh}` → nouveaux jetons |
| GET  | `/api/auth/moi/` | Profil, rôles, permissions de l'utilisateur connecté |
| POST | `/api/auth/mot-de-passe/` | `{actuel, nouveau}` : changement de son propre mot de passe |

### Utilisateurs, rôles et permissions — `/api/`

Droits : `administration.utilisateur.*` (comptes), `administration.role.*` (droits des rôles).

```
utilisateurs/                        GET liste (?q=, ?role=CODE, ?actif=true|false) / POST
                                     {login, mot_de_passe, nom, prenoms, email?, telephone?, roles: ["COMPTABLE", ...]}
utilisateurs/{id}/                   GET / PATCH (roles = liste complète ; actif) / DELETE (suppression logique)
utilisateurs/{id}/mot-de-passe/      POST {mot_de_passe}   réinitialisation par l'administrateur
roles/                               GET rôles + codes de permissions + nombre d'utilisateurs
roles/{id}/permissions/              PUT {permissions: [codes]}   (rôle ADMIN non modifiable)
permissions/                         GET catalogue (module, ressource, action, libellé)
```

Garde-fous : impossible de se désactiver, se supprimer ou se retirer le rôle ADMIN ; il reste toujours au
moins un administrateur actif ; login unique sans tenir compte de la casse (réutilisable après suppression) ;
mot de passe de 8 caractères minimum, ni courant, ni uniquement numérique. Un compte désactivé est refusé
immédiatement, y compris avec un jeton encore valide.

### Référentiels — `/api/referentiels/`

Lecture : tout utilisateur connecté (sauf tarifs : `comptabilite.tarif.lire`).
Écriture : `administration.referentiel.*` ; tarifs `comptabilite.tarif.*` ; types de frais `comptabilite.frais_annexe.*`.

| Ressource | Filtres (`?param=`) |
|---|---|
| `annees/` (+ `POST {id}/activer/`, `POST {id}/copier-structure/ {"source": id}`) | `active`, `q` |
| `semestres/` (créés avec l'année ; dates et clôture modifiables) | `annee`, `numero` |
| `filieres/` | `active`, `q` |
| `niveaux/` | `q` |
| `classes/` (libellé automatique si vide) | `annee`, `filiere`, `niveau`, `q` |
| `matieres/` | `filiere`, `niveau`, `semestre`, `q` |
| `enseignants/` | `type_contrat`, `q` |
| `enseignements/` (contrôle filière / niveau / semestre) | `enseignant`, `classe`, `semestre`, `matiere`, `annee` |
| `statuts-etudiant/`, `types-piece/`, `villes/` | `q` (villes) |
| `ecoles/` | `ville`, `type`, `q` |
| `types-frais/` | `categorie`, `obligatoire` |
| `tarifs/` | `annee`, `type_frais`, `filiere`, `niveau`, `statut` |
| `categories-mouvement/` | `sens` |
| `parametres/{cle}/` (+ `POST parametres/ponderation/`) | — |
| `tout/` (lot complet ; `?depuis=<sync_seq>` = changements seulement) | `depuis` |

### Scolarité — `/api/scolarite/`

| Endpoint | Rôle |
|---|---|
| `etudiants/` | CRUD ; `?q=` (sans accents), `?sexe=`, `?ville=`, `?ecole=` |
| `etudiants/recherche/?q=` | Recherche rapide : matricule exact > partiel > nom approchant (sans accents) |
| `etudiants/matricule/{matricule}/` | Dossier complet par matricule |
| `etudiants/{id}/dossier/` | Étudiant + contacts + inscriptions + pièces + pièces manquantes |
| `etudiants/{id}/photo/` | GET image · POST multipart `photo` (JPEG/PNG/WEBP ≤ 3 Mo → JPEG 800 px) · DELETE |
| `contacts/?etudiant=` | Parents, tuteurs, personne à prévenir |
| `inscriptions/` | CRUD ; `?annee=active&classe=&etat=&statut=&etudiant=&type=&source=&q=` |
| `inscriptions/nouvelle/` | Étudiant (ou `etudiant_id`) + contacts + inscription en un appel |
| `inscriptions/{id}/valider/` | Matricule + frais (triggers). Refus si pièces obligatoires manquantes, sauf `{"forcer": true}` ; refus si classe complète |
| `inscriptions/{id}/annuler/` | `{"motif"}` ; refusé s'il existe des versements ; frais dus supprimés |
| `inscriptions/{id}/abandon/` | `{"motif"}` ; inscription validée, frais et versements conservés |
| `inscriptions/{id}/pieces-manquantes/` | Pièces obligatoires non fournies |
| `pieces/` | multipart `fichier` (PDF/JPEG/PNG ≤ 5 Mo, type vérifié sur le contenu), `type_piece`, `etudiant` et/ou `inscription` |
| `pieces/{id}/fichier/` · `pieces/{id}/verifier/` | Téléchargement · contrôle par la scolarité |
| `listes/classe/?classe=` | Liste de classe |
| `listes/sexe/` · `listes/statut/` | Listes regroupées (`?annee=active&classe=&filiere=&niveau=&sexe=&statut=`) |
| `listes/effectifs/` | Effectifs par classe (total, sexe, statut) |
| `listes/notation/?classe=&semestre=&matiere=` | Étudiants × évaluations |

Listes : `?export=xlsx` ou `?export=csv` (droit `.exporter`), `?inclure_attente=true` pour ajouter les inscriptions en attente.
Fichiers jamais publics : servis par l'API à un utilisateur authentifié. Dossier : `MEDIA_ROOT` (`.env`).

### Comptabilité — `/api/comptabilite/`

| Endpoint | Rôle |
|---|---|
| `frais/` | Frais dus par inscription ; `?inscription=&classe=&categorie=&type_frais=&annee=&q=`. Montant repris du barème si absent ; remise motivée ; refus si le dû deviendrait < au déjà versé |
| `frais/affecter-classe/` | `{classe, type_frais, montant?}` : frais annexe pour toute une classe (idempotent) |
| `prises-en-charge/` | `{inscription, type_payeur, organisme, type_frais?, taux \| montant}` ; total des PEC ≤ total dû |
| `versements/` | GET / POST seulement. Contrôles : trop-perçu, reste par type de frais, référence obligatoire (Mobile Money, virement, chèque), pas de date future. Réponse avec la situation à jour |
| `versements/{id}/annuler/` | `{"motif"}` — écriture de caisse annulée par trigger, motif dans `journal_audit` |
| `versements/{id}/recu/` | Reçu PDF A4, deux exemplaires, montant en lettres, mention ANNULÉ si besoin |
| `mouvements/` | Entrées / sorties ; sens déduit de la catégorie ; `?sens=&categorie=&mode=&du=&au=&manuel=&q=` ; justificatif multipart |
| `mouvements/{id}/annuler/` · `{id}/justificatif/` | Annulation motivée (saisies manuelles) · fichier justificatif |
| `situation/` | Par étudiant : dû, PEC, versé, restes ; `?annee=&classe=&statut=&etat=&solde=debiteur\|solde&q=` |
| `situation/classes/` | Par classe : effectif, recouvrement (%), débiteurs |
| `situation/{inscription_id}/` | Détail : frais par type, PEC, versements |
| `caisse/journal/?du=&au=&mode=` | Journal avec solde initial et solde progressif |
| `caisse/synthese/?du=&au=` | Totaux par catégorie, mode de paiement, mois |

Exports `?export=xlsx|csv` : versements, mouvements, situation, situation par classe, journal de caisse.

### Notes et moyennes — `/api/notes/`

Un enseignant (rôle ENSEIGNANT seul) ne voit et ne saisit que **ses cours** (attributions matière × classe × semestre).

| Endpoint | Rôle |
|---|---|
| `mes-cours/` | Cours de l'enseignant connecté (année active), avec état des examens |
| `evaluations/` | CRUD ; `?classe=&semestre=&matiere=&type=&session=&annee=`. Contrôles : matière de la classe, bon semestre, un seul examen par session, 2e session après la 1re, semestre non clôturé |
| `evaluations/{id}/grille/` | Étudiants concernés + notes + statistiques (2e session : non-admis seulement) |
| `evaluations/{id}/saisir/` | `{"notes": [{"inscription", "valeur", "absent"}]}` ; `valeur: null` efface. Erreur sur une ligne → rien n'est enregistré. Notes validées / moyennes validées → refusées et listées |
| `evaluations/{id}/valider/` | Validation des notes d'examen (`moyenne.validation_note_examen.valider`) ; `{"forcer": true}` si notes manquantes |
| `notes/{id}/` | PATCH. Note validée : droit `modification_note_examen` + `motif` (≥ 5 caractères) → historisée |
| `moyennes/calculer/` | `{classe, semestre}` → `ispat.calculer_moyennes` (ne touche jamais au validé) |
| `moyennes/tableau/` | Délibération : étudiants × matières, moyenne, crédits, rang, décision, statistiques ; `?export=xlsx\|csv` |
| `moyennes/valider/` | `{classe, semestre, matiere?}` ; exige toutes les notes d'examen validées ; recalcule avant de figer |
| `moyennes/rouvrir/` | `{classe, semestre, matiere?, motif}` → repasse en calculé (réclamation, correction) |
| `moyennes/matieres/{id}/modifier/` | `{moyenne, motif}` (moyenne validée) → crédits, moyenne de semestre et rangs recalculés |
| `moyennes/semestre/{id}/modifier/` | `{decision + motif}` et/ou `{appreciation}` |
| `historique/` | Modifications motivées : `?table=&classe=&semestre=&enregistrement=` (avec étudiant, objet, auteur) |

### Bulletins et relevés — `/api/bulletins/` (PDF)

| Endpoint | Rôle |
|---|---|
| `semestre/?inscription=\|classe=&semestre=` | Bulletin de semestre (S1 ou S2) d'un étudiant, ou de toute la classe en un PDF |
| `releve/?inscription=\|classe=&semestre=&session=1\|2` | Relevé de notes d'examen (1re ou 2e session) |
| `…&provisoire=true` | Édition de contrôle : filigrane PROVISOIRE, non numérotée, non archivée, possible avant validation |
| `editions/?inscription=&classe=&semestre=&type=&session=` | Historique des éditions officielles (JSON) |
| `editions/{id}/fichier/` | Copie archivée exacte d'une édition |

Édition officielle : numérotée (`BUL-2026-S1-00001`, `REL-2026-S1-SES2-00001`), archivée dans `MEDIA_ROOT/bulletins/`,
réédition = même numéro. Exige : moyennes de semestre validées (bulletin) / notes d'examen de la session validées (relevé).
Droits : `bulletin.semestre1|semestre2|examen_session1|examen_session2` — `.creer` (officiel), `.lire` (provisoire, historique).
Logo : `ressources/logo_ispat.png` (PNG transparent ; chemin modifiable par `ISPAT_LOGO` dans `.env`).

### Gestion commerciale — `/api/commercial/`

| Endpoint | Rôle |
|---|---|
| `campagnes/` | Campagnes de prospection (objectif d'inscrits) avec compteurs prospects / pré-inscrits / inscrits |
| `prospects/` | CRUD ; doublon (même téléphone, quel que soit le format, ou même identité) → 409 sauf `{"forcer": true}` ; `ecole_nom` libre (école retrouvée sans accents, sinon créée) ; filtres `campagne, annee, ville, ecole, sexe, statut (liste), source, filiere, agent=moi, du, au, relance_avant, q` ; `?export=xlsx\|csv` |
| `prospects/doublons/?telephone=\|nom=&prenoms=` | Contrôle avant saisie |
| `prospects/liste/?groupe=ville\|ecole\|genre\|filiere\|statut` | Liste des prospects par ville, école, genre… (+ export) |
| `prospects/{id}/preinscrire/` | Pré-inscription à partir du prospect |
| `prospects/{id}/inscrire/` | Inscription des prospects : `{classe, statut_etudiant, etudiant?: {compléments}}` → étudiant + inscription en attente |
| `relances/` · `relances/a-faire/?date=&agent=moi` | Historique des relances (1re relance : NOUVEAU → CONTACTÉ) · prospects à relancer et jamais contactés |
| `preinscriptions/` | Liste des pré-inscriptions ; rapprochement automatique avec le prospect de même téléphone ; filtres `annee, statut, source, filiere, niveau, ville, ecole, sexe, du, au, q` ; export |
| `preinscriptions/{id}/valider/` · `rejeter/` | Dossier accepté · rejet motivé |
| `preinscriptions/{id}/pieces/` | GET liste + pièces manquantes · POST multipart `fichier`, `type_piece` |
| `preinscriptions/{id}/inscrire/` | `{classe, statut_etudiant, etudiant_id?, forcer?}` ; pièces reprises dans le dossier ; étudiant semblable → 409 avec la liste |
| `analyse/?campagne=\|annee=&du=&au=&agent=&source=&filiere=` | Taux de contact, de pré-inscription, d'inscription, de conversion ; par ville, école, genre, filière, source, agent, mois ; objectif ; pré-inscriptions de l'année ; `?export=xlsx\|csv` |

Statuts du prospect : NOUVEAU → CONTACTÉ → PRÉ-INSCRIT → INSCRIT (à la validation de l'inscription, trigger) ; PERDU (manuel).
Annuler l'inscription (scolarité) remet le prospect PRÉ-INSCRIT et la pré-inscription « dossier accepté ».

### Synchronisation hors ligne — `/api/sync/`

| Endpoint | Rôle |
|---|---|
| `etat/` | Filigrane, tables reçues par l'utilisateur, opérations qu'il peut envoyer hors ligne |
| `pull/?depuis=&limite=&tables=&initial=` | Changements `depuis < sync_seq <= jusqu_a` (lignes brutes, suppressions comprises). Rappeler avec `depuis = jusqu_a` tant que `complet = false`. Premier chargement : `depuis=0&initial=true` sur toutes les pages. `reinitialiser = true` : base restaurée, tout recharger |
| `push/` | `{"operations": [{op_id, table, action, id, version?, donnees?, motif?}]}` (200 max) → un résultat par opération : `ok`, `deja_traite`, `conflit` (+ ligne serveur), `refuse`, `erreur`, `invalide` |

Garanties :
- **Rien de manqué** : `ispat.sync_filigrane()` attend la fin des écritures en cours ; tout `sync_seq` inférieur ou égal au filigrane est validé.
- **Rien d'appliqué deux fois** : `op_id` (UUID client) mémorisé dans `ispat.sync_operation`.
- **Pas d'écrasement silencieux** : `version` obligatoire pour modifier / supprimer ; version différente → conflit avec la ligne serveur.
- **Mêmes règles qu'en ligne** : chaque opération passe par la vue métier du module (contrôles, droits, triggers), dans son propre point de sauvegarde.
- **Portée** : chaque utilisateur ne reçoit que ses tables ; l'enseignant ne reçoit que ses classes et ses cours, sans les coordonnées des étudiants.

Opérations hors ligne : prospects (créer, modifier, supprimer, pré-inscrire), relances, pré-inscriptions, campagnes,
étudiants, contacts, inscriptions (`nouvelle`, modifier), versements (créer), mouvements de caisse, évaluations (créer,
modifier, supprimer, `saisir` les notes).

### Liaison avec le site WordPress — `/api/wp/`

Authentification par **signature HMAC-SHA256** (pas de JWT) : en-têtes `X-ISPAT-Horodatage` et `X-ISPAT-Signature`
= HMAC(secret, horodatage \n MÉTHODE \n chemin?requête \n sha256(corps)). Refus si signature fausse, corps modifié
ou horodatage à plus de 5 minutes. Secret : `ISPAT_WP_SECRET` (`.env`) = `ISPAT_API_SECRET` (`wp-config.php`).

| Endpoint | Rôle |
|---|---|
| `GET options/` | Listes du formulaire du site : filières actives, niveaux, villes, types de pièces |
| `POST preinscriptions/` | Pré-inscription du site (JSON). Idempotent par `wp_entry_id`. Année visée = année la plus récente ; filière / niveau par code ; ville et école en texte libre (retrouvées sans accents, sinon créées) ; rapprochement avec le prospect de même téléphone |
| `PUT preinscriptions/{wp_entry_id}/pieces/{TYPE}/` | Pièce jointe (corps = fichier brut, PDF/JPEG/PNG ≤ 5 Mo, type vérifié sur le contenu). Un renvoi remplace la version précédente |

À l'inscription d'une pré-inscription, la photo d'identité jointe devient la photo de l'étudiant.

`annee=active` sélectionne l'année académique active.
Suppression = logique, refusée (409) si l'élément est encore utilisé.
Erreurs base traduites : doublon → 409, contrôle / référence → 400, message des triggers → 400.

## Créer une vue protégée

```python
from core.mixins import ViewSetISPAT
from core.permissions import permissions_crud

class VersementViewSet(ViewSetISPAT):
    queryset = Versement.objects.all()
    serializer_class = VersementSerializer
    permissions_requises = permissions_crud("comptabilite.versement")
```

## Structure

```
config/          paramètres, urls, wsgi/asgi
core/
  models.py      ModeleSynchro (base commune), Utilisateur, Role, Permission, liaisons
  backends.py    authentification (login insensible à la casse)
  permissions.py PermissionISPAT, permissions_crud()
  mixins.py      ContexteAuditMixin, VueISPAT, ViewSetISPAT (suppression logique, contrôle des dépendances)
  exceptions.py  traduction des erreurs PostgreSQL, Conflit (409)
  filtres.py     FiltreSimpleMixin, filtre_annee(), filtre_booleen()
  base_serializers.py  SerializerSynchro, champs()
  serializers.py connexion JWT + profil
  views.py       santé, connexion, profil
  management/commands/creer_admin.py
  exports.py     export Excel / CSV aux couleurs ISPAT
referentiels/    16 référentiels (modèles, serializers, vues, urls)
scolarite/       étudiants, contacts, inscriptions, pièces jointes, photo, listes
  fichiers.py    contrôle et stockage des fichiers
  listes.py      listes et exports
comptabilite/    frais, prises en charge, versements, caisse
  calculs.py     situation d'une inscription, barème, montant en lettres
  recu.py        reçu PDF
  situation.py   situation financière, journal et synthèse de caisse
notes/           évaluations, notes, moyennes
  portee.py      restriction de l'enseignant à ses cours
  outils.py      concernés par une évaluation, recalcul semestre / rangs
  moyennes.py    calcul, tableau, validation, réouverture, modifications
bulletins/       bulletins de semestre, relevés d'examen
  donnees.py     assemblage, statistiques de classe, contrôles, numérotation
  pdf.py         mise en page (logo, photo, tableau, synthèse, signatures)
commercial/      campagnes, prospects, relances, pré-inscriptions
  services.py    doublons, rapprochement, conversion en inscription
  analyse.py     taux et répartitions
sync/            synchronisation hors ligne
  registre.py    tables synchronisées : droits, portée, colonnes, opérations d'envoi
  views.py       état, pull, push
siteweb/         réception des pré-inscriptions du site WordPress
  signature.py   vérification HMAC
ressources/      logo_ispat.png
```

## Données de l'établissement

Après le schéma, charger l'offre de formation officielle (17 filières, niveaux BT1–BT3 / BTS1–BTS2) :

```bash
psql -U ispat -d ispat_gestion -f ispat_donnees_003_offre_formation.sql
```

## Mise à jour d'une base existante

Base créée avec une version antérieure du schéma : exécuter les correctifs dans l'ordre.

```bash
psql -U ispat -d ispat_gestion -f ispat_patch_001_recherche_sans_accent.sql
psql -U ispat -d ispat_gestion -f ispat_patch_002_situation_abandon.sql
psql -U ispat -d ispat_gestion -f ispat_patch_004_synchronisation.sql
```

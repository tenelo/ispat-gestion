-- =============================================================================
--  ISPAT GESTION — Schéma PostgreSQL (v1)
--  Institut Supérieur Privé d'Agriculture et Technologie — Ferkessédougou
--
--  Cible      : PostgreSQL 14+ (testé sur 16)
--  Front      : Angular PWA (hors ligne via IndexedDB + file d'attente de sync)
--  Conventions:
--    * Clés primaires UUID  -> générables côté client hors ligne (crypto.randomUUID()).
--    * deleted_at           -> suppression logique (tombstone propagé aux clients).
--    * version              -> verrou optimiste (UPDATE ... WHERE id = :id AND version = :v).
--    * sync_seq             -> curseur de synchronisation (pull : WHERE sync_seq > :dernier).
--    * created_by/updated_by-> renseignés via  SET LOCAL app.user_id = '<uuid>'  par l'API.
--    * Motif de modification d'une note/moyenne validée : SET LOCAL app.motif = '...'.
--    * Montants en FCFA (XOF), sans décimales.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS ispat;
SET search_path = ispat, public;

CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ispat;    -- recherche floue nom/prénoms
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA ispat;   -- recherche insensible aux accents (KONÉ = KONE)

-- Texte normalisé pour la recherche : minuscules, sans accents (IMMUTABLE -> indexable)
CREATE OR REPLACE FUNCTION ispat.sans_accent(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lower(ispat.unaccent('ispat.unaccent'::regdictionary, $1))
$$;

CREATE SEQUENCE ispat.sync_seq;           -- curseur global de synchronisation
CREATE SEQUENCE ispat.recu_seq;           -- numérotation des reçus de versement

-- Utilisateur courant transmis par l'API
CREATE OR REPLACE FUNCTION ispat.app_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- =============================================================================
-- 1. SÉCURITÉ : utilisateurs, rôles, permissions, audit
-- =============================================================================

CREATE TABLE ispat.role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  libelle     text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE TABLE ispat.permission (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,          -- ex: comptabilite.versement.creer
  module      text NOT NULL,                 -- comptabilite | scolarite | moyenne | bulletin | commercial | administration
  ressource   text NOT NULL,                 -- versement, inscription, ...
  action      text NOT NULL CHECK (action IN ('lire','creer','modifier','supprimer','valider','exporter')),
  libelle     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE TABLE ispat.role_permission (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id       uuid NOT NULL REFERENCES ispat.role(id),
  permission_id uuid NOT NULL REFERENCES ispat.permission(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  sync_seq      bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by    uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_role_permission ON ispat.role_permission(role_id, permission_id) WHERE deleted_at IS NULL;

CREATE TABLE ispat.utilisateur (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login             text NOT NULL,
  email             text,
  mot_de_passe_hash text NOT NULL,          -- argon2id / bcrypt calculé par l'API, jamais en clair
  nom               text NOT NULL,
  prenoms           text NOT NULL,
  telephone         text,
  actif             boolean NOT NULL DEFAULT true,
  derniere_connexion timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  sync_seq          bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by        uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_utilisateur_login ON ispat.utilisateur(lower(login)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_utilisateur_email ON ispat.utilisateur(lower(email)) WHERE deleted_at IS NULL AND email IS NOT NULL;

CREATE TABLE ispat.utilisateur_role (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id uuid NOT NULL REFERENCES ispat.utilisateur(id),
  role_id        uuid NOT NULL REFERENCES ispat.role(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  sync_seq       bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by     uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_utilisateur_role ON ispat.utilisateur_role(utilisateur_id, role_id) WHERE deleted_at IS NULL;

-- Journal d'audit (serveur uniquement, non synchronisé)
CREATE TABLE ispat.journal_audit (
  id                bigserial PRIMARY KEY,
  table_nom         text NOT NULL,
  enregistrement_id uuid NOT NULL,
  action            text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  ancien            jsonb,
  nouveau           jsonb,
  utilisateur_id    uuid,
  motif             text,
  date_action       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_journal_audit_ref ON ispat.journal_audit(table_nom, enregistrement_id);
CREATE INDEX ix_journal_audit_date ON ispat.journal_audit(date_action);

-- =============================================================================
-- 2. PARAMÈTRES
-- =============================================================================

CREATE TABLE ispat.parametre (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cle         text NOT NULL UNIQUE,
  valeur      text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE OR REPLACE FUNCTION ispat.param(p_cle text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT valeur FROM ispat.parametre WHERE cle = p_cle AND deleted_at IS NULL
$$;

-- =============================================================================
-- 3. RÉFÉRENTIELS ACADÉMIQUES
-- =============================================================================

CREATE TABLE ispat.annee_academique (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  libelle     text NOT NULL UNIQUE,          -- 2026-2027
  date_debut  date NOT NULL,
  date_fin    date NOT NULL,
  est_active  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid,
  CHECK (date_fin > date_debut)
);
CREATE UNIQUE INDEX ux_annee_active ON ispat.annee_academique(est_active) WHERE est_active AND deleted_at IS NULL;

CREATE TABLE ispat.semestre (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annee_id    uuid NOT NULL REFERENCES ispat.annee_academique(id),
  numero      smallint NOT NULL CHECK (numero IN (1,2)),
  date_debut  date,
  date_fin    date,
  cloture     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_semestre ON ispat.semestre(annee_id, numero) WHERE deleted_at IS NULL;

CREATE TABLE ispat.filiere (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,                 -- 3 lettres conseillées (entre dans le matricule)
  libelle     text NOT NULL,
  description text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_filiere_code ON ispat.filiere(upper(code)) WHERE deleted_at IS NULL;

CREATE TABLE ispat.niveau (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,                 -- L1, L2, L3, M1, M2, BTS1, BTS2
  libelle     text NOT NULL,
  ordre       smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_niveau_code ON ispat.niveau(upper(code)) WHERE deleted_at IS NULL;

CREATE TABLE ispat.classe (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annee_id    uuid NOT NULL REFERENCES ispat.annee_academique(id),
  filiere_id  uuid NOT NULL REFERENCES ispat.filiere(id),
  niveau_id   uuid NOT NULL REFERENCES ispat.niveau(id),
  libelle     text NOT NULL,                 -- ex: L1 Production Animale A
  groupe      text,                          -- A, B, ...
  capacite    integer CHECK (capacite IS NULL OR capacite > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_classe ON ispat.classe(annee_id, filiere_id, niveau_id, coalesce(groupe,'')) WHERE deleted_at IS NULL;

CREATE TABLE ispat.matiere (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  libelle         text NOT NULL,
  filiere_id      uuid NOT NULL REFERENCES ispat.filiere(id),
  niveau_id       uuid NOT NULL REFERENCES ispat.niveau(id),
  semestre_numero smallint NOT NULL CHECK (semestre_numero IN (1,2)),
  coefficient     numeric(4,2) NOT NULL DEFAULT 1 CHECK (coefficient > 0),
  credits         smallint NOT NULL DEFAULT 0 CHECK (credits >= 0),
  volume_horaire  smallint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  sync_seq        bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by      uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_matiere ON ispat.matiere(filiere_id, niveau_id, upper(code)) WHERE deleted_at IS NULL;

CREATE TABLE ispat.enseignant (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id uuid REFERENCES ispat.utilisateur(id),   -- compte pour la saisie des notes
  nom            text NOT NULL,
  prenoms        text NOT NULL,
  sexe           char(1) CHECK (sexe IN ('M','F')),
  telephone      text,
  email          text,
  specialite     text,
  type_contrat   text CHECK (type_contrat IN ('PERMANENT','VACATAIRE')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  sync_seq       bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by     uuid, updated_by uuid
);

CREATE TABLE ispat.enseignement (            -- qui enseigne quoi, dans quelle classe, quel semestre
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enseignant_id uuid NOT NULL REFERENCES ispat.enseignant(id),
  matiere_id    uuid NOT NULL REFERENCES ispat.matiere(id),
  classe_id     uuid NOT NULL REFERENCES ispat.classe(id),
  semestre_id   uuid NOT NULL REFERENCES ispat.semestre(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  sync_seq      bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by    uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_enseignement ON ispat.enseignement(matiere_id, classe_id, semestre_id) WHERE deleted_at IS NULL;

CREATE TABLE ispat.statut_etudiant (         -- Affecté de l'État, Non affecté, ...
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  libelle     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE TABLE ispat.type_piece (              -- pièces du dossier d'inscription
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  libelle     text NOT NULL,
  obligatoire boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE TABLE ispat.ville (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  libelle     text NOT NULL,
  region      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_ville ON ispat.ville(lower(libelle)) WHERE deleted_at IS NULL;

CREATE TABLE ispat.ecole (                   -- établissement d'origine (lycée, collège, ...)
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom         text NOT NULL,
  ville_id    uuid REFERENCES ispat.ville(id),
  type_ecole  text CHECK (type_ecole IN ('LYCEE','COLLEGE','UNIVERSITE','AUTRE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_ecole ON ispat.ecole(lower(nom), ville_id) WHERE deleted_at IS NULL;

-- =============================================================================
-- 4. GESTION COMMERCIALE (prospection)
-- =============================================================================

CREATE TABLE ispat.campagne_prospection (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annee_id    uuid NOT NULL REFERENCES ispat.annee_academique(id),
  libelle     text NOT NULL,
  date_debut  date NOT NULL,
  date_fin    date,
  objectif    integer,                       -- nombre d'inscrits visé
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE TABLE ispat.prospect (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campagne_id         uuid REFERENCES ispat.campagne_prospection(id),
  nom                 text NOT NULL,
  prenoms             text NOT NULL,
  sexe                char(1) NOT NULL CHECK (sexe IN ('M','F')),
  date_naissance      date,
  telephone           text,
  telephone_parent    text,
  email               text,
  ville_id            uuid REFERENCES ispat.ville(id),
  ecole_id            uuid REFERENCES ispat.ecole(id),
  niveau_etude        text,                  -- Terminale, BAC, BTS, Licence...
  serie_bac           text,                  -- A, C, D, ...
  filiere_souhaitee_id uuid REFERENCES ispat.filiere(id),
  source              text NOT NULL DEFAULT 'TERRAIN'
                      CHECK (source IN ('TERRAIN','SITE_WEB','SALON','RESEAUX_SOCIAUX','RECOMMANDATION','AUTRE')),
  agent_id            uuid REFERENCES ispat.utilisateur(id),   -- commercial ayant collecté
  date_contact        date NOT NULL DEFAULT current_date,
  statut              text NOT NULL DEFAULT 'NOUVEAU'
                      CHECK (statut IN ('NOUVEAU','CONTACTE','PREINSCRIT','INSCRIT','PERDU')),
  etudiant_id         uuid,                  -- FK ajoutée après création d'etudiant
  observations        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  version             integer NOT NULL DEFAULT 1,
  sync_seq            bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by          uuid, updated_by uuid
);
CREATE INDEX ix_prospect_campagne ON ispat.prospect(campagne_id);
CREATE INDEX ix_prospect_ville    ON ispat.prospect(ville_id);
CREATE INDEX ix_prospect_ecole    ON ispat.prospect(ecole_id);
CREATE INDEX ix_prospect_statut   ON ispat.prospect(statut);
CREATE INDEX ix_prospect_tel      ON ispat.prospect(telephone);

CREATE TABLE ispat.suivi_prospect (          -- historique des relances
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES ispat.prospect(id),
  date_suivi  timestamptz NOT NULL DEFAULT now(),
  canal       text NOT NULL CHECK (canal IN ('APPEL','SMS','WHATSAPP','EMAIL','VISITE')),
  resultat    text,
  prochaine_relance date,
  agent_id    uuid REFERENCES ispat.utilisateur(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

-- =============================================================================
-- 5. SCOLARITÉ : étudiants, inscriptions, pré-inscriptions, pièces jointes
-- =============================================================================

CREATE TABLE ispat.etudiant (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matricule        text UNIQUE,              -- attribué à la 1re inscription validée (voir trigger)
  nom              text NOT NULL,
  prenoms          text NOT NULL,
  sexe             char(1) NOT NULL CHECK (sexe IN ('M','F')),
  date_naissance   date,
  lieu_naissance   text,
  nationalite      text DEFAULT 'Ivoirienne',
  num_piece_identite text,
  telephone        text,
  email            text,
  adresse          text,
  ville_id         uuid REFERENCES ispat.ville(id),
  ecole_origine_id uuid REFERENCES ispat.ecole(id),
  serie_bac        text,
  annee_bac        smallint,
  photo_chemin     text,                     -- chemin/URL du fichier photo
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  version          integer NOT NULL DEFAULT 1,
  sync_seq         bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by       uuid, updated_by uuid
);
CREATE INDEX ix_etudiant_nom_trgm ON ispat.etudiant USING gin (ispat.sans_accent(nom || ' ' || prenoms) gin_trgm_ops);
CREATE INDEX ix_etudiant_matricule_trgm ON ispat.etudiant USING gin (upper(matricule) gin_trgm_ops);

ALTER TABLE ispat.prospect
  ADD CONSTRAINT fk_prospect_etudiant FOREIGN KEY (etudiant_id) REFERENCES ispat.etudiant(id);

CREATE TABLE ispat.contact_etudiant (        -- parents / tuteurs / personne à prévenir
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  etudiant_id uuid NOT NULL REFERENCES ispat.etudiant(id),
  lien        text NOT NULL CHECK (lien IN ('PERE','MERE','TUTEUR','CONJOINT','AUTRE')),
  nom_complet text NOT NULL,
  telephone   text,
  profession  text,
  est_urgence boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE TABLE ispat.compteur_matricule (      -- compteur par année x filière (serveur uniquement)
  annee_code   text NOT NULL,
  filiere_code text NOT NULL,
  dernier      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (annee_code, filiere_code)
);

CREATE TABLE ispat.inscription (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  etudiant_id        uuid NOT NULL REFERENCES ispat.etudiant(id),
  annee_id           uuid NOT NULL REFERENCES ispat.annee_academique(id),
  classe_id          uuid NOT NULL REFERENCES ispat.classe(id),
  statut_etudiant_id uuid NOT NULL REFERENCES ispat.statut_etudiant(id),
  type_inscription   text NOT NULL DEFAULT 'NOUVELLE'
                     CHECK (type_inscription IN ('NOUVELLE','REINSCRIPTION','REDOUBLEMENT','TRANSFERT')),
  date_inscription   date NOT NULL DEFAULT current_date,
  etat               text NOT NULL DEFAULT 'EN_ATTENTE'
                     CHECK (etat IN ('EN_ATTENTE','VALIDEE','ANNULEE','ABANDON')),
  source             text NOT NULL DEFAULT 'GUICHET' CHECK (source IN ('GUICHET','SITE_WEB','PROSPECTION')),
  prospect_id        uuid REFERENCES ispat.prospect(id),
  valide_par         uuid REFERENCES ispat.utilisateur(id),
  valide_le          timestamptz,
  observations       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1,
  sync_seq           bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by         uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_inscription_annee ON ispat.inscription(etudiant_id, annee_id)
  WHERE deleted_at IS NULL AND etat <> 'ANNULEE';
CREATE INDEX ix_inscription_classe ON ispat.inscription(classe_id);

CREATE TABLE ispat.preinscription (          -- alimentée par le formulaire WordPress ou le guichet
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annee_id             uuid NOT NULL REFERENCES ispat.annee_academique(id),
  prospect_id          uuid REFERENCES ispat.prospect(id),
  nom                  text NOT NULL,
  prenoms              text NOT NULL,
  sexe                 char(1) NOT NULL CHECK (sexe IN ('M','F')),
  date_naissance       date,
  lieu_naissance       text,
  telephone            text,
  email                text,
  ville_id             uuid REFERENCES ispat.ville(id),
  ecole_id             uuid REFERENCES ispat.ecole(id),
  serie_bac            text,
  filiere_souhaitee_id uuid REFERENCES ispat.filiere(id),
  niveau_souhaite_id   uuid REFERENCES ispat.niveau(id),
  source               text NOT NULL DEFAULT 'SITE_WEB' CHECK (source IN ('SITE_WEB','GUICHET','PROSPECTION')),
  wp_entry_id          text,                 -- identifiant de l'entrée côté WordPress (idempotence import)
  donnees_brutes       jsonb,                -- payload WordPress d'origine
  statut               text NOT NULL DEFAULT 'EN_ATTENTE'
                       CHECK (statut IN ('EN_ATTENTE','VALIDEE','REJETEE','CONVERTIE')),
  inscription_id       uuid REFERENCES ispat.inscription(id),   -- renseigné à la conversion
  traite_par           uuid REFERENCES ispat.utilisateur(id),
  traite_le            timestamptz,
  motif_rejet          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  version              integer NOT NULL DEFAULT 1,
  sync_seq             bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by           uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_preinscription_wp ON ispat.preinscription(wp_entry_id) WHERE wp_entry_id IS NOT NULL;
CREATE INDEX ix_preinscription_statut ON ispat.preinscription(statut);

CREATE TABLE ispat.piece_jointe (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_piece_id     uuid NOT NULL REFERENCES ispat.type_piece(id),
  etudiant_id       uuid REFERENCES ispat.etudiant(id),
  inscription_id    uuid REFERENCES ispat.inscription(id),
  preinscription_id uuid REFERENCES ispat.preinscription(id),
  nom_fichier       text NOT NULL,
  chemin            text NOT NULL,           -- stockage fichier (disque VPS / objet), jamais le binaire en base
  mime_type         text,
  taille_octets     bigint,
  verifie           boolean NOT NULL DEFAULT false,
  verifie_par       uuid REFERENCES ispat.utilisateur(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  sync_seq          bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by        uuid, updated_by uuid,
  CHECK (num_nonnulls(etudiant_id, inscription_id, preinscription_id) >= 1)
);

-- =============================================================================
-- 6. NOTES, MOYENNES, BULLETINS
-- =============================================================================

CREATE TABLE ispat.evaluation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  classe_id     uuid NOT NULL REFERENCES ispat.classe(id),
  matiere_id    uuid NOT NULL REFERENCES ispat.matiere(id),
  semestre_id   uuid NOT NULL REFERENCES ispat.semestre(id),
  type_eval     text NOT NULL CHECK (type_eval IN ('DEVOIR','INTERROGATION','TP','EXPOSE','EXAMEN')),
  session       smallint NOT NULL DEFAULT 1 CHECK (session IN (1,2)),   -- utile pour EXAMEN
  libelle       text NOT NULL,
  date_eval     date,
  poids         numeric(4,2) NOT NULL DEFAULT 1 CHECK (poids > 0),      -- poids dans la moyenne de CC
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1,
  sync_seq      bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by    uuid, updated_by uuid,
  CHECK (type_eval = 'EXAMEN' OR session = 1)
);
CREATE INDEX ix_evaluation_cms ON ispat.evaluation(classe_id, matiere_id, semestre_id);
CREATE UNIQUE INDEX ux_evaluation_examen ON ispat.evaluation(classe_id, matiere_id, semestre_id, session)
  WHERE type_eval = 'EXAMEN' AND deleted_at IS NULL;

CREATE TABLE ispat.note (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id  uuid NOT NULL REFERENCES ispat.evaluation(id),
  inscription_id uuid NOT NULL REFERENCES ispat.inscription(id),
  valeur         numeric(4,2) CHECK (valeur BETWEEN 0 AND 20),
  absent         boolean NOT NULL DEFAULT false,      -- absent = 0 dans les calculs
  statut         text NOT NULL DEFAULT 'SAISIE' CHECK (statut IN ('SAISIE','VALIDEE')),
  saisi_par      uuid REFERENCES ispat.utilisateur(id),
  valide_par     uuid REFERENCES ispat.utilisateur(id),
  valide_le      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  sync_seq       bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by     uuid, updated_by uuid,
  CHECK (valeur IS NOT NULL OR absent)
);
CREATE UNIQUE INDEX ux_note ON ispat.note(evaluation_id, inscription_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_note_inscription ON ispat.note(inscription_id);

CREATE TABLE ispat.moyenne_matiere (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inscription_id   uuid NOT NULL REFERENCES ispat.inscription(id),
  matiere_id       uuid NOT NULL REFERENCES ispat.matiere(id),
  semestre_id      uuid NOT NULL REFERENCES ispat.semestre(id),
  moyenne_cc       numeric(5,2),             -- contrôle continu
  note_examen_s1   numeric(4,2),             -- examen 1re session
  note_examen_s2   numeric(4,2),             -- examen 2e session (rattrapage)
  moyenne_session1 numeric(5,2),
  moyenne_finale   numeric(5,2),
  credits_acquis   smallint NOT NULL DEFAULT 0,
  statut           text NOT NULL DEFAULT 'CALCULEE' CHECK (statut IN ('CALCULEE','VALIDEE')),
  valide_par       uuid REFERENCES ispat.utilisateur(id),
  valide_le        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  version          integer NOT NULL DEFAULT 1,
  sync_seq         bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by       uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_moyenne_matiere ON ispat.moyenne_matiere(inscription_id, matiere_id, semestre_id) WHERE deleted_at IS NULL;

CREATE TABLE ispat.moyenne_semestre (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inscription_id uuid NOT NULL REFERENCES ispat.inscription(id),
  semestre_id    uuid NOT NULL REFERENCES ispat.semestre(id),
  moyenne        numeric(5,2),
  credits_acquis smallint NOT NULL DEFAULT 0,
  credits_total  smallint NOT NULL DEFAULT 0,
  rang           integer,
  decision       text CHECK (decision IN ('ADMIS','AJOURNE','SESSION2')),
  appreciation   text,
  statut         text NOT NULL DEFAULT 'CALCULEE' CHECK (statut IN ('CALCULEE','VALIDEE')),
  valide_par     uuid REFERENCES ispat.utilisateur(id),
  valide_le      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  sync_seq       bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by     uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_moyenne_semestre ON ispat.moyenne_semestre(inscription_id, semestre_id) WHERE deleted_at IS NULL;

-- Traçabilité des modifications de notes / moyennes déjà validées
CREATE TABLE ispat.historique_modification (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_nom         text NOT NULL CHECK (table_nom IN ('note','moyenne_matiere','moyenne_semestre')),
  enregistrement_id uuid NOT NULL,
  champ             text NOT NULL,
  ancienne_valeur   numeric(5,2),
  nouvelle_valeur   numeric(5,2),
  motif             text NOT NULL,
  modifie_par       uuid,
  modifie_le        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  version           integer NOT NULL DEFAULT 1,
  sync_seq          bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by        uuid, updated_by uuid
);
CREATE INDEX ix_historique_ref ON ispat.historique_modification(table_nom, enregistrement_id);

CREATE TABLE ispat.bulletin (                -- trace de chaque bulletin / relevé édité
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inscription_id uuid NOT NULL REFERENCES ispat.inscription(id),
  semestre_id    uuid REFERENCES ispat.semestre(id),
  type_bulletin  text NOT NULL CHECK (type_bulletin IN ('SEMESTRE','RELEVE_EXAMEN')),
  session        smallint CHECK (session IN (1,2)),
  numero         text,
  date_edition   timestamptz NOT NULL DEFAULT now(),
  fichier_chemin text,                       -- PDF généré
  edite_par      uuid REFERENCES ispat.utilisateur(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  sync_seq       bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by     uuid, updated_by uuid,
  CHECK (type_bulletin = 'SEMESTRE' OR session IS NOT NULL)
);

-- =============================================================================
-- 7. COMPTABILITÉ
-- =============================================================================

CREATE TABLE ispat.type_frais (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  libelle     text NOT NULL,
  categorie   text NOT NULL CHECK (categorie IN ('INSCRIPTION','SCOLARITE','ANNEXE')),
  obligatoire boolean NOT NULL DEFAULT true,  -- généré automatiquement à la validation de l'inscription
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE TABLE ispat.tarif (                   -- barème : NULL = s'applique à tous
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annee_id           uuid NOT NULL REFERENCES ispat.annee_academique(id),
  type_frais_id      uuid NOT NULL REFERENCES ispat.type_frais(id),
  filiere_id         uuid REFERENCES ispat.filiere(id),
  niveau_id          uuid REFERENCES ispat.niveau(id),
  statut_etudiant_id uuid REFERENCES ispat.statut_etudiant(id),
  montant            numeric(14,0) NOT NULL CHECK (montant >= 0),
  nb_tranches        smallint NOT NULL DEFAULT 1 CHECK (nb_tranches >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1,
  sync_seq           bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by         uuid, updated_by uuid
);
CREATE UNIQUE INDEX ux_tarif ON ispat.tarif(annee_id, type_frais_id,
  coalesce(filiere_id,'00000000-0000-0000-0000-000000000000'),
  coalesce(niveau_id,'00000000-0000-0000-0000-000000000000'),
  coalesce(statut_etudiant_id,'00000000-0000-0000-0000-000000000000')) WHERE deleted_at IS NULL;

CREATE TABLE ispat.frais_inscription (       -- ce que doit chaque inscrit (scolarité + frais annexes)
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inscription_id uuid NOT NULL REFERENCES ispat.inscription(id),
  type_frais_id  uuid NOT NULL REFERENCES ispat.type_frais(id),
  montant        numeric(14,0) NOT NULL CHECK (montant >= 0),
  remise         numeric(14,0) NOT NULL DEFAULT 0 CHECK (remise >= 0),
  motif_remise   text,
  date_echeance  date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  sync_seq       bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by     uuid, updated_by uuid,
  CHECK (remise <= montant)
);
CREATE UNIQUE INDEX ux_frais_inscription ON ispat.frais_inscription(inscription_id, type_frais_id) WHERE deleted_at IS NULL;

CREATE TABLE ispat.prise_en_charge (         -- État, entreprise, ONG, bourse, parent tiers...
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inscription_id uuid NOT NULL REFERENCES ispat.inscription(id),
  type_frais_id  uuid REFERENCES ispat.type_frais(id),   -- NULL = toutes catégories
  type_payeur    text NOT NULL CHECK (type_payeur IN ('ETAT','ENTREPRISE','ONG','BOURSE','PARENT_TIERS','AUTRE')),
  organisme      text NOT NULL,
  taux           numeric(5,2) CHECK (taux IS NULL OR taux BETWEEN 0 AND 100),
  montant        numeric(14,0) NOT NULL CHECK (montant >= 0),
  reference_doc  text,                        -- n° convention / lettre d'affectation
  date_accord    date,
  statut         text NOT NULL DEFAULT 'ACTIVE' CHECK (statut IN ('ACTIVE','SUSPENDUE','ANNULEE')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  sync_seq       bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by     uuid, updated_by uuid
);

CREATE TABLE ispat.versement (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inscription_id     uuid NOT NULL REFERENCES ispat.inscription(id),
  type_frais_id      uuid REFERENCES ispat.type_frais(id),   -- NULL = imputation globale
  payeur             text NOT NULL DEFAULT 'ETUDIANT' CHECK (payeur IN ('ETUDIANT','PRISE_EN_CHARGE')),
  prise_en_charge_id uuid REFERENCES ispat.prise_en_charge(id),
  montant            numeric(14,0) NOT NULL CHECK (montant > 0),
  date_versement     date NOT NULL DEFAULT current_date,
  mode_paiement      text NOT NULL CHECK (mode_paiement IN ('ESPECES','MOBILE_MONEY','VIREMENT','CHEQUE','AUTRE')),
  reference          text,                    -- n° transaction mobile money / chèque
  numero_recu        text UNIQUE,             -- généré serveur si NULL
  annule             boolean NOT NULL DEFAULT false,
  motif_annulation   text,
  encaisse_par       uuid REFERENCES ispat.utilisateur(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1,
  sync_seq           bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by         uuid, updated_by uuid,
  CHECK (payeur = 'ETUDIANT' OR prise_en_charge_id IS NOT NULL),
  CHECK (NOT annule OR motif_annulation IS NOT NULL)
);
CREATE INDEX ix_versement_inscription ON ispat.versement(inscription_id);
CREATE INDEX ix_versement_date ON ispat.versement(date_versement);

CREATE TABLE ispat.categorie_mouvement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  libelle     text NOT NULL,
  sens        text NOT NULL CHECK (sens IN ('ENTREE','SORTIE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  sync_seq    bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by  uuid, updated_by uuid
);

CREATE TABLE ispat.mouvement_caisse (        -- Entrées / Sorties
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sens           text NOT NULL CHECK (sens IN ('ENTREE','SORTIE')),
  categorie_id   uuid NOT NULL REFERENCES ispat.categorie_mouvement(id),
  montant        numeric(14,0) NOT NULL CHECK (montant > 0),
  date_mouvement date NOT NULL DEFAULT current_date,
  libelle        text NOT NULL,
  tiers          text,                        -- fournisseur / bénéficiaire / déposant
  mode_paiement  text NOT NULL CHECK (mode_paiement IN ('ESPECES','MOBILE_MONEY','VIREMENT','CHEQUE','AUTRE')),
  reference      text,
  justificatif_chemin text,
  versement_id   uuid UNIQUE REFERENCES ispat.versement(id),   -- entrée générée automatiquement
  annule         boolean NOT NULL DEFAULT false,
  saisi_par      uuid REFERENCES ispat.utilisateur(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  sync_seq       bigint NOT NULL DEFAULT nextval('ispat.sync_seq'),
  created_by     uuid, updated_by uuid
);
CREATE INDEX ix_mouvement_date ON ispat.mouvement_caisse(date_mouvement);

-- =============================================================================
-- 8. TRIGGERS
-- =============================================================================

-- 8.1 Colonnes techniques (toutes les tables synchronisées)
--     Verrou consultatif PARTAGÉ pris AVANT d'attribuer sync_seq : ispat.sync_filigrane() (verrou EXCLUSIF)
--     attend ainsi la fin des transactions en cours ; tout sync_seq <= filigrane est donc déjà validé.
--     (À l'INSERT, la valeur par défaut de sync_seq est calculée avant le trigger : on la réattribue.)
CREATE OR REPLACE FUNCTION ispat.tg_colonnes_techniques() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(7234001);
  NEW.sync_seq := nextval('ispat.sync_seq');
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := coalesce(NEW.created_by, ispat.app_user());
    NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := coalesce(ispat.app_user(), NEW.updated_by);
    NEW.version    := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'ispat' AND c.column_name = 'sync_seq'
  LOOP
    EXECUTE format('CREATE TRIGGER a_colonnes_techniques BEFORE INSERT OR UPDATE ON ispat.%I
                    FOR EACH ROW EXECUTE FUNCTION ispat.tg_colonnes_techniques()', t.table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON ispat.%I (sync_seq)', 'ix_' || t.table_name || '_sync_seq',
                   t.table_name);
  END LOOP;
END $$;

-- 8.1 bis Synchronisation hors ligne
-- Filigrane : plus grand sync_seq dont toutes les écritures sont validées (voir 8.1).
CREATE OR REPLACE FUNCTION ispat.sync_filigrane() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  PERFORM pg_advisory_lock(7234001);          -- attend les transactions d'écriture en cours
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO v FROM ispat.sync_seq;
  PERFORM pg_advisory_unlock(7234001);
  RETURN v;
END $$;

-- Opérations reçues des clients hors ligne (idempotence : un op_id n'est appliqué qu'une fois)
CREATE TABLE ispat.sync_operation (
  op_id             uuid PRIMARY KEY,
  utilisateur_id    uuid NOT NULL REFERENCES ispat.utilisateur(id),
  table_nom         text NOT NULL,
  action            text NOT NULL,
  enregistrement_id uuid,
  statut            text NOT NULL CHECK (statut IN ('OK', 'CONFLIT', 'ERREUR', 'REFUSE')),
  code_http         smallint,
  reponse           jsonb,
  recu_le           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sync_operation_utilisateur ON ispat.sync_operation(utilisateur_id, recu_le);

-- 8.2 Journal d'audit (tables sensibles)
CREATE OR REPLACE FUNCTION ispat.tg_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ispat.journal_audit(table_nom, enregistrement_id, action, ancien, nouveau, utilisateur_id, motif)
  VALUES (TG_TABLE_NAME,
          CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
          TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
          ispat.app_user(),
          NULLIF(current_setting('app.motif', true), ''));
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inscription','note','moyenne_matiere','moyenne_semestre','versement',
                           'mouvement_caisse','prise_en_charge','frais_inscription','tarif',
                           'utilisateur_role','role_permission']
  LOOP
    EXECUTE format('CREATE TRIGGER z_audit AFTER INSERT OR UPDATE OR DELETE ON ispat.%I
                    FOR EACH ROW EXECUTE FUNCTION ispat.tg_audit()', t);
  END LOOP;
END $$;

-- 8.3 Protection des notes / moyennes validées
--     Toute modification de la valeur d'un enregistrement VALIDEE exige SET LOCAL app.motif
--     et est historisée. Une suppression d'un enregistrement validé est interdite.
--     TG_ARGV[0] = colonne protégée
CREATE OR REPLACE FUNCTION ispat.tg_proteger_valide() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_col    text := TG_ARGV[0];
  v_old    numeric := (to_jsonb(OLD) ->> v_col)::numeric;
  v_new    numeric := (to_jsonb(NEW) ->> v_col)::numeric;
  v_motif  text := NULLIF(current_setting('app.motif', true), '');
BEGIN
  IF OLD.statut = 'VALIDEE' THEN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      RAISE EXCEPTION 'Suppression interdite : % validée (id %)', TG_TABLE_NAME, OLD.id;
    END IF;
    IF v_new IS DISTINCT FROM v_old
       OR (TG_TABLE_NAME = 'note' AND (to_jsonb(NEW)->>'absent') IS DISTINCT FROM (to_jsonb(OLD)->>'absent')) THEN
      IF v_motif IS NULL THEN
        RAISE EXCEPTION 'Modification d''une % validée : motif obligatoire', TG_TABLE_NAME
          USING HINT = 'Exécuter SET LOCAL app.motif = ''...'' dans la transaction';
      END IF;
      INSERT INTO ispat.historique_modification
             (table_nom, enregistrement_id, champ, ancienne_valeur, nouvelle_valeur, motif, modifie_par)
      VALUES (TG_TABLE_NAME, OLD.id, v_col, v_old, v_new, v_motif, ispat.app_user());
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER b_proteger_note BEFORE UPDATE ON ispat.note
  FOR EACH ROW EXECUTE FUNCTION ispat.tg_proteger_valide('valeur');
CREATE TRIGGER b_proteger_moyenne_matiere BEFORE UPDATE ON ispat.moyenne_matiere
  FOR EACH ROW EXECUTE FUNCTION ispat.tg_proteger_valide('moyenne_finale');
CREATE TRIGGER b_proteger_moyenne_semestre BEFORE UPDATE ON ispat.moyenne_semestre
  FOR EACH ROW EXECUTE FUNCTION ispat.tg_proteger_valide('moyenne');

-- 8.4 Validation d'inscription : matricule + frais dus + conversion prospect
--     Matricule = AA + CODE_FILIERE + NNNN   (ex : 26AGR0001)
CREATE OR REPLACE FUNCTION ispat.generer_matricule(p_annee uuid, p_filiere uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_annee text; v_fil text; v_num integer;
BEGIN
  SELECT to_char(date_debut, 'YY') INTO v_annee FROM ispat.annee_academique WHERE id = p_annee;
  SELECT upper(code) INTO v_fil FROM ispat.filiere WHERE id = p_filiere;
  INSERT INTO ispat.compteur_matricule(annee_code, filiere_code, dernier)
  VALUES (v_annee, v_fil, 1)
  ON CONFLICT (annee_code, filiere_code) DO UPDATE SET dernier = ispat.compteur_matricule.dernier + 1
  RETURNING dernier INTO v_num;
  RETURN v_annee || v_fil || lpad(v_num::text, 4, '0');
END $$;

CREATE OR REPLACE FUNCTION ispat.tg_inscription_validee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_filiere uuid; v_niveau uuid;
BEGIN
  IF NEW.etat <> 'VALIDEE' OR (TG_OP = 'UPDATE' AND OLD.etat = 'VALIDEE') THEN
    RETURN NULL;
  END IF;

  SELECT filiere_id, niveau_id INTO v_filiere, v_niveau FROM ispat.classe WHERE id = NEW.classe_id;

  -- 1) matricule
  UPDATE ispat.etudiant
     SET matricule = ispat.generer_matricule(NEW.annee_id, v_filiere)
   WHERE id = NEW.etudiant_id AND matricule IS NULL;

  -- 2) frais dus : tarif le plus spécifique par type de frais obligatoire
  INSERT INTO ispat.frais_inscription(inscription_id, type_frais_id, montant)
  SELECT DISTINCT ON (t.type_frais_id) NEW.id, t.type_frais_id, t.montant
    FROM ispat.tarif t
    JOIN ispat.type_frais tf ON tf.id = t.type_frais_id AND tf.obligatoire AND tf.deleted_at IS NULL
   WHERE t.deleted_at IS NULL
     AND t.annee_id = NEW.annee_id
     AND (t.filiere_id IS NULL OR t.filiere_id = v_filiere)
     AND (t.niveau_id IS NULL OR t.niveau_id = v_niveau)
     AND (t.statut_etudiant_id IS NULL OR t.statut_etudiant_id = NEW.statut_etudiant_id)
     AND NOT EXISTS (SELECT 1 FROM ispat.frais_inscription f
                      WHERE f.inscription_id = NEW.id AND f.type_frais_id = t.type_frais_id AND f.deleted_at IS NULL)
   ORDER BY t.type_frais_id,
            (t.filiere_id IS NOT NULL) DESC,
            (t.niveau_id IS NOT NULL) DESC,
            (t.statut_etudiant_id IS NOT NULL) DESC;

  -- 3) prospect converti
  IF NEW.prospect_id IS NOT NULL THEN
    UPDATE ispat.prospect SET statut = 'INSCRIT', etudiant_id = NEW.etudiant_id
     WHERE id = NEW.prospect_id;
  END IF;

  RETURN NULL;
END $$;

CREATE TRIGGER c_inscription_validee AFTER INSERT OR UPDATE OF etat ON ispat.inscription
  FOR EACH ROW EXECUTE FUNCTION ispat.tg_inscription_validee();

-- 8.5 Pré-inscription liée à un prospect -> prospect PREINSCRIT
CREATE OR REPLACE FUNCTION ispat.tg_preinscription_prospect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.prospect_id IS NOT NULL THEN
    UPDATE ispat.prospect SET statut = 'PREINSCRIT'
     WHERE id = NEW.prospect_id AND statut IN ('NOUVEAU','CONTACTE');
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER c_preinscription_prospect AFTER INSERT OR UPDATE OF prospect_id ON ispat.preinscription
  FOR EACH ROW EXECUTE FUNCTION ispat.tg_preinscription_prospect();

-- 8.6 Versement -> n° de reçu + écriture d'entrée en caisse
CREATE OR REPLACE FUNCTION ispat.tg_versement_recu() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.numero_recu IS NULL THEN
    NEW.numero_recu := 'REC-' || to_char(NEW.date_versement, 'YYYY') || '-'
                       || lpad(nextval('ispat.recu_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER b_versement_recu BEFORE INSERT ON ispat.versement
  FOR EACH ROW EXECUTE FUNCTION ispat.tg_versement_recu();

CREATE OR REPLACE FUNCTION ispat.tg_versement_caisse() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cat uuid; v_lib text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT id INTO v_cat FROM ispat.categorie_mouvement WHERE code = 'VERSEMENT_SCOLARITE';
    SELECT 'Versement ' || coalesce(e.matricule, '') || ' ' || e.nom || ' ' || e.prenoms
      INTO v_lib
      FROM ispat.inscription i JOIN ispat.etudiant e ON e.id = i.etudiant_id
     WHERE i.id = NEW.inscription_id;
    INSERT INTO ispat.mouvement_caisse(sens, categorie_id, montant, date_mouvement, libelle, tiers,
                                       mode_paiement, reference, versement_id, annule, saisi_par)
    VALUES ('ENTREE', v_cat, NEW.montant, NEW.date_versement, v_lib, NULL,
            NEW.mode_paiement, NEW.numero_recu, NEW.id, NEW.annule, NEW.encaisse_par);
  ELSE
    UPDATE ispat.mouvement_caisse
       SET montant = NEW.montant, date_mouvement = NEW.date_versement,
           mode_paiement = NEW.mode_paiement, annule = NEW.annule OR NEW.deleted_at IS NOT NULL
     WHERE versement_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER c_versement_caisse AFTER INSERT OR UPDATE ON ispat.versement
  FOR EACH ROW EXECUTE FUNCTION ispat.tg_versement_caisse();

-- =============================================================================
-- 9. FONCTIONS MÉTIER
-- =============================================================================

-- 9.1 Calcul des moyennes d'une classe pour un semestre
--     moyenne = poids_cc * CC + poids_examen * Examen
--     2e session : REMPLACE (la note S2 remplace S1) ou MEILLEURE (on garde la meilleure moyenne)
--     Les moyennes VALIDEE ne sont jamais écrasées.
CREATE OR REPLACE FUNCTION ispat.calculer_moyennes(p_classe uuid, p_semestre uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  p_cc    numeric := coalesce(ispat.param('poids_cc'), '0.4')::numeric;
  p_ex    numeric := coalesce(ispat.param('poids_examen'), '0.6')::numeric;
  p_seuil numeric := coalesce(ispat.param('seuil_validation'), '10')::numeric;
  p_regle text    := coalesce(ispat.param('regle_session2'), 'REMPLACE');
  v_nb    integer;
BEGIN
  WITH ins AS (
    SELECT i.id AS inscription_id
      FROM ispat.inscription i
     WHERE i.classe_id = p_classe AND i.etat = 'VALIDEE' AND i.deleted_at IS NULL
  ),
  mat AS (
    SELECT DISTINCT e.matiere_id
      FROM ispat.evaluation e
     WHERE e.classe_id = p_classe AND e.semestre_id = p_semestre AND e.deleted_at IS NULL
  ),
  notes AS (
    SELECT n.inscription_id, e.matiere_id, e.type_eval, e.session, e.poids,
           CASE WHEN n.absent THEN 0 ELSE n.valeur END AS v
      FROM ispat.note n
      JOIN ispat.evaluation e ON e.id = n.evaluation_id AND e.deleted_at IS NULL
     WHERE e.classe_id = p_classe AND e.semestre_id = p_semestre AND n.deleted_at IS NULL
  ),
  agg AS (
    SELECT ins.inscription_id, mat.matiere_id,
           round(sum(nt.v * nt.poids) FILTER (WHERE nt.type_eval <> 'EXAMEN')
                 / nullif(sum(nt.poids) FILTER (WHERE nt.type_eval <> 'EXAMEN'), 0), 2) AS cc,
           max(nt.v) FILTER (WHERE nt.type_eval = 'EXAMEN' AND nt.session = 1) AS ex1,
           max(nt.v) FILTER (WHERE nt.type_eval = 'EXAMEN' AND nt.session = 2) AS ex2
      FROM ins CROSS JOIN mat
      LEFT JOIN notes nt ON nt.inscription_id = ins.inscription_id AND nt.matiere_id = mat.matiere_id
     GROUP BY ins.inscription_id, mat.matiere_id
  ),
  calc AS (
    SELECT a.*,
           CASE WHEN a.cc IS NULL THEN a.ex1
                WHEN a.ex1 IS NULL THEN NULL
                ELSE round(a.cc * p_cc + a.ex1 * p_ex, 2) END AS m1,
           CASE WHEN a.ex2 IS NULL THEN NULL
                WHEN a.cc IS NULL THEN a.ex2
                ELSE round(a.cc * p_cc + a.ex2 * p_ex, 2) END AS m2
      FROM agg a
  ),
  fin AS (
    SELECT c.*, m.credits,
           CASE WHEN c.m2 IS NULL THEN c.m1
                WHEN p_regle = 'MEILLEURE' THEN greatest(coalesce(c.m1, 0), c.m2)
                ELSE c.m2 END AS mf
      FROM calc c JOIN ispat.matiere m ON m.id = c.matiere_id
  )
  INSERT INTO ispat.moyenne_matiere AS mm
         (inscription_id, matiere_id, semestre_id, moyenne_cc, note_examen_s1, note_examen_s2,
          moyenne_session1, moyenne_finale, credits_acquis)
  SELECT inscription_id, matiere_id, p_semestre, cc, ex1, ex2, m1, mf,
         CASE WHEN mf >= p_seuil THEN credits ELSE 0 END
    FROM fin
  ON CONFLICT (inscription_id, matiere_id, semestre_id) WHERE deleted_at IS NULL
  DO UPDATE SET moyenne_cc       = EXCLUDED.moyenne_cc,
                note_examen_s1   = EXCLUDED.note_examen_s1,
                note_examen_s2   = EXCLUDED.note_examen_s2,
                moyenne_session1 = EXCLUDED.moyenne_session1,
                moyenne_finale   = EXCLUDED.moyenne_finale,
                credits_acquis   = EXCLUDED.credits_acquis
          WHERE mm.statut <> 'VALIDEE';
  GET DIAGNOSTICS v_nb = ROW_COUNT;

  -- Moyenne semestrielle, crédits, rang, décision
  WITH s AS (
    SELECT mm.inscription_id,
           round(sum(mm.moyenne_finale * m.coefficient) / nullif(sum(m.coefficient), 0), 2) AS moy,
           sum(mm.credits_acquis)::smallint AS ca,
           sum(m.credits)::smallint AS ct,
           bool_or(mm.note_examen_s2 IS NOT NULL) AS a_session2
      FROM ispat.moyenne_matiere mm
      JOIN ispat.matiere m ON m.id = mm.matiere_id
      JOIN ispat.inscription i ON i.id = mm.inscription_id
     WHERE i.classe_id = p_classe AND mm.semestre_id = p_semestre
       AND mm.deleted_at IS NULL AND mm.moyenne_finale IS NOT NULL
     GROUP BY mm.inscription_id
  ),
  r AS (
    SELECT s.*, rank() OVER (ORDER BY s.moy DESC NULLS LAST) AS rg FROM s
  )
  INSERT INTO ispat.moyenne_semestre AS ms
         (inscription_id, semestre_id, moyenne, credits_acquis, credits_total, rang, decision)
  SELECT inscription_id, p_semestre, moy, ca, ct, rg,
         CASE WHEN moy >= p_seuil THEN 'ADMIS'
              WHEN a_session2 THEN 'AJOURNE'
              ELSE 'SESSION2' END
    FROM r
  ON CONFLICT (inscription_id, semestre_id) WHERE deleted_at IS NULL
  DO UPDATE SET moyenne = EXCLUDED.moyenne, credits_acquis = EXCLUDED.credits_acquis,
                credits_total = EXCLUDED.credits_total, rang = EXCLUDED.rang, decision = EXCLUDED.decision
          WHERE ms.statut <> 'VALIDEE';

  RETURN v_nb;
END $$;

-- 9.2 Recherche étudiant (matricule exact > matricule partiel > nom/prénoms, sans accents)
CREATE OR REPLACE FUNCTION ispat.rechercher_etudiant(p_q text, p_limite integer DEFAULT 20)
RETURNS TABLE (id uuid, matricule text, nom text, prenoms text, sexe char(1), photo_chemin text, score real)
LANGUAGE sql STABLE AS $$
  SELECT e.id, e.matricule, e.nom, e.prenoms, e.sexe, e.photo_chemin,
         CASE WHEN upper(e.matricule) = upper(trim(p_q)) THEN 1.0
              WHEN upper(e.matricule) LIKE upper(trim(p_q)) || '%' THEN 0.9
              ELSE ispat.similarity(ispat.sans_accent(e.nom || ' ' || e.prenoms), ispat.sans_accent(trim(p_q))) * 0.8
         END::real AS score
    FROM ispat.etudiant e
   WHERE e.deleted_at IS NULL
     AND (upper(e.matricule) LIKE upper(trim(p_q)) || '%'
          OR ispat.sans_accent(e.nom || ' ' || e.prenoms) OPERATOR(ispat.%) ispat.sans_accent(trim(p_q))
          OR ispat.sans_accent(e.nom || ' ' || e.prenoms) LIKE '%' || ispat.sans_accent(trim(p_q)) || '%')
   ORDER BY score DESC, e.nom, e.prenoms
   LIMIT p_limite
$$;

-- =============================================================================
-- 10. VUES (listes et tableaux de bord)
-- =============================================================================

-- Scolarité : liste de classe / par sexe / par statut (filtres côté API)
CREATE OR REPLACE VIEW ispat.v_etudiant_inscrit AS
SELECT i.id AS inscription_id, e.id AS etudiant_id, e.matricule, e.nom, e.prenoms, e.sexe,
       e.date_naissance, e.lieu_naissance, e.telephone, e.photo_chemin,
       i.annee_id, a.libelle AS annee, i.classe_id, c.libelle AS classe,
       f.id AS filiere_id, f.libelle AS filiere, n.id AS niveau_id, n.code AS niveau,
       se.id AS statut_id, se.code AS statut_code, se.libelle AS statut,
       i.type_inscription, i.date_inscription, i.etat
  FROM ispat.inscription i
  JOIN ispat.etudiant e         ON e.id = i.etudiant_id
  JOIN ispat.annee_academique a ON a.id = i.annee_id
  JOIN ispat.classe c           ON c.id = i.classe_id
  JOIN ispat.filiere f          ON f.id = c.filiere_id
  JOIN ispat.niveau n           ON n.id = c.niveau_id
  JOIN ispat.statut_etudiant se ON se.id = i.statut_etudiant_id
 WHERE i.deleted_at IS NULL AND e.deleted_at IS NULL;

-- Effectifs par classe x sexe et classe x statut
CREATE OR REPLACE VIEW ispat.v_effectifs AS
SELECT annee_id, annee, classe_id, classe,
       CASE WHEN grouping(sexe) = 0 THEN 'SEXE'
            WHEN grouping(statut) = 0 THEN 'STATUT'
            ELSE 'TOTAL' END AS axe,
       CASE WHEN grouping(sexe) = 0 THEN sexe::text
            WHEN grouping(statut) = 0 THEN statut
            ELSE 'Total' END AS modalite,
       count(*) AS effectif
  FROM ispat.v_etudiant_inscrit
 WHERE etat = 'VALIDEE'
 GROUP BY GROUPING SETS ((annee_id, annee, classe_id, classe, sexe),
                         (annee_id, annee, classe_id, classe, statut),
                         (annee_id, annee, classe_id, classe));

-- Liste de notation (une ligne par note)
CREATE OR REPLACE VIEW ispat.v_liste_notation AS
SELECT ev.classe_id, ev.semestre_id, ev.matiere_id, m.code AS matiere_code, m.libelle AS matiere,
       ev.id AS evaluation_id, ev.type_eval, ev.session, ev.libelle AS evaluation, ev.date_eval,
       vi.inscription_id, vi.matricule, vi.nom, vi.prenoms, vi.sexe,
       nt.id AS note_id, nt.valeur, nt.absent, nt.statut
  FROM ispat.evaluation ev
  JOIN ispat.matiere m ON m.id = ev.matiere_id
  JOIN ispat.v_etudiant_inscrit vi ON vi.classe_id = ev.classe_id AND vi.etat = 'VALIDEE'
  LEFT JOIN ispat.note nt ON nt.evaluation_id = ev.id AND nt.inscription_id = vi.inscription_id AND nt.deleted_at IS NULL
 WHERE ev.deleted_at IS NULL;

-- Lignes de bulletin (semestre 1 / 2) et relevés d'examen (session 1 / 2)
CREATE OR REPLACE VIEW ispat.v_bulletin_ligne AS
SELECT mm.inscription_id, mm.semestre_id, s.numero AS semestre_numero,
       m.code AS matiere_code, m.libelle AS matiere, m.coefficient, m.credits,
       mm.moyenne_cc, mm.note_examen_s1, mm.note_examen_s2,
       mm.moyenne_session1, mm.moyenne_finale, mm.credits_acquis, mm.statut
  FROM ispat.moyenne_matiere mm
  JOIN ispat.matiere m  ON m.id = mm.matiere_id
  JOIN ispat.semestre s ON s.id = mm.semestre_id
 WHERE mm.deleted_at IS NULL;

-- Situation financière par inscription
CREATE OR REPLACE VIEW ispat.v_situation_financiere AS
WITH du AS (
  SELECT inscription_id, sum(montant - remise) AS total_du
    FROM ispat.frais_inscription WHERE deleted_at IS NULL GROUP BY inscription_id
), pec AS (
  SELECT inscription_id, sum(montant) AS part_pec
    FROM ispat.prise_en_charge WHERE deleted_at IS NULL AND statut = 'ACTIVE' GROUP BY inscription_id
), ver AS (
  SELECT inscription_id,
         sum(montant) FILTER (WHERE payeur = 'ETUDIANT')        AS verse_etudiant,
         sum(montant) FILTER (WHERE payeur = 'PRISE_EN_CHARGE') AS verse_pec
    FROM ispat.versement WHERE deleted_at IS NULL AND NOT annule GROUP BY inscription_id
)
SELECT vi.inscription_id, vi.matricule, vi.nom, vi.prenoms, vi.classe, vi.annee_id, vi.statut,
       coalesce(du.total_du, 0)          AS total_du,
       coalesce(pec.part_pec, 0)         AS part_prise_en_charge,
       coalesce(ver.verse_etudiant, 0)   AS verse_etudiant,
       coalesce(ver.verse_pec, 0)        AS verse_prise_en_charge,
       greatest(coalesce(du.total_du,0) - least(coalesce(pec.part_pec,0), coalesce(du.total_du,0))
                - coalesce(ver.verse_etudiant,0), 0) AS reste_etudiant,
       greatest(coalesce(pec.part_pec,0) - coalesce(ver.verse_pec,0), 0) AS reste_prise_en_charge,
       vi.etat                                   -- VALIDEE ou ABANDON (une dette d'abandon reste à recouvrer)
  FROM ispat.v_etudiant_inscrit vi
  LEFT JOIN du  ON du.inscription_id  = vi.inscription_id
  LEFT JOIN pec ON pec.inscription_id = vi.inscription_id
  LEFT JOIN ver ON ver.inscription_id = vi.inscription_id
 WHERE vi.etat IN ('VALIDEE', 'ABANDON');

-- Caisse : solde mensuel
CREATE OR REPLACE VIEW ispat.v_caisse_mensuelle AS
SELECT date_trunc('month', date_mouvement)::date AS mois,
       sum(montant) FILTER (WHERE sens = 'ENTREE') AS total_entrees,
       sum(montant) FILTER (WHERE sens = 'SORTIE') AS total_sorties,
       coalesce(sum(montant) FILTER (WHERE sens = 'ENTREE'), 0)
     - coalesce(sum(montant) FILTER (WHERE sens = 'SORTIE'), 0) AS solde
  FROM ispat.mouvement_caisse
 WHERE deleted_at IS NULL AND NOT annule
 GROUP BY 1;

-- Analyse de la prospection : taux de pré-inscription et d'inscription
--   par campagne, global, ville, école, genre
CREATE OR REPLACE VIEW ispat.v_prospection_stats AS
WITH p AS (
  SELECT p.id, p.campagne_id, p.sexe,
         coalesce(v.libelle, 'Non renseignée') AS ville,
         coalesce(ec.nom, 'Non renseignée')    AS ecole,
         (p.statut IN ('PREINSCRIT','INSCRIT')
          OR EXISTS (SELECT 1 FROM ispat.preinscription pr
                      WHERE pr.prospect_id = p.id AND pr.deleted_at IS NULL)) AS est_preinscrit,
         (p.statut = 'INSCRIT') AS est_inscrit
    FROM ispat.prospect p
    LEFT JOIN ispat.ville v  ON v.id  = p.ville_id
    LEFT JOIN ispat.ecole ec ON ec.id = p.ecole_id
   WHERE p.deleted_at IS NULL
)
SELECT campagne_id,
       CASE WHEN grouping(ville) = 0 THEN 'VILLE'
            WHEN grouping(ecole) = 0 THEN 'ECOLE'
            WHEN grouping(sexe)  = 0 THEN 'GENRE'
            ELSE 'GLOBAL' END AS axe,
       CASE WHEN grouping(ville) = 0 THEN ville
            WHEN grouping(ecole) = 0 THEN ecole
            WHEN grouping(sexe)  = 0 THEN sexe::text
            ELSE 'Total' END AS modalite,
       count(*)                                  AS nb_prospects,
       count(*) FILTER (WHERE est_preinscrit)    AS nb_preinscrits,
       count(*) FILTER (WHERE est_inscrit)       AS nb_inscrits,
       round(100.0 * count(*) FILTER (WHERE est_preinscrit) / count(*), 1) AS taux_preinscription,
       round(100.0 * count(*) FILTER (WHERE est_inscrit)    / count(*), 1) AS taux_inscription,
       round(100.0 * count(*) FILTER (WHERE est_inscrit)
             / nullif(count(*) FILTER (WHERE est_preinscrit), 0), 1)       AS taux_conversion_preinscrits
  FROM p
 GROUP BY GROUPING SETS ((campagne_id), (campagne_id, ville), (campagne_id, ecole), (campagne_id, sexe));

-- Permissions effectives d'un utilisateur (chargées à la connexion, mises en cache hors ligne)
CREATE OR REPLACE VIEW ispat.v_permissions_utilisateur AS
SELECT DISTINCT ur.utilisateur_id, p.code, p.module, p.ressource, p.action
  FROM ispat.utilisateur_role ur
  JOIN ispat.role r             ON r.id = ur.role_id AND r.deleted_at IS NULL
  JOIN ispat.role_permission rp ON rp.role_id = r.id AND rp.deleted_at IS NULL
  JOIN ispat.permission p       ON p.id = rp.permission_id AND p.deleted_at IS NULL
 WHERE ur.deleted_at IS NULL;

-- =============================================================================
-- 11. DONNÉES INITIALES
-- =============================================================================

INSERT INTO ispat.parametre(cle, valeur, description) VALUES
  ('nom_etablissement', 'ISPAT - Institut Supérieur Privé d''Agriculture et Technologie', 'Affiché sur bulletins et reçus'),
  ('ville_etablissement', 'Ferkessédougou', NULL),
  ('devise', 'XOF', 'Franc CFA'),
  ('poids_cc', '0.4', 'Poids du contrôle continu dans la moyenne matière'),
  ('poids_examen', '0.6', 'Poids de l''examen dans la moyenne matière'),
  ('seuil_validation', '10', 'Moyenne minimale de validation (matière et semestre)'),
  ('regle_session2', 'REMPLACE', 'REMPLACE : la note de 2e session remplace la 1re | MEILLEURE : on garde la meilleure moyenne');

INSERT INTO ispat.niveau(code, libelle, ordre) VALUES
  ('BTS1','BTS 1re année',1), ('BTS2','BTS 2e année',2),
  ('L1','Licence 1',3), ('L2','Licence 2',4), ('L3','Licence 3',5),
  ('M1','Master 1',6), ('M2','Master 2',7);

INSERT INTO ispat.statut_etudiant(code, libelle) VALUES
  ('AFFECTE', 'Affecté de l''État'),
  ('NON_AFFECTE', 'Non affecté');

INSERT INTO ispat.type_piece(code, libelle, obligatoire) VALUES
  ('PHOTO', 'Photo d''identité', true),
  ('EXTRAIT_NAISSANCE', 'Extrait d''acte de naissance', true),
  ('PIECE_IDENTITE', 'CNI / Attestation d''identité', false),
  ('RELEVE_BAC', 'Relevé de notes du BAC', true),
  ('DIPLOME', 'Diplôme / Attestation de réussite', false),
  ('BULLETINS', 'Bulletins de notes', false),
  ('FICHE_ORIENTATION', 'Fiche d''orientation / affectation', false),
  ('AUTRE', 'Autre document', false);

INSERT INTO ispat.type_frais(code, libelle, categorie, obligatoire) VALUES
  ('INSCRIPTION', 'Frais d''inscription', 'INSCRIPTION', true),
  ('SCOLARITE', 'Frais de scolarité', 'SCOLARITE', true),
  ('TENUE', 'Tenue', 'ANNEXE', true),
  ('CARTE_ETUDIANT', 'Carte d''étudiant', 'ANNEXE', true),
  ('ASSURANCE', 'Assurance', 'ANNEXE', true),
  ('FRAIS_EXAMEN', 'Frais d''examen', 'ANNEXE', false),
  ('SORTIE_TERRAIN', 'Sortie / stage terrain', 'ANNEXE', false);

INSERT INTO ispat.categorie_mouvement(code, libelle, sens) VALUES
  ('VERSEMENT_SCOLARITE', 'Versements étudiants', 'ENTREE'),
  ('SUBVENTION', 'Subventions / prises en charge', 'ENTREE'),
  ('VENTE_PRODUITS', 'Vente de produits (ferme école)', 'ENTREE'),
  ('AUTRE_ENTREE', 'Autres entrées', 'ENTREE'),
  ('SALAIRES', 'Salaires et vacations', 'SORTIE'),
  ('FOURNITURES', 'Fournitures et consommables', 'SORTIE'),
  ('CHARGES', 'Loyer, électricité, eau, internet', 'SORTIE'),
  ('MAINTENANCE', 'Entretien et maintenance', 'SORTIE'),
  ('TRANSPORT', 'Transport et missions', 'SORTIE'),
  ('AUTRE_SORTIE', 'Autres sorties', 'SORTIE');

INSERT INTO ispat.ville(libelle, region) VALUES
  ('Ferkessédougou','Tchologo'), ('Kong','Tchologo'), ('Ouangolodougou','Tchologo'),
  ('Korhogo','Poro'), ('Boundiali','Bagoué'), ('Katiola','Hambol'),
  ('Bouaké','Gbêkê'), ('Odienné','Kabadougou'), ('Yamoussoukro','Yamoussoukro'), ('Abidjan','Abidjan');

-- Rôles
INSERT INTO ispat.role(code, libelle, description) VALUES
  ('ADMIN', 'Administrateur', 'Accès total, gestion des utilisateurs et paramètres'),
  ('DIRECTION', 'Direction', 'Consultation de tous les modules, validations finales'),
  ('DIRECTEUR_ETUDES', 'Directeur des études', 'Notes, moyennes, validations, bulletins'),
  ('COMPTABLE', 'Comptable / Caissier', 'Comptabilité complète'),
  ('SCOLARITE', 'Service scolarité', 'Inscriptions, listes, bulletins'),
  ('ENSEIGNANT', 'Enseignant', 'Saisie des notes de ses matières'),
  ('COMMERCIAL', 'Chargé commercial', 'Prospection et pré-inscriptions');

-- Permissions : module x ressource x actions
INSERT INTO ispat.permission(code, module, ressource, action, libelle)
SELECT x.module || '.' || x.ressource || '.' || a, x.module, x.ressource, a, x.libelle || ' : ' || a
  FROM (VALUES
    ('administration','utilisateur',            'Utilisateurs',                     ARRAY['lire','creer','modifier','supprimer']),
    ('administration','role',                   'Rôles et permissions',             ARRAY['lire','creer','modifier','supprimer']),
    ('administration','parametre',              'Paramètres',                       ARRAY['lire','modifier']),
    ('administration','referentiel',            'Référentiels (filières, classes, matières...)', ARRAY['lire','creer','modifier','supprimer']),
    ('administration','journal',                'Journal d''audit',                 ARRAY['lire','exporter']),
    ('comptabilite','versement',                'Versements',                       ARRAY['lire','creer','modifier','supprimer','exporter']),
    ('comptabilite','entree',                   'Entrées de caisse',                ARRAY['lire','creer','modifier','supprimer','exporter']),
    ('comptabilite','sortie',                   'Sorties de caisse',                ARRAY['lire','creer','modifier','supprimer','exporter']),
    ('comptabilite','frais_annexe',             'Frais annexes',                    ARRAY['lire','creer','modifier','supprimer']),
    ('comptabilite','prise_en_charge',          'Prises en charge',                 ARRAY['lire','creer','modifier','supprimer']),
    ('comptabilite','tarif',                    'Barème des frais',                 ARRAY['lire','creer','modifier','supprimer']),
    ('comptabilite','situation',                'Situation financière',             ARRAY['lire','exporter']),
    ('scolarite','inscription',                 'Inscriptions',                     ARRAY['lire','creer','modifier','supprimer','valider']),
    ('scolarite','liste_classe',                'Listes de classe',                 ARRAY['lire','exporter']),
    ('scolarite','liste_notation',              'Listes de notation',               ARRAY['lire','exporter']),
    ('scolarite','liste_sexe',                  'Listes par sexe',                  ARRAY['lire','exporter']),
    ('scolarite','liste_statut',                'Listes par statut',                ARRAY['lire','exporter']),
    ('moyenne','note',                          'Saisie des notes',                 ARRAY['lire','creer','modifier','supprimer']),
    ('moyenne','calcul',                        'Calcul des moyennes',              ARRAY['lire','creer']),
    ('moyenne','validation_moyenne',            'Validation de moyenne',            ARRAY['lire','valider']),
    ('moyenne','validation_note_examen',        'Validation de note d''examen',     ARRAY['lire','valider']),
    ('moyenne','modification_note_examen',      'Modification de notes d''examen',  ARRAY['lire','modifier']),
    ('moyenne','modification_moyenne',          'Modification de moyenne',          ARRAY['lire','modifier']),
    ('bulletin','semestre1',                    'Bulletin semestre 1',              ARRAY['lire','creer','exporter']),
    ('bulletin','semestre2',                    'Bulletin semestre 2',              ARRAY['lire','creer','exporter']),
    ('bulletin','examen_session1',              'Relevé examen 1re session',        ARRAY['lire','creer','exporter']),
    ('bulletin','examen_session2',              'Relevé examen 2e session',         ARRAY['lire','creer','exporter']),
    ('commercial','prospection',                'Prospection',                      ARRAY['lire','creer','modifier','supprimer']),
    ('commercial','preinscription',             'Pré-inscriptions',                 ARRAY['lire','creer','modifier','supprimer','valider']),
    ('commercial','liste_prospect',             'Listes des prospects',             ARRAY['lire','exporter']),
    ('commercial','inscription_prospect',       'Inscription des prospects',        ARRAY['lire','creer']),
    ('commercial','analyse',                    'Analyse de la prospection',        ARRAY['lire','exporter'])
  ) AS x(module, ressource, libelle, actions)
  CROSS JOIN LATERAL unnest(x.actions) AS a;

-- Attribution rôle -> permissions
INSERT INTO ispat.role_permission(role_id, permission_id)
SELECT r.id, p.id
  FROM ispat.role r
  JOIN ispat.permission p ON
       (r.code = 'ADMIN')
    OR (r.code = 'DIRECTION'        AND (p.action IN ('lire','exporter')
                                         OR p.code IN ('moyenne.validation_moyenne.valider',
                                                       'moyenne.validation_note_examen.valider',
                                                       'scolarite.inscription.valider')))
    OR (r.code = 'DIRECTEUR_ETUDES' AND (p.module IN ('moyenne','bulletin')
                                         OR p.code IN ('scolarite.liste_classe.lire','scolarite.liste_notation.lire',
                                                       'scolarite.liste_classe.exporter','scolarite.liste_notation.exporter',
                                                       'administration.referentiel.lire')))
    OR (r.code = 'COMPTABLE'        AND (p.module = 'comptabilite'
                                         OR p.code IN ('scolarite.inscription.lire','scolarite.liste_classe.lire')))
    OR (r.code = 'SCOLARITE'        AND (p.module IN ('scolarite','bulletin')
                                         OR p.ressource IN ('note','calcul')
                                         OR p.code IN ('comptabilite.situation.lire','commercial.preinscription.lire',
                                                       'commercial.preinscription.valider','administration.referentiel.lire')))
    OR (r.code = 'ENSEIGNANT'       AND p.code IN ('moyenne.note.lire','moyenne.note.creer','moyenne.note.modifier',
                                                   'scolarite.liste_classe.lire','scolarite.liste_notation.lire'))
    OR (r.code = 'COMMERCIAL'       AND (p.module = 'commercial' OR p.code = 'administration.referentiel.lire'));

-- Filières : à saisir selon l'offre ISPAT réelle (code de 3 lettres = partie du matricule), ex :
-- INSERT INTO ispat.filiere(code, libelle) VALUES ('AGR','Agronomie');

-- Compte administrateur : créé par l'API (hash du mot de passe calculé côté serveur).

COMMIT;

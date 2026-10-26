-- =============================================================================
--  ISPAT GESTION — Données 003 : offre de formation officielle de l'ISPAT
--  Source : kakemono officiel ISPAT (repris dans le thème WordPress, inc/data.php)
--
--  * 17 filières avec leurs codes officiels (le code entre dans le matricule : 26ATPV0001)
--  * niveaux : BT1, BT2, BT3 (Brevet de Technicien, 3 ans après la 3e)
--              BTS1, BTS2 (BTS / DTS, 2 ans après la Terminale)
--  * L1, L2, L3, M1, M2 retirés (suppression logique) s'ils ne sont utilisés par aucune
--    classe ni matière ; sinon ils sont conservés et signalés.
--
--  Rejouable sans risque (aucun doublon).
--    psql -U ispat -d ispat_gestion -f ispat_donnees_003_offre_formation.sql
-- =============================================================================

BEGIN;
SET search_path = ispat, public;

-- -----------------------------------------------------------------------------
-- 1. Filières
-- -----------------------------------------------------------------------------
INSERT INTO ispat.filiere (code, libelle, description)
VALUES
  -- BTS / DTS Industriels (2 ans, niveau Terminale)
  ('ATPV',  'Agriculture Tropicale option Production Végétale', 'BTS / DTS Industriels — 2 ans — niveau Terminale'),
  ('ATPA',  'Agriculture Tropicale option Production Animale',  'BTS / DTS Industriels — 2 ans — niveau Terminale'),
  ('GBAT',  'Génie Civil option Bâtiment',                      'BTS / DTS Industriels — 2 ans — niveau Terminale'),
  ('TP',    'Topographie',                                      'BTS / DTS Industriels — 2 ans — niveau Terminale'),
  ('CV',    'Communication Visuelle',                           'BTS / DTS Industriels — 2 ans — niveau Terminale'),
  ('IDA',   'Informatique Développeur d''Applications',         'BTS / DTS Industriels — 2 ans — niveau Terminale'),
  -- BTS / DTS Tertiaires (2 ans, niveau Terminale)
  ('AD',    'Assistanat de Direction',                          'BTS / DTS Tertiaires — 2 ans — niveau Terminale'),
  ('RHCOM', 'Ressources Humaines et Communication',             'BTS / DTS Tertiaires — 2 ans — niveau Terminale'),
  ('TH',    'Tourisme et Hôtellerie',                           'BTS / DTS Tertiaires — 2 ans — niveau Terminale'),
  ('GEC',   'Gestion Commerciale',                              'BTS / DTS Tertiaires — 2 ans — niveau Terminale'),
  ('LOG',   'Logistique Transport',                             'BTS / DTS Tertiaires — 2 ans — niveau Terminale'),
  ('GCT',   'Gestion des Collectivités Territoriales',          'BTS / DTS Tertiaires — 2 ans — niveau Terminale'),
  -- Professionnel BT (3 ans, niveau Troisième)
  ('AQUA',  'Aquaculture',                                      'Brevet de Technicien — 3 ans — niveau Troisième'),
  ('CGO',   'Chantiers Gros Œuvres',                            'Brevet de Technicien — 3 ans — niveau Troisième'),
  ('ISP',   'Installations Sanitaires et Plomberies',           'Brevet de Technicien — 3 ans — niveau Troisième'),
  ('PV',    'Productions Végétales',                            'Brevet de Technicien — 3 ans — niveau Troisième'),
  ('PA',    'Productions Animales',                             'Brevet de Technicien — 3 ans — niveau Troisième')
ON CONFLICT (upper(code)) WHERE deleted_at IS NULL DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Niveaux
-- -----------------------------------------------------------------------------
INSERT INTO ispat.niveau (code, libelle, ordre)
VALUES
  ('BT1',  'Brevet de Technicien 1re année', 1),
  ('BT2',  'Brevet de Technicien 2e année',  2),
  ('BT3',  'Brevet de Technicien 3e année',  3),
  ('BTS1', 'BTS / DTS 1re année',            4),
  ('BTS2', 'BTS / DTS 2e année',             5)
ON CONFLICT (upper(code)) WHERE deleted_at IS NULL
DO UPDATE SET libelle = EXCLUDED.libelle, ordre = EXCLUDED.ordre
 WHERE ispat.niveau.libelle IS DISTINCT FROM EXCLUDED.libelle
    OR ispat.niveau.ordre   IS DISTINCT FROM EXCLUDED.ordre;

-- -----------------------------------------------------------------------------
-- 3. Retrait des niveaux LMD non proposés par l'ISPAT (s'ils sont inutilisés)
-- -----------------------------------------------------------------------------
UPDATE ispat.niveau n
   SET deleted_at = now()
 WHERE n.code IN ('L1', 'L2', 'L3', 'M1', 'M2')
   AND n.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM ispat.classe c  WHERE c.niveau_id = n.id AND c.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM ispat.matiere m WHERE m.niveau_id = n.id AND m.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM ispat.tarif t   WHERE t.niveau_id = n.id AND t.deleted_at IS NULL);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT code FROM ispat.niveau WHERE code IN ('L1','L2','L3','M1','M2') AND deleted_at IS NULL LOOP
    RAISE NOTICE 'Niveau % conservé : utilisé par des classes, matières ou tarifs.', r.code;
  END LOOP;
END $$;

COMMIT;

-- Contrôle
SELECT code, libelle, ordre FROM ispat.niveau WHERE deleted_at IS NULL ORDER BY ordre;
SELECT count(*) AS filieres_actives FROM ispat.filiere WHERE deleted_at IS NULL;

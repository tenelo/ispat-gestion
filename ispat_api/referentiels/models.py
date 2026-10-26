"""
Référentiels ISPAT — tables du schéma `ispat` (managed = False, voir ispat_gestion_schema.sql).
"""
from django.db import models

from core.models import ModeleSynchro, Utilisateur

SEXE = [("M", "Masculin"), ("F", "Féminin")]
SEMESTRE_NUMERO = [(1, "Semestre 1"), (2, "Semestre 2")]


# --------------------------------------------------------------------------------------
# Calendrier académique
# --------------------------------------------------------------------------------------

class AnneeAcademique(ModeleSynchro):
    libelle = models.TextField()
    date_debut = models.DateField()
    date_fin = models.DateField()
    est_active = models.BooleanField(default=False)

    class Meta:
        managed = False
        db_table = "annee_academique"
        ordering = ["-date_debut"]
        verbose_name = "année académique"
        verbose_name_plural = "années académiques"

    def __str__(self):
        return self.libelle


class Semestre(ModeleSynchro):
    annee = models.ForeignKey(AnneeAcademique, on_delete=models.DO_NOTHING, db_column="annee_id",
                              related_name="semestres")
    numero = models.SmallIntegerField(choices=SEMESTRE_NUMERO)
    date_debut = models.DateField(null=True, blank=True)
    date_fin = models.DateField(null=True, blank=True)
    cloture = models.BooleanField(default=False)

    class Meta:
        managed = False
        db_table = "semestre"
        ordering = ["annee__date_debut", "numero"]
        verbose_name = "semestre"
        verbose_name_plural = "semestres"

    def __str__(self):
        return f"S{self.numero} {self.annee}"


# --------------------------------------------------------------------------------------
# Offre de formation
# --------------------------------------------------------------------------------------

class Filiere(ModeleSynchro):
    code = models.TextField()
    libelle = models.TextField()
    description = models.TextField(null=True, blank=True)
    active = models.BooleanField(default=True)

    class Meta:
        managed = False
        db_table = "filiere"
        ordering = ["libelle"]
        verbose_name = "filière"
        verbose_name_plural = "filières"

    def __str__(self):
        return self.libelle


class Niveau(ModeleSynchro):
    code = models.TextField()
    libelle = models.TextField()
    ordre = models.SmallIntegerField()

    class Meta:
        managed = False
        db_table = "niveau"
        ordering = ["ordre"]
        verbose_name = "niveau"
        verbose_name_plural = "niveaux"

    def __str__(self):
        return self.code


class Classe(ModeleSynchro):
    annee = models.ForeignKey(AnneeAcademique, on_delete=models.DO_NOTHING, db_column="annee_id",
                              related_name="classes")
    filiere = models.ForeignKey(Filiere, on_delete=models.DO_NOTHING, db_column="filiere_id", related_name="classes")
    niveau = models.ForeignKey(Niveau, on_delete=models.DO_NOTHING, db_column="niveau_id", related_name="classes")
    libelle = models.TextField()
    groupe = models.TextField(null=True, blank=True)
    capacite = models.IntegerField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "classe"
        ordering = ["niveau__ordre", "libelle"]
        verbose_name = "classe"
        verbose_name_plural = "classes"

    def __str__(self):
        return self.libelle


class Matiere(ModeleSynchro):
    code = models.TextField()
    libelle = models.TextField()
    filiere = models.ForeignKey(Filiere, on_delete=models.DO_NOTHING, db_column="filiere_id", related_name="matieres")
    niveau = models.ForeignKey(Niveau, on_delete=models.DO_NOTHING, db_column="niveau_id", related_name="matieres")
    semestre_numero = models.SmallIntegerField(choices=SEMESTRE_NUMERO)
    coefficient = models.DecimalField(max_digits=4, decimal_places=2, default=1)
    credits = models.SmallIntegerField(default=0)
    volume_horaire = models.SmallIntegerField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "matiere"
        ordering = ["semestre_numero", "code"]
        verbose_name = "matière"
        verbose_name_plural = "matières"

    def __str__(self):
        return f"{self.code} {self.libelle}"


class Enseignant(ModeleSynchro):
    TYPES_CONTRAT = [("PERMANENT", "Permanent"), ("VACATAIRE", "Vacataire")]

    utilisateur = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="utilisateur_id",
                                    null=True, blank=True, related_name="profils_enseignant")
    nom = models.TextField()
    prenoms = models.TextField()
    sexe = models.CharField(max_length=1, choices=SEXE, null=True, blank=True)
    telephone = models.TextField(null=True, blank=True)
    email = models.TextField(null=True, blank=True)
    specialite = models.TextField(null=True, blank=True)
    type_contrat = models.TextField(choices=TYPES_CONTRAT, null=True, blank=True)

    class Meta:
        managed = False
        db_table = "enseignant"
        ordering = ["nom", "prenoms"]
        verbose_name = "enseignant"
        verbose_name_plural = "enseignants"

    def __str__(self):
        return f"{self.nom} {self.prenoms}"


class Enseignement(ModeleSynchro):
    enseignant = models.ForeignKey(Enseignant, on_delete=models.DO_NOTHING, db_column="enseignant_id",
                                   related_name="enseignements")
    matiere = models.ForeignKey(Matiere, on_delete=models.DO_NOTHING, db_column="matiere_id",
                                related_name="enseignements")
    classe = models.ForeignKey(Classe, on_delete=models.DO_NOTHING, db_column="classe_id",
                               related_name="enseignements")
    semestre = models.ForeignKey(Semestre, on_delete=models.DO_NOTHING, db_column="semestre_id",
                                 related_name="enseignements")

    class Meta:
        managed = False
        db_table = "enseignement"
        verbose_name = "attribution de cours"
        verbose_name_plural = "attributions de cours"


# --------------------------------------------------------------------------------------
# Listes de valeurs
# --------------------------------------------------------------------------------------

class StatutEtudiant(ModeleSynchro):
    code = models.TextField(unique=True)
    libelle = models.TextField()

    class Meta:
        managed = False
        db_table = "statut_etudiant"
        ordering = ["libelle"]
        verbose_name = "statut étudiant"
        verbose_name_plural = "statuts étudiant"

    def __str__(self):
        return self.libelle


class TypePiece(ModeleSynchro):
    code = models.TextField(unique=True)
    libelle = models.TextField()
    obligatoire = models.BooleanField(default=False)

    class Meta:
        managed = False
        db_table = "type_piece"
        ordering = ["libelle"]
        verbose_name = "type de pièce"
        verbose_name_plural = "types de pièce"

    def __str__(self):
        return self.libelle


class Ville(ModeleSynchro):
    libelle = models.TextField()
    region = models.TextField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "ville"
        ordering = ["libelle"]
        verbose_name = "ville"
        verbose_name_plural = "villes"

    def __str__(self):
        return self.libelle


class Ecole(ModeleSynchro):
    TYPES_ECOLE = [("LYCEE", "Lycée"), ("COLLEGE", "Collège"), ("UNIVERSITE", "Université"), ("AUTRE", "Autre")]

    nom = models.TextField()
    ville = models.ForeignKey(Ville, on_delete=models.DO_NOTHING, db_column="ville_id", null=True, blank=True,
                              related_name="ecoles")
    type_ecole = models.TextField(choices=TYPES_ECOLE, null=True, blank=True)

    class Meta:
        managed = False
        db_table = "ecole"
        ordering = ["nom"]
        verbose_name = "école"
        verbose_name_plural = "écoles"

    def __str__(self):
        return self.nom


# --------------------------------------------------------------------------------------
# Finances (référentiels)
# --------------------------------------------------------------------------------------

class TypeFrais(ModeleSynchro):
    CATEGORIES = [("INSCRIPTION", "Inscription"), ("SCOLARITE", "Scolarité"), ("ANNEXE", "Frais annexe")]

    code = models.TextField(unique=True)
    libelle = models.TextField()
    categorie = models.TextField(choices=CATEGORIES)
    obligatoire = models.BooleanField(default=True)

    class Meta:
        managed = False
        db_table = "type_frais"
        ordering = ["categorie", "libelle"]
        verbose_name = "type de frais"
        verbose_name_plural = "types de frais"

    def __str__(self):
        return self.libelle


class Tarif(ModeleSynchro):
    annee = models.ForeignKey(AnneeAcademique, on_delete=models.DO_NOTHING, db_column="annee_id",
                              related_name="tarifs")
    type_frais = models.ForeignKey(TypeFrais, on_delete=models.DO_NOTHING, db_column="type_frais_id",
                                   related_name="tarifs")
    filiere = models.ForeignKey(Filiere, on_delete=models.DO_NOTHING, db_column="filiere_id", null=True, blank=True,
                                related_name="tarifs")
    niveau = models.ForeignKey(Niveau, on_delete=models.DO_NOTHING, db_column="niveau_id", null=True, blank=True,
                               related_name="tarifs")
    statut_etudiant = models.ForeignKey(StatutEtudiant, on_delete=models.DO_NOTHING, db_column="statut_etudiant_id",
                                        null=True, blank=True, related_name="tarifs")
    montant = models.DecimalField(max_digits=14, decimal_places=0)
    nb_tranches = models.SmallIntegerField(default=1)

    class Meta:
        managed = False
        db_table = "tarif"
        ordering = ["type_frais__categorie", "type_frais__libelle"]
        verbose_name = "tarif"
        verbose_name_plural = "tarifs"


class CategorieMouvement(ModeleSynchro):
    SENS = [("ENTREE", "Entrée"), ("SORTIE", "Sortie")]

    code = models.TextField(unique=True)
    libelle = models.TextField()
    sens = models.TextField(choices=SENS)

    class Meta:
        managed = False
        db_table = "categorie_mouvement"
        ordering = ["sens", "libelle"]
        verbose_name = "catégorie de mouvement"
        verbose_name_plural = "catégories de mouvement"

    def __str__(self):
        return self.libelle


class Parametre(ModeleSynchro):
    cle = models.TextField(unique=True)
    valeur = models.TextField()
    description = models.TextField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "parametre"
        ordering = ["cle"]
        verbose_name = "paramètre"
        verbose_name_plural = "paramètres"

    def __str__(self):
        return self.cle

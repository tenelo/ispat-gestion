"""
Scolarité ISPAT — tables du schéma `ispat` (managed = False, voir ispat_gestion_schema.sql).

À la validation d'une inscription (etat -> VALIDEE), le trigger PostgreSQL `c_inscription_validee` :
  1. attribue le matricule de l'étudiant s'il n'en a pas (format AA + FILIERE + NNNN) ;
  2. génère les frais dus (table frais_inscription) d'après le barème ;
  3. passe le prospect lié au statut INSCRIT.
"""
from django.db import models
from django.utils import timezone

from core.models import ModeleSynchro, Utilisateur
from referentiels.models import SEXE, AnneeAcademique, Classe, Ecole, StatutEtudiant, TypePiece, Ville


class Etudiant(ModeleSynchro):
    matricule = models.TextField(unique=True, null=True, blank=True, editable=False)
    nom = models.TextField()
    prenoms = models.TextField()
    sexe = models.CharField(max_length=1, choices=SEXE)
    date_naissance = models.DateField(null=True, blank=True)
    lieu_naissance = models.TextField(null=True, blank=True)
    nationalite = models.TextField(null=True, blank=True, default="Ivoirienne")
    num_piece_identite = models.TextField(null=True, blank=True)
    telephone = models.TextField(null=True, blank=True)
    email = models.TextField(null=True, blank=True)
    adresse = models.TextField(null=True, blank=True)
    ville = models.ForeignKey(Ville, on_delete=models.DO_NOTHING, db_column="ville_id", null=True, blank=True,
                              related_name="etudiants")
    ecole_origine = models.ForeignKey(Ecole, on_delete=models.DO_NOTHING, db_column="ecole_origine_id", null=True,
                                      blank=True, related_name="etudiants")
    serie_bac = models.TextField(null=True, blank=True)
    annee_bac = models.SmallIntegerField(null=True, blank=True)
    photo_chemin = models.TextField(null=True, blank=True, editable=False)

    class Meta:
        managed = False
        db_table = "etudiant"
        ordering = ["nom", "prenoms"]
        verbose_name = "étudiant"
        verbose_name_plural = "étudiants"

    def __str__(self):
        return f"{self.matricule or '(sans matricule)'} {self.nom} {self.prenoms}"


class ContactEtudiant(ModeleSynchro):
    LIENS = [("PERE", "Père"), ("MERE", "Mère"), ("TUTEUR", "Tuteur"), ("CONJOINT", "Conjoint"), ("AUTRE", "Autre")]

    etudiant = models.ForeignKey(Etudiant, on_delete=models.DO_NOTHING, db_column="etudiant_id",
                                 related_name="contacts")
    lien = models.TextField(choices=LIENS)
    nom_complet = models.TextField()
    telephone = models.TextField(null=True, blank=True)
    profession = models.TextField(null=True, blank=True)
    est_urgence = models.BooleanField(default=False)

    class Meta:
        managed = False
        db_table = "contact_etudiant"
        ordering = ["-est_urgence", "lien"]
        verbose_name = "contact"
        verbose_name_plural = "contacts"


class Inscription(ModeleSynchro):
    TYPES = [("NOUVELLE", "Nouvelle inscription"), ("REINSCRIPTION", "Réinscription"),
             ("REDOUBLEMENT", "Redoublement"), ("TRANSFERT", "Transfert")]
    ETATS = [("EN_ATTENTE", "En attente"), ("VALIDEE", "Validée"), ("ANNULEE", "Annulée"), ("ABANDON", "Abandon")]
    SOURCES = [("GUICHET", "Guichet"), ("SITE_WEB", "Site web"), ("PROSPECTION", "Prospection")]

    etudiant = models.ForeignKey(Etudiant, on_delete=models.DO_NOTHING, db_column="etudiant_id",
                                 related_name="inscriptions")
    annee = models.ForeignKey(AnneeAcademique, on_delete=models.DO_NOTHING, db_column="annee_id",
                              related_name="inscriptions")
    classe = models.ForeignKey(Classe, on_delete=models.DO_NOTHING, db_column="classe_id", related_name="inscriptions")
    statut_etudiant = models.ForeignKey(StatutEtudiant, on_delete=models.DO_NOTHING, db_column="statut_etudiant_id",
                                        related_name="inscriptions")
    type_inscription = models.TextField(choices=TYPES, default="NOUVELLE")
    date_inscription = models.DateField(default=timezone.localdate)
    etat = models.TextField(choices=ETATS, default="EN_ATTENTE")
    source = models.TextField(choices=SOURCES, default="GUICHET")
    prospect_id = models.UUIDField(null=True, blank=True)          # FK vers prospect (module commercial, étape 8)
    valide_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="valide_par", null=True,
                                   blank=True, related_name="inscriptions_validees")
    valide_le = models.DateTimeField(null=True, blank=True)
    observations = models.TextField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "inscription"
        ordering = ["-date_inscription", "etudiant__nom"]
        verbose_name = "inscription"
        verbose_name_plural = "inscriptions"


class PieceJointe(ModeleSynchro):
    type_piece = models.ForeignKey(TypePiece, on_delete=models.DO_NOTHING, db_column="type_piece_id",
                                   related_name="pieces")
    etudiant = models.ForeignKey(Etudiant, on_delete=models.DO_NOTHING, db_column="etudiant_id", null=True,
                                 blank=True, related_name="pieces")
    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id", null=True,
                                    blank=True, related_name="pieces")
    preinscription_id = models.UUIDField(null=True, blank=True)    # FK vers preinscription (étape 8 / WordPress)
    nom_fichier = models.TextField()
    chemin = models.TextField()
    mime_type = models.TextField(null=True, blank=True)
    taille_octets = models.BigIntegerField(null=True, blank=True)
    verifie = models.BooleanField(default=False)
    verifie_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="verifie_par", null=True,
                                    blank=True, related_name="pieces_verifiees")

    class Meta:
        managed = False
        db_table = "piece_jointe"
        ordering = ["type_piece__libelle", "-created_at"]
        verbose_name = "pièce jointe"
        verbose_name_plural = "pièces jointes"


class VEtudiantInscrit(models.Model):
    """Vue ispat.v_etudiant_inscrit (lecture seule) : base des listes de classe / sexe / statut."""

    inscription_id = models.UUIDField(primary_key=True)
    etudiant_id = models.UUIDField()
    matricule = models.TextField(null=True)
    nom = models.TextField()
    prenoms = models.TextField()
    sexe = models.CharField(max_length=1)
    date_naissance = models.DateField(null=True)
    lieu_naissance = models.TextField(null=True)
    telephone = models.TextField(null=True)
    photo_chemin = models.TextField(null=True)
    annee_id = models.UUIDField()
    annee = models.TextField()
    classe_id = models.UUIDField()
    classe = models.TextField()
    filiere_id = models.UUIDField()
    filiere = models.TextField()
    niveau_id = models.UUIDField()
    niveau = models.TextField()
    statut_id = models.UUIDField()
    statut_code = models.TextField()
    statut = models.TextField()
    type_inscription = models.TextField()
    date_inscription = models.DateField()
    etat = models.TextField()

    class Meta:
        managed = False
        db_table = "v_etudiant_inscrit"
        ordering = ["nom", "prenoms"]

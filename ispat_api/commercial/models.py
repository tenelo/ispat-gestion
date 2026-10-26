"""
Gestion commerciale ISPAT — tables du schéma `ispat` (managed = False, voir ispat_gestion_schema.sql).

Cycle d'un prospect :
  NOUVEAU -> CONTACTE (1re relance) -> PREINSCRIT (pré-inscription ou inscription en attente)
          -> INSCRIT (inscription validée : trigger c_inscription_validee) ; PERDU à tout moment (manuel).
"""
from django.db import models
from django.utils import timezone

from core.models import ModeleSynchro, Utilisateur
from referentiels.models import SEXE, AnneeAcademique, Ecole, Filiere, Niveau, Ville
from scolarite.models import Etudiant, Inscription


class CampagneProspection(ModeleSynchro):
    annee = models.ForeignKey(AnneeAcademique, on_delete=models.DO_NOTHING, db_column="annee_id",
                              related_name="campagnes")
    libelle = models.TextField()
    date_debut = models.DateField()
    date_fin = models.DateField(null=True, blank=True)
    objectif = models.IntegerField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "campagne_prospection"
        ordering = ["-date_debut"]
        verbose_name = "campagne de prospection"
        verbose_name_plural = "campagnes de prospection"

    def __str__(self):
        return self.libelle


class Prospect(ModeleSynchro):
    SOURCES = [("TERRAIN", "Terrain"), ("SITE_WEB", "Site web"), ("SALON", "Salon / forum"),
               ("RESEAUX_SOCIAUX", "Réseaux sociaux"), ("RECOMMANDATION", "Recommandation"), ("AUTRE", "Autre")]
    STATUTS = [("NOUVEAU", "Nouveau"), ("CONTACTE", "Contacté"), ("PREINSCRIT", "Pré-inscrit"),
               ("INSCRIT", "Inscrit"), ("PERDU", "Perdu")]

    campagne = models.ForeignKey(CampagneProspection, on_delete=models.DO_NOTHING, db_column="campagne_id",
                                 null=True, blank=True, related_name="prospects")
    nom = models.TextField()
    prenoms = models.TextField()
    sexe = models.CharField(max_length=1, choices=SEXE)
    date_naissance = models.DateField(null=True, blank=True)
    telephone = models.TextField(null=True, blank=True)
    telephone_parent = models.TextField(null=True, blank=True)
    email = models.TextField(null=True, blank=True)
    ville = models.ForeignKey(Ville, on_delete=models.DO_NOTHING, db_column="ville_id", null=True, blank=True,
                              related_name="prospects")
    ecole = models.ForeignKey(Ecole, on_delete=models.DO_NOTHING, db_column="ecole_id", null=True, blank=True,
                              related_name="prospects")
    niveau_etude = models.TextField(null=True, blank=True)
    serie_bac = models.TextField(null=True, blank=True)
    filiere_souhaitee = models.ForeignKey(Filiere, on_delete=models.DO_NOTHING, db_column="filiere_souhaitee_id",
                                          null=True, blank=True, related_name="prospects")
    source = models.TextField(choices=SOURCES, default="TERRAIN")
    agent = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="agent_id", null=True, blank=True,
                              related_name="prospects")
    date_contact = models.DateField(default=timezone.localdate)
    statut = models.TextField(choices=STATUTS, default="NOUVEAU")
    etudiant = models.ForeignKey(Etudiant, on_delete=models.DO_NOTHING, db_column="etudiant_id", null=True,
                                 blank=True, related_name="prospects")
    observations = models.TextField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "prospect"
        ordering = ["-date_contact", "nom", "prenoms"]
        verbose_name = "prospect"
        verbose_name_plural = "prospects"

    def __str__(self):
        return f"{self.nom} {self.prenoms}"


class SuiviProspect(ModeleSynchro):
    CANAUX = [("APPEL", "Appel"), ("SMS", "SMS"), ("WHATSAPP", "WhatsApp"), ("EMAIL", "E-mail"), ("VISITE", "Visite")]

    prospect = models.ForeignKey(Prospect, on_delete=models.DO_NOTHING, db_column="prospect_id",
                                 related_name="suivis")
    date_suivi = models.DateTimeField(default=timezone.now)
    canal = models.TextField(choices=CANAUX)
    resultat = models.TextField(null=True, blank=True)
    prochaine_relance = models.DateField(null=True, blank=True)
    agent = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="agent_id", null=True, blank=True,
                              related_name="suivis_prospects")

    class Meta:
        managed = False
        db_table = "suivi_prospect"
        ordering = ["-date_suivi"]
        verbose_name = "relance"
        verbose_name_plural = "relances"


class Preinscription(ModeleSynchro):
    SOURCES = [("SITE_WEB", "Site web"), ("GUICHET", "Guichet"), ("PROSPECTION", "Prospection")]
    STATUTS = [("EN_ATTENTE", "En attente"), ("VALIDEE", "Dossier accepté"), ("REJETEE", "Rejetée"),
               ("CONVERTIE", "Inscrite")]

    annee = models.ForeignKey(AnneeAcademique, on_delete=models.DO_NOTHING, db_column="annee_id",
                              related_name="preinscriptions")
    prospect = models.ForeignKey(Prospect, on_delete=models.DO_NOTHING, db_column="prospect_id", null=True,
                                 blank=True, related_name="preinscriptions")
    nom = models.TextField()
    prenoms = models.TextField()
    sexe = models.CharField(max_length=1, choices=SEXE)
    date_naissance = models.DateField(null=True, blank=True)
    lieu_naissance = models.TextField(null=True, blank=True)
    telephone = models.TextField(null=True, blank=True)
    email = models.TextField(null=True, blank=True)
    ville = models.ForeignKey(Ville, on_delete=models.DO_NOTHING, db_column="ville_id", null=True, blank=True,
                              related_name="preinscriptions")
    ecole = models.ForeignKey(Ecole, on_delete=models.DO_NOTHING, db_column="ecole_id", null=True, blank=True,
                              related_name="preinscriptions")
    serie_bac = models.TextField(null=True, blank=True)
    filiere_souhaitee = models.ForeignKey(Filiere, on_delete=models.DO_NOTHING, db_column="filiere_souhaitee_id",
                                          null=True, blank=True, related_name="preinscriptions")
    niveau_souhaite = models.ForeignKey(Niveau, on_delete=models.DO_NOTHING, db_column="niveau_souhaite_id",
                                        null=True, blank=True, related_name="preinscriptions")
    source = models.TextField(choices=SOURCES, default="SITE_WEB")
    wp_entry_id = models.TextField(null=True, blank=True, unique=True)
    donnees_brutes = models.JSONField(null=True, blank=True)
    statut = models.TextField(choices=STATUTS, default="EN_ATTENTE")
    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id", null=True,
                                    blank=True, related_name="preinscriptions")
    traite_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="traite_par", null=True,
                                   blank=True, related_name="preinscriptions_traitees")
    traite_le = models.DateTimeField(null=True, blank=True)
    motif_rejet = models.TextField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "preinscription"
        ordering = ["-created_at"]
        verbose_name = "pré-inscription"
        verbose_name_plural = "pré-inscriptions"

    def __str__(self):
        return f"{self.nom} {self.prenoms}"

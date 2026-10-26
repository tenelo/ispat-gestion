"""
Comptabilité ISPAT — tables du schéma `ispat` (managed = False, voir ispat_gestion_schema.sql).

Automatismes PostgreSQL :
  * validation d'inscription -> frais_inscription générés d'après le barème (tarif) ;
  * versement inséré        -> numéro de reçu REC-AAAA-NNNNNN + écriture ENTREE dans mouvement_caisse ;
  * versement annulé        -> écriture de caisse liée marquée annulée.
"""
from django.db import models
from django.utils import timezone

from core.models import ModeleSynchro, Utilisateur
from referentiels.models import CategorieMouvement, TypeFrais
from scolarite.models import Inscription

MODES_PAIEMENT = [("ESPECES", "Espèces"), ("MOBILE_MONEY", "Mobile Money"), ("VIREMENT", "Virement"),
                  ("CHEQUE", "Chèque"), ("AUTRE", "Autre")]


class FraisInscription(ModeleSynchro):
    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id",
                                    related_name="frais")
    type_frais = models.ForeignKey(TypeFrais, on_delete=models.DO_NOTHING, db_column="type_frais_id",
                                   related_name="frais_inscriptions")
    montant = models.DecimalField(max_digits=14, decimal_places=0)
    remise = models.DecimalField(max_digits=14, decimal_places=0, default=0)
    motif_remise = models.TextField(null=True, blank=True)
    date_echeance = models.DateField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "frais_inscription"
        ordering = ["type_frais__categorie", "type_frais__libelle"]
        verbose_name = "frais dû"
        verbose_name_plural = "frais dus"

    @property
    def montant_du(self):
        return self.montant - self.remise


class PriseEnCharge(ModeleSynchro):
    TYPES_PAYEUR = [("ETAT", "État"), ("ENTREPRISE", "Entreprise"), ("ONG", "ONG"), ("BOURSE", "Bourse"),
                    ("PARENT_TIERS", "Parent / tiers"), ("AUTRE", "Autre")]
    STATUTS = [("ACTIVE", "Active"), ("SUSPENDUE", "Suspendue"), ("ANNULEE", "Annulée")]

    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id",
                                    related_name="prises_en_charge")
    type_frais = models.ForeignKey(TypeFrais, on_delete=models.DO_NOTHING, db_column="type_frais_id", null=True,
                                   blank=True, related_name="prises_en_charge")
    type_payeur = models.TextField(choices=TYPES_PAYEUR)
    organisme = models.TextField()
    taux = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    montant = models.DecimalField(max_digits=14, decimal_places=0)
    reference_doc = models.TextField(null=True, blank=True)
    date_accord = models.DateField(null=True, blank=True)
    statut = models.TextField(choices=STATUTS, default="ACTIVE")

    class Meta:
        managed = False
        db_table = "prise_en_charge"
        ordering = ["-date_accord", "organisme"]
        verbose_name = "prise en charge"
        verbose_name_plural = "prises en charge"


class Versement(ModeleSynchro):
    PAYEURS = [("ETUDIANT", "Étudiant / famille"), ("PRISE_EN_CHARGE", "Prise en charge")]

    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id",
                                    related_name="versements")
    type_frais = models.ForeignKey(TypeFrais, on_delete=models.DO_NOTHING, db_column="type_frais_id", null=True,
                                   blank=True, related_name="versements")
    payeur = models.TextField(choices=PAYEURS, default="ETUDIANT")
    prise_en_charge = models.ForeignKey(PriseEnCharge, on_delete=models.DO_NOTHING, db_column="prise_en_charge_id",
                                        null=True, blank=True, related_name="versements")
    montant = models.DecimalField(max_digits=14, decimal_places=0)
    date_versement = models.DateField(default=timezone.localdate)
    mode_paiement = models.TextField(choices=MODES_PAIEMENT)
    reference = models.TextField(null=True, blank=True)
    numero_recu = models.TextField(unique=True, null=True, blank=True, editable=False)
    annule = models.BooleanField(default=False)
    motif_annulation = models.TextField(null=True, blank=True)
    encaisse_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="encaisse_par", null=True,
                                     blank=True, related_name="versements_encaisses")

    class Meta:
        managed = False
        db_table = "versement"
        ordering = ["-date_versement", "-created_at"]
        verbose_name = "versement"
        verbose_name_plural = "versements"


class MouvementCaisse(ModeleSynchro):
    SENS = [("ENTREE", "Entrée"), ("SORTIE", "Sortie")]

    sens = models.TextField(choices=SENS)
    categorie = models.ForeignKey(CategorieMouvement, on_delete=models.DO_NOTHING, db_column="categorie_id",
                                  related_name="mouvements")
    montant = models.DecimalField(max_digits=14, decimal_places=0)
    date_mouvement = models.DateField(default=timezone.localdate)
    libelle = models.TextField()
    tiers = models.TextField(null=True, blank=True)
    mode_paiement = models.TextField(choices=MODES_PAIEMENT)
    reference = models.TextField(null=True, blank=True)
    justificatif_chemin = models.TextField(null=True, blank=True, editable=False)
    versement = models.OneToOneField(Versement, on_delete=models.DO_NOTHING, db_column="versement_id", null=True,
                                     blank=True, related_name="mouvement", editable=False)
    annule = models.BooleanField(default=False)
    saisi_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="saisi_par", null=True,
                                  blank=True, related_name="mouvements_saisis")

    class Meta:
        managed = False
        db_table = "mouvement_caisse"
        ordering = ["-date_mouvement", "-created_at"]
        verbose_name = "mouvement de caisse"
        verbose_name_plural = "mouvements de caisse"

"""
Notes et moyennes ISPAT — tables du schéma `ispat` (managed = False, voir ispat_gestion_schema.sql).

Côté PostgreSQL :
  * ispat.calculer_moyennes(classe, semestre) calcule moyenne_matiere puis moyenne_semestre
    (pondération CC / examen, règle de 2e session, seuil, crédits, rang, décision) sans jamais
    écraser une moyenne VALIDEE ;
  * trigger b_proteger_* : modifier la valeur d'une note / moyenne VALIDEE exige app.motif
    et écrit une ligne dans historique_modification ; supprimer une valeur validée est interdit.
"""
from django.db import models

from core.models import ModeleSynchro, Utilisateur
from referentiels.models import Classe, Matiere, Semestre
from scolarite.models import Inscription


class Evaluation(ModeleSynchro):
    TYPES = [("DEVOIR", "Devoir"), ("INTERROGATION", "Interrogation"), ("TP", "Travaux pratiques"),
             ("EXPOSE", "Exposé"), ("EXAMEN", "Examen")]
    SESSIONS = [(1, "1re session"), (2, "2e session")]

    classe = models.ForeignKey(Classe, on_delete=models.DO_NOTHING, db_column="classe_id", related_name="evaluations")
    matiere = models.ForeignKey(Matiere, on_delete=models.DO_NOTHING, db_column="matiere_id",
                                related_name="evaluations")
    semestre = models.ForeignKey(Semestre, on_delete=models.DO_NOTHING, db_column="semestre_id",
                                 related_name="evaluations")
    type_eval = models.TextField(choices=TYPES)
    session = models.SmallIntegerField(choices=SESSIONS, default=1)
    libelle = models.TextField()
    date_eval = models.DateField(null=True, blank=True)
    poids = models.DecimalField(max_digits=4, decimal_places=2, default=1)

    class Meta:
        managed = False
        db_table = "evaluation"
        ordering = ["matiere__code", "type_eval", "session", "date_eval"]
        verbose_name = "évaluation"
        verbose_name_plural = "évaluations"

    @property
    def est_examen(self):
        return self.type_eval == "EXAMEN"


class Note(ModeleSynchro):
    STATUTS = [("SAISIE", "Saisie"), ("VALIDEE", "Validée")]

    evaluation = models.ForeignKey(Evaluation, on_delete=models.DO_NOTHING, db_column="evaluation_id",
                                   related_name="notes")
    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id",
                                    related_name="notes")
    valeur = models.DecimalField(max_digits=4, decimal_places=2, null=True, blank=True)
    absent = models.BooleanField(default=False)
    statut = models.TextField(choices=STATUTS, default="SAISIE")
    saisi_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="saisi_par", null=True,
                                  blank=True, related_name="notes_saisies")
    valide_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="valide_par", null=True,
                                   blank=True, related_name="notes_validees")
    valide_le = models.DateTimeField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "note"
        verbose_name = "note"
        verbose_name_plural = "notes"


class MoyenneMatiere(ModeleSynchro):
    STATUTS = [("CALCULEE", "Calculée"), ("VALIDEE", "Validée")]

    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id",
                                    related_name="moyennes_matiere")
    matiere = models.ForeignKey(Matiere, on_delete=models.DO_NOTHING, db_column="matiere_id",
                                related_name="moyennes")
    semestre = models.ForeignKey(Semestre, on_delete=models.DO_NOTHING, db_column="semestre_id",
                                 related_name="moyennes_matiere")
    moyenne_cc = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    note_examen_s1 = models.DecimalField(max_digits=4, decimal_places=2, null=True, blank=True)
    note_examen_s2 = models.DecimalField(max_digits=4, decimal_places=2, null=True, blank=True)
    moyenne_session1 = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    moyenne_finale = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    credits_acquis = models.SmallIntegerField(default=0)
    statut = models.TextField(choices=STATUTS, default="CALCULEE")
    valide_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="valide_par", null=True,
                                   blank=True, related_name="moyennes_matiere_validees")
    valide_le = models.DateTimeField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "moyenne_matiere"
        ordering = ["matiere__code"]
        verbose_name = "moyenne de matière"
        verbose_name_plural = "moyennes de matière"


class MoyenneSemestre(ModeleSynchro):
    STATUTS = [("CALCULEE", "Calculée"), ("VALIDEE", "Validée")]
    DECISIONS = [("ADMIS", "Admis"), ("AJOURNE", "Ajourné"), ("SESSION2", "Session 2")]

    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id",
                                    related_name="moyennes_semestre")
    semestre = models.ForeignKey(Semestre, on_delete=models.DO_NOTHING, db_column="semestre_id",
                                 related_name="moyennes_semestre")
    moyenne = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    credits_acquis = models.SmallIntegerField(default=0)
    credits_total = models.SmallIntegerField(default=0)
    rang = models.IntegerField(null=True, blank=True)
    decision = models.TextField(choices=DECISIONS, null=True, blank=True)
    appreciation = models.TextField(null=True, blank=True)
    statut = models.TextField(choices=STATUTS, default="CALCULEE")
    valide_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="valide_par", null=True,
                                   blank=True, related_name="moyennes_semestre_validees")
    valide_le = models.DateTimeField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "moyenne_semestre"
        ordering = ["rang"]
        verbose_name = "moyenne de semestre"
        verbose_name_plural = "moyennes de semestre"


class HistoriqueModification(ModeleSynchro):
    table_nom = models.TextField()
    enregistrement_id = models.UUIDField()
    champ = models.TextField()
    ancienne_valeur = models.DecimalField(max_digits=5, decimal_places=2, null=True)
    nouvelle_valeur = models.DecimalField(max_digits=5, decimal_places=2, null=True)
    motif = models.TextField()
    modifie_par = models.UUIDField(null=True)
    modifie_le = models.DateTimeField()

    class Meta:
        managed = False
        db_table = "historique_modification"
        ordering = ["-modifie_le"]
        verbose_name = "modification de note / moyenne"
        verbose_name_plural = "modifications de notes / moyennes"

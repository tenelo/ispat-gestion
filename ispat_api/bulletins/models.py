"""
Bulletins ISPAT — table ispat.bulletin (managed = False) : trace de chaque édition officielle.
Une ligne par (inscription, semestre, type, session) ; une réédition garde le numéro et met à jour la date.
"""
from django.db import models

from core.models import ModeleSynchro, Utilisateur
from referentiels.models import Semestre
from scolarite.models import Inscription


class Bulletin(ModeleSynchro):
    TYPES = [("SEMESTRE", "Bulletin de semestre"), ("RELEVE_EXAMEN", "Relevé de notes d'examen")]

    inscription = models.ForeignKey(Inscription, on_delete=models.DO_NOTHING, db_column="inscription_id",
                                    related_name="bulletins")
    semestre = models.ForeignKey(Semestre, on_delete=models.DO_NOTHING, db_column="semestre_id", null=True,
                                 blank=True, related_name="bulletins")
    type_bulletin = models.TextField(choices=TYPES)
    session = models.SmallIntegerField(null=True, blank=True)
    numero = models.TextField(null=True, blank=True)
    date_edition = models.DateTimeField()
    fichier_chemin = models.TextField(null=True, blank=True)
    edite_par = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="edite_par", null=True,
                                  blank=True, related_name="bulletins_edites")

    class Meta:
        managed = False
        db_table = "bulletin"
        ordering = ["-date_edition"]
        verbose_name = "bulletin"
        verbose_name_plural = "bulletins"

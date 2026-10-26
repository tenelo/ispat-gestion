"""Outils communs aux notes et aux moyennes."""
from decimal import Decimal

from django.db import connection
from django.shortcuts import get_object_or_404
from rest_framework import serializers

from referentiels.models import Classe, Parametre, Semestre
from scolarite.models import Inscription

from .models import MoyenneMatiere


def seuil_validation():
    p = Parametre.objects.filter(cle="seuil_validation").first()
    return Decimal(p.valeur) if p else Decimal("10")


def charger_classe_semestre(classe_id, semestre_id):
    classe = get_object_or_404(Classe.objects.select_related("annee", "filiere", "niveau"), pk=classe_id)
    semestre = get_object_or_404(Semestre, pk=semestre_id)
    if semestre.annee_id != classe.annee_id:
        raise serializers.ValidationError({"semestre": "Ce semestre n'appartient pas à l'année de la classe."})
    return classe, semestre


def inscrits_evaluation(evaluation):
    """
    Étudiants concernés par une évaluation (inscriptions VALIDEE de la classe).
    2e session : seulement les étudiants non admis en 1re session dans la matière.
    """
    qs = Inscription.objects.filter(classe_id=evaluation.classe_id, etat="VALIDEE").select_related("etudiant") \
        .order_by("etudiant__nom", "etudiant__prenoms")
    if evaluation.est_examen and evaluation.session == 2:
        moyennes = MoyenneMatiere.objects.filter(matiere_id=evaluation.matiere_id, semestre_id=evaluation.semestre_id,
                                                 inscription__classe_id=evaluation.classe_id)
        if not moyennes.exists():
            return None                       # moyennes de 1re session non calculées
        seuil = seuil_validation()
        admis = {m.inscription_id for m in moyennes if m.moyenne_session1 is not None and m.moyenne_session1 >= seuil}
        qs = qs.exclude(pk__in=admis)
    return qs


def recalculer_semestre(inscription_id, semestre_id):
    """Recalcule moyenne, crédits et décision d'un étudiant (après modification d'une moyenne de matière)."""
    with connection.cursor() as c:
        c.execute("""
            WITH s AS (
              SELECT round(sum(mm.moyenne_finale * m.coefficient) / nullif(sum(m.coefficient), 0), 2) AS moy,
                     sum(mm.credits_acquis)::smallint AS ca, sum(m.credits)::smallint AS ct,
                     bool_or(mm.note_examen_s2 IS NOT NULL) AS s2
                FROM ispat.moyenne_matiere mm JOIN ispat.matiere m ON m.id = mm.matiere_id
               WHERE mm.inscription_id = %s AND mm.semestre_id = %s
                 AND mm.deleted_at IS NULL AND mm.moyenne_finale IS NOT NULL)
            UPDATE ispat.moyenne_semestre ms
               SET moyenne = s.moy, credits_acquis = s.ca, credits_total = s.ct,
                   decision = CASE WHEN s.moy >= coalesce(ispat.param('seuil_validation'), '10')::numeric THEN 'ADMIS'
                                   WHEN s.s2 THEN 'AJOURNE' ELSE 'SESSION2' END
              FROM s
             WHERE ms.inscription_id = %s AND ms.semestre_id = %s AND ms.deleted_at IS NULL""",
                  [inscription_id, semestre_id, inscription_id, semestre_id])


def recalculer_rangs(classe_id, semestre_id):
    with connection.cursor() as c:
        c.execute("""
            UPDATE ispat.moyenne_semestre ms SET rang = r.rg
              FROM (SELECT ms2.id, rank() OVER (ORDER BY ms2.moyenne DESC NULLS LAST) AS rg
                      FROM ispat.moyenne_semestre ms2 JOIN ispat.inscription i ON i.id = ms2.inscription_id
                     WHERE i.classe_id = %s AND ms2.semestre_id = %s AND ms2.deleted_at IS NULL) r
             WHERE ms.id = r.id AND ms.rang IS DISTINCT FROM r.rg""", [classe_id, semestre_id])

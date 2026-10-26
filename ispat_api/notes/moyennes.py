"""
API moyennes — /api/notes/moyennes/...

  calculer/            POST {classe, semestre}                         -> ispat.calculer_moyennes (jamais sur du validé)
  tableau/             GET ?classe=&semestre=[&export=xlsx|csv]        -> étudiants × matières, moyenne, rang, décision
  matieres/            GET ?classe=&semestre=&matiere=&inscription=&statut=
  matieres/{id}/modifier/   POST {moyenne, motif}   (moyenne VALIDEE ; recalcul semestre + rangs)
  semestre/            GET ?classe=&semestre=&inscription=&statut=
  semestre/{id}/modifier/   POST {decision?, appreciation?, motif}
  valider/             POST {classe, semestre, matiere?}               -> exige les notes d'examen validées
  rouvrir/             POST {classe, semestre, matiere?, motif}        -> repasse en CALCULEE (recalcul possible)
"""
from decimal import Decimal

from django.db import connection, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from core.exceptions import Conflit
from core.exports import reponse_export
from core.filtres import FiltreSimpleMixin
from core.mixins import VueISPAT, ViewSetISPAT, definir_contexte_base
from referentiels.models import Matiere
from scolarite.listes import VueListe
from scolarite.models import Inscription

from .models import Evaluation, MoyenneMatiere, MoyenneSemestre, Note
from .outils import charger_classe_semestre, recalculer_rangs, recalculer_semestre, seuil_validation
from .serializers import (
    ClasseSemestreSerializer, ModificationMoyenneSerializer, ModificationSemestreSerializer, MoyenneMatiereSerializer,
    MoyenneSemestreSerializer,
)

LIRE_MOYENNES = ["moyenne.validation_moyenne.lire", "moyenne.calcul.lire", "moyenne.modification_moyenne.lire"]
LIBELLES_DECISION = {"ADMIS": "Admis", "AJOURNE": "Ajourné", "SESSION2": "Session 2"}


def _saisie_classe_semestre(request, motif_obligatoire=False):
    s = ClasseSemestreSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    d = s.validated_data
    classe, semestre = charger_classe_semestre(d["classe"], d["semestre"])
    matiere = get_object_or_404(Matiere, pk=d["matiere"]) if d.get("matiere") else None
    motif = (d.get("motif") or "").strip()
    if motif_obligatoire and len(motif) < 5:
        raise serializers.ValidationError({"motif": "Motif obligatoire (5 caractères minimum)."})
    return classe, semestre, matiere, motif


def _calculer(classe, semestre):
    if semestre.cloture:
        raise Conflit("Semestre clôturé : calcul impossible.")
    with connection.cursor() as c:
        c.execute("SELECT ispat.calculer_moyennes(%s, %s)", [classe.pk, semestre.pk])
        return c.fetchone()[0]


def _matieres_classe(classe, semestre):
    return Matiere.objects.filter(filiere_id=classe.filiere_id, niveau_id=classe.niveau_id,
                                  semestre_numero=semestre.numero).order_by("code")


# --------------------------------------------------------------------------------------

class CalculerView(VueISPAT):
    permissions_requises = {"POST": "moyenne.calcul.creer"}

    def post(self, request):
        classe, semestre, _, _ = _saisie_classe_semestre(request)
        lignes = _calculer(classe, semestre)
        mm = MoyenneMatiere.objects.filter(inscription__classe=classe, semestre=semestre)
        ms = MoyenneSemestre.objects.filter(inscription__classe=classe, semestre=semestre)
        return Response({
            "classe": classe.libelle, "semestre": semestre.numero, "lignes_traitees": lignes,
            "moyennes_matiere": mm.count(), "moyennes_matiere_validees": mm.filter(statut="VALIDEE").count(),
            "admis": ms.filter(decision="ADMIS").count(), "session2": ms.filter(decision="SESSION2").count(),
            "ajournes": ms.filter(decision="AJOURNE").count(),
        })


class TableauView(VueListe):
    """Tableau de délibération : étudiants × matières."""

    permission_lire = LIRE_MOYENNES
    permission_exporter = LIRE_MOYENNES

    def get(self, request):
        p = request.query_params
        if not p.get("classe") or not p.get("semestre"):
            raise serializers.ValidationError("Paramètres ?classe=<id>&semestre=<id> obligatoires.")
        classe, semestre = charger_classe_semestre(p["classe"], p["semestre"])
        fmt = self.format_export()
        matieres = list(_matieres_classe(classe, semestre))
        inscriptions = Inscription.objects.filter(classe=classe, etat="VALIDEE").select_related("etudiant") \
            .order_by("etudiant__nom", "etudiant__prenoms")
        mm = {(m.inscription_id, m.matiere_id): m for m in
              MoyenneMatiere.objects.filter(inscription__classe=classe, semestre=semestre)}
        ms = {m.inscription_id: m for m in MoyenneSemestre.objects.filter(inscription__classe=classe, semestre=semestre)}

        etudiants = []
        for i, ins in enumerate(inscriptions, start=1):
            s = ms.get(ins.pk)
            etudiants.append({
                "numero": i, "inscription_id": ins.pk, "matricule": ins.etudiant.matricule, "nom": ins.etudiant.nom,
                "prenoms": ins.etudiant.prenoms, "sexe": ins.etudiant.sexe,
                "moyennes": {str(m.pk): (None if (ins.pk, m.pk) not in mm else {
                    "id": mm[(ins.pk, m.pk)].pk, "moyenne_finale": mm[(ins.pk, m.pk)].moyenne_finale,
                    "moyenne_session1": mm[(ins.pk, m.pk)].moyenne_session1,
                    "credits_acquis": mm[(ins.pk, m.pk)].credits_acquis, "statut": mm[(ins.pk, m.pk)].statut})
                    for m in matieres},
                "moyenne_semestre_id": s.pk if s else None,
                "moyenne": s.moyenne if s else None, "credits_acquis": s.credits_acquis if s else None,
                "credits_total": s.credits_total if s else None, "rang": s.rang if s else None,
                "decision": s.decision if s else None, "statut": s.statut if s else None,
            })
        moyennes = [e["moyenne"] for e in etudiants if e["moyenne"] is not None]
        stats = {
            "effectif": len(etudiants), "classes_calculees": len(moyennes),
            "moyenne_classe": round(sum(moyennes) / len(moyennes), 2) if moyennes else None,
            "plus_forte": max(moyennes) if moyennes else None, "plus_faible": min(moyennes) if moyennes else None,
            "admis": sum(1 for e in etudiants if e["decision"] == "ADMIS"),
            "session2": sum(1 for e in etudiants if e["decision"] == "SESSION2"),
            "ajournes": sum(1 for e in etudiants if e["decision"] == "AJOURNE"),
        }
        stats["taux_reussite"] = round(100 * stats["admis"] / len(moyennes), 1) if moyennes else None

        if fmt:
            entetes = ["N°", "Matricule", "Nom", "Prénoms", *[f"{m.code} (coef {m.coefficient:g})" for m in matieres],
                       "Moyenne", "Crédits", "Rang", "Décision"]
            donnees = [[e["numero"], e["matricule"], e["nom"], e["prenoms"],
                        *[(e["moyennes"][str(m.pk)] or {}).get("moyenne_finale") for m in matieres],
                        e["moyenne"], f"{e['credits_acquis']}/{e['credits_total']}" if e["credits_total"] else None,
                        e["rang"], LIBELLES_DECISION.get(e["decision"], "")] for e in etudiants]
            return reponse_export(fmt, f"Tableau des moyennes — {classe.libelle}",
                                  f"Semestre {semestre.numero} · {classe.annee.libelle} · moyenne de classe "
                                  f"{stats['moyenne_classe'] if stats['moyenne_classe'] is not None else '—'}",
                                  entetes, donnees, f"moyennes_{classe.libelle}_S{semestre.numero}")
        return Response({
            "classe": {"id": classe.pk, "libelle": classe.libelle, "annee": classe.annee.libelle},
            "semestre": {"id": semestre.pk, "numero": semestre.numero, "cloture": semestre.cloture},
            "matieres": [{"id": m.pk, "code": m.code, "libelle": m.libelle, "coefficient": m.coefficient,
                          "credits": m.credits} for m in matieres],
            "etudiants": etudiants, "statistiques": stats,
        })


class MoyenneMatiereViewSet(FiltreSimpleMixin, ViewSetISPAT):
    queryset = MoyenneMatiere.objects.select_related("inscription__etudiant", "matiere")
    serializer_class = MoyenneMatiereSerializer
    pagination_class = None
    http_method_names = ["get", "post", "head", "options"]
    filtres = {"classe": "inscription__classe_id", "semestre": "semestre_id", "matiere": "matiere_id",
               "inscription": "inscription_id", "statut": "statut"}
    permissions_requises = {"list": LIRE_MOYENNES, "retrieve": LIRE_MOYENNES,
                            "modifier": "moyenne.modification_moyenne.modifier"}

    def list(self, request, *args, **kwargs):
        if not (request.query_params.get("classe") or request.query_params.get("inscription")):
            raise serializers.ValidationError("Filtre obligatoire : ?classe= ou ?inscription=.")
        return super().list(request, *args, **kwargs)

    @action(detail=True, methods=["post"])
    def modifier(self, request, pk=None):
        mm = self.get_object()
        s = ModificationMoyenneSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        if mm.statut != "VALIDEE":
            raise Conflit("Moyenne non validée : corriger les notes et recalculer (elle serait écrasée au prochain calcul).")
        nouvelle = s.validated_data["moyenne"]
        with transaction.atomic():
            definir_contexte_base(motif=s.validated_data["motif"])
            mm.moyenne_finale = nouvelle
            mm.credits_acquis = mm.matiere.credits if nouvelle >= seuil_validation() else 0
            mm.save(update_fields=["moyenne_finale", "credits_acquis"])
            recalculer_semestre(mm.inscription_id, mm.semestre_id)
            recalculer_rangs(mm.inscription.classe_id, mm.semestre_id)
        mm.refresh_from_db()
        semestre = MoyenneSemestre.objects.filter(inscription_id=mm.inscription_id, semestre_id=mm.semestre_id).first()
        return Response({"moyenne_matiere": MoyenneMatiereSerializer(mm).data,
                         "moyenne_semestre": MoyenneSemestreSerializer(semestre).data if semestre else None})


class MoyenneSemestreViewSet(FiltreSimpleMixin, ViewSetISPAT):
    queryset = MoyenneSemestre.objects.select_related("inscription__etudiant")
    serializer_class = MoyenneSemestreSerializer
    pagination_class = None
    http_method_names = ["get", "post", "head", "options"]
    filtres = {"classe": "inscription__classe_id", "semestre": "semestre_id", "inscription": "inscription_id",
               "statut": "statut", "decision": "decision"}
    permissions_requises = {"list": LIRE_MOYENNES, "retrieve": LIRE_MOYENNES,
                            "modifier": "moyenne.modification_moyenne.modifier"}

    def list(self, request, *args, **kwargs):
        if not (request.query_params.get("classe") or request.query_params.get("inscription")):
            raise serializers.ValidationError("Filtre obligatoire : ?classe= ou ?inscription=.")
        return super().list(request, *args, **kwargs)

    @action(detail=True, methods=["post"])
    def modifier(self, request, pk=None):
        ms = self.get_object()
        s = ModificationSemestreSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        champs = []
        if "decision" in d:
            ms.decision = d["decision"]
            champs.append("decision")
        if "appreciation" in d:
            ms.appreciation = d["appreciation"].strip() or None
            champs.append("appreciation")
        if d.get("motif"):
            definir_contexte_base(motif=d["motif"])
        ms.save(update_fields=champs)
        ms.refresh_from_db()
        return Response(MoyenneSemestreSerializer(ms).data)


class ValiderView(VueISPAT):
    permissions_requises = {"POST": "moyenne.validation_moyenne.valider"}

    def post(self, request):
        classe, semestre, matiere, _ = _saisie_classe_semestre(request)
        matieres = [matiere] if matiere else list(_matieres_classe(classe, semestre))

        bloquants = []
        for m in matieres:
            examens = Evaluation.objects.filter(classe=classe, semestre=semestre, matiere=m, type_eval="EXAMEN")
            if not examens.filter(session=1).exists():
                bloquants.append({"matiere": m.code, "raison": "Aucun examen de 1re session."})
            elif Note.objects.filter(evaluation__in=examens, statut="SAISIE").exists():
                bloquants.append({"matiere": m.code, "raison": "Notes d'examen non validées."})
        if bloquants:
            raise Conflit({"detail": "Validation impossible : notes d'examen à valider d'abord.", "matieres": bloquants})

        _calculer(classe, semestre)                      # moyennes à jour avant de les figer
        maintenant = timezone.now()
        with transaction.atomic():
            nb_mm = MoyenneMatiere.objects.filter(inscription__classe=classe, semestre=semestre, matiere__in=matieres,
                                                  statut="CALCULEE") \
                .update(statut="VALIDEE", valide_par=request.user, valide_le=maintenant)
            nb_ms = 0
            if matiere is None:
                nb_ms = MoyenneSemestre.objects.filter(inscription__classe=classe, semestre=semestre,
                                                       statut="CALCULEE") \
                    .update(statut="VALIDEE", valide_par=request.user, valide_le=maintenant)
        return Response({"moyennes_matiere_validees": nb_mm, "moyennes_semestre_validees": nb_ms})


class RouvrirView(VueISPAT):
    permissions_requises = {"POST": "moyenne.modification_moyenne.modifier"}

    def post(self, request):
        classe, semestre, matiere, motif = _saisie_classe_semestre(request, motif_obligatoire=True)
        if semestre.cloture:
            raise Conflit("Semestre clôturé.")
        with transaction.atomic():
            definir_contexte_base(motif=motif)
            mm = MoyenneMatiere.objects.filter(inscription__classe=classe, semestre=semestre, statut="VALIDEE")
            if matiere is not None:
                mm = mm.filter(matiere=matiere)
            nb_mm = mm.update(statut="CALCULEE", valide_par=None, valide_le=None)
            nb_ms = MoyenneSemestre.objects.filter(inscription__classe=classe, semestre=semestre, statut="VALIDEE") \
                .update(statut="CALCULEE", valide_par=None, valide_le=None)
        return Response({"moyennes_matiere_rouvertes": nb_mm, "moyennes_semestre_rouvertes": nb_ms})

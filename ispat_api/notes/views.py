"""
API notes — /api/notes/...

  mes-cours/                         cours de l'enseignant connecté (ou de l'année pour la scolarité)
  evaluations/                       CRUD ; ?classe=&semestre=&matiere=&type=&session=&annee=
  evaluations/{id}/grille/           étudiants concernés + notes + statistiques
  evaluations/{id}/saisir/           {"notes": [{"inscription", "valeur", "absent"}]}  (tout ou rien sur les erreurs)
  evaluations/{id}/valider/          validation des notes d'examen  {"forcer": true} si notes manquantes
  notes/                             ?evaluation= | ?inscription= ; PATCH {"valeur" | "absent", "motif"}
  historique/                        modifications des notes / moyennes validées ; ?table=&classe=&enregistrement=

Un enseignant (rôle ENSEIGNANT seul) ne voit et ne saisit que ses cours (voir notes/portee.py).
"""
from django.db import connection, transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from core.exceptions import Conflit
from core.filtres import FiltreSimpleMixin, filtre_annee
from core.mixins import VueISPAT, ViewSetISPAT, definir_contexte_base
from core.permissions import permissions_crud
from referentiels.models import Enseignement

from .models import Evaluation, MoyenneMatiere, Note
from .outils import inscrits_evaluation
from .portee import exiger_cours, filtrer_evaluations
from .serializers import EvaluationSerializer, NoteSerializer, SaisieSerializer


def _semestre_ouvert(evaluation):
    if evaluation.semestre.cloture:
        raise Conflit("Semestre clôturé : saisie fermée.")


def _grille(evaluation):
    inscrits = inscrits_evaluation(evaluation)
    if inscrits is None:
        raise Conflit("Calculer d'abord les moyennes de 1re session (la 2e session ne concerne que les non-admis).")
    notes = {n.inscription_id: n for n in evaluation.notes.all()}
    moyennes_validees = set(MoyenneMatiere.objects.filter(
        matiere_id=evaluation.matiere_id, semestre_id=evaluation.semestre_id, statut="VALIDEE",
        inscription__classe_id=evaluation.classe_id).values_list("inscription_id", flat=True))
    lignes, valeurs, absents = [], [], 0
    for i, ins in enumerate(inscrits, start=1):
        n = notes.get(ins.pk)
        if n is not None:
            if n.absent:
                absents += 1
            elif n.valeur is not None:
                valeurs.append(n.valeur)
        lignes.append({
            "numero": i, "inscription_id": ins.pk, "matricule": ins.etudiant.matricule, "nom": ins.etudiant.nom,
            "prenoms": ins.etudiant.prenoms, "sexe": ins.etudiant.sexe,
            "note": None if n is None else {"id": n.pk, "valeur": n.valeur, "absent": n.absent, "statut": n.statut,
                                            "version": n.version},
            "verrouillee": (n is not None and n.statut == "VALIDEE") or ins.pk in moyennes_validees,
        })
    return {
        "evaluation": EvaluationSerializer(evaluation).data,
        "semestre_cloture": evaluation.semestre.cloture,
        "etudiants": lignes,
        "statistiques": {
            "effectif": len(lignes), "notes": len(valeurs), "absents": absents,
            "manquantes": len(lignes) - len(valeurs) - absents,
            "moyenne": round(sum(valeurs) / len(valeurs), 2) if valeurs else None,
            "plus_forte": max(valeurs) if valeurs else None, "plus_faible": min(valeurs) if valeurs else None,
            "sous_la_moyenne": sum(1 for v in valeurs if v < 10),
        },
    }


# --------------------------------------------------------------------------------------
# Mes cours
# --------------------------------------------------------------------------------------

class MesCoursView(VueISPAT):
    permissions_requises = {"GET": "moyenne.note.lire"}

    def get(self, request):
        qs = Enseignement.objects.select_related("enseignant", "matiere", "classe", "semestre", "classe__annee")
        qs = filtrer_evaluations(qs, request.user)
        annee = request.query_params.get("annee") or "active"
        qs = qs.filter(classe__annee__est_active=True) if annee == "active" else qs.filter(classe__annee_id=annee)
        resultat = []
        for e in qs.order_by("classe__libelle", "semestre__numero", "matiere__code"):
            evals = Evaluation.objects.filter(matiere_id=e.matiere_id, classe_id=e.classe_id, semestre_id=e.semestre_id)
            examens = {ev.session: ev for ev in evals if ev.type_eval == "EXAMEN"}
            resultat.append({
                "enseignement_id": e.pk, "enseignant": f"{e.enseignant.nom} {e.enseignant.prenoms}",
                "classe_id": e.classe_id, "classe": e.classe.libelle, "semestre_id": e.semestre_id,
                "semestre": e.semestre.numero, "matiere_id": e.matiere_id, "matiere_code": e.matiere.code,
                "matiere": e.matiere.libelle, "nb_evaluations": evals.count(),
                "examen_session1": bool(examens.get(1)), "examen_session2": bool(examens.get(2)),
            })
        return Response(resultat)


# --------------------------------------------------------------------------------------
# Évaluations
# --------------------------------------------------------------------------------------

class EvaluationViewSet(FiltreSimpleMixin, ViewSetISPAT):
    serializer_class = EvaluationSerializer
    pagination_class = None
    filtres = {"classe": "classe_id", "semestre": "semestre_id", "matiere": "matiere_id", "type": "type_eval",
               "session": "session", "annee": filtre_annee("classe__annee")}
    champs_recherche = ("libelle__unaccent", "matiere__code", "matiere__libelle__unaccent")
    permissions_requises = permissions_crud(
        "moyenne.note",
        grille="moyenne.note.lire",
        saisir="moyenne.note.creer",
        valider="moyenne.validation_note_examen.valider",
    )

    def get_queryset(self):
        qs = Evaluation.objects.select_related("classe", "matiere", "semestre").annotate(
            nb_notes=Count("notes", filter=Q(notes__deleted_at__isnull=True)),
            nb_validees=Count("notes", filter=Q(notes__deleted_at__isnull=True, notes__statut="VALIDEE")))
        return filtrer_evaluations(qs, self.request.user)

    def perform_create(self, serializer):
        d = serializer.validated_data
        exiger_cours(self.request.user, d["matiere"].pk, d["classe"].pk, d["semestre"].pk)
        super().perform_create(serializer)

    def perform_update(self, serializer):
        inst, d = serializer.instance, serializer.validated_data
        if inst.notes.filter(statut="VALIDEE").exists():
            raise Conflit("Des notes de cette évaluation sont validées : modification impossible.")
        _semestre_ouvert(inst)
        exiger_cours(self.request.user, getattr(d.get("matiere"), "pk", inst.matiere_id),
                     getattr(d.get("classe"), "pk", inst.classe_id), getattr(d.get("semestre"), "pk", inst.semestre_id))
        super().perform_update(serializer)

    def perform_destroy(self, instance):
        if instance.notes.filter(statut="VALIDEE").exists():
            raise Conflit("Des notes de cette évaluation sont validées : suppression impossible.")
        if instance.est_examen and instance.session == 1 and Evaluation.objects.filter(
                classe_id=instance.classe_id, matiere_id=instance.matiere_id, semestre_id=instance.semestre_id,
                type_eval="EXAMEN", session=2).exists():
            raise Conflit("Supprimer d'abord l'examen de 2e session.")
        _semestre_ouvert(instance)
        with transaction.atomic():
            for note in instance.notes.all():
                note.supprimer()
            instance.supprimer()

    @action(detail=True, methods=["get"])
    def grille(self, request, pk=None):
        return Response(_grille(self.get_object()))

    @action(detail=True, methods=["post"])
    def saisir(self, request, pk=None):
        evaluation = self.get_object()
        _semestre_ouvert(evaluation)
        saisie = SaisieSerializer(data=request.data)
        saisie.is_valid(raise_exception=True)
        lignes = saisie.validated_data["notes"]

        inscrits = inscrits_evaluation(evaluation)
        if inscrits is None:
            raise Conflit("Calculer d'abord les moyennes de 1re session.")
        autorises = set(inscrits.values_list("pk", flat=True))
        vus, erreurs = set(), []
        for rang, l in enumerate(lignes):
            if l["inscription"] in vus:
                erreurs.append({"ligne": rang, "inscription": l["inscription"], "erreur": "Étudiant en double."})
            elif l["inscription"] not in autorises:
                erreurs.append({"ligne": rang, "inscription": l["inscription"],
                                "erreur": "Étudiant non concerné par cette évaluation."})
            vus.add(l["inscription"])
        if erreurs:
            raise serializers.ValidationError({"erreurs": erreurs})

        existantes = {n.inscription_id: n for n in evaluation.notes.all()}
        moyennes_validees = set(MoyenneMatiere.objects.filter(
            matiere_id=evaluation.matiere_id, semestre_id=evaluation.semestre_id, statut="VALIDEE",
            inscription_id__in=vus).values_list("inscription_id", flat=True))
        bilan = {"creees": 0, "modifiees": 0, "effacees": 0, "inchangees": 0, "refusees": []}

        with transaction.atomic():
            for l in lignes:
                ins_id, absent, valeur = l["inscription"], l.get("absent", False), l.get("valeur")
                note = existantes.get(ins_id)
                if note is not None and note.statut == "VALIDEE":
                    bilan["refusees"].append({"inscription": ins_id, "raison": "Note validée (passer par la modification motivée)."})
                    continue
                if ins_id in moyennes_validees:
                    bilan["refusees"].append({"inscription": ins_id, "raison": "Moyenne de la matière déjà validée."})
                    continue
                if not absent and valeur is None:
                    if note is not None:
                        note.supprimer()
                        bilan["effacees"] += 1
                    continue
                valeur = None if absent else valeur
                if note is None:
                    Note.objects.create(evaluation=evaluation, inscription_id=ins_id, valeur=valeur, absent=absent,
                                        saisi_par=request.user)
                    bilan["creees"] += 1
                elif note.valeur != valeur or note.absent != absent:
                    note.valeur, note.absent, note.saisi_par = valeur, absent, request.user
                    note.save(update_fields=["valeur", "absent", "saisi_par"])
                    bilan["modifiees"] += 1
                else:
                    bilan["inchangees"] += 1
        bilan["grille"] = _grille(evaluation)
        return Response(bilan)

    @action(detail=True, methods=["post"])
    def valider(self, request, pk=None):
        evaluation = self.get_object()
        if not evaluation.est_examen:
            raise serializers.ValidationError("Seules les notes d'examen se valident (le contrôle continu est validé avec la moyenne).")
        grille = _grille(evaluation)
        manquants = [{"matricule": l["matricule"], "nom": f"{l['nom']} {l['prenoms']}"}
                     for l in grille["etudiants"] if l["note"] is None]
        if manquants and str(request.data.get("forcer")).lower() not in ("true", "1", "oui"):
            raise Conflit({"detail": f"{len(manquants)} note(s) manquante(s). Renvoyer avec {{\"forcer\": true}} pour valider quand même.",
                           "manquants": manquants})
        nb = evaluation.notes.filter(statut="SAISIE").update(statut="VALIDEE", valide_par=request.user,
                                                              valide_le=timezone.now())
        return Response({"validees": nb, "manquantes": len(manquants), "grille": _grille(evaluation)})


# --------------------------------------------------------------------------------------
# Notes (consultation, correction unitaire, modification motivée)
# --------------------------------------------------------------------------------------

class NoteViewSet(FiltreSimpleMixin, ViewSetISPAT):
    serializer_class = NoteSerializer
    pagination_class = None
    http_method_names = ["get", "put", "patch", "head", "options"]
    filtres = {"evaluation": "evaluation_id", "inscription": "inscription_id", "statut": "statut"}
    permissions_requises = {
        "list": "moyenne.note.lire",
        "retrieve": "moyenne.note.lire",
        "update": ["moyenne.note.modifier", "moyenne.modification_note_examen.modifier"],
        "partial_update": ["moyenne.note.modifier", "moyenne.modification_note_examen.modifier"],
    }

    def get_queryset(self):
        qs = Note.objects.select_related("evaluation", "evaluation__semestre", "inscription__etudiant")
        return filtrer_evaluations(qs, self.request.user, prefixe="evaluation__")

    def list(self, request, *args, **kwargs):
        if not (request.query_params.get("evaluation") or request.query_params.get("inscription")):
            raise serializers.ValidationError("Filtre obligatoire : ?evaluation= ou ?inscription=.")
        return super().list(request, *args, **kwargs)

    def perform_update(self, serializer):
        note, u = serializer.instance, self.request.user
        ev = note.evaluation
        self._avertissement = None
        if note.statut == "VALIDEE":
            if not u.a_permission("moyenne.modification_note_examen.modifier"):
                raise PermissionDenied("Note validée : droit « modification de notes d'examen » requis.")
            motif = (self.request.data.get("motif") or "").strip()
            if len(motif) < 5:
                raise serializers.ValidationError({"motif": "Motif obligatoire (5 caractères minimum) pour modifier une note validée."})
            definir_contexte_base(motif=motif)
            if MoyenneMatiere.objects.filter(inscription_id=note.inscription_id, matiere_id=ev.matiere_id,
                                             semestre_id=ev.semestre_id, statut="VALIDEE").exists():
                self._avertissement = ("La moyenne de cette matière est validée : elle n'est pas recalculée. "
                                       "Utiliser « rouvrir » puis recalculer, ou « modification de moyenne ».")
            serializer.save().refresh_from_db()          # saisi_par d'origine conservé ; l'auteur est dans l'historique
            return
        else:
            if not u.a_permission("moyenne.note.modifier"):
                raise PermissionDenied("Droit « saisie des notes » requis.")
            exiger_cours(u, ev.matiere_id, ev.classe_id, ev.semestre_id)
            _semestre_ouvert(ev)
            if MoyenneMatiere.objects.filter(inscription_id=note.inscription_id, matiere_id=ev.matiere_id,
                                             semestre_id=ev.semestre_id, statut="VALIDEE").exists():
                raise Conflit("Moyenne de la matière déjà validée : passer par la modification de moyenne.")
        serializer.save(saisi_par=u).refresh_from_db()

    def update(self, request, *args, **kwargs):
        reponse = super().update(request, *args, **kwargs)
        if getattr(self, "_avertissement", None):
            reponse.data["avertissement"] = self._avertissement
        return reponse


# --------------------------------------------------------------------------------------
# Historique des modifications
# --------------------------------------------------------------------------------------

class HistoriqueView(VueISPAT):
    permissions_requises = {"GET": ["moyenne.modification_note_examen.lire", "moyenne.modification_moyenne.lire"]}

    def get(self, request):
        p = request.query_params
        conditions, params = ["h.deleted_at IS NULL"], []
        if p.get("table"):
            conditions.append("h.table_nom = %s")
            params.append(p["table"])
        if p.get("enregistrement"):
            conditions.append("h.enregistrement_id = %s")
            params.append(p["enregistrement"])
        if p.get("classe"):
            conditions.append("coalesce(i1.classe_id, i2.classe_id, i3.classe_id) = %s")
            params.append(p["classe"])
        if p.get("semestre"):
            conditions.append("coalesce(ev.semestre_id, mm.semestre_id, ms.semestre_id) = %s")
            params.append(p["semestre"])
        with connection.cursor() as c:
            c.execute(f"""
                SELECT h.id, h.table_nom, h.enregistrement_id, h.champ, h.ancienne_valeur, h.nouvelle_valeur, h.motif,
                       h.modifie_le, u.nom || ' ' || u.prenoms AS modifie_par,
                       coalesce(e1.matricule, e2.matricule, e3.matricule) AS matricule,
                       coalesce(e1.nom || ' ' || e1.prenoms, e2.nom || ' ' || e2.prenoms, e3.nom || ' ' || e3.prenoms) AS etudiant,
                       coalesce(m1.code || ' — ' || ev.libelle, m2.code, 'Moyenne du semestre') AS objet
                  FROM ispat.historique_modification h
                  LEFT JOIN ispat.utilisateur u ON u.id = h.modifie_par
                  LEFT JOIN ispat.note n ON h.table_nom = 'note' AND n.id = h.enregistrement_id
                  LEFT JOIN ispat.evaluation ev ON ev.id = n.evaluation_id
                  LEFT JOIN ispat.matiere m1 ON m1.id = ev.matiere_id
                  LEFT JOIN ispat.inscription i1 ON i1.id = n.inscription_id
                  LEFT JOIN ispat.etudiant e1 ON e1.id = i1.etudiant_id
                  LEFT JOIN ispat.moyenne_matiere mm ON h.table_nom = 'moyenne_matiere' AND mm.id = h.enregistrement_id
                  LEFT JOIN ispat.matiere m2 ON m2.id = mm.matiere_id
                  LEFT JOIN ispat.inscription i2 ON i2.id = mm.inscription_id
                  LEFT JOIN ispat.etudiant e2 ON e2.id = i2.etudiant_id
                  LEFT JOIN ispat.moyenne_semestre ms ON h.table_nom = 'moyenne_semestre' AND ms.id = h.enregistrement_id
                  LEFT JOIN ispat.inscription i3 ON i3.id = ms.inscription_id
                  LEFT JOIN ispat.etudiant e3 ON e3.id = i3.etudiant_id
                 WHERE {' AND '.join(conditions)}
                 ORDER BY h.modifie_le DESC LIMIT 500""", params)
            colonnes = [d[0] for d in c.description]
            return Response([dict(zip(colonnes, r)) for r in c.fetchall()])

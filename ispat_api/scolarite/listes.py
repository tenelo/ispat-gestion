"""
Listes de scolarité — /api/scolarite/listes/...   (JSON, ou ?export=xlsx | csv)

  classe/?classe=<id>                              liste de classe
  sexe/?annee=active&classe=&filiere=&niveau=&sexe=   liste par sexe
  statut/?annee=active&classe=&filiere=&niveau=&statut=<code>   liste par statut
  effectifs/?annee=active                          effectifs par classe (total, sexe, statut)
  notation/?classe=<id>&semestre=<id>&matiere=     liste de notation (étudiants x évaluations)

Par défaut : inscriptions VALIDEE uniquement ; ?inclure_attente=true ajoute les inscriptions en attente.
Droits : scolarite.<liste>.lire pour consulter, scolarite.<liste>.exporter pour exporter.
"""
from django.db import connection
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from core.exports import FORMATS_EXPORT, reponse_export
from core.mixins import VueISPAT
from referentiels.models import AnneeAcademique, Classe, Semestre

from .models import VEtudiantInscrit

LIBELLES_SEXE = {"M": "Masculin", "F": "Féminin"}
ORDRE_TYPES_EVAL = {"DEVOIR": 1, "INTERROGATION": 2, "TP": 3, "EXPOSE": 4, "EXAMEN": 5}


class VueListe(VueISPAT):
    """Base : contrôle lecture / export, filtres communs."""

    permission_lire = None
    permission_exporter = None

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        lire = self.permission_lire if isinstance(self.permission_lire, (list, tuple)) else [self.permission_lire]
        self.permissions_requises = {"GET": list(lire)}

    # -- export ---------------------------------------------------------------------------
    def format_export(self):
        fmt = (self.request.query_params.get("export") or "").lower()
        if not fmt:
            return None
        if fmt not in FORMATS_EXPORT:
            raise serializers.ValidationError({"export": "Formats possibles : xlsx, csv."})
        codes = self.permission_exporter if isinstance(self.permission_exporter, (list, tuple)) \
            else [self.permission_exporter]
        if not any(self.request.user.a_permission(c) for c in codes):
            raise PermissionDenied("Vous n'avez pas la permission d'exporter cette liste.")
        return fmt

    # -- filtres --------------------------------------------------------------------------
    def annee(self):
        valeur = self.request.query_params.get("annee") or "active"
        if valeur == "active":
            annee = AnneeAcademique.objects.filter(est_active=True).first()
            if annee is None:
                raise serializers.ValidationError({"annee": "Aucune année académique active."})
            return annee
        return get_object_or_404(AnneeAcademique, pk=valeur)

    def inscrits(self, qs=None):
        qs = qs if qs is not None else VEtudiantInscrit.objects.all()
        p = self.request.query_params
        etats = ["VALIDEE", "EN_ATTENTE"] if (p.get("inclure_attente") or "").lower() in ("1", "true", "oui") \
            else ["VALIDEE"]
        qs = qs.filter(etat__in=etats)
        for param, champ in (("classe", "classe_id"), ("filiere", "filiere_id"), ("niveau", "niveau_id"),
                             ("statut", "statut_code"), ("sexe", "sexe")):
            valeur = p.get(param)
            if valeur:
                qs = qs.filter(**{champ: valeur.upper() if param in ("statut", "sexe") else valeur})
        return qs


def ligne_etudiant(numero, e):
    return {
        "numero": numero,
        "inscription_id": e.inscription_id,
        "etudiant_id": e.etudiant_id,
        "matricule": e.matricule,
        "nom": e.nom,
        "prenoms": e.prenoms,
        "sexe": e.sexe,
        "date_naissance": e.date_naissance,
        "lieu_naissance": e.lieu_naissance,
        "classe": e.classe,
        "statut": e.statut,
        "statut_code": e.statut_code,
        "telephone": e.telephone,
        "etat": e.etat,
    }


ENTETES_ETUDIANT = ["N°", "Matricule", "Nom", "Prénoms", "Sexe", "Date de naissance", "Lieu de naissance",
                    "Classe", "Statut"]


def valeurs_etudiant(l):
    return [l["numero"], l["matricule"], l["nom"], l["prenoms"], l["sexe"], l["date_naissance"],
            l["lieu_naissance"], l["classe"], l["statut"]]


# --------------------------------------------------------------------------------------

class ListeClasseView(VueListe):
    permission_lire = "scolarite.liste_classe.lire"
    permission_exporter = "scolarite.liste_classe.exporter"

    def get(self, request):
        classe_id = request.query_params.get("classe")
        if not classe_id:
            raise serializers.ValidationError({"classe": "Paramètre ?classe=<id> obligatoire."})
        classe = get_object_or_404(Classe.objects.select_related("annee", "filiere", "niveau"), pk=classe_id)
        fmt = self.format_export()
        etudiants = [ligne_etudiant(i, e) for i, e in enumerate(self.inscrits().order_by("nom", "prenoms"), start=1)]

        if fmt:
            return reponse_export(fmt, f"Liste de classe — {classe.libelle}",
                                  f"Année {classe.annee.libelle} · {len(etudiants)} étudiant(s)",
                                  ENTETES_ETUDIANT, [valeurs_etudiant(l) for l in etudiants],
                                  f"liste_classe_{classe.libelle}_{classe.annee.libelle}")
        return Response({
            "classe": {"id": classe.pk, "libelle": classe.libelle, "annee": classe.annee.libelle,
                       "filiere": classe.filiere.libelle, "niveau": classe.niveau.code, "capacite": classe.capacite},
            "effectif": len(etudiants),
            "garcons": sum(1 for l in etudiants if l["sexe"] == "M"),
            "filles": sum(1 for l in etudiants if l["sexe"] == "F"),
            "etudiants": etudiants,
        })


class _ListeGroupeeView(VueListe):
    """Liste regroupée (par sexe ou par statut) sur une année."""

    champ_groupe = None
    titre = None

    def libelle_groupe(self, cle, exemple):
        raise NotImplementedError

    def get(self, request):
        annee = self.annee()
        fmt = self.format_export()
        qs = self.inscrits(VEtudiantInscrit.objects.filter(annee_id=annee.pk)) \
            .order_by(self.champ_groupe, "classe", "nom", "prenoms")

        groupes, ordre = {}, []
        for e in qs:
            cle = getattr(e, self.champ_groupe)
            if cle not in groupes:
                groupes[cle] = {"cle": cle, "libelle": self.libelle_groupe(cle, e), "etudiants": []}
                ordre.append(cle)
            groupe = groupes[cle]
            groupe["etudiants"].append(ligne_etudiant(len(groupe["etudiants"]) + 1, e))

        if fmt:
            lignes = [valeurs_etudiant(l) for cle in ordre for l in groupes[cle]["etudiants"]]
            return reponse_export(fmt, self.titre, f"Année {annee.libelle} · {len(lignes)} étudiant(s)",
                                  ENTETES_ETUDIANT, lignes, f"{self.titre}_{annee.libelle}")
        return Response({
            "annee": annee.libelle,
            "total": sum(len(g["etudiants"]) for g in groupes.values()),
            "groupes": [{**groupes[c], "effectif": len(groupes[c]["etudiants"])} for c in ordre],
        })


class ListeSexeView(_ListeGroupeeView):
    permission_lire = "scolarite.liste_sexe.lire"
    permission_exporter = "scolarite.liste_sexe.exporter"
    champ_groupe = "sexe"
    titre = "Liste par sexe"

    def libelle_groupe(self, cle, exemple):
        return LIBELLES_SEXE.get(cle, cle)


class ListeStatutView(_ListeGroupeeView):
    permission_lire = "scolarite.liste_statut.lire"
    permission_exporter = "scolarite.liste_statut.exporter"
    champ_groupe = "statut_code"
    titre = "Liste par statut"

    def libelle_groupe(self, cle, exemple):
        return exemple.statut


class EffectifsView(VueListe):
    permission_lire = ["scolarite.liste_classe.lire", "scolarite.liste_sexe.lire", "scolarite.liste_statut.lire"]
    permission_exporter = ["scolarite.liste_classe.exporter", "scolarite.liste_sexe.exporter",
                           "scolarite.liste_statut.exporter"]

    def get(self, request):
        annee = self.annee()
        fmt = self.format_export()
        with connection.cursor() as curseur:
            curseur.execute("SELECT classe_id, classe, axe, modalite, effectif FROM ispat.v_effectifs "
                            "WHERE annee_id = %s ORDER BY classe", [annee.pk])
            lignes = curseur.fetchall()

        classes, statuts = {}, []
        for classe_id, classe, axe, modalite, effectif in lignes:
            c = classes.setdefault(classe_id, {"classe_id": classe_id, "classe": classe, "total": 0, "M": 0, "F": 0,
                                               "statuts": {}})
            if axe == "TOTAL":
                c["total"] = effectif
            elif axe == "SEXE":
                c[modalite] = effectif
            else:
                c["statuts"][modalite] = effectif
                if modalite not in statuts:
                    statuts.append(modalite)
        statuts.sort()
        resultat = sorted(classes.values(), key=lambda c: c["classe"])
        totaux = {"total": sum(c["total"] for c in resultat), "M": sum(c["M"] for c in resultat),
                  "F": sum(c["F"] for c in resultat),
                  "statuts": {s: sum(c["statuts"].get(s, 0) for c in resultat) for s in statuts}}

        if fmt:
            entetes = ["Classe", "Total", "Garçons", "Filles", *statuts]
            donnees = [[c["classe"], c["total"], c["M"], c["F"], *[c["statuts"].get(s, 0) for s in statuts]]
                       for c in resultat]
            donnees.append(["TOTAL", totaux["total"], totaux["M"], totaux["F"],
                            *[totaux["statuts"][s] for s in statuts]])
            return reponse_export(fmt, "Effectifs par classe", f"Année {annee.libelle}", entetes, donnees,
                                  f"effectifs_{annee.libelle}")
        return Response({"annee": annee.libelle, "statuts": statuts, "classes": resultat, "totaux": totaux})


class ListeNotationView(VueListe):
    permission_lire = "scolarite.liste_notation.lire"
    permission_exporter = "scolarite.liste_notation.exporter"

    def get(self, request):
        p = request.query_params
        if not p.get("classe") or not p.get("semestre"):
            raise serializers.ValidationError("Paramètres ?classe=<id>&semestre=<id> obligatoires.")
        classe = get_object_or_404(Classe.objects.select_related("annee"), pk=p["classe"])
        semestre = get_object_or_404(Semestre, pk=p["semestre"])
        if semestre.annee_id != classe.annee_id:
            raise serializers.ValidationError({"semestre": "Ce semestre n'appartient pas à l'année de la classe."})
        fmt = self.format_export()

        sql = ("SELECT evaluation_id, matiere_code, matiere, type_eval, session, evaluation, date_eval, "
               "inscription_id, valeur, absent, statut FROM ispat.v_liste_notation "
               "WHERE classe_id = %s AND semestre_id = %s")
        params = [classe.pk, semestre.pk]
        if p.get("matiere"):
            sql += " AND matiere_id = %s"
            params.append(p["matiere"])
        with connection.cursor() as curseur:
            curseur.execute(sql, params)
            lignes = curseur.fetchall()

        evaluations, notes = {}, {}
        for (ev_id, mat_code, mat, type_eval, session, libelle, date_eval,
             inscription_id, valeur, absent, statut) in lignes:
            evaluations.setdefault(ev_id, {"id": ev_id, "matiere_code": mat_code, "matiere": mat,
                                           "type_eval": type_eval, "session": session, "libelle": libelle,
                                           "date": date_eval})
            if valeur is not None or absent:
                notes[(inscription_id, ev_id)] = {"valeur": valeur, "absent": absent, "statut": statut}

        colonnes = sorted(evaluations.values(), key=lambda e: (e["matiere_code"], ORDRE_TYPES_EVAL.get(e["type_eval"], 9),
                                                               e["session"], e["date"] or classe.annee.date_debut))
        etudiants = []
        for i, e in enumerate(self.inscrits(VEtudiantInscrit.objects.filter(classe_id=classe.pk))
                              .order_by("nom", "prenoms"), start=1):
            etudiants.append({"numero": i, "inscription_id": e.inscription_id, "matricule": e.matricule,
                              "nom": e.nom, "prenoms": e.prenoms, "sexe": e.sexe,
                              "notes": {str(c["id"]): notes.get((e.inscription_id, c["id"])) for c in colonnes}})

        if fmt:
            entetes = ["N°", "Matricule", "Nom", "Prénoms",
                       *[f"{c['matiere_code']} — {c['libelle']}" for c in colonnes]]
            donnees = []
            for et in etudiants:
                cellules = []
                for c in colonnes:
                    n = et["notes"][str(c["id"])]
                    cellules.append("ABS" if n and n["absent"] else (n["valeur"] if n else None))
                donnees.append([et["numero"], et["matricule"], et["nom"], et["prenoms"], *cellules])
            return reponse_export(fmt, f"Liste de notation — {classe.libelle}",
                                  f"Semestre {semestre.numero} · {classe.annee.libelle}", entetes, donnees,
                                  f"notation_{classe.libelle}_S{semestre.numero}")
        return Response({"classe": classe.libelle, "semestre": semestre.numero, "evaluations": colonnes,
                         "etudiants": etudiants})

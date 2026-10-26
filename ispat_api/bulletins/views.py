"""
API bulletins — /api/bulletins/...   (réponses PDF)

  semestre/?inscription=<id>&semestre=<id>[&provisoire=true]     bulletin d'un étudiant
  semestre/?classe=<id>&semestre=<id>[&provisoire=true]          bulletins de toute la classe (un PDF)
  releve/?inscription=|classe=<id>&semestre=<id>&session=1|2[&provisoire=true]   relevé de notes d'examen
  editions/?inscription=&classe=&semestre=&type=&session=        historique des éditions officielles (JSON)
  editions/{id}/fichier/                                         copie archivée d'une édition

Officiel  : numéroté, archivé, exige la validation (moyennes de semestre / notes d'examen de la session).
Provisoire: filigrane PROVISOIRE, non numéroté, non archivé, possible avant validation (contrôle).

Droits : bulletin.semestre1 | semestre2 | examen_session1 | examen_session2
         .creer pour l'édition officielle, .lire pour l'édition provisoire et l'historique.
"""
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from core.exceptions import Conflit
from core.exports import nom_etablissement, nom_fichier_sur
from core.mixins import VueISPAT
from notes.outils import charger_classe_semestre, seuil_validation
from scolarite.models import Inscription
from scolarite.views import reponse_fichier

from .donnees import (
    blocages_semestre, blocages_session, donnees_bulletin_semestre, donnees_releve, enregistrer_edition, parametre,
    statistiques_classe,
)
from .models import Bulletin
from .pdf import generer_pdf

TOUS_LIRE = ["bulletin.semestre1.lire", "bulletin.semestre2.lire", "bulletin.examen_session1.lire",
             "bulletin.examen_session2.lire"]


def code_droit(type_bulletin, semestre_numero, session, action):
    ressource = f"semestre{semestre_numero}" if type_bulletin == "SEMESTRE" else f"examen_session{session}"
    return f"bulletin.{ressource}.{action}"


def infos_etablissement():
    ville = parametre("ville_etablissement")
    return {"nom": nom_etablissement(), "ville": ville,
            "ligne2": " · ".join(x for x in [ville, "Côte d'Ivoire"] if x), "seuil": seuil_validation()}


class VueEdition(VueISPAT):
    type_bulletin = None
    permissions_requises = {"GET": TOUS_LIRE}

    def get(self, request):
        p = request.query_params
        provisoire = (p.get("provisoire") or "").lower() in ("1", "true", "oui")
        session = None
        if self.type_bulletin == "RELEVE_EXAMEN":
            if p.get("session") not in ("1", "2"):
                raise serializers.ValidationError({"session": "Paramètre ?session=1 ou 2 obligatoire."})
            session = int(p["session"])
        if not p.get("semestre") or not (p.get("inscription") or p.get("classe")):
            raise serializers.ValidationError("Paramètres obligatoires : ?semestre= et ?inscription= ou ?classe=.")

        if p.get("inscription"):
            inscription = get_object_or_404(
                Inscription.objects.select_related("etudiant", "classe__filiere", "classe__niveau", "annee",
                                                   "statut_etudiant"), pk=p["inscription"])
            classe, semestre = charger_classe_semestre(inscription.classe_id, p["semestre"])
            inscriptions = [inscription]
        else:
            classe, semestre = charger_classe_semestre(p["classe"], p["semestre"])
            inscriptions = list(Inscription.objects.filter(classe=classe, etat="VALIDEE")
                                .select_related("etudiant", "classe__filiere", "classe__niveau", "annee",
                                                "statut_etudiant").order_by("etudiant__nom", "etudiant__prenoms"))
        if not inscriptions:
            raise Conflit("Aucun étudiant inscrit (validé) dans cette classe.")
        if any(i.etat not in ("VALIDEE", "ABANDON") for i in inscriptions):
            raise Conflit("Inscription non validée : pas de bulletin.")

        droit = code_droit(self.type_bulletin, semestre.numero, session, "lire" if provisoire else "creer")
        if not request.user.a_permission(droit):
            raise PermissionDenied(f"Droit requis : {droit}.")

        if not provisoire:
            blocages = blocages_semestre(inscriptions, semestre) if self.type_bulletin == "SEMESTRE" \
                else blocages_session(classe, semestre, session, inscriptions)
            if blocages:
                raise Conflit({"detail": "Édition officielle impossible. Utiliser ?provisoire=true pour un contrôle.",
                               "blocages": blocages})

        etab = infos_etablissement()
        stats = statistiques_classe(classe, semestre)
        documents = []
        for ins in inscriptions:
            d = donnees_bulletin_semestre(ins, semestre, stats) if self.type_bulletin == "SEMESTRE" \
                else donnees_releve(ins, semestre, session, stats)
            documents.append((ins, d))

        if provisoire:
            contenu = generer_pdf([(d, None) for _, d in documents], etab, provisoire=True)
        else:
            numerotes = []
            with transaction.atomic():
                for ins, d in documents:
                    trace = enregistrer_edition(ins, semestre, self.type_bulletin, session, request.user)
                    individuel = generer_pdf([(d, trace.numero)], etab, titre=trace.numero)
                    if trace.fichier_chemin and default_storage.exists(trace.fichier_chemin):
                        default_storage.delete(trace.fichier_chemin)
                    trace.fichier_chemin = default_storage.save(
                        f"bulletins/{ins.annee.date_debut:%Y}/{trace.numero}.pdf", ContentFile(individuel))
                    trace.save(update_fields=["fichier_chemin"])
                    numerotes.append((d, trace.numero))
            contenu = generer_pdf(numerotes, etab) if len(numerotes) > 1 else individuel

        if len(inscriptions) == 1:
            e = inscriptions[0].etudiant
            nom = f"{'bulletin' if self.type_bulletin == 'SEMESTRE' else 'releve'}_{e.matricule or e.nom}_S{semestre.numero}"
        else:
            nom = f"{'bulletins' if self.type_bulletin == 'SEMESTRE' else 'releves'}_{classe.libelle}_S{semestre.numero}"
        if session:
            nom += f"_session{session}"
        if provisoire:
            nom += "_PROVISOIRE"
        reponse = HttpResponse(contenu, content_type="application/pdf")
        reponse["Content-Disposition"] = f'inline; filename="{nom_fichier_sur(nom)}.pdf"'
        reponse["X-Nombre-Documents"] = str(len(documents))
        return reponse


class BulletinSemestreView(VueEdition):
    type_bulletin = "SEMESTRE"


class ReleveExamenView(VueEdition):
    type_bulletin = "RELEVE_EXAMEN"


class EditionsView(VueISPAT):
    permissions_requises = {"GET": TOUS_LIRE}

    def get(self, request):
        p = request.query_params
        qs = Bulletin.objects.select_related("inscription__etudiant", "inscription__classe", "semestre", "edite_par")
        if p.get("inscription"):
            qs = qs.filter(inscription_id=p["inscription"])
        if p.get("classe"):
            qs = qs.filter(inscription__classe_id=p["classe"])
        if p.get("semestre"):
            qs = qs.filter(semestre_id=p["semestre"])
        if p.get("type"):
            qs = qs.filter(type_bulletin=p["type"].upper())
        if p.get("session"):
            qs = qs.filter(session=p["session"])
        return Response([{
            "id": b.pk, "numero": b.numero, "type_bulletin": b.type_bulletin, "session": b.session,
            "semestre": b.semestre.numero if b.semestre_id else None, "inscription_id": b.inscription_id,
            "matricule": b.inscription.etudiant.matricule,
            "etudiant": f"{b.inscription.etudiant.nom} {b.inscription.etudiant.prenoms}",
            "classe": b.inscription.classe.libelle, "date_edition": b.date_edition,
            "edite_par": b.edite_par.nom_complet if b.edite_par_id else None,
            "fichier_url": f"/api/bulletins/editions/{b.pk}/fichier/" if b.fichier_chemin else None,
        } for b in qs[:500]])


class EditionFichierView(VueISPAT):
    permissions_requises = {"GET": TOUS_LIRE}

    def get(self, request, pk):
        b = get_object_or_404(Bulletin, pk=pk)
        return reponse_fichier(b.fichier_chemin, f"{b.numero}.pdf", "application/pdf")

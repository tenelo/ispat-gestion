"""
API comptabilité — /api/comptabilite/...

  frais/                         frais dus par inscription (scolarité + frais annexes), remises motivées
  frais/affecter-classe/         affecter un frais annexe à toute une classe
  prises-en-charge/              État, entreprise, ONG, bourse... (montant ou taux)
  versements/                    encaissements (création + consultation ; jamais modifiés)
  versements/{id}/annuler/       {"motif"} — l'écriture de caisse liée est annulée par trigger
  versements/{id}/recu/          reçu PDF (2 exemplaires)
  mouvements/                    entrées / sorties de caisse manuelles (+ écritures auto des versements)
  mouvements/{id}/annuler/       {"motif"}
  mouvements/{id}/justificatif/  GET fichier / POST multipart « justificatif »
Exports : ?export=xlsx | csv sur versements/ et mouvements/.
"""
from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from core.exceptions import Conflit
from core.exports import FORMATS_EXPORT, reponse_export
from core.filtres import FiltreSimpleMixin, filtre_annee, filtre_booleen
from core.mixins import ViewSetISPAT, definir_contexte_base
from core.permissions import permissions_crud
from referentiels.models import Classe, TypeFrais
from scolarite.fichiers import enregistrer_piece
from scolarite.models import Inscription
from scolarite.views import motif_obligatoire, reponse_fichier

from .calculs import situation_inscription, tarif_applicable
from .models import FraisInscription, MouvementCaisse, PriseEnCharge, Versement
from .recu import generer_recu_pdf
from .serializers import (
    AffectationClasseSerializer, FraisInscriptionSerializer, MouvementCaisseSerializer, PriseEnChargeSerializer,
    VersementSerializer,
)


def filtre_date(lookup):
    return lambda qs, valeur: qs.filter(**{lookup: valeur})


class ExportListeMixin:
    """?export=xlsx|csv sur la liste filtrée (sans pagination), avec contrôle du droit d'export."""

    permission_export = None
    titre_export = "Export"

    def colonnes_export(self):
        raise NotImplementedError

    def list(self, request, *args, **kwargs):
        fmt = (request.query_params.get("export") or "").lower()
        if not fmt:
            return super().list(request, *args, **kwargs)
        if fmt not in FORMATS_EXPORT:
            raise serializers.ValidationError({"export": "Formats possibles : xlsx, csv."})
        codes = self.permission_export if isinstance(self.permission_export, (list, tuple)) else [self.permission_export]
        if not any(request.user.a_permission(c) for c in codes):
            raise PermissionDenied("Vous n'avez pas la permission d'exporter.")
        entetes, extraire = self.colonnes_export()
        lignes = [extraire(o) for o in self.filter_queryset(self.get_queryset())]
        p = request.query_params
        periode = " · ".join(x for x in [f"du {p['du']}" if p.get("du") else "", f"au {p['au']}" if p.get("au") else ""] if x)
        return reponse_export(fmt, self.titre_export, periode, entetes, lignes, self.titre_export)


# --------------------------------------------------------------------------------------
# Frais dus
# --------------------------------------------------------------------------------------

class FraisInscriptionViewSet(FiltreSimpleMixin, ViewSetISPAT):
    queryset = FraisInscription.objects.select_related("inscription__etudiant", "inscription__classe", "type_frais")
    serializer_class = FraisInscriptionSerializer
    filtres = {"inscription": "inscription_id", "type_frais": "type_frais_id", "categorie": "type_frais__categorie",
               "classe": "inscription__classe_id", "annee": filtre_annee("inscription__annee")}
    champs_recherche = ("inscription__etudiant__nom__unaccent", "inscription__etudiant__prenoms__unaccent",
                        "inscription__etudiant__matricule")
    permissions_requises = permissions_crud(
        "comptabilite.frais_annexe",
        list=["comptabilite.frais_annexe.lire", "comptabilite.situation.lire"],
        retrieve=["comptabilite.frais_annexe.lire", "comptabilite.situation.lire"],
        affecter_classe="comptabilite.frais_annexe.creer",
    )

    def perform_destroy(self, instance):
        if Versement.objects.filter(inscription_id=instance.inscription_id, type_frais_id=instance.type_frais_id,
                                    annule=False).exists():
            raise Conflit("Des versements sont imputés sur ces frais : les annuler d'abord.")
        situation = situation_inscription(instance.inscription_id)
        if situation["total_du"] - instance.montant_du < situation["verse_total"]:
            raise Conflit("Suppression impossible : le total dû deviendrait inférieur au total déjà versé.")
        super().perform_destroy(instance)

    @action(detail=False, methods=["post"], url_path="affecter-classe")
    def affecter_classe(self, request):
        saisie = AffectationClasseSerializer(data=request.data)
        saisie.is_valid(raise_exception=True)
        d = saisie.validated_data
        classe = get_object_or_404(Classe, pk=d["classe"])
        type_frais = get_object_or_404(TypeFrais, pk=d["type_frais"])
        crees, deja, sans_tarif = 0, 0, []
        with transaction.atomic():
            for inscription in Inscription.objects.filter(classe=classe, etat="VALIDEE").select_related("etudiant"):
                if FraisInscription.objects.filter(inscription=inscription, type_frais=type_frais).exists():
                    deja += 1
                    continue
                montant = d.get("montant")
                if montant is None:
                    montant = tarif_applicable(inscription, type_frais.pk)
                if montant is None:
                    sans_tarif.append(inscription.etudiant.matricule)
                    continue
                FraisInscription.objects.create(inscription=inscription, type_frais=type_frais, montant=montant,
                                                date_echeance=d.get("date_echeance"))
                crees += 1
        return Response({"classe": classe.libelle, "frais": type_frais.libelle, "crees": crees, "deja_affectes": deja,
                         "sans_tarif": sans_tarif})


# --------------------------------------------------------------------------------------
# Prises en charge
# --------------------------------------------------------------------------------------

class PriseEnChargeViewSet(FiltreSimpleMixin, ViewSetISPAT):
    queryset = PriseEnCharge.objects.select_related("inscription__etudiant", "type_frais")
    serializer_class = PriseEnChargeSerializer
    filtres = {"inscription": "inscription_id", "type_payeur": "type_payeur", "statut": "statut",
               "classe": "inscription__classe_id", "annee": filtre_annee("inscription__annee")}
    champs_recherche = ("organisme__unaccent", "inscription__etudiant__nom__unaccent", "inscription__etudiant__matricule")
    permissions_requises = permissions_crud("comptabilite.prise_en_charge")

    def perform_destroy(self, instance):
        if instance.versements.filter(annule=False).exists():
            raise Conflit("Des versements de cet organisme existent : les annuler d'abord.")
        super().perform_destroy(instance)


# --------------------------------------------------------------------------------------
# Versements
# --------------------------------------------------------------------------------------

class VersementViewSet(ExportListeMixin, FiltreSimpleMixin, ViewSetISPAT):
    queryset = Versement.objects.select_related("inscription__etudiant", "inscription__classe", "inscription__annee",
                                                "type_frais", "prise_en_charge", "encaisse_par")
    serializer_class = VersementSerializer
    http_method_names = ["get", "post", "head", "options"]
    filtres = {
        "inscription": "inscription_id",
        "etudiant": "inscription__etudiant_id",
        "classe": "inscription__classe_id",
        "annee": filtre_annee("inscription__annee"),
        "mode": "mode_paiement",
        "payeur": "payeur",
        "type_frais": "type_frais_id",
        "encaisse_par": "encaisse_par_id",
        "annule": filtre_booleen("annule"),
        "numero": "numero_recu__iexact",
        "du": filtre_date("date_versement__gte"),
        "au": filtre_date("date_versement__lte"),
    }
    champs_recherche = ("numero_recu", "reference", "inscription__etudiant__nom__unaccent",
                        "inscription__etudiant__prenoms__unaccent", "inscription__etudiant__matricule")
    permissions_requises = {
        "list": "comptabilite.versement.lire",
        "retrieve": "comptabilite.versement.lire",
        "recu": "comptabilite.versement.lire",
        "create": "comptabilite.versement.creer",
        "annuler": "comptabilite.versement.supprimer",
    }
    permission_export = "comptabilite.versement.exporter"
    titre_export = "Journal des versements"

    def colonnes_export(self):
        entetes = ["Date", "N° reçu", "Matricule", "Nom et prénoms", "Classe", "Objet", "Payeur", "Mode",
                   "Référence", "Montant", "Annulé", "Encaissé par"]

        def extraire(v):
            e = v.inscription.etudiant
            return [v.date_versement, v.numero_recu, e.matricule, f"{e.nom} {e.prenoms}", v.inscription.classe.libelle,
                    v.type_frais.libelle if v.type_frais_id else "Global",
                    v.prise_en_charge.organisme if v.prise_en_charge_id else "Étudiant",
                    v.get_mode_paiement_display(), v.reference, v.montant, "Oui" if v.annule else "",
                    v.encaisse_par.nom_complet if v.encaisse_par_id else ""]
        return entetes, extraire

    def perform_create(self, serializer):
        serializer.save(encaisse_par=self.request.user).refresh_from_db()

    def create(self, request, *args, **kwargs):
        reponse = super().create(request, *args, **kwargs)
        s = situation_inscription(reponse.data["inscription"])
        reponse.data["situation"] = {k: s[k] for k in ("total_du", "part_prise_en_charge", "verse_total",
                                                       "reste_etudiant", "reste_prise_en_charge")}
        return reponse

    @action(detail=True, methods=["post"])
    def annuler(self, request, pk=None):
        versement = self.get_object()
        if versement.annule:
            raise Conflit("Versement déjà annulé.")
        motif = motif_obligatoire(request)
        definir_contexte_base(motif=motif)          # motif tracé dans journal_audit
        versement.annule = True
        versement.motif_annulation = motif
        versement.save(update_fields=["annule", "motif_annulation"])
        versement.refresh_from_db()
        return Response(VersementSerializer(versement, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["get"])
    def recu(self, request, pk=None):
        versement = self.get_object()
        reponse = HttpResponse(generer_recu_pdf(versement), content_type="application/pdf")
        reponse["Content-Disposition"] = f'inline; filename="{versement.numero_recu}.pdf"'
        return reponse


# --------------------------------------------------------------------------------------
# Mouvements de caisse
# --------------------------------------------------------------------------------------

def _code_sens(sens, action_droit):
    return f"comptabilite.{'entree' if sens == 'ENTREE' else 'sortie'}.{action_droit}"


class MouvementCaisseViewSet(ExportListeMixin, FiltreSimpleMixin, ViewSetISPAT):
    queryset = MouvementCaisse.objects.select_related("categorie", "saisi_par", "versement")
    serializer_class = MouvementCaisseSerializer
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    http_method_names = ["get", "post", "put", "patch", "head", "options"]
    filtres = {
        "sens": "sens",
        "categorie": "categorie_id",
        "mode": "mode_paiement",
        "annule": filtre_booleen("annule"),
        "manuel": filtre_booleen("versement__isnull"),          # ?manuel=true -> saisies manuelles seulement
        "du": filtre_date("date_mouvement__gte"),
        "au": filtre_date("date_mouvement__lte"),
    }
    champs_recherche = ("libelle__unaccent", "tiers__unaccent", "reference")
    LIRE = ["comptabilite.entree.lire", "comptabilite.sortie.lire"]
    permissions_requises = {
        "list": LIRE,
        "retrieve": LIRE,
        "justificatif": LIRE,
        "create": ["comptabilite.entree.creer", "comptabilite.sortie.creer"],
        "update": ["comptabilite.entree.modifier", "comptabilite.sortie.modifier"],
        "partial_update": ["comptabilite.entree.modifier", "comptabilite.sortie.modifier"],
        "envoyer_justificatif": ["comptabilite.entree.modifier", "comptabilite.sortie.modifier"],
        "annuler": ["comptabilite.entree.supprimer", "comptabilite.sortie.supprimer"],
    }
    permission_export = ["comptabilite.entree.exporter", "comptabilite.sortie.exporter"]
    titre_export = "Mouvements de caisse"

    def get_queryset(self):
        qs = super().get_queryset()
        u = self.request.user
        if not u.a_permission("comptabilite.entree.lire"):
            qs = qs.exclude(sens="ENTREE")
        if not u.a_permission("comptabilite.sortie.lire"):
            qs = qs.exclude(sens="SORTIE")
        return qs

    def colonnes_export(self):
        entetes = ["Date", "Sens", "Catégorie", "Libellé", "Tiers", "Mode", "Référence", "Montant", "Annulé"]

        def extraire(m):
            return [m.date_mouvement, m.get_sens_display(), m.categorie.libelle, m.libelle, m.tiers,
                    m.get_mode_paiement_display(), m.reference, m.montant, "Oui" if m.annule else ""]
        return entetes, extraire

    def _exiger(self, sens, action_droit):
        if not self.request.user.a_permission(_code_sens(sens, action_droit)):
            raise PermissionDenied(f"Droit requis : {_code_sens(sens, action_droit)}.")

    def perform_create(self, serializer):
        self._exiger(serializer.validated_data["sens"], "creer")
        serializer.save(saisi_par=self.request.user).refresh_from_db()

    def perform_update(self, serializer):
        self._exiger(serializer.instance.sens, "modifier")
        super().perform_update(serializer)

    @action(detail=True, methods=["post"])
    def annuler(self, request, pk=None):
        mouvement = self.get_object()
        self._exiger(mouvement.sens, "supprimer")
        if mouvement.versement_id:
            raise Conflit("Écriture générée par un versement : annuler le versement.")
        if mouvement.annule:
            raise Conflit("Écriture déjà annulée.")
        motif = motif_obligatoire(request)
        definir_contexte_base(motif=motif)
        mouvement.annule = True
        mouvement.save(update_fields=["annule"])
        mouvement.refresh_from_db()
        return Response(MouvementCaisseSerializer(mouvement, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["get"])
    def justificatif(self, request, pk=None):
        mouvement = self.get_object()
        return reponse_fichier(mouvement.justificatif_chemin)

    @justificatif.mapping.post
    def envoyer_justificatif(self, request, pk=None):
        mouvement = self.get_object()
        self._exiger(mouvement.sens, "modifier")
        fichier = request.FILES.get("justificatif")
        if fichier is None:
            raise serializers.ValidationError({"justificatif": "Fichier « justificatif » manquant (multipart)."})
        mouvement.justificatif_chemin = enregistrer_piece(fichier, dossier="justificatifs")[0]
        mouvement.save(update_fields=["justificatif_chemin"])
        mouvement.refresh_from_db()
        return Response(MouvementCaisseSerializer(mouvement, context=self.get_serializer_context()).data,
                        status=status.HTTP_200_OK)

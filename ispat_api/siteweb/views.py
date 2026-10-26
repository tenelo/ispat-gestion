"""
Réception des pré-inscriptions du site WordPress — /api/wp/...   (authentification : signature HMAC)

  GET  options/                                         listes du formulaire (filières, niveaux, villes, pièces)
  POST preinscriptions/                                 JSON ; idempotent par « wp_entry_id »
  PUT  preinscriptions/{wp_entry_id}/pieces/{TYPE}/     corps = fichier brut (PDF, JPEG, PNG ≤ 5 Mo)
                                                        en-tête X-Nom-Fichier (encodé URL)

Règles :
  * année visée : l'année académique la plus récente (les pré-inscriptions précèdent la rentrée) ;
  * filière par son code (ATPV, IDA…), niveau par son code (BT1, BTS1…) ; ville et école en texte libre
    (retrouvées sans tenir compte des accents ni de la casse, sinon créées) ;
  * renvoi du même wp_entry_id : mise à jour si la pré-inscription est encore en attente, sinon inchangée ;
  * rapprochement automatique avec le prospect de même téléphone (gestion commerciale).
"""
import re
import unicodedata
from urllib.parse import unquote

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.response import Response

from commercial.models import Preinscription
from commercial.serializers import PreinscriptionSerializer
from commercial.services import marquer_preinscrit, rapprocher_prospect
from core.exceptions import Conflit
from core.mixins import VueISPAT
from referentiels.models import AnneeAcademique, Filiere, Niveau, TypePiece, Ville
from scolarite.fichiers import enregistrer_piece
from scolarite.models import PieceJointe

from .signature import SignatureWordPress

MOTIF_ENTREE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def annee_cible():
    annee = AnneeAcademique.objects.order_by("-date_debut").first()
    if annee is None:
        raise Conflit("Aucune année académique n'est créée dans l'application de gestion.")
    return annee


def _cle(texte):
    """« Ferkessédougou », « FERKESSEDOUGOU », « ferkessé-dougou » -> même clé."""
    sans_accents = unicodedata.normalize("NFKD", texte).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", sans_accents.lower())


def resoudre_ville(nom):
    nom = " ".join((nom or "").split())
    if not nom:
        return None
    cle = _cle(nom)
    for v in Ville.objects.all():
        if _cle(v.libelle) == cle:
            return v
    return Ville.objects.create(libelle=nom[:1].upper() + nom[1:])


class VueSite(VueISPAT):
    authentication_classes = []
    permission_classes = [SignatureWordPress]
    permission_libre = True


class OptionsView(VueSite):
    def get(self, request):
        annee = AnneeAcademique.objects.order_by("-date_debut").first()
        return Response({
            "annee": annee.libelle if annee else None,
            "filieres": [{"code": f.code, "libelle": f.libelle} for f in Filiere.objects.filter(active=True)
                         .order_by("code")],
            "niveaux": [{"code": n.code, "libelle": n.libelle} for n in Niveau.objects.order_by("ordre")],
            "villes": [v.libelle for v in Ville.objects.order_by("libelle")],
            "pieces": [{"code": t.code, "libelle": t.libelle, "obligatoire": t.obligatoire}
                       for t in TypePiece.objects.exclude(code="AUTRE").order_by("-obligatoire", "libelle")],
            "taille_max_piece": settings.ISPAT_PIECE_TAILLE_MAX,
        })


class SaisieSite(serializers.Serializer):
    wp_entry_id = serializers.RegexField(MOTIF_ENTREE)
    nom = serializers.CharField(max_length=100)
    prenoms = serializers.CharField(max_length=150)
    sexe = serializers.ChoiceField(choices=["M", "F"])
    date_naissance = serializers.DateField(required=False, allow_null=True)
    lieu_naissance = serializers.CharField(max_length=100, required=False, allow_blank=True, allow_null=True)
    telephone = serializers.CharField(max_length=30)
    email = serializers.CharField(max_length=150, required=False, allow_blank=True, allow_null=True)
    ville = serializers.CharField(max_length=100, required=False, allow_blank=True, allow_null=True)
    ecole = serializers.CharField(max_length=150, required=False, allow_blank=True, allow_null=True)
    serie_bac = serializers.CharField(max_length=20, required=False, allow_blank=True, allow_null=True)
    filiere_code = serializers.CharField(max_length=10, required=False, allow_blank=True, allow_null=True)
    niveau_code = serializers.CharField(max_length=10, required=False, allow_blank=True, allow_null=True)
    message = serializers.CharField(max_length=2000, required=False, allow_blank=True, allow_null=True)


class PreinscriptionSiteView(VueSite):
    def post(self, request):
        saisie = SaisieSite(data=request.data)
        saisie.is_valid(raise_exception=True)
        d = saisie.validated_data
        annee = annee_cible()
        filiere = Filiere.objects.filter(code__iexact=(d.get("filiere_code") or "").strip(), active=True).first()
        niveau = Niveau.objects.filter(code__iexact=(d.get("niveau_code") or "").strip()).first()
        ville = resoudre_ville(d.get("ville"))
        donnees = {
            "annee": annee.pk, "nom": d["nom"], "prenoms": d["prenoms"], "sexe": d["sexe"],
            "date_naissance": d.get("date_naissance"), "lieu_naissance": (d.get("lieu_naissance") or "").strip() or None,
            "telephone": d["telephone"], "email": (d.get("email") or "").strip() or None,
            "ville": ville.pk if ville else None, "ecole_nom": d.get("ecole") or "",
            "serie_bac": d.get("serie_bac"), "filiere_souhaitee": filiere.pk if filiere else None,
            "niveau_souhaite": niveau.pk if niveau else None, "source": "SITE_WEB",
        }
        brutes = {k: (str(v) if v is not None else None) for k, v in request.data.items()}

        existante = Preinscription.tous.filter(wp_entry_id=d["wp_entry_id"]).first()
        with transaction.atomic():
            if existante is not None:
                if existante.statut != "EN_ATTENTE" or existante.deleted_at is not None:
                    return Response(self.reponse(existante, cree=False, modifiee=False))
                s = PreinscriptionSerializer(existante, data=donnees, partial=True)
                s.is_valid(raise_exception=True)
                pre = s.save(donnees_brutes=brutes)
                cree = False
            else:
                s = PreinscriptionSerializer(data=donnees)
                s.is_valid(raise_exception=True)
                pre = s.save(wp_entry_id=d["wp_entry_id"], donnees_brutes=brutes)
                cree = True
            rapproche = None
            if pre.prospect_id:
                marquer_preinscrit(pre.prospect)
            else:
                rapproche = rapprocher_prospect(pre)
        pre.refresh_from_db()
        corps = self.reponse(pre, cree=cree, modifiee=not cree)
        corps["prospect_rapproche"] = bool(rapproche)
        corps["filiere_reconnue"] = filiere is not None or not d.get("filiere_code")
        return Response(corps, status=status.HTTP_201_CREATED if cree else status.HTTP_200_OK)

    @staticmethod
    def reponse(pre, cree, modifiee):
        return {"id": pre.pk, "wp_entry_id": pre.wp_entry_id, "statut": pre.statut, "cree": cree,
                "modifiee": modifiee, "annee": pre.annee.libelle}


class PieceSiteView(VueSite):
    def put(self, request, wp_entry_id, type_code):
        if not MOTIF_ENTREE.match(wp_entry_id):
            raise serializers.ValidationError({"wp_entry_id": "Identifiant invalide."})
        pre = get_object_or_404(Preinscription, wp_entry_id=wp_entry_id)
        if pre.statut == "REJETEE":
            raise Conflit("Pré-inscription rejetée : pièce non enregistrée.")
        type_piece = get_object_or_404(TypePiece, code__iexact=type_code)
        corps = request.body
        if not corps:
            raise serializers.ValidationError({"fichier": "Corps de requête vide."})
        nom = unquote(request.headers.get("X-Nom-Fichier", "") or f"{type_piece.code.lower()}")[:200]
        chemin, mime, taille, nom_origine = enregistrer_piece(ContentFile(corps, name=nom))

        with transaction.atomic():
            for ancienne in PieceJointe.objects.filter(preinscription_id=pre.pk, type_piece=type_piece):
                if default_storage.exists(ancienne.chemin):
                    default_storage.delete(ancienne.chemin)
                ancienne.supprimer()                      # renvoi d'une pièce : la dernière version remplace
            piece = PieceJointe.objects.create(
                type_piece=type_piece, preinscription_id=pre.pk, nom_fichier=nom_origine, chemin=chemin,
                mime_type=mime, taille_octets=taille, inscription_id=pre.inscription_id,
                etudiant_id=pre.inscription.etudiant_id if pre.inscription_id else None)
        return Response({"id": piece.pk, "type": type_piece.code, "taille": taille, "mime": mime},
                        status=status.HTTP_201_CREATED)

"""
API scolarité — /api/scolarite/...

  etudiants/                         CRUD, ?q= (nom, prénoms, matricule), ?sexe=, ?ville=
  etudiants/recherche/?q=            recherche rapide (matricule exact > partiel > nom approchant)
  etudiants/matricule/{matricule}/   dossier complet par matricule
  etudiants/{id}/dossier/            étudiant + contacts + inscriptions + pièces + pièces manquantes
  etudiants/{id}/photo/              GET (image) / POST multipart « photo » / DELETE
  contacts/                          parents, tuteurs, personnes à prévenir
  inscriptions/                      CRUD, filtres annee / classe / etat / statut / etudiant / type, ?q=
  inscriptions/nouvelle/             étudiant + contacts + inscription en un appel
  inscriptions/{id}/valider/         -> matricule + frais (triggers PostgreSQL)  {"forcer": true} si pièces manquantes
  inscriptions/{id}/annuler/         {"motif": "..."}  (refusé s'il existe des versements)
  inscriptions/{id}/abandon/         {"motif": "..."}  (étudiant validé qui quitte l'établissement)
  inscriptions/{id}/pieces-manquantes/
  pieces/                            multipart : fichier, type_piece, etudiant et/ou inscription
  pieces/{id}/fichier/               téléchargement
  pieces/{id}/verifier/              pièce contrôlée par la scolarité
"""
from django.core.files.storage import default_storage
from django.db import connection, transaction
from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from core.exceptions import Conflit
from core.filtres import FiltreSimpleMixin, filtre_annee
from core.mixins import ViewSetISPAT
from core.permissions import permissions_crud
from referentiels.models import TypePiece

from .fichiers import enregistrer_photo
from .models import ContactEtudiant, Etudiant, Inscription, PieceJointe
from .serializers import (
    ContactEtudiantSerializer, EtudiantSerializer, InscriptionSerializer, NouvelleInscriptionSerializer,
    PieceJointeSerializer,
)

LECTURE_ETUDIANT = ["scolarite.inscription.lire", "scolarite.liste_classe.lire", "comptabilite.versement.lire"]
VRAI = (True, "true", "1", 1, "oui")


# --------------------------------------------------------------------------------------
# Outils
# --------------------------------------------------------------------------------------

def pieces_manquantes(etudiant):
    presentes = set(PieceJointe.objects.filter(etudiant=etudiant).values_list("type_piece__code", flat=True))
    if etudiant.photo_chemin:
        presentes.add("PHOTO")
    return [{"code": t.code, "libelle": t.libelle}
            for t in TypePiece.objects.filter(obligatoire=True) if t.code not in presentes]


def construire_dossier(etudiant, contexte):
    etudiant.refresh_from_db()
    inscriptions = etudiant.inscriptions.select_related("annee", "classe", "statut_etudiant", "valide_par")
    return {
        "etudiant": EtudiantSerializer(etudiant, context=contexte).data,
        "contacts": ContactEtudiantSerializer(etudiant.contacts.all(), many=True, context=contexte).data,
        "inscriptions": InscriptionSerializer(inscriptions, many=True, context=contexte).data,
        "pieces": PieceJointeSerializer(etudiant.pieces.select_related("type_piece"), many=True, context=contexte).data,
        "pieces_manquantes": pieces_manquantes(etudiant),
    }


def reponse_fichier(chemin, nom=None, type_mime=None):
    if not chemin or not default_storage.exists(chemin):
        raise Http404("Fichier introuvable.")
    reponse = FileResponse(default_storage.open(chemin, "rb"), content_type=type_mime, filename=nom)
    reponse["Cache-Control"] = "private, max-age=3600"
    return reponse


def motif_obligatoire(request):
    motif = (request.data.get("motif") or "").strip()
    if len(motif) < 3:
        raise serializers.ValidationError({"motif": "Motif obligatoire."})
    return motif


# --------------------------------------------------------------------------------------
# Étudiants
# --------------------------------------------------------------------------------------

class EtudiantViewSet(FiltreSimpleMixin, ViewSetISPAT):
    queryset = Etudiant.objects.select_related("ville", "ecole_origine")
    serializer_class = EtudiantSerializer
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    filtres = {"sexe": "sexe", "ville": "ville_id", "ecole": "ecole_origine_id"}
    champs_recherche = ("nom__unaccent", "prenoms__unaccent", "matricule", "telephone")
    permissions_requises = permissions_crud(
        "scolarite.inscription",
        list=LECTURE_ETUDIANT,
        retrieve=LECTURE_ETUDIANT,
        recherche=LECTURE_ETUDIANT,
        photo=LECTURE_ETUDIANT,
        par_matricule="scolarite.inscription.lire",
        dossier="scolarite.inscription.lire",
        envoyer_photo="scolarite.inscription.modifier",
        supprimer_photo="scolarite.inscription.modifier",
    )

    def perform_destroy(self, instance):
        if instance.inscriptions.exists():
            raise Conflit("Suppression impossible : l'étudiant a des inscriptions (annuler l'inscription à la place).")
        for contact in instance.contacts.all():
            contact.supprimer()
        for piece in instance.pieces.all():
            piece.supprimer()
        instance.supprimer()

    @action(detail=False, methods=["get"])
    def recherche(self, request):
        q = (request.query_params.get("q") or "").strip()
        if len(q) < 2:
            raise serializers.ValidationError({"q": "Saisir au moins 2 caractères."})
        limite = min(int(request.query_params.get("limite", 20) or 20), 50)
        with connection.cursor() as curseur:
            curseur.execute(
                """
                SELECT r.id, r.matricule, r.nom, r.prenoms, r.sexe, r.photo_chemin, r.score, e.version,
                       vi.inscription_id, vi.classe, vi.etat
                  FROM ispat.rechercher_etudiant(%s, %s) r
                  JOIN ispat.etudiant e ON e.id = r.id
                  LEFT JOIN ispat.v_etudiant_inscrit vi
                         ON vi.etudiant_id = r.id AND vi.etat <> 'ANNULEE'
                        AND vi.annee_id = (SELECT id FROM ispat.annee_academique
                                            WHERE est_active AND deleted_at IS NULL)
                 ORDER BY r.score DESC, r.nom, r.prenoms
                """,
                [q, limite],
            )
            colonnes = [c[0] for c in curseur.description]
            lignes = [dict(zip(colonnes, ligne)) for ligne in curseur.fetchall()]
        for ligne in lignes:
            chemin, version = ligne.pop("photo_chemin"), ligne.pop("version")
            ligne["photo_url"] = (reverse("etudiant-photo", kwargs={"pk": ligne["id"]}) + f"?v={version}") if chemin else None
            ligne["score"] = round(float(ligne["score"]), 2)
        return Response(lignes)

    @action(detail=False, methods=["get"], url_path=r"matricule/(?P<matricule>[^/]+)")
    def par_matricule(self, request, matricule=None):
        etudiant = Etudiant.objects.filter(matricule__iexact=matricule.strip()).first()
        if etudiant is None:
            raise Http404("Aucun étudiant avec ce matricule.")
        return Response(construire_dossier(etudiant, self.get_serializer_context()))

    @action(detail=True, methods=["get"])
    def dossier(self, request, pk=None):
        return Response(construire_dossier(self.get_object(), self.get_serializer_context()))

    @action(detail=True, methods=["get"])
    def photo(self, request, pk=None):
        etudiant = self.get_object()
        return reponse_fichier(etudiant.photo_chemin, f"{etudiant.matricule or etudiant.pk}.jpg", "image/jpeg")

    @photo.mapping.post
    def envoyer_photo(self, request, pk=None):
        etudiant = self.get_object()
        fichier = request.FILES.get("photo")
        if fichier is None:
            raise serializers.ValidationError({"photo": "Fichier « photo » manquant (multipart/form-data)."})
        etudiant.photo_chemin = enregistrer_photo(fichier, etudiant.pk, etudiant.photo_chemin)
        etudiant.save(update_fields=["photo_chemin"])
        etudiant.refresh_from_db()
        return Response(EtudiantSerializer(etudiant, context=self.get_serializer_context()).data)

    @photo.mapping.delete
    def supprimer_photo(self, request, pk=None):
        etudiant = self.get_object()
        if etudiant.photo_chemin and default_storage.exists(etudiant.photo_chemin):
            default_storage.delete(etudiant.photo_chemin)
        etudiant.photo_chemin = None
        etudiant.save(update_fields=["photo_chemin"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class ContactEtudiantViewSet(FiltreSimpleMixin, ViewSetISPAT):
    queryset = ContactEtudiant.objects.select_related("etudiant")
    serializer_class = ContactEtudiantSerializer
    pagination_class = None
    filtres = {"etudiant": "etudiant_id"}
    permissions_requises = permissions_crud("scolarite.inscription")

    def list(self, request, *args, **kwargs):
        if not request.query_params.get("etudiant"):
            raise serializers.ValidationError({"etudiant": "Filtre ?etudiant=<id> obligatoire."})
        return super().list(request, *args, **kwargs)


# --------------------------------------------------------------------------------------
# Inscriptions
# --------------------------------------------------------------------------------------

class InscriptionViewSet(FiltreSimpleMixin, ViewSetISPAT):
    queryset = Inscription.objects.select_related("etudiant", "annee", "classe", "statut_etudiant", "valide_par")
    serializer_class = InscriptionSerializer
    filtres = {
        "annee": filtre_annee(),
        "classe": "classe_id",
        "etat": "etat",
        "etudiant": "etudiant_id",
        "statut": "statut_etudiant_id",
        "type": "type_inscription",
        "source": "source",
    }
    champs_recherche = ("etudiant__nom__unaccent", "etudiant__prenoms__unaccent", "etudiant__matricule")
    permissions_requises = permissions_crud(
        "scolarite.inscription",
        nouvelle="scolarite.inscription.creer",
        valider="scolarite.inscription.valider",
        annuler="scolarite.inscription.valider",
        abandon="scolarite.inscription.valider",
        pieces_manquantes="scolarite.inscription.lire",
    )

    def perform_destroy(self, instance):
        if instance.etat != "EN_ATTENTE":
            raise Conflit("Seule une inscription en attente peut être supprimée (sinon : annuler ou abandon).")
        super().perform_destroy(instance)

    @action(detail=False, methods=["post"])
    def nouvelle(self, request):
        saisie = NouvelleInscriptionSerializer(data=request.data)
        saisie.is_valid(raise_exception=True)
        d = saisie.validated_data
        contexte = self.get_serializer_context()

        with transaction.atomic():
            if d.get("etudiant_id"):
                etudiant = get_object_or_404(Etudiant, pk=d["etudiant_id"])
                nouveau = False
            else:
                s_etudiant = EtudiantSerializer(data=d["etudiant"], context=contexte)
                if not s_etudiant.is_valid():
                    raise serializers.ValidationError({"etudiant": s_etudiant.errors})
                etudiant = s_etudiant.save()
                nouveau = True

            for rang, contact in enumerate(d.get("contacts") or []):
                s_contact = ContactEtudiantSerializer(data=contact, context={**contexte, "etudiant_fourni": True})
                if not s_contact.is_valid():
                    raise serializers.ValidationError({"contacts": {rang: s_contact.errors}})
                s_contact.save(etudiant=etudiant)

            donnees = {
                "etudiant": etudiant.pk,
                "classe": d["classe"],
                "statut_etudiant": d["statut_etudiant"],
                "type_inscription": d.get("type_inscription") or ("NOUVELLE" if nouveau else "REINSCRIPTION"),
                "source": d.get("source") or "GUICHET",
                "prospect_id": d.get("prospect_id"),
                "observations": d.get("observations"),
            }
            if d.get("id"):
                donnees["id"] = d["id"]
            if d.get("date_inscription"):
                donnees["date_inscription"] = d["date_inscription"]
            s_inscription = InscriptionSerializer(data=donnees, context=contexte)
            if not s_inscription.is_valid():
                raise serializers.ValidationError({"inscription": s_inscription.errors})
            inscription = s_inscription.save()

        resultat = construire_dossier(etudiant, contexte)
        resultat["inscription_id"] = inscription.pk
        return Response(resultat, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"], url_path="pieces-manquantes")
    def pieces_manquantes(self, request, pk=None):
        return Response(pieces_manquantes(self.get_object().etudiant))

    @action(detail=True, methods=["post"])
    def valider(self, request, pk=None):
        inscription = self.get_object()
        if inscription.etat != "EN_ATTENTE":
            raise Conflit(f"Inscription déjà {inscription.get_etat_display().lower()}.")

        manquantes = pieces_manquantes(inscription.etudiant)
        if manquantes and request.data.get("forcer") not in VRAI:
            raise Conflit({"detail": "Pièces obligatoires manquantes. Renvoyer avec {\"forcer\": true} pour valider quand même.",
                           "pieces_manquantes": manquantes})

        classe = inscription.classe
        if classe.capacite:
            effectif = Inscription.objects.filter(classe=classe, etat="VALIDEE").count()
            if effectif >= classe.capacite:
                raise Conflit(f"Classe complète ({effectif}/{classe.capacite}).")

        inscription.etat = "VALIDEE"
        inscription.valide_par = request.user
        inscription.valide_le = timezone.now()
        inscription.save(update_fields=["etat", "valide_par", "valide_le"])   # trigger : matricule + frais

        inscription.refresh_from_db()
        inscription.etudiant.refresh_from_db()
        with connection.cursor() as curseur:
            curseur.execute("SELECT count(*), coalesce(sum(montant - remise), 0) FROM ispat.frais_inscription "
                            "WHERE inscription_id = %s AND deleted_at IS NULL", [inscription.pk])
            nb_frais, total_du = curseur.fetchone()
        return Response({
            "inscription": InscriptionSerializer(inscription, context=self.get_serializer_context()).data,
            "matricule": inscription.etudiant.matricule,
            "frais_generes": nb_frais,
            "total_du": total_du,
            "pieces_manquantes": manquantes,
        })

    @action(detail=True, methods=["post"])
    def annuler(self, request, pk=None):
        inscription = self.get_object()
        motif = motif_obligatoire(request)
        if inscription.etat in ("ANNULEE", "ABANDON"):
            raise Conflit("Inscription déjà annulée ou abandonnée.")
        with connection.cursor() as curseur:
            curseur.execute("SELECT count(*) FROM ispat.versement WHERE inscription_id = %s "
                            "AND deleted_at IS NULL AND NOT annule", [inscription.pk])
            if curseur.fetchone()[0]:
                raise Conflit("Des versements existent : les annuler en comptabilité, ou déclarer un abandon.")
            curseur.execute("UPDATE ispat.frais_inscription SET deleted_at = now() "
                            "WHERE inscription_id = %s AND deleted_at IS NULL", [inscription.pk])
        from commercial.services import apres_annulation_inscription      # import local : pas de cycle
        apres_annulation_inscription(inscription)                          # prospect / pré-inscription rétablis
        return self._changer_etat(inscription, "ANNULEE", motif)

    @action(detail=True, methods=["post"])
    def abandon(self, request, pk=None):
        inscription = self.get_object()
        motif = motif_obligatoire(request)
        if inscription.etat != "VALIDEE":
            raise Conflit("Seule une inscription validée peut passer en abandon.")
        return self._changer_etat(inscription, "ABANDON", motif)

    def _changer_etat(self, inscription, etat, motif):
        horodatage = timezone.localtime().strftime("%d/%m/%Y %H:%M")
        mention = f"[{etat} {horodatage} — {self.request.user.nom_complet}] {motif}"
        inscription.observations = f"{inscription.observations}\n{mention}" if inscription.observations else mention
        inscription.etat = etat
        inscription.save(update_fields=["etat", "observations"])
        inscription.refresh_from_db()
        return Response(InscriptionSerializer(inscription, context=self.get_serializer_context()).data)


# --------------------------------------------------------------------------------------
# Pièces jointes
# --------------------------------------------------------------------------------------

class PieceJointeViewSet(FiltreSimpleMixin, ViewSetISPAT):
    queryset = PieceJointe.objects.select_related("type_piece")
    serializer_class = PieceJointeSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    pagination_class = None
    http_method_names = ["get", "post", "delete", "head", "options"]
    filtres = {"etudiant": "etudiant_id", "inscription": "inscription_id", "type_piece": "type_piece_id",
               "preinscription": "preinscription_id"}
    permissions_requises = permissions_crud(
        "scolarite.inscription",
        fichier="scolarite.inscription.lire",
        verifier="scolarite.inscription.valider",
    )

    def list(self, request, *args, **kwargs):
        if not any(request.query_params.get(p) for p in ("etudiant", "inscription", "preinscription")):
            raise serializers.ValidationError("Filtre obligatoire : ?etudiant=, ?inscription= ou ?preinscription=.")
        return super().list(request, *args, **kwargs)

    @action(detail=True, methods=["get"])
    def fichier(self, request, pk=None):
        piece = self.get_object()
        return reponse_fichier(piece.chemin, piece.nom_fichier, piece.mime_type)

    @action(detail=True, methods=["post"])
    def verifier(self, request, pk=None):
        piece = self.get_object()
        piece.verifie = True
        piece.verifie_par = request.user
        piece.save(update_fields=["verifie", "verifie_par"])
        piece.refresh_from_db()
        return Response(PieceJointeSerializer(piece, context=self.get_serializer_context()).data)

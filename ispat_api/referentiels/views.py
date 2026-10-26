"""
API des référentiels — /api/referentiels/...

Droits :
  * lecture : tout utilisateur connecté (listes déroulantes, cache hors ligne), sauf les tarifs ;
  * écriture : administration.referentiel.*  (tarifs : comptabilite.tarif.*, types de frais : comptabilite.frais_annexe.*).
"""
from django.db import connection, transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from core.filtres import FiltreSimpleMixin, filtre_annee, filtre_booleen
from core.mixins import VueISPAT, ViewSetISPAT, verifier_dependances
from core.permissions import AUTHENTIFIE, permissions_crud

from .models import (
    AnneeAcademique, CategorieMouvement, Classe, Ecole, Enseignant, Enseignement, Filiere, Matiere, Niveau,
    Parametre, Semestre, StatutEtudiant, Tarif, TypeFrais, TypePiece, Ville,
)
from .serializers import (
    AnneeAcademiqueSerializer, CategorieMouvementSerializer, ClasseSerializer, EcoleSerializer, EnseignantSerializer,
    EnseignementSerializer, FiliereSerializer, MatiereSerializer, NiveauSerializer, ParametreSerializer,
    PonderationSerializer, SemestreSerializer, StatutEtudiantSerializer, TarifSerializer, TypeFraisSerializer,
    TypePieceSerializer, VilleSerializer,
)

REFERENTIEL = permissions_crud("administration.referentiel", list=AUTHENTIFIE, retrieve=AUTHENTIFIE)


class ReferentielViewSet(FiltreSimpleMixin, ViewSetISPAT):
    """Base : pas de pagination (tables courtes, mises en cache côté client)."""

    pagination_class = None
    permissions_requises = REFERENTIEL


# --------------------------------------------------------------------------------------
# Calendrier
# --------------------------------------------------------------------------------------

class AnneeAcademiqueViewSet(ReferentielViewSet):
    """
    Création : les semestres 1 et 2 sont créés automatiquement.
    POST /annees/{id}/activer/            -> année active (une seule à la fois)
    POST /annees/{id}/copier-structure/   {"source": "<uuid année>"} -> recopie classes et tarifs
    """

    queryset = AnneeAcademique.objects.prefetch_related("semestres")
    serializer_class = AnneeAcademiqueSerializer
    filtres = {"active": filtre_booleen("est_active")}
    champs_recherche = ("libelle",)
    permissions_requises = {
        **REFERENTIEL,
        "activer": "administration.referentiel.modifier",
        "copier_structure": "administration.referentiel.creer",
    }

    def perform_create(self, serializer):
        if serializer.validated_data.get("est_active"):
            AnneeAcademique.objects.filter(est_active=True).update(est_active=False)
        annee = serializer.save()
        Semestre.objects.create(annee=annee, numero=1, date_debut=annee.date_debut)
        Semestre.objects.create(annee=annee, numero=2, date_fin=annee.date_fin)
        annee.refresh_from_db()

    def perform_destroy(self, instance):
        verifier_dependances(instance, ignorer=("semestres",))
        semestres = list(instance.semestres.all())
        for semestre in semestres:
            verifier_dependances(semestre)
        for semestre in semestres:
            semestre.supprimer()
        instance.supprimer()

    @action(detail=True, methods=["post"])
    def activer(self, request, pk=None):
        annee = self.get_object()
        AnneeAcademique.objects.filter(est_active=True).exclude(pk=annee.pk).update(est_active=False)
        if not annee.est_active:
            annee.est_active = True
            annee.save(update_fields=["est_active"])
        annee.refresh_from_db()
        return Response(self.get_serializer(annee).data)

    @action(detail=True, methods=["post"], url_path="copier-structure")
    def copier_structure(self, request, pk=None):
        cible = self.get_object()
        source_id = request.data.get("source")
        if not source_id:
            raise serializers.ValidationError({"source": "Année source obligatoire."})
        source = get_object_or_404(AnneeAcademique, pk=source_id)
        if source.pk == cible.pk:
            raise serializers.ValidationError({"source": "L'année source doit être différente de l'année cible."})

        nb_classes = nb_tarifs = 0
        with transaction.atomic():
            for c in Classe.objects.filter(annee=source):
                if not Classe.objects.filter(annee=cible, filiere_id=c.filiere_id, niveau_id=c.niveau_id,
                                             groupe=c.groupe).exists():
                    Classe.objects.create(annee=cible, filiere_id=c.filiere_id, niveau_id=c.niveau_id,
                                          groupe=c.groupe, libelle=c.libelle, capacite=c.capacite)
                    nb_classes += 1
            for t in Tarif.objects.filter(annee=source):
                if not Tarif.objects.filter(annee=cible, type_frais_id=t.type_frais_id, filiere_id=t.filiere_id,
                                            niveau_id=t.niveau_id, statut_etudiant_id=t.statut_etudiant_id).exists():
                    Tarif.objects.create(annee=cible, type_frais_id=t.type_frais_id, filiere_id=t.filiere_id,
                                         niveau_id=t.niveau_id, statut_etudiant_id=t.statut_etudiant_id,
                                         montant=t.montant, nb_tranches=t.nb_tranches)
                    nb_tarifs += 1
        return Response({"classes_copiees": nb_classes, "tarifs_copies": nb_tarifs})


class SemestreViewSet(ReferentielViewSet):
    """Semestres créés avec l'année : seuls les dates et la clôture sont modifiables."""

    queryset = Semestre.objects.select_related("annee")
    serializer_class = SemestreSerializer
    http_method_names = ["get", "put", "patch", "head", "options"]
    filtres = {"annee": filtre_annee(), "numero": "numero"}


# --------------------------------------------------------------------------------------
# Offre de formation
# --------------------------------------------------------------------------------------

class FiliereViewSet(ReferentielViewSet):
    queryset = Filiere.objects.all()
    serializer_class = FiliereSerializer
    filtres = {"active": filtre_booleen("active")}
    champs_recherche = ("code", "libelle")


class NiveauViewSet(ReferentielViewSet):
    queryset = Niveau.objects.all()
    serializer_class = NiveauSerializer
    champs_recherche = ("code", "libelle")


class ClasseViewSet(ReferentielViewSet):
    queryset = Classe.objects.select_related("annee", "filiere", "niveau")
    serializer_class = ClasseSerializer
    filtres = {"annee": filtre_annee(), "filiere": "filiere_id", "niveau": "niveau_id"}
    champs_recherche = ("libelle", "filiere__libelle", "niveau__code")


class MatiereViewSet(ReferentielViewSet):
    queryset = Matiere.objects.select_related("filiere", "niveau")
    serializer_class = MatiereSerializer
    filtres = {"filiere": "filiere_id", "niveau": "niveau_id", "semestre": "semestre_numero"}
    champs_recherche = ("code", "libelle")


class EnseignantViewSet(ReferentielViewSet):
    queryset = Enseignant.objects.select_related("utilisateur")
    serializer_class = EnseignantSerializer
    filtres = {"type_contrat": "type_contrat"}
    champs_recherche = ("nom", "prenoms", "specialite", "telephone")


class EnseignementViewSet(ReferentielViewSet):
    queryset = Enseignement.objects.select_related("enseignant", "matiere", "classe", "semestre")
    serializer_class = EnseignementSerializer
    filtres = {"enseignant": "enseignant_id", "classe": "classe_id", "semestre": "semestre_id",
               "matiere": "matiere_id", "annee": filtre_annee("classe__annee")}


# --------------------------------------------------------------------------------------
# Listes de valeurs
# --------------------------------------------------------------------------------------

class StatutEtudiantViewSet(ReferentielViewSet):
    queryset = StatutEtudiant.objects.all()
    serializer_class = StatutEtudiantSerializer


class TypePieceViewSet(ReferentielViewSet):
    queryset = TypePiece.objects.all()
    serializer_class = TypePieceSerializer


class VilleViewSet(ReferentielViewSet):
    queryset = Ville.objects.all()
    serializer_class = VilleSerializer
    champs_recherche = ("libelle", "region")


class EcoleViewSet(ReferentielViewSet):
    queryset = Ecole.objects.select_related("ville")
    serializer_class = EcoleSerializer
    filtres = {"ville": "ville_id", "type": "type_ecole"}
    champs_recherche = ("nom",)


# --------------------------------------------------------------------------------------
# Finances
# --------------------------------------------------------------------------------------

class TypeFraisViewSet(ReferentielViewSet):
    queryset = TypeFrais.objects.all()
    serializer_class = TypeFraisSerializer
    filtres = {"categorie": "categorie", "obligatoire": filtre_booleen("obligatoire")}
    permissions_requises = permissions_crud("comptabilite.frais_annexe", list=AUTHENTIFIE, retrieve=AUTHENTIFIE)


class TarifViewSet(ReferentielViewSet):
    queryset = Tarif.objects.select_related("annee", "type_frais", "filiere", "niveau", "statut_etudiant")
    serializer_class = TarifSerializer
    filtres = {"annee": filtre_annee(), "type_frais": "type_frais_id", "filiere": "filiere_id",
               "niveau": "niveau_id", "statut": "statut_etudiant_id"}
    permissions_requises = permissions_crud("comptabilite.tarif")


class CategorieMouvementViewSet(ReferentielViewSet):
    queryset = CategorieMouvement.objects.all()
    serializer_class = CategorieMouvementSerializer
    filtres = {"sens": "sens"}
    permissions_requises = {
        "list": AUTHENTIFIE,
        "retrieve": AUTHENTIFIE,
        "create": ["administration.referentiel.creer", "comptabilite.entree.creer"],
        "update": ["administration.referentiel.modifier", "comptabilite.entree.modifier"],
        "partial_update": ["administration.referentiel.modifier", "comptabilite.entree.modifier"],
        "destroy": ["administration.referentiel.supprimer", "comptabilite.entree.supprimer"],
    }


# --------------------------------------------------------------------------------------
# Paramètres
# --------------------------------------------------------------------------------------

class ParametreViewSet(ReferentielViewSet):
    """
    GET   /parametres/                 liste
    PATCH /parametres/{cle}/           {"valeur": "..."}
    POST  /parametres/ponderation/     {"poids_cc": 0.4, "poids_examen": 0.6}  (somme = 1)
    Pas de création ni de suppression (paramètres fournis par le script SQL).
    """

    queryset = Parametre.objects.all()
    serializer_class = ParametreSerializer
    lookup_field = "cle"
    lookup_value_regex = "[a-z0-9_]+"
    http_method_names = ["get", "put", "patch", "post", "head", "options"]
    permissions_requises = {
        "list": AUTHENTIFIE,
        "retrieve": AUTHENTIFIE,
        "update": "administration.parametre.modifier",
        "partial_update": "administration.parametre.modifier",
        "ponderation": "administration.parametre.modifier",
    }

    @action(detail=False, methods=["post"])
    def ponderation(self, request):
        saisie = PonderationSerializer(data=request.data)
        saisie.is_valid(raise_exception=True)
        for cle in ("poids_cc", "poids_examen"):
            parametre = get_object_or_404(Parametre, cle=cle)
            parametre.valeur = str(saisie.validated_data[cle].normalize())
            parametre.save(update_fields=["valeur"])
        qs = Parametre.objects.filter(cle__in=["poids_cc", "poids_examen"])
        return Response(ParametreSerializer(qs, many=True).data)


# --------------------------------------------------------------------------------------
# Lot complet (chargement initial / rafraîchissement du cache hors ligne)
# --------------------------------------------------------------------------------------

class ReferentielsToutView(VueISPAT):
    """
    GET /api/referentiels/tout/              -> tous les référentiels actifs
    GET /api/referentiels/tout/?depuis=1234  -> uniquement les changements après sync_seq 1234
                                                (supprimés inclus : deleted_at renseigné)
    """

    permissions_requises = {"GET": AUTHENTIFIE}

    LOTS = [
        ("annees", AnneeAcademique, AnneeAcademiqueSerializer, None),
        ("semestres", Semestre, SemestreSerializer, None),
        ("filieres", Filiere, FiliereSerializer, None),
        ("niveaux", Niveau, NiveauSerializer, None),
        ("classes", Classe, ClasseSerializer, None),
        ("matieres", Matiere, MatiereSerializer, None),
        ("enseignants", Enseignant, EnseignantSerializer, None),
        ("enseignements", Enseignement, EnseignementSerializer, None),
        ("statuts_etudiant", StatutEtudiant, StatutEtudiantSerializer, None),
        ("types_piece", TypePiece, TypePieceSerializer, None),
        ("villes", Ville, VilleSerializer, None),
        ("ecoles", Ecole, EcoleSerializer, None),
        ("types_frais", TypeFrais, TypeFraisSerializer, None),
        ("categories_mouvement", CategorieMouvement, CategorieMouvementSerializer, None),
        ("parametres", Parametre, ParametreSerializer, None),
        ("tarifs", Tarif, TarifSerializer, "comptabilite.tarif.lire"),
    ]

    def get(self, request):
        depuis = request.query_params.get("depuis")
        if depuis is not None and not depuis.isdigit():
            raise serializers.ValidationError({"depuis": "Entier attendu (sync_seq)."})

        with connection.cursor() as curseur:
            curseur.execute("SELECT last_value FROM ispat.sync_seq")
            sync_seq = curseur.fetchone()[0]

        resultat = {"sync_seq": sync_seq, "complet": depuis is None}
        for cle, modele, serializer_classe, permission in self.LOTS:
            if permission and not request.user.a_permission(permission):
                continue
            qs = modele.tous.filter(sync_seq__gt=int(depuis)) if depuis is not None else modele.objects.all()
            resultat[cle] = serializer_classe(qs, many=True).data
        return Response(resultat)

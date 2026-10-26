"""
API gestion commerciale — /api/commercial/...

  campagnes/                         CRUD + compteurs (prospects, pré-inscrits, inscrits)
  prospects/                         CRUD ; doublons refusés (409) sauf {"forcer": true}
                                     ?campagne=&annee=&ville=&ecole=&sexe=&statut=&source=&filiere=&agent=moi&du=&au=
                                     &relance_avant=AAAA-MM-JJ&q= ; ?export=xlsx|csv
  prospects/doublons/?telephone=&nom=&prenoms=      contrôle avant saisie
  prospects/liste/?groupe=ville|ecole|genre|filiere|statut   liste regroupée (+ export)
  prospects/{id}/preinscrire/        pré-inscription à partir du prospect
  prospects/{id}/inscrire/           inscription directe (EN_ATTENTE) {classe, statut_etudiant, ...}
  relances/                          historique des relances (?prospect=)
  relances/a-faire/?date=&agent=moi  prospects à relancer + jamais contactés
  preinscriptions/                   CRUD ; ?annee=&statut=&source=&filiere=&niveau=&du=&au=&q= ; export
  preinscriptions/{id}/valider/      dossier accepté
  preinscriptions/{id}/rejeter/      {"motif"}
  preinscriptions/{id}/inscrire/     {classe, statut_etudiant, etudiant_id?, forcer?}
  preinscriptions/{id}/pieces/       GET liste / POST multipart (fichier, type_piece)
  preinscriptions/{id}/pieces/{piece_id}/   téléchargement
"""
from django.db import transaction
from django.db.models import Count, Max, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from comptabilite.views import ExportListeMixin, filtre_date
from core.exceptions import Conflit
from core.exports import FORMATS_EXPORT, reponse_export
from core.filtres import FiltreSimpleMixin, filtre_annee
from core.mixins import ViewSetISPAT
from core.permissions import permissions_crud
from referentiels.models import TypePiece
from scolarite.fichiers import enregistrer_piece
from scolarite.models import PieceJointe
from scolarite.serializers import PieceJointeSerializer
from scolarite.views import construire_dossier, reponse_fichier

from .models import CampagneProspection, Preinscription, Prospect, SuiviProspect
from .serializers import (
    CampagneSerializer, InscrireSerializer, MotifSerializer, PreinscriptionSerializer, ProspectSerializer,
    SuiviSerializer,
)
from .services import (
    doublons_prospect, inscrire, marquer_preinscrit, rapprocher_prospect, resume_prospect,
)

VRAI = (True, "true", "1", 1, "oui")
LIRE_PROSPECTS = ["commercial.prospection.lire", "commercial.liste_prospect.lire"]
LIBELLES_STATUT = dict(Prospect.STATUTS)
LIBELLES_SOURCE = dict(Prospect.SOURCES)


def _agent(qs, request, champ="agent"):
    valeur = request.query_params.get("agent")
    if not valeur:
        return qs
    return qs.filter(**{f"{champ}_id": request.user.pk if valeur == "moi" else valeur})


# --------------------------------------------------------------------------------------
# Campagnes
# --------------------------------------------------------------------------------------

class CampagneViewSet(FiltreSimpleMixin, ViewSetISPAT):
    serializer_class = CampagneSerializer
    pagination_class = None
    filtres = {"annee": filtre_annee()}
    champs_recherche = ("libelle__unaccent",)
    permissions_requises = permissions_crud(
        "commercial.prospection", list=[*LIRE_PROSPECTS, "commercial.analyse.lire"],
        retrieve=[*LIRE_PROSPECTS, "commercial.analyse.lire"])

    def get_queryset(self):
        actifs = Q(prospects__deleted_at__isnull=True)
        return CampagneProspection.objects.select_related("annee").annotate(
            nb_prospects=Count("prospects", filter=actifs, distinct=True),
            nb_preinscrits=Count("prospects", filter=actifs & Q(prospects__statut__in=("PREINSCRIT", "INSCRIT")),
                                 distinct=True),
            nb_inscrits=Count("prospects", filter=actifs & Q(prospects__statut="INSCRIT"), distinct=True)) \
            .order_by("-date_debut")


# --------------------------------------------------------------------------------------
# Prospects
# --------------------------------------------------------------------------------------

class ProspectViewSet(ExportListeMixin, FiltreSimpleMixin, ViewSetISPAT):
    serializer_class = ProspectSerializer
    filtres = {
        "campagne": "campagne_id",
        "annee": filtre_annee("campagne__annee"),
        "ville": "ville_id",
        "ecole": "ecole_id",
        "sexe": lambda qs, v: qs.filter(sexe=v.upper()),
        "statut": lambda qs, v: qs.filter(statut__in=v.upper().split(",")),
        "source": "source",
        "filiere": "filiere_souhaitee_id",
        "du": filtre_date("date_contact__gte"),
        "au": filtre_date("date_contact__lte"),
        "relance_avant": filtre_date("prochaine_relance__lte"),
    }
    champs_recherche = ("nom__unaccent", "prenoms__unaccent", "telephone", "telephone_parent")
    permissions_requises = permissions_crud(
        "commercial.prospection",
        list=LIRE_PROSPECTS, retrieve=LIRE_PROSPECTS,
        doublons="commercial.prospection.lire",
        liste="commercial.liste_prospect.lire",
        preinscrire="commercial.preinscription.creer",
        inscrire="commercial.inscription_prospect.creer",
    )
    permission_export = "commercial.liste_prospect.exporter"
    titre_export = "Liste des prospects"

    def get_queryset(self):
        derniere = SuiviProspect.objects.filter(prospect=OuterRef("pk")).order_by("-date_suivi")
        qs = Prospect.objects.select_related("campagne", "ville", "ecole", "filiere_souhaitee", "agent", "etudiant") \
            .annotate(nb_relances=Count("suivis", filter=Q(suivis__deleted_at__isnull=True)),
                      derniere_relance=Max("suivis__date_suivi", filter=Q(suivis__deleted_at__isnull=True)),
                      prochaine_relance=Subquery(derniere.values("prochaine_relance")[:1])) \
            .order_by("-date_contact", "nom", "prenoms")      # tri explicite : Meta.ordering ignoré avec GROUP BY
        return _agent(qs, self.request)

    @staticmethod
    def ligne_export(p, groupe=None):
        ligne = [p.nom, p.prenoms, p.sexe, p.telephone, p.telephone_parent,
                 p.ville.libelle if p.ville_id else "", p.ecole.nom if p.ecole_id else "",
                 p.filiere_souhaitee.code if p.filiere_souhaitee_id else "", LIBELLES_SOURCE.get(p.source, p.source),
                 LIBELLES_STATUT.get(p.statut, p.statut), p.date_contact, p.agent.nom_complet if p.agent_id else ""]
        return [groupe, *ligne] if groupe is not None else ligne

    ENTETES = ["Nom", "Prénoms", "Sexe", "Téléphone", "Tél. parent", "Ville", "École", "Filière souhaitée", "Source",
               "Statut", "Date de contact", "Agent"]

    def colonnes_export(self):
        return self.ENTETES, self.ligne_export

    def create(self, request, *args, **kwargs):
        s = self.get_serializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        if request.data.get("forcer") not in VRAI:
            doublons = doublons_prospect(d["nom"], d["prenoms"], d.get("telephone"), d.get("telephone_parent"),
                                         d.get("date_naissance"))
            if doublons:
                raise Conflit({"detail": "Prospect probablement déjà enregistré. Renvoyer avec {\"forcer\": true} "
                                         "pour l'enregistrer quand même.",
                               "doublons": [resume_prospect(p) for p in doublons]})
        prospect = s.save(agent=request.user)
        return Response(self.get_serializer(self.get_queryset().get(pk=prospect.pk)).data,
                        status=status.HTTP_201_CREATED)

    def perform_destroy(self, instance):
        if instance.statut in ("PREINSCRIT", "INSCRIT"):
            raise Conflit("Prospect pré-inscrit ou inscrit : passer son statut à « Perdu » plutôt que le supprimer.")
        with transaction.atomic():
            for suivi in instance.suivis.all():
                suivi.supprimer()
            instance.supprimer()

    @action(detail=False, methods=["get"])
    def doublons(self, request):
        p = request.query_params
        if not (p.get("telephone") or (p.get("nom") and p.get("prenoms"))):
            raise serializers.ValidationError("Fournir ?telephone= ou ?nom=&prenoms=.")
        return Response([resume_prospect(x) for x in doublons_prospect(p.get("nom"), p.get("prenoms"),
                                                                       p.get("telephone"))])

    @action(detail=False, methods=["get"])
    def liste(self, request):
        axes = {
            "ville": (lambda x: x.ville.libelle if x.ville_id else "Ville non renseignée", "Ville"),
            "ecole": (lambda x: x.ecole.nom if x.ecole_id else "École non renseignée", "École"),
            "genre": (lambda x: "Féminin" if x.sexe == "F" else "Masculin", "Genre"),
            "filiere": (lambda x: x.filiere_souhaitee.libelle if x.filiere_souhaitee_id else "Sans préférence",
                        "Filière souhaitée"),
            "statut": (lambda x: LIBELLES_STATUT.get(x.statut, x.statut), "Statut"),
        }
        groupe = (request.query_params.get("groupe") or "ville").lower()
        if groupe not in axes:
            raise serializers.ValidationError({"groupe": f"Valeurs possibles : {', '.join(axes)}."})
        cle, titre_axe = axes[groupe]
        fmt = (request.query_params.get("export") or "").lower()
        if fmt:
            if fmt not in FORMATS_EXPORT:
                raise serializers.ValidationError({"export": "Formats possibles : xlsx, csv."})
            if not request.user.a_permission(self.permission_export):
                raise PermissionDenied("Vous n'avez pas la permission d'exporter.")

        prospects = sorted(self.filter_queryset(self.get_queryset()), key=lambda x: (cle(x), x.nom, x.prenoms))
        groupes, ordre = {}, []
        for x in prospects:
            g = cle(x)
            if g not in groupes:
                groupes[g] = []
                ordre.append(g)
            groupes[g].append(x)

        if fmt:
            lignes = [self.ligne_export(x, g) for g in ordre for x in groupes[g]]
            return reponse_export(fmt, f"Prospects par {titre_axe.lower()}", f"{len(prospects)} prospect(s)",
                                  [titre_axe, *self.ENTETES], lignes, f"prospects_par_{groupe}")
        contexte = self.get_serializer_context()
        return Response({
            "groupe": groupe, "total": len(prospects),
            "groupes": [{
                "libelle": g, "effectif": len(groupes[g]),
                "filles": sum(1 for x in groupes[g] if x.sexe == "F"),
                "preinscrits": sum(1 for x in groupes[g] if x.statut in ("PREINSCRIT", "INSCRIT")),
                "inscrits": sum(1 for x in groupes[g] if x.statut == "INSCRIT"),
                "prospects": ProspectSerializer(groupes[g], many=True, context=contexte).data,
            } for g in ordre],
        })

    @action(detail=True, methods=["post"])
    def preinscrire(self, request, pk=None):
        prospect = self.get_object()
        if prospect.statut == "INSCRIT":
            raise Conflit("Prospect déjà inscrit.")
        ouvertes = prospect.preinscriptions.filter(statut__in=("EN_ATTENTE", "VALIDEE"))
        if ouvertes.exists():
            raise Conflit({"detail": "Une pré-inscription est déjà en cours pour ce prospect.",
                           "preinscription_id": ouvertes.first().pk})
        donnees = {"prospect": prospect.pk, "nom": prospect.nom, "prenoms": prospect.prenoms, "sexe": prospect.sexe,
                   "date_naissance": prospect.date_naissance, "telephone": prospect.telephone or prospect.telephone_parent,
                   "email": prospect.email, "ville": prospect.ville_id, "ecole": prospect.ecole_id,
                   "serie_bac": prospect.serie_bac, "filiere_souhaitee": prospect.filiere_souhaitee_id,
                   "source": "PROSPECTION"}
        donnees.update({k: v for k, v in request.data.items() if k in (
            "id", "annee", "lieu_naissance", "niveau_souhaite", "filiere_souhaitee", "email", "date_naissance")})
        s = PreinscriptionSerializer(data=donnees, context=self.get_serializer_context())
        s.is_valid(raise_exception=True)
        with transaction.atomic():
            pre = s.save()
            marquer_preinscrit(prospect)
        pre.refresh_from_db()
        return Response(PreinscriptionSerializer(pre, context=self.get_serializer_context()).data,
                        status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def inscrire(self, request, pk=None):
        prospect = self.get_object()
        if prospect.statut == "INSCRIT":
            raise Conflit("Prospect déjà inscrit.")
        saisie = InscrireSerializer(data=request.data)
        saisie.is_valid(raise_exception=True)
        d = saisie.validated_data
        ouvertes = list(prospect.preinscriptions.filter(statut__in=("EN_ATTENTE", "VALIDEE")))
        preinscription = ouvertes[0] if len(ouvertes) == 1 else None
        if len(ouvertes) > 1:
            raise Conflit("Plusieurs pré-inscriptions en cours : inscrire depuis la pré-inscription voulue.")
        base = {"nom": prospect.nom, "prenoms": prospect.prenoms, "sexe": prospect.sexe,
                "date_naissance": prospect.date_naissance, "telephone": prospect.telephone, "email": prospect.email,
                "ville": prospect.ville_id, "ecole_origine": prospect.ecole_id, "serie_bac": prospect.serie_bac}
        if preinscription is not None:
            base.update({"lieu_naissance": preinscription.lieu_naissance,
                         "date_naissance": preinscription.date_naissance or prospect.date_naissance})
        base.update(d.get("etudiant") or {})
        contexte = self.get_serializer_context()
        with transaction.atomic():
            etudiant, inscription = inscrire(
                base, classe=d["classe"], statut_etudiant=d["statut_etudiant"], contexte=contexte,
                etudiant_id=d.get("etudiant_id"), forcer=d["forcer"], prospect=prospect, preinscription=preinscription,
                origine="PROSPECTION", observations=d.get("observations"), id_inscription=d.get("id"))
            if preinscription is not None:
                preinscription.traite_par, preinscription.traite_le = request.user, timezone.now()
                preinscription.save(update_fields=["traite_par", "traite_le"])
        dossier = construire_dossier(etudiant, contexte)
        dossier["inscription_id"] = inscription.pk
        return Response(dossier, status=status.HTTP_201_CREATED)


# --------------------------------------------------------------------------------------
# Relances
# --------------------------------------------------------------------------------------

class SuiviViewSet(FiltreSimpleMixin, ViewSetISPAT):
    serializer_class = SuiviSerializer
    pagination_class = None
    filtres = {"prospect": "prospect_id", "canal": "canal"}
    permissions_requises = permissions_crud("commercial.prospection", a_faire="commercial.prospection.lire")

    def get_queryset(self):
        return _agent(SuiviProspect.objects.select_related("prospect", "agent"), self.request)

    def list(self, request, *args, **kwargs):
        if not request.query_params.get("prospect") and not request.query_params.get("agent"):
            raise serializers.ValidationError("Filtre obligatoire : ?prospect= ou ?agent=.")
        return super().list(request, *args, **kwargs)

    def perform_create(self, serializer):
        with transaction.atomic():
            suivi = serializer.save(agent=self.request.user)
            if suivi.prospect.statut == "NOUVEAU":
                suivi.prospect.statut = "CONTACTE"
                suivi.prospect.save(update_fields=["statut"])
        suivi.refresh_from_db()

    @action(detail=False, methods=["get"], url_path="a-faire")
    def a_faire(self, request):
        jour = parse_date(request.query_params.get("date") or "") or timezone.localdate()
        derniere = SuiviProspect.objects.filter(prospect=OuterRef("pk")).order_by("-date_suivi")
        base = _agent(Prospect.objects.filter(statut__in=("NOUVEAU", "CONTACTE", "PREINSCRIT"))
                      .select_related("campagne", "ville", "ecole", "filiere_souhaitee", "agent")
                      .annotate(nb_relances=Count("suivis", filter=Q(suivis__deleted_at__isnull=True)),
                                derniere_relance=Max("suivis__date_suivi", filter=Q(suivis__deleted_at__isnull=True)),
                                prochaine_relance=Subquery(derniere.values("prochaine_relance")[:1])), request)
        contexte = self.get_serializer_context()
        a_relancer = base.filter(prochaine_relance__lte=jour).order_by("prochaine_relance", "nom")
        jamais = base.filter(nb_relances=0).order_by("date_contact", "nom")
        return Response({
            "date": jour,
            "a_relancer": ProspectSerializer(a_relancer, many=True, context=contexte).data,
            "jamais_contactes": ProspectSerializer(jamais, many=True, context=contexte).data,
        })


# --------------------------------------------------------------------------------------
# Pré-inscriptions
# --------------------------------------------------------------------------------------

class PreinscriptionViewSet(ExportListeMixin, FiltreSimpleMixin, ViewSetISPAT):
    serializer_class = PreinscriptionSerializer
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    filtres = {
        "annee": filtre_annee(),
        "statut": lambda qs, v: qs.filter(statut__in=v.upper().split(",")),
        "source": "source",
        "filiere": "filiere_souhaitee_id",
        "niveau": "niveau_souhaite_id",
        "ville": "ville_id",
        "ecole": "ecole_id",
        "sexe": lambda qs, v: qs.filter(sexe=v.upper()),
        "prospect": "prospect_id",
        "du": lambda qs, v: qs.filter(created_at__date__gte=v),
        "au": lambda qs, v: qs.filter(created_at__date__lte=v),
    }
    champs_recherche = ("nom__unaccent", "prenoms__unaccent", "telephone")
    permissions_requises = permissions_crud(
        "commercial.preinscription",
        valider="commercial.preinscription.valider",
        rejeter="commercial.preinscription.valider",
        inscrire=["commercial.inscription_prospect.creer", "scolarite.inscription.creer"],
        pieces="commercial.preinscription.lire",
        ajouter_piece=["commercial.preinscription.creer", "commercial.preinscription.modifier"],
        fichier_piece="commercial.preinscription.lire",
    )
    permission_export = ["commercial.liste_prospect.exporter", "scolarite.liste_classe.exporter"]
    titre_export = "Liste des pré-inscriptions"

    def get_queryset(self):
        pieces = PieceJointe.objects.filter(preinscription_id=OuterRef("pk")).order_by() \
            .values("preinscription_id").annotate(n=Count("id")).values("n")[:1]
        return Preinscription.objects.select_related(
            "annee", "prospect", "ville", "ecole", "filiere_souhaitee", "niveau_souhaite", "traite_par",
            "inscription__etudiant").annotate(nb_pieces=Coalesce(Subquery(pieces), 0))

    def colonnes_export(self):
        entetes = ["Date", "Nom", "Prénoms", "Sexe", "Date de naissance", "Téléphone", "Ville", "École",
                   "Filière souhaitée", "Niveau", "Source", "Statut", "Matricule", "Pièces"]
        statuts, sources = dict(Preinscription.STATUTS), dict(Preinscription.SOURCES)

        def extraire(p):
            return [timezone.localtime(p.created_at).date(), p.nom, p.prenoms, p.sexe, p.date_naissance, p.telephone,
                    p.ville.libelle if p.ville_id else "", p.ecole.nom if p.ecole_id else "",
                    p.filiere_souhaitee.libelle if p.filiere_souhaitee_id else "",
                    p.niveau_souhaite.code if p.niveau_souhaite_id else "", sources.get(p.source, p.source),
                    statuts.get(p.statut, p.statut),
                    p.inscription.etudiant.matricule if p.inscription_id else "", p.nb_pieces]
        return entetes, extraire

    def create(self, request, *args, **kwargs):
        s = self.get_serializer(data=request.data)
        s.is_valid(raise_exception=True)
        with transaction.atomic():
            pre = s.save()
            rapproche = None
            if pre.prospect_id:
                marquer_preinscrit(pre.prospect)
            else:
                rapproche = rapprocher_prospect(pre)
        donnees = self.get_serializer(self.get_queryset().get(pk=pre.pk)).data
        donnees["prospect_rapproche"] = bool(rapproche)
        return Response(donnees, status=status.HTTP_201_CREATED)

    def perform_destroy(self, instance):
        if instance.statut == "CONVERTIE":
            raise Conflit("Pré-inscription déjà inscrite : annuler l'inscription en scolarité.")
        with transaction.atomic():
            for piece in PieceJointe.objects.filter(preinscription_id=instance.pk):
                piece.supprimer()
            instance.supprimer()

    def _traiter(self, pre, statut, motif=None):
        if pre.statut in ("CONVERTIE", "REJETEE"):
            raise Conflit("Pré-inscription déjà inscrite ou rejetée.")
        pre.statut, pre.traite_par, pre.traite_le = statut, self.request.user, timezone.now()
        pre.motif_rejet = motif
        pre.save(update_fields=["statut", "traite_par", "traite_le", "motif_rejet"])
        return Response(self.get_serializer(self.get_queryset().get(pk=pre.pk)).data)

    @action(detail=True, methods=["post"])
    def valider(self, request, pk=None):
        return self._traiter(self.get_object(), "VALIDEE")

    @action(detail=True, methods=["post"])
    def rejeter(self, request, pk=None):
        s = MotifSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        return self._traiter(self.get_object(), "REJETEE", s.validated_data["motif"].strip())

    @action(detail=True, methods=["post"])
    def inscrire(self, request, pk=None):
        pre = self.get_object()
        if pre.statut in ("CONVERTIE", "REJETEE"):
            raise Conflit("Pré-inscription déjà inscrite ou rejetée.")
        saisie = InscrireSerializer(data=request.data)
        saisie.is_valid(raise_exception=True)
        d = saisie.validated_data
        from referentiels.models import Classe
        classe = get_object_or_404(Classe, pk=d["classe"])
        if classe.annee_id != pre.annee_id:
            raise serializers.ValidationError({"classe": "La classe n'appartient pas à l'année de la pré-inscription."})
        base = {"nom": pre.nom, "prenoms": pre.prenoms, "sexe": pre.sexe, "date_naissance": pre.date_naissance,
                "lieu_naissance": pre.lieu_naissance, "telephone": pre.telephone, "email": pre.email,
                "ville": pre.ville_id, "ecole_origine": pre.ecole_id, "serie_bac": pre.serie_bac}
        base.update(d.get("etudiant") or {})
        contexte = self.get_serializer_context()
        with transaction.atomic():
            etudiant, inscription = inscrire(
                base, classe=classe.pk, statut_etudiant=d["statut_etudiant"], contexte=contexte,
                etudiant_id=d.get("etudiant_id"), forcer=d["forcer"], prospect=pre.prospect, preinscription=pre,
                origine=pre.source if pre.source in ("SITE_WEB", "GUICHET") else "PROSPECTION",
                observations=d.get("observations"), id_inscription=d.get("id"))
            pre.traite_par, pre.traite_le = request.user, timezone.now()
            pre.save(update_fields=["traite_par", "traite_le"])
        dossier = construire_dossier(etudiant, contexte)
        dossier["inscription_id"] = inscription.pk
        dossier["avertissement"] = None
        if pre.filiere_souhaitee_id and classe.filiere_id != pre.filiere_souhaitee_id:
            dossier["avertissement"] = "La classe choisie n'est pas dans la filière souhaitée."
        return Response(dossier, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def pieces(self, request, pk=None):
        pre = self.get_object()
        qs = PieceJointe.objects.filter(preinscription_id=pre.pk).select_related("type_piece")
        donnees = PieceJointeSerializer(qs, many=True, context=self.get_serializer_context()).data
        for d in donnees:
            d["url"] = f"/api/commercial/preinscriptions/{pre.pk}/pieces/{d['id']}/"
        presentes = {p.type_piece.code for p in qs}
        manquantes = [{"code": t.code, "libelle": t.libelle} for t in TypePiece.objects.filter(obligatoire=True)
                      if t.code not in presentes]
        return Response({"pieces": donnees, "pieces_manquantes": manquantes})

    @pieces.mapping.post
    def ajouter_piece(self, request, pk=None):
        pre = self.get_object()
        if pre.statut == "REJETEE":
            raise Conflit("Pré-inscription rejetée.")
        fichier = request.FILES.get("fichier")
        type_piece = get_object_or_404(TypePiece, pk=request.data.get("type_piece")) \
            if request.data.get("type_piece") else None
        if fichier is None or type_piece is None:
            raise serializers.ValidationError("Champs multipart « fichier » et « type_piece » obligatoires.")
        chemin, mime, taille, nom = enregistrer_piece(fichier)
        piece = PieceJointe.objects.create(
            type_piece=type_piece, preinscription_id=pre.pk, nom_fichier=nom, chemin=chemin, mime_type=mime,
            taille_octets=taille, inscription_id=pre.inscription_id,
            etudiant_id=pre.inscription.etudiant_id if pre.inscription_id else None)
        piece.refresh_from_db()
        donnees = PieceJointeSerializer(piece, context=self.get_serializer_context()).data
        donnees["url"] = f"/api/commercial/preinscriptions/{pre.pk}/pieces/{piece.pk}/"
        return Response(donnees, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"], url_path=r"pieces/(?P<piece_id>[0-9a-f-]{36})")
    def fichier_piece(self, request, pk=None, piece_id=None):
        pre = self.get_object()
        piece = get_object_or_404(PieceJointe, pk=piece_id, preinscription_id=pre.pk)
        return reponse_fichier(piece.chemin, piece.nom_fichier, piece.mime_type)

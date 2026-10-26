"""
Règles métier de la gestion commerciale.

  * cle_telephone      : forme comparable d'un numéro (10 derniers chiffres : 07 07 12 34 56 = +225 0707123456)
  * doublons_prospect  : prospects actifs ayant le même téléphone, ou mêmes nom + prénoms (+ date de naissance)
  * rapprocher_prospect: rattache une pré-inscription (site web, guichet) au prospect de même téléphone
  * inscrire           : crée (ou reprend) l'étudiant et son inscription EN_ATTENTE depuis un prospect / une
                         pré-inscription ; la validation de l'inscription (scolarité) fait passer le prospect INSCRIT
  * apres_annulation_inscription : remet prospect et pré-inscription dans leur état précédent
"""
import re

from django.core.files.storage import default_storage
from django.db import connection
from django.db.models import Q
from rest_framework import serializers

from core.exceptions import Conflit
from scolarite.fichiers import enregistrer_photo
from scolarite.models import Etudiant, Inscription, PieceJointe
from scolarite.serializers import EtudiantSerializer, InscriptionSerializer

from .models import Preinscription, Prospect

STATUTS_OUVERTS = ("NOUVEAU", "CONTACTE", "PERDU")


def cle_telephone(numero):
    chiffres = re.sub(r"\D", "", numero or "")
    return chiffres[-10:] if len(chiffres) >= 8 else None


def _filtre_telephone(cles):
    cles = [c for c in cles if c]
    if not cles:
        return None
    with connection.cursor() as c:
        c.execute("""SELECT id FROM ispat.prospect
                      WHERE deleted_at IS NULL
                        AND (right(regexp_replace(coalesce(telephone, ''), '\\D', '', 'g'), 10) = ANY(%s)
                          OR right(regexp_replace(coalesce(telephone_parent, ''), '\\D', '', 'g'), 10) = ANY(%s))""",
                  [cles, cles])
        return [r[0] for r in c.fetchall()]


def doublons_prospect(nom, prenoms, telephone=None, telephone_parent=None, date_naissance=None, exclure=None):
    ids = _filtre_telephone([cle_telephone(telephone), cle_telephone(telephone_parent)]) or []
    condition = Q(pk__in=ids)
    if nom and prenoms:
        identite = Q(nom__unaccent__iexact=nom.strip(), prenoms__unaccent__iexact=prenoms.strip())
        if date_naissance:
            identite &= Q(date_naissance=date_naissance) | Q(date_naissance__isnull=True)
        condition |= identite
    qs = Prospect.objects.filter(condition).select_related("campagne", "agent")
    if exclure:
        qs = qs.exclude(pk=exclure)
    return list(qs[:10])


def resume_prospect(p):
    return {"id": p.pk, "nom": p.nom, "prenoms": p.prenoms, "telephone": p.telephone, "statut": p.statut,
            "campagne": p.campagne.libelle if p.campagne_id else None, "date_contact": p.date_contact,
            "agent": p.agent.nom_complet if p.agent_id else None}


def marquer_preinscrit(prospect):
    if prospect.statut in STATUTS_OUVERTS:
        prospect.statut = "PREINSCRIT"
        prospect.save(update_fields=["statut"])


def rapprocher_prospect(preinscription):
    """Pré-inscription sans prospect : rattachement au prospect le plus récent ayant le même téléphone."""
    if preinscription.prospect_id or not preinscription.telephone:
        return None
    ids = _filtre_telephone([cle_telephone(preinscription.telephone)])
    if not ids:
        return None
    prospect = Prospect.objects.filter(pk__in=ids).exclude(statut="INSCRIT").order_by("-date_contact").first()
    if prospect is None:
        return None
    preinscription.prospect = prospect
    preinscription.save(update_fields=["prospect"])
    marquer_preinscrit(prospect)
    return prospect


# --------------------------------------------------------------------------------------
# Conversion en inscription
# --------------------------------------------------------------------------------------

def etudiants_semblables(nom, prenoms, date_naissance=None):
    qs = Etudiant.objects.filter(nom__unaccent__iexact=nom.strip(), prenoms__unaccent__iexact=prenoms.strip())
    if date_naissance:
        qs = qs.filter(Q(date_naissance=date_naissance) | Q(date_naissance__isnull=True))
    return list(qs[:10])


def inscrire(source_donnees, *, classe, statut_etudiant, contexte, etudiant_id=None, forcer=False, prospect=None,
             preinscription=None, origine="PROSPECTION", type_inscription=None, observations=None, id_inscription=None):
    """
    source_donnees : dict des champs étudiant (nom, prenoms, sexe, date_naissance, ...).
    Retourne (etudiant, inscription). Lève Conflit si un étudiant semblable existe (sauf etudiant_id ou forcer).
    """
    if etudiant_id:
        etudiant = Etudiant.objects.filter(pk=etudiant_id).first()
        if etudiant is None:
            raise serializers.ValidationError({"etudiant_id": "Étudiant introuvable."})
    else:
        semblables = etudiants_semblables(source_donnees["nom"], source_donnees["prenoms"],
                                          source_donnees.get("date_naissance"))
        if semblables and not forcer:
            raise Conflit({
                "detail": "Un étudiant semblable existe déjà. Renvoyer avec « etudiant_id » pour le réutiliser, "
                          "ou avec {\"forcer\": true} pour créer un nouvel étudiant.",
                "etudiants": [{"id": e.pk, "matricule": e.matricule, "nom": e.nom, "prenoms": e.prenoms,
                               "date_naissance": e.date_naissance} for e in semblables],
            })
        s = EtudiantSerializer(data=source_donnees, context=contexte)
        if not s.is_valid():
            raise serializers.ValidationError({"etudiant": s.errors})
        etudiant = s.save()

    deja_inscrit = Inscription.objects.filter(etudiant=etudiant).exclude(etat="ANNULEE").exists()
    donnees = {"etudiant": etudiant.pk, "classe": classe, "statut_etudiant": statut_etudiant, "source": origine,
               "prospect_id": prospect.pk if prospect else None, "observations": observations,
               "type_inscription": type_inscription or ("REINSCRIPTION" if deja_inscrit else "NOUVELLE")}
    if id_inscription:
        donnees["id"] = id_inscription
    s = InscriptionSerializer(data=donnees, context=contexte)
    if not s.is_valid():
        raise serializers.ValidationError({"inscription": s.errors})
    inscription = s.save()

    if prospect is not None:
        prospect.etudiant = etudiant
        prospect.save(update_fields=["etudiant"])
        marquer_preinscrit(prospect)
    if preinscription is not None:
        preinscription.statut = "CONVERTIE"
        preinscription.inscription = inscription
        preinscription.save(update_fields=["statut", "inscription"])
        PieceJointe.objects.filter(preinscription_id=preinscription.pk).update(etudiant=etudiant,
                                                                               inscription=inscription)
        reprendre_photo(etudiant, preinscription)
    return etudiant, inscription


def reprendre_photo(etudiant, preinscription):
    """La photo d'identité jointe à la pré-inscription devient la photo de l'étudiant (s'il n'en a pas)."""
    if etudiant.photo_chemin:
        return
    piece = PieceJointe.objects.filter(preinscription_id=preinscription.pk, type_piece__code="PHOTO",
                                       mime_type__startswith="image/").order_by("-created_at").first()
    if piece is None or not default_storage.exists(piece.chemin):
        return
    try:
        with default_storage.open(piece.chemin, "rb") as fichier:
            etudiant.photo_chemin = enregistrer_photo(fichier, etudiant.pk)
    except serializers.ValidationError:
        return                                   # image illisible : la scolarité ajoutera la photo à la main
    etudiant.save(update_fields=["photo_chemin"])


def apres_annulation_inscription(inscription):
    """Appelée par la scolarité à l'annulation d'une inscription."""
    for pre in Preinscription.objects.filter(inscription=inscription, statut="CONVERTIE"):
        pre.statut = "VALIDEE"
        pre.inscription = None
        pre.save(update_fields=["statut", "inscription"])
    if inscription.prospect_id:
        autre = Inscription.objects.filter(prospect_id=inscription.prospect_id, etat__in=("VALIDEE", "ABANDON")) \
            .exclude(pk=inscription.pk).exists()
        if not autre:
            Prospect.objects.filter(pk=inscription.prospect_id, statut="INSCRIT").update(statut="PREINSCRIT")

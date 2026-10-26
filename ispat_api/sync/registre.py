"""
Registre des tables synchronisées avec les clients hors ligne.

Pour chaque table :
  * lire      : droits permettant de la recevoir (l'un suffit ; AUTHENTIFIE = tout utilisateur connecté)
  * portee    : restriction des lignes selon l'utilisateur -> (queryset, restreint: bool)
  * restreints: colonnes envoyées quand la portée est restreinte (ex : enseignant -> pas de téléphone des étudiants)
  * envoi     : opérations acceptées en push -> {action: (ViewSet, méthode HTTP, action du ViewSet, sur une ligne ?)}

Les règles métier et les droits d'écriture restent ceux des vues de chaque module : le push les réutilise.
"""
from dataclasses import dataclass, field

from commercial.models import CampagneProspection, Preinscription, Prospect, SuiviProspect
from commercial.views import CampagneViewSet, PreinscriptionViewSet, ProspectViewSet, SuiviViewSet
from comptabilite.models import FraisInscription, MouvementCaisse, PriseEnCharge, Versement
from comptabilite.views import MouvementCaisseViewSet, VersementViewSet
from core.permissions import AUTHENTIFIE
from notes.models import Evaluation, MoyenneMatiere, MoyenneSemestre, Note
from notes.portee import cours_restreints, filtrer_evaluations
from notes.views import EvaluationViewSet
from referentiels.models import (
    AnneeAcademique, CategorieMouvement, Classe, Ecole, Enseignant, Enseignement, Filiere, Matiere, Niveau,
    Parametre, Semestre, StatutEtudiant, Tarif, TypeFrais, TypePiece, Ville,
)
from scolarite.models import ContactEtudiant, Etudiant, Inscription, PieceJointe
from scolarite.views import ContactEtudiantViewSet, EtudiantViewSet, InscriptionViewSet

CREER = ("post", "create", False)
MODIFIER = ("patch", "partial_update", True)
SUPPRIMER = ("delete", "destroy", True)


@dataclass
class TableSync:
    nom: str
    modele: type
    lire: tuple
    portee: object = None
    restreints: tuple = ()
    envoi: dict = field(default_factory=dict)

    def lisible(self, utilisateur):
        return AUTHENTIFIE in self.lire or any(utilisateur.a_permission(c) for c in self.lire)

    def champs(self, restreint=False):
        tous = [f.attname for f in self.modele._meta.concrete_fields]
        if restreint and self.restreints:
            return [c for c in tous if c in self.restreints]
        return tous

    def queryset(self, utilisateur):
        qs = self.modele.tous.all()
        if self.portee is None:
            return qs, False
        return self.portee(qs, utilisateur)


# --------------------------------------------------------------------------------------
# Portées
# --------------------------------------------------------------------------------------

LECTURE_SCOLARITE_COMPLETE = ("scolarite.inscription.lire", "comptabilite.versement.lire")
TECHNIQUES = ("id", "version", "sync_seq", "deleted_at", "updated_at")


def _classes_enseignant(utilisateur):
    cours = cours_restreints(utilisateur)
    return None if cours is None else {classe for _, classe, _ in cours}


def _vue_complete_scolarite(utilisateur):
    return any(utilisateur.a_permission(c) for c in LECTURE_SCOLARITE_COMPLETE)


def portee_etudiant(qs, u):
    if _vue_complete_scolarite(u):
        return qs, False
    classes = _classes_enseignant(u)
    if classes is None:
        return qs, False
    return qs.filter(inscriptions__classe_id__in=classes).distinct(), True


def portee_inscription(qs, u):
    if _vue_complete_scolarite(u):
        return qs, False
    classes = _classes_enseignant(u)
    if classes is None:
        return qs, False
    return qs.filter(classe_id__in=classes), True


def portee_evaluation(qs, u):
    return filtrer_evaluations(qs, u), cours_restreints(u) is not None


def portee_note(qs, u):
    return filtrer_evaluations(qs, u, prefixe="evaluation__"), cours_restreints(u) is not None


def portee_caisse(qs, u):
    sens = [s for s, code in (("ENTREE", "comptabilite.entree.lire"), ("SORTIE", "comptabilite.sortie.lire"))
            if u.a_permission(code)]
    return qs.filter(sens__in=sens), len(sens) < 2


# --------------------------------------------------------------------------------------
# Registre
# --------------------------------------------------------------------------------------

LIRE_PROSPECTS = ("commercial.prospection.lire", "commercial.liste_prospect.lire")
LIRE_MOYENNES = ("moyenne.validation_moyenne.lire", "moyenne.calcul.lire", "moyenne.modification_moyenne.lire")
LIRE_FINANCES = ("comptabilite.versement.lire", "comptabilite.situation.lire", "comptabilite.frais_annexe.lire",
                 "comptabilite.prise_en_charge.lire")

TABLES = [
    # Référentiels
    TableSync("annee_academique", AnneeAcademique, (AUTHENTIFIE,)),
    TableSync("semestre", Semestre, (AUTHENTIFIE,)),
    TableSync("filiere", Filiere, (AUTHENTIFIE,)),
    TableSync("niveau", Niveau, (AUTHENTIFIE,)),
    TableSync("classe", Classe, (AUTHENTIFIE,)),
    TableSync("matiere", Matiere, (AUTHENTIFIE,)),
    TableSync("enseignant", Enseignant, (AUTHENTIFIE,)),
    TableSync("enseignement", Enseignement, (AUTHENTIFIE,)),
    TableSync("statut_etudiant", StatutEtudiant, (AUTHENTIFIE,)),
    TableSync("type_piece", TypePiece, (AUTHENTIFIE,)),
    TableSync("ville", Ville, (AUTHENTIFIE,)),
    TableSync("ecole", Ecole, (AUTHENTIFIE,)),
    TableSync("type_frais", TypeFrais, (AUTHENTIFIE,)),
    TableSync("categorie_mouvement", CategorieMouvement, (AUTHENTIFIE,)),
    TableSync("parametre", Parametre, (AUTHENTIFIE,)),
    TableSync("tarif", Tarif, ("comptabilite.tarif.lire",)),
    # Scolarité
    TableSync("etudiant", Etudiant, ("scolarite.inscription.lire", "comptabilite.versement.lire",
                                     "scolarite.liste_classe.lire"),
              portee=portee_etudiant,
              restreints=(*TECHNIQUES, "matricule", "nom", "prenoms", "sexe", "photo_chemin"),
              envoi={"creer": (EtudiantViewSet, *CREER), "modifier": (EtudiantViewSet, *MODIFIER)}),
    TableSync("contact_etudiant", ContactEtudiant, ("scolarite.inscription.lire",),
              envoi={"creer": (ContactEtudiantViewSet, *CREER), "modifier": (ContactEtudiantViewSet, *MODIFIER),
                     "supprimer": (ContactEtudiantViewSet, *SUPPRIMER)}),
    TableSync("inscription", Inscription, ("scolarite.inscription.lire", "comptabilite.versement.lire",
                                           "scolarite.liste_classe.lire"),
              portee=portee_inscription,
              restreints=(*TECHNIQUES, "etudiant_id", "annee_id", "classe_id", "etat"),
              envoi={"nouvelle": (InscriptionViewSet, "post", "nouvelle", False),
                     "modifier": (InscriptionViewSet, *MODIFIER)}),
    TableSync("piece_jointe", PieceJointe, ("scolarite.inscription.lire",)),
    # Comptabilité
    TableSync("frais_inscription", FraisInscription, LIRE_FINANCES),
    TableSync("prise_en_charge", PriseEnCharge, LIRE_FINANCES),
    TableSync("versement", Versement, ("comptabilite.versement.lire",),
              envoi={"creer": (VersementViewSet, *CREER)}),
    TableSync("mouvement_caisse", MouvementCaisse, ("comptabilite.entree.lire", "comptabilite.sortie.lire"),
              portee=portee_caisse,
              envoi={"creer": (MouvementCaisseViewSet, *CREER), "modifier": (MouvementCaisseViewSet, *MODIFIER)}),
    # Notes
    TableSync("evaluation", Evaluation, ("moyenne.note.lire",), portee=portee_evaluation,
              envoi={"creer": (EvaluationViewSet, *CREER), "modifier": (EvaluationViewSet, *MODIFIER),
                     "supprimer": (EvaluationViewSet, *SUPPRIMER),
                     "saisir": (EvaluationViewSet, "post", "saisir", True)}),
    TableSync("note", Note, ("moyenne.note.lire",), portee=portee_note),
    TableSync("moyenne_matiere", MoyenneMatiere, LIRE_MOYENNES),
    TableSync("moyenne_semestre", MoyenneSemestre, LIRE_MOYENNES),
    # Commercial
    TableSync("campagne_prospection", CampagneProspection, (*LIRE_PROSPECTS, "commercial.analyse.lire"),
              envoi={"creer": (CampagneViewSet, *CREER), "modifier": (CampagneViewSet, *MODIFIER)}),
    TableSync("prospect", Prospect, LIRE_PROSPECTS,
              envoi={"creer": (ProspectViewSet, *CREER), "modifier": (ProspectViewSet, *MODIFIER),
                     "supprimer": (ProspectViewSet, *SUPPRIMER),
                     "preinscrire": (ProspectViewSet, "post", "preinscrire", True)}),
    TableSync("suivi_prospect", SuiviProspect, ("commercial.prospection.lire",),
              envoi={"creer": (SuiviViewSet, *CREER), "modifier": (SuiviViewSet, *MODIFIER)}),
    TableSync("preinscription", Preinscription, ("commercial.preinscription.lire",),
              envoi={"creer": (PreinscriptionViewSet, *CREER), "modifier": (PreinscriptionViewSet, *MODIFIER)}),
]

PAR_NOM = {t.nom: t for t in TABLES}

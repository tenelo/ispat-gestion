"""
Portée d'un utilisateur sur les notes.

Un enseignant (rôle ENSEIGNANT seul) ne voit et ne saisit que les évaluations de SES cours,
c'est-à-dire les attributions (enseignement) matière × classe × semestre liées à son profil enseignant.
Les rôles ADMIN, DIRECTION, DIRECTEUR_ETUDES et SCOLARITE ont une portée complète.
"""
from django.db.models import Q
from rest_framework.exceptions import PermissionDenied

from referentiels.models import Enseignement

ROLES_PORTEE_COMPLETE = {"ADMIN", "DIRECTION", "DIRECTEUR_ETUDES", "SCOLARITE"}


def cours_restreints(utilisateur):
    """None = aucune restriction ; sinon ensemble de (matiere_id, classe_id, semestre_id)."""
    if utilisateur.codes_roles() & ROLES_PORTEE_COMPLETE:
        return None
    if not hasattr(utilisateur, "_cours_ispat"):
        utilisateur._cours_ispat = set(
            Enseignement.objects.filter(enseignant__utilisateur=utilisateur)
            .values_list("matiere_id", "classe_id", "semestre_id"))
    return utilisateur._cours_ispat


def filtrer_evaluations(qs, utilisateur, prefixe=""):
    cours = cours_restreints(utilisateur)
    if cours is None:
        return qs
    if not cours:
        return qs.none()
    condition = Q()
    for matiere_id, classe_id, semestre_id in cours:
        condition |= Q(**{f"{prefixe}matiere_id": matiere_id, f"{prefixe}classe_id": classe_id,
                          f"{prefixe}semestre_id": semestre_id})
    return qs.filter(condition)


def exiger_cours(utilisateur, matiere_id, classe_id, semestre_id):
    cours = cours_restreints(utilisateur)
    if cours is not None and (matiere_id, classe_id, semestre_id) not in cours:
        raise PermissionDenied("Ce cours ne vous est pas attribué.")

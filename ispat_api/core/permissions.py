"""
Contrôle d'accès par permissions ISPAT (table ispat.permission, codes « module.ressource.action »).

Chaque vue déclare ce qu'elle exige :

    class InscriptionViewSet(ViewSetISPAT):
        permissions_requises = permissions_crud("scolarite.inscription")
        # ou à la main :
        permissions_requises = {"list": "scolarite.inscription.lire", "valider": "scolarite.inscription.valider"}

Clé = action du ViewSet (list, retrieve, create, ..., ou @action personnalisée) ou méthode HTTP.
Valeur = un code ou une liste de codes (l'un d'eux suffit). Clé "*" = valeur par défaut.
Valeur AUTHENTIFIE = tout utilisateur connecté (ex : lecture des référentiels pour les listes déroulantes).
Une vue sans déclaration est REFUSÉE, sauf si elle définit permission_libre = True.
"""
from rest_framework.permissions import BasePermission

AUTHENTIFIE = "__authentifie__"


def permissions_crud(prefixe, **supplementaires):
    """Correspondance standard actions DRF -> codes de permission."""
    regles = {
        "list": f"{prefixe}.lire",
        "retrieve": f"{prefixe}.lire",
        "create": f"{prefixe}.creer",
        "update": f"{prefixe}.modifier",
        "partial_update": f"{prefixe}.modifier",
        "destroy": f"{prefixe}.supprimer",
    }
    regles.update(supplementaires)
    return regles


class PermissionISPAT(BasePermission):
    message = "Vous n'avez pas la permission d'effectuer cette action."

    def has_permission(self, request, view):
        if getattr(view, "permission_libre", False):
            return True
        if request.method.lower() not in getattr(view, "http_method_names", ()):
            return True                      # méthode non autorisée : DRF répondra 405 (pas 403)
        utilisateur = request.user
        if not utilisateur or not utilisateur.is_authenticated:
            return False

        exigences = getattr(view, "permissions_requises", None)
        if not exigences:
            return False

        action = getattr(view, "action", None)
        code = exigences.get(action) if action else None
        if code is None:
            code = exigences.get(request.method, exigences.get("*"))
        if code is None:
            return False

        codes = code if isinstance(code, (list, tuple, set, frozenset)) else [code]
        if AUTHENTIFIE in codes:
            return True
        return any(utilisateur.a_permission(c) for c in codes)

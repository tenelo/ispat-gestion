"""
Filtres simples par paramètres d'URL (sans dépendance externe).

    class ClasseViewSet(FiltreSimpleMixin, ViewSetISPAT):
        filtres = {"annee": filtre_annee(), "filiere": "filiere_id", "active": filtre_booleen("active")}
        champs_recherche = ("libelle",)

    GET /classes/?annee=active&filiere=<uuid>&q=agro
"""
from django.core.exceptions import ValidationError
from django.db.models import Q

VRAI = {"1", "true", "oui", "yes", "vrai"}
FAUX = {"0", "false", "non", "no", "faux"}


def filtre_annee(champ="annee"):
    """?annee=active -> année active ; ?annee=<uuid> -> année donnée."""

    def appliquer(qs, valeur):
        if valeur == "active":
            return qs.filter(**{f"{champ}__est_active": True})
        return qs.filter(**{f"{champ}_id": valeur})

    return appliquer


def filtre_booleen(lookup):
    def appliquer(qs, valeur):
        v = valeur.strip().lower()
        if v in VRAI:
            return qs.filter(**{lookup: True})
        if v in FAUX:
            return qs.filter(**{lookup: False})
        raise ValidationError(f"Valeur booléenne invalide : « {valeur} ».")

    return appliquer


class FiltreSimpleMixin:
    """
    Les filtres s'appliquent dans filter_queryset() (appelé par DRF pour list / retrieve / get_object),
    et non dans get_queryset() : une vue peut ainsi redéfinir get_queryset() sans perdre ses filtres.
    """

    filtres = {}
    champs_recherche = ()

    def filter_queryset(self, queryset):
        qs = super().filter_queryset(queryset)
        params = self.request.query_params
        for param, cible in self.filtres.items():
            valeur = params.get(param)
            if valeur is None or valeur == "":
                continue
            qs = cible(qs, valeur) if callable(cible) else qs.filter(**{cible: valeur})

        recherche = (params.get("q") or "").strip()
        if recherche and self.champs_recherche:
            condition = Q()
            for champ in self.champs_recherche:
                condition |= Q(**{f"{champ}__icontains": recherche})
            qs = qs.filter(condition)
        return qs

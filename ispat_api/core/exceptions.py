"""
Gestion centralisée des erreurs : traduit les erreurs PostgreSQL en réponses API claires (en français).

  23505 unique_violation       -> 409 « existe déjà »
  23503 foreign_key_violation  -> 400 « référence invalide »
  23514 check_violation        -> 400 « valeur non autorisée »
  23502 not_null_violation     -> 400 « champ obligatoire »
  P0001 raise_exception        -> 400 message du trigger (ex : motif obligatoire)
  22xxx data_exception         -> 400 « valeur invalide »
  ValidationError Django       -> 400 (ex : UUID mal formé dans un filtre)
"""
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DataError, IntegrityError, InternalError
from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.response import Response
from rest_framework.views import exception_handler, set_rollback


class Conflit(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "Conflit avec des données existantes."
    default_code = "conflit"


MESSAGES_CONTRAINTES = {
    "ux_filiere_code": "Ce code de filière existe déjà.",
    "ux_niveau_code": "Ce code de niveau existe déjà.",
    "ux_classe": "Cette classe existe déjà pour cette année (même filière, niveau et groupe).",
    "ux_matiere": "Ce code de matière existe déjà pour cette filière et ce niveau.",
    "ux_enseignement": "Cette matière est déjà attribuée dans cette classe pour ce semestre.",
    "ux_tarif": "Un tarif existe déjà pour cette combinaison (année, frais, filière, niveau, statut).",
    "ux_annee_active": "Une autre année académique est déjà active.",
    "ux_semestre": "Ce semestre existe déjà pour cette année.",
    "ux_ville": "Cette ville existe déjà.",
    "ux_ecole": "Cette école existe déjà dans cette ville.",
    "annee_academique_libelle_key": "Cette année académique existe déjà.",
    "statut_etudiant_code_key": "Ce code de statut existe déjà.",
    "type_piece_code_key": "Ce code de pièce existe déjà.",
    "type_frais_code_key": "Ce code de frais existe déjà.",
    "categorie_mouvement_code_key": "Ce code de catégorie existe déjà.",
    "parametre_cle_key": "Ce paramètre existe déjà.",
    "ux_utilisateur_login": "Ce login est déjà utilisé.",
    "ux_utilisateur_email": "Cet e-mail est déjà utilisé.",
}


def _diag(exc):
    cause = exc.__cause__
    sqlstate = getattr(cause, "sqlstate", None)
    diag = getattr(cause, "diag", None)
    return sqlstate, diag


def gestionnaire_exceptions(exc, context):
    if isinstance(exc, DjangoValidationError):
        set_rollback()
        return Response({"detail": " ".join(exc.messages)}, status=status.HTTP_400_BAD_REQUEST)

    if isinstance(exc, IntegrityError):
        set_rollback()
        sqlstate, diag = _diag(exc)
        contrainte = getattr(diag, "constraint_name", None)
        if sqlstate == "23505":
            message = MESSAGES_CONTRAINTES.get(contrainte, "Cet enregistrement existe déjà.")
            code = status.HTTP_409_CONFLICT
        elif sqlstate == "23503":
            message, code = "Référence invalide : l'élément lié n'existe pas.", status.HTTP_400_BAD_REQUEST
        elif sqlstate == "23514":
            message, code = f"Valeur non autorisée (contrôle {contrainte}).", status.HTTP_400_BAD_REQUEST
        elif sqlstate == "23502":
            colonne = getattr(diag, "column_name", None)
            message, code = f"Champ obligatoire manquant : {colonne}.", status.HTTP_400_BAD_REQUEST
        else:
            message, code = "Opération refusée par la base de données.", status.HTTP_400_BAD_REQUEST
        return Response({"detail": message, "contrainte": contrainte}, status=code)

    if isinstance(exc, (InternalError, DataError)):
        sqlstate, diag = _diag(exc)
        if sqlstate == "P0001" or (sqlstate or "").startswith("22"):
            set_rollback()
            corps = {"detail": getattr(diag, "message_primary", None) or "Valeur invalide."}
            indice = getattr(diag, "message_hint", None)
            if indice:
                corps["indice"] = indice
            return Response(corps, status=status.HTTP_400_BAD_REQUEST)

    return exception_handler(exc, context)

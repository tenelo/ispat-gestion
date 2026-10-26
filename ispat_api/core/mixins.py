"""
Classes de base des vues ISPAT.

ContexteAuditMixin transmet à PostgreSQL, pour la transaction de la requête :
  * app.user_id -> utilisateur connecté (created_by / updated_by / journal_audit)
  * app.motif   -> en-tête HTTP « X-Motif » (obligatoire pour modifier une note / moyenne validée)
Nécessite ATOMIC_REQUESTS = True (settings) : set_config(..., true) = SET LOCAL.
"""
from django.db import connection
from rest_framework import viewsets
from rest_framework.response import Response
from rest_framework.views import APIView

from .exceptions import Conflit

LONGUEUR_MAX_MOTIF = 500


def definir_contexte_base(utilisateur_id=None, motif=None):
    with connection.cursor() as curseur:
        if utilisateur_id:
            curseur.execute("SELECT set_config('app.user_id', %s, true)", [str(utilisateur_id)])
        if motif:
            curseur.execute("SELECT set_config('app.motif', %s, true)", [motif[:LONGUEUR_MAX_MOTIF]])


def verifier_dependances(instance, ignorer=()):
    """
    Refuse (409) la suppression logique d'un élément encore utilisé par des enregistrements actifs.
    `ignorer` : noms d'accesseurs inverses à ne pas contrôler (ex : "semestres" pour une année).
    """
    bloquants = []
    for relation in instance._meta.related_objects:
        if not (relation.one_to_many or relation.one_to_one):
            continue
        if relation.get_accessor_name() in ignorer:
            continue
        modele = relation.related_model
        qs = modele._base_manager.filter(**{relation.field.name: instance})
        if any(f.name == "deleted_at" for f in modele._meta.concrete_fields):
            qs = qs.filter(deleted_at__isnull=True)
        if qs.exists():
            bloquants.append(str(modele._meta.verbose_name_plural))
    if bloquants:
        raise Conflit(f"Suppression impossible : élément utilisé par {', '.join(sorted(set(bloquants)))}.")


class ContexteAuditMixin:
    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)        # authentification + permissions
        utilisateur = request.user
        definir_contexte_base(
            utilisateur_id=utilisateur.id if utilisateur and utilisateur.is_authenticated else None,
            motif=(request.headers.get("X-Motif") or "").strip() or None,
        )


class VueISPAT(ContexteAuditMixin, APIView):
    """APIView avec contexte d'audit."""


class ViewSetISPAT(ContexteAuditMixin, viewsets.ModelViewSet):
    """
    ModelViewSet avec :
      * contexte d'audit ;
      * relecture après écriture (version, sync_seq, dates posées par les triggers) ;
      * suppression logique, refusée si l'élément est encore utilisé (jamais de DELETE physique).
    """

    dependances_ignorees = ()

    def perform_create(self, serializer):
        serializer.save().refresh_from_db()

    def perform_update(self, serializer):
        serializer.save().refresh_from_db()

    def perform_destroy(self, instance):
        verifier_dependances(instance, ignorer=self.dependances_ignorees)
        instance.supprimer()

    def destroy(self, request, *args, **kwargs):
        self.perform_destroy(self.get_object())
        return Response(status=204)

from django.db import models

from core.models import Utilisateur


class SyncOperation(models.Model):
    """Opération reçue d'un client hors ligne (table ispat.sync_operation, managed = False)."""

    op_id = models.UUIDField(primary_key=True)
    utilisateur = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="utilisateur_id",
                                    related_name="operations_sync")
    table_nom = models.TextField()
    action = models.TextField()
    enregistrement_id = models.UUIDField(null=True)
    statut = models.TextField()
    code_http = models.SmallIntegerField(null=True)
    reponse = models.JSONField(null=True)
    recu_le = models.DateTimeField(auto_now_add=True)

    class Meta:
        managed = False
        db_table = "sync_operation"

"""
Base des serializers des tables synchronisées.

  * Colonnes techniques en lecture seule (alimentées par les triggers PostgreSQL).
  * `id` accepté à la création (UUID généré hors ligne par le client), ignoré en modification.
"""
from rest_framework import serializers

CHAMPS_TECHNIQUES = ["created_at", "updated_at", "deleted_at", "version", "sync_seq", "created_by", "updated_by"]


def champs(*noms):
    """Liste complète des champs : id + champs métier + colonnes techniques."""
    return ["id", *noms, *CHAMPS_TECHNIQUES]


class SerializerSynchro(serializers.ModelSerializer):
    def get_fields(self):
        champs_serializer = super().get_fields()
        for nom in CHAMPS_TECHNIQUES:
            if nom in champs_serializer:
                champs_serializer[nom].read_only = True
        if "id" in champs_serializer:
            champs_serializer["id"].required = False
        return champs_serializer

    def update(self, instance, validated_data):
        validated_data.pop("id", None)
        return super().update(instance, validated_data)

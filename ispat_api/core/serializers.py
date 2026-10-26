from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import Utilisateur


class UtilisateurMoiSerializer(serializers.ModelSerializer):
    roles = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()

    class Meta:
        model = Utilisateur
        fields = ["id", "login", "nom", "prenoms", "email", "telephone", "roles", "permissions"]

    def get_roles(self, obj):
        return sorted(obj.codes_roles())

    def get_permissions(self, obj):
        return sorted(obj.codes_permissions())


class ConnexionSerializer(TokenObtainPairSerializer):
    """
    Réponse de connexion : jetons JWT + profil + rôles + permissions.
    Le front Angular met le profil en cache (IndexedDB) pour appliquer les droits hors ligne.
    """

    default_error_messages = {"no_active_account": "Identifiant ou mot de passe incorrect."}

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["login"] = user.login
        token["nom_complet"] = user.nom_complet
        token["roles"] = sorted(user.codes_roles())
        return token

    def validate(self, attrs):
        donnees = super().validate(attrs)
        donnees["utilisateur"] = UtilisateurMoiSerializer(self.user).data
        return donnees

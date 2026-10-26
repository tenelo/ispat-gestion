from django.db import connection
from django.utils import timezone
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.views import TokenObtainPairView

from .mixins import VueISPAT
from .serializers import ConnexionSerializer, UtilisateurMoiSerializer


class SanteView(VueISPAT):
    """GET /api/sante/ — disponibilité de l'API et de la base (utilisé par le front pour détecter le mode en ligne)."""

    authentication_classes = []
    permission_classes = [AllowAny]
    permission_libre = True

    def get(self, request):
        with connection.cursor() as curseur:
            curseur.execute("SELECT last_value FROM ispat.sync_seq")
            sync_seq = curseur.fetchone()[0]
        return Response({"statut": "ok", "heure_serveur": timezone.now(), "sync_seq": sync_seq})


class ConnexionView(TokenObtainPairView):
    """POST /api/auth/connexion/  {login, password} -> {access, refresh, utilisateur}"""

    serializer_class = ConnexionSerializer


class MoiView(VueISPAT):
    """GET /api/auth/moi/ — profil, rôles et permissions de l'utilisateur connecté."""

    permission_classes = [IsAuthenticated]
    permission_libre = True

    def get(self, request):
        return Response(UtilisateurMoiSerializer(request.user).data)

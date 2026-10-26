from django.urls import path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenRefreshView

from .administration import MonMotDePasseView, PermissionViewSet, RoleViewSet, UtilisateurViewSet
from .views import ConnexionView, MoiView, SanteView

routeur = DefaultRouter(trailing_slash=True)
routeur.include_root_view = False
routeur.register("utilisateurs", UtilisateurViewSet, basename="utilisateur")
routeur.register("roles", RoleViewSet, basename="role")
routeur.register("permissions", PermissionViewSet, basename="permission")

urlpatterns = [
    path("sante/", SanteView.as_view(), name="sante"),
    path("auth/connexion/", ConnexionView.as_view(), name="auth-connexion"),
    path("auth/rafraichir/", TokenRefreshView.as_view(), name="auth-rafraichir"),
    path("auth/moi/", MoiView.as_view(), name="auth-moi"),
    path("auth/mot-de-passe/", MonMotDePasseView.as_view(), name="auth-mot-de-passe"),
    *routeur.urls,
]

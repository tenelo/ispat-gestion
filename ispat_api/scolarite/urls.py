from django.urls import path
from rest_framework.routers import DefaultRouter

from . import listes, views

routeur = DefaultRouter()
routeur.register("etudiants", views.EtudiantViewSet, basename="etudiant")
routeur.register("contacts", views.ContactEtudiantViewSet, basename="contact-etudiant")
routeur.register("inscriptions", views.InscriptionViewSet, basename="inscription")
routeur.register("pieces", views.PieceJointeViewSet, basename="piece-jointe")

urlpatterns = [
    path("listes/classe/", listes.ListeClasseView.as_view(), name="liste-classe"),
    path("listes/sexe/", listes.ListeSexeView.as_view(), name="liste-sexe"),
    path("listes/statut/", listes.ListeStatutView.as_view(), name="liste-statut"),
    path("listes/effectifs/", listes.EffectifsView.as_view(), name="liste-effectifs"),
    path("listes/notation/", listes.ListeNotationView.as_view(), name="liste-notation"),
    *routeur.urls,
]

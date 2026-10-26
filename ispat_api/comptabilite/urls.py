from django.urls import path
from rest_framework.routers import DefaultRouter

from . import situation, views

routeur = DefaultRouter()
routeur.register("frais", views.FraisInscriptionViewSet, basename="frais-inscription")
routeur.register("prises-en-charge", views.PriseEnChargeViewSet, basename="prise-en-charge")
routeur.register("versements", views.VersementViewSet, basename="versement")
routeur.register("mouvements", views.MouvementCaisseViewSet, basename="mouvement-caisse")

urlpatterns = [
    path("situation/", situation.SituationListeView.as_view(), name="situation-liste"),
    path("situation/classes/", situation.SituationClassesView.as_view(), name="situation-classes"),
    path("situation/<uuid:inscription_id>/", situation.SituationDetailView.as_view(), name="situation-detail"),
    path("caisse/journal/", situation.JournalCaisseView.as_view(), name="caisse-journal"),
    path("caisse/synthese/", situation.SyntheseCaisseView.as_view(), name="caisse-synthese"),
    *routeur.urls,
]

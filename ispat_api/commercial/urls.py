from django.urls import path
from rest_framework.routers import DefaultRouter

from . import analyse, views

routeur = DefaultRouter()
routeur.register("campagnes", views.CampagneViewSet, basename="campagne")
routeur.register("prospects", views.ProspectViewSet, basename="prospect")
routeur.register("relances", views.SuiviViewSet, basename="relance")
routeur.register("preinscriptions", views.PreinscriptionViewSet, basename="preinscription")

urlpatterns = [
    path("analyse/", analyse.AnalyseView.as_view(), name="analyse-prospection"),
    *routeur.urls,
]

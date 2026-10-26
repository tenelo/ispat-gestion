from django.urls import path
from rest_framework.routers import DefaultRouter

from . import moyennes, views

routeur = DefaultRouter()
routeur.register("evaluations", views.EvaluationViewSet, basename="evaluation")
routeur.register("notes", views.NoteViewSet, basename="note")
routeur.register("moyennes/matieres", moyennes.MoyenneMatiereViewSet, basename="moyenne-matiere")
routeur.register("moyennes/semestre", moyennes.MoyenneSemestreViewSet, basename="moyenne-semestre")

urlpatterns = [
    path("mes-cours/", views.MesCoursView.as_view(), name="mes-cours"),
    path("historique/", views.HistoriqueView.as_view(), name="historique-modifications"),
    path("moyennes/calculer/", moyennes.CalculerView.as_view(), name="moyennes-calculer"),
    path("moyennes/tableau/", moyennes.TableauView.as_view(), name="moyennes-tableau"),
    path("moyennes/valider/", moyennes.ValiderView.as_view(), name="moyennes-valider"),
    path("moyennes/rouvrir/", moyennes.RouvrirView.as_view(), name="moyennes-rouvrir"),
    *routeur.urls,
]

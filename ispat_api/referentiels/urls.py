from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

routeur = DefaultRouter()
routeur.register("annees", views.AnneeAcademiqueViewSet, basename="annee")
routeur.register("semestres", views.SemestreViewSet, basename="semestre")
routeur.register("filieres", views.FiliereViewSet, basename="filiere")
routeur.register("niveaux", views.NiveauViewSet, basename="niveau")
routeur.register("classes", views.ClasseViewSet, basename="classe")
routeur.register("matieres", views.MatiereViewSet, basename="matiere")
routeur.register("enseignants", views.EnseignantViewSet, basename="enseignant")
routeur.register("enseignements", views.EnseignementViewSet, basename="enseignement")
routeur.register("statuts-etudiant", views.StatutEtudiantViewSet, basename="statut-etudiant")
routeur.register("types-piece", views.TypePieceViewSet, basename="type-piece")
routeur.register("villes", views.VilleViewSet, basename="ville")
routeur.register("ecoles", views.EcoleViewSet, basename="ecole")
routeur.register("types-frais", views.TypeFraisViewSet, basename="type-frais")
routeur.register("tarifs", views.TarifViewSet, basename="tarif")
routeur.register("categories-mouvement", views.CategorieMouvementViewSet, basename="categorie-mouvement")
routeur.register("parametres", views.ParametreViewSet, basename="parametre")

urlpatterns = [
    path("tout/", views.ReferentielsToutView.as_view(), name="referentiels-tout"),
    *routeur.urls,
]

from django.urls import path

from . import views

urlpatterns = [
    path("semestre/", views.BulletinSemestreView.as_view(), name="bulletin-semestre"),
    path("releve/", views.ReleveExamenView.as_view(), name="releve-examen"),
    path("editions/", views.EditionsView.as_view(), name="bulletin-editions"),
    path("editions/<uuid:pk>/fichier/", views.EditionFichierView.as_view(), name="bulletin-edition-fichier"),
]

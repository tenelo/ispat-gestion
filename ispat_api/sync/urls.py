from django.urls import path

from . import views

urlpatterns = [
    path("etat/", views.EtatView.as_view(), name="sync-etat"),
    path("pull/", views.PullView.as_view(), name="sync-pull"),
    path("push/", views.PushView.as_view(), name="sync-push"),
]

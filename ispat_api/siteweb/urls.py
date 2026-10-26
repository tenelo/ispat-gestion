from django.urls import path

from . import views

urlpatterns = [
    path("options/", views.OptionsView.as_view(), name="wp-options"),
    path("preinscriptions/", views.PreinscriptionSiteView.as_view(), name="wp-preinscriptions"),
    path("preinscriptions/<str:wp_entry_id>/pieces/<str:type_code>/", views.PieceSiteView.as_view(),
         name="wp-piece"),
]

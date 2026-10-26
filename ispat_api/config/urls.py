from django.conf import settings
from django.conf.urls.static import static
from django.urls import include, path

urlpatterns = [
    path("api/", include("core.urls")),
    path("api/referentiels/", include("referentiels.urls")),
    path("api/scolarite/", include("scolarite.urls")),
    path("api/comptabilite/", include("comptabilite.urls")),
    path("api/notes/", include("notes.urls")),
    path("api/bulletins/", include("bulletins.urls")),
    path("api/commercial/", include("commercial.urls")),
    path("api/sync/", include("sync.urls")),
    path("api/wp/", include("siteweb.urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

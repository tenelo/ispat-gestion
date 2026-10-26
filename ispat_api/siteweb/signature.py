"""
Authentification du site WordPress par signature HMAC-SHA256 (secret partagé, jamais transmis).

En-têtes envoyés par WordPress :
    X-ISPAT-Horodatage : secondes Unix
    X-ISPAT-Signature  : hex( HMAC_SHA256( secret, horodatage \n MÉTHODE \n chemin?requête \n sha256_hex(corps) ) )

Refus si : secret non configuré, horodatage hors fenêtre (± ISPAT_WP_TOLERANCE s), signature différente,
ou adresse IP hors de ISPAT_WP_IPS (si cette liste est renseignée).
"""
import hashlib
import hmac
import time

from django.conf import settings
from rest_framework.permissions import BasePermission


def calculer_signature(secret, horodatage, methode, chemin, corps):
    message = f"{horodatage}\n{methode.upper()}\n{chemin}\n{hashlib.sha256(corps).hexdigest()}"
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def ip_client(request):
    if getattr(settings, "ISPAT_DERRIERE_PROXY", False):
        transmise = request.META.get("HTTP_X_FORWARDED_FOR", "")
        if transmise:
            return transmise.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "")


class SignatureWordPress(BasePermission):
    message = "Signature du site invalide ou absente."

    def has_permission(self, request, view):
        secret = getattr(settings, "ISPAT_WP_SECRET", "")
        if not secret:
            self.message = "Liaison avec le site non configurée (ISPAT_WP_SECRET)."
            return False
        autorisees = getattr(settings, "ISPAT_WP_IPS", [])
        if autorisees and ip_client(request) not in autorisees:
            self.message = "Adresse non autorisée."
            return False
        horodatage = request.headers.get("X-ISPAT-Horodatage", "")
        signature = request.headers.get("X-ISPAT-Signature", "")
        if not horodatage.isdigit() or not signature:
            return False
        if abs(time.time() - int(horodatage)) > getattr(settings, "ISPAT_WP_TOLERANCE", 300):
            self.message = "Horodatage expiré : vérifier l'horloge du serveur WordPress."
            return False
        attendue = calculer_signature(secret, horodatage, request.method, request.get_full_path(), request.body)
        return hmac.compare_digest(attendue, signature.lower())

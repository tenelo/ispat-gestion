"""
Contrôle et stockage des fichiers (photos, pièces jointes).

  * Le type est déterminé par le CONTENU (signature binaire), pas par l'extension ni par le navigateur.
  * Photos : recadrées à 800 px max, ré-encodées en JPEG (supprime les métadonnées EXIF / GPS).
  * Stockage via default_storage (disque MEDIA_ROOT aujourd'hui, stockage objet possible plus tard).
  * Les fichiers ne sont jamais servis publiquement : téléchargement via l'API, utilisateur authentifié.
"""
import io
import uuid

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.utils import timezone
from PIL import Image, ImageOps, UnidentifiedImageError
from rest_framework import serializers

SIGNATURES = {
    "application/pdf": [b"%PDF"],
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/png": [b"\x89PNG\r\n\x1a\n"],
}
EXTENSIONS = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
TYPES_PIECE = {"application/pdf", "image/jpeg", "image/png"}
TYPES_PHOTO = {"image/jpeg", "image/png", "image/webp"}
PHOTO_TAILLE_PX = 800


def detecter_type(fichier):
    position = fichier.tell()
    entete = fichier.read(16)
    fichier.seek(position)
    for mime, signatures in SIGNATURES.items():
        if any(entete.startswith(s) for s in signatures):
            return mime
    if entete[:4] == b"RIFF" and entete[8:12] == b"WEBP":
        return "image/webp"
    return None


def _verifier_taille(fichier, maximum):
    if fichier.size > maximum:
        raise serializers.ValidationError(
            {"fichier": f"Fichier trop volumineux ({fichier.size // 1024} Ko, maximum {maximum // 1024} Ko)."})


def enregistrer_piece(fichier, dossier="pieces"):
    """Valide et enregistre une pièce jointe (ou un justificatif). Retourne (chemin, mime, taille, nom_origine)."""
    _verifier_taille(fichier, settings.ISPAT_PIECE_TAILLE_MAX)
    mime = detecter_type(fichier)
    if mime not in TYPES_PIECE:
        raise serializers.ValidationError({"fichier": "Formats acceptés : PDF, JPEG, PNG."})
    nom = f"{dossier}/{timezone.localdate():%Y/%m}/{uuid.uuid4().hex}.{EXTENSIONS[mime]}"
    chemin = default_storage.save(nom, fichier)
    nom_origine = (getattr(fichier, "name", None) or nom).split("/")[-1].split("\\")[-1][:200]
    return chemin, mime, fichier.size, nom_origine


def enregistrer_photo(fichier, etudiant_id, ancien_chemin=None):
    """Valide, normalise (JPEG 800 px) et enregistre la photo d'un étudiant. Retourne le chemin."""
    _verifier_taille(fichier, settings.ISPAT_PHOTO_TAILLE_MAX)
    if detecter_type(fichier) not in TYPES_PHOTO:
        raise serializers.ValidationError({"photo": "Formats acceptés : JPEG, PNG, WEBP."})
    try:
        image = Image.open(fichier)
        image = ImageOps.exif_transpose(image)
        image = image.convert("RGB")
        image.thumbnail((PHOTO_TAILLE_PX, PHOTO_TAILLE_PX))
    except (UnidentifiedImageError, OSError) as exc:
        raise serializers.ValidationError({"photo": "Image illisible ou corrompue."}) from exc

    tampon = io.BytesIO()
    image.save(tampon, format="JPEG", quality=85, optimize=True)
    if ancien_chemin and default_storage.exists(ancien_chemin):
        default_storage.delete(ancien_chemin)
    return default_storage.save(f"photos/{etudiant_id}_{uuid.uuid4().hex[:8]}.jpg", ContentFile(tampon.getvalue()))

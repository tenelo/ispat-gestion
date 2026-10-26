"""
Paramètres Django — ISPAT Gestion API.

Base de données : PostgreSQL, schéma `ispat` créé par ispat_gestion_schema.sql.
  * Les tables métier sont gérées par le script SQL (modèles Django managed = False).
  * Les tables techniques de Django (django_migrations, auth_permission...) vont dans `public`.
  * search_path = public, ispat  -> les noms de tables métier se résolvent dans `ispat`.
"""
import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env_list(nom, defaut=""):
    return [v.strip() for v in os.getenv(nom, defaut).split(",") if v.strip()]


SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-uniquement-a-remplacer")
DEBUG = os.getenv("DJANGO_DEBUG", "False").lower() in ("1", "true", "oui", "yes")
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.staticfiles",
    "django.contrib.postgres",          # lookup __unaccent (recherche sans accents)
    "rest_framework",
    "corsheaders",
    "core",
    "referentiels",
    "scolarite",
    "comptabilite",
    "notes",
    "bulletins",
    "commercial",
    "sync",
    "siteweb",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    }
]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("DB_NAME", "ispat_gestion"),
        "USER": os.getenv("DB_USER", "ispat"),
        "PASSWORD": os.getenv("DB_PASSWORD", ""),
        "HOST": os.getenv("DB_HOST", "127.0.0.1"),
        "PORT": os.getenv("DB_PORT", "5432"),
        "OPTIONS": {"options": "-c search_path=public,ispat"},
        # Chaque requête HTTP = une transaction : indispensable pour SET LOCAL app.user_id / app.motif
        "ATOMIC_REQUESTS": True,
        "CONN_MAX_AGE": 60,
    }
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Utilisateur = table ispat.utilisateur
AUTH_USER_MODEL = "core.Utilisateur"
AUTHENTICATION_BACKENDS = ["core.backends.LoginInsensibleCasseBackend"]
# Unicité du login assurée en base par l'index unique lower(login) (insensible à la casse)
SILENCED_SYSTEM_CHECKS = ["auth.W004"]

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "fr-fr"
TIME_ZONE = "Africa/Abidjan"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "media/"
MEDIA_ROOT = Path(os.getenv("MEDIA_ROOT", BASE_DIR / "media"))   # photos, pièces jointes, bulletins PDF

# Limites des fichiers envoyés
ISPAT_PHOTO_TAILLE_MAX = 3 * 1024 * 1024        # 3 Mo (photo ré-encodée en JPEG 800 px)
ISPAT_PIECE_TAILLE_MAX = 5 * 1024 * 1024        # 5 Mo par pièce jointe (PDF, JPEG, PNG)
DATA_UPLOAD_MAX_MEMORY_SIZE = 6 * 1024 * 1024

# Liaison avec le site WordPress (pré-inscriptions en ligne) — voir siteweb/signature.py
ISPAT_WP_SECRET = os.getenv("ISPAT_WP_SECRET", "")             # même valeur que ISPAT_API_SECRET dans wp-config.php
ISPAT_WP_TOLERANCE = int(os.getenv("ISPAT_WP_TOLERANCE", "300"))  # écart d'horloge toléré (secondes)
ISPAT_WP_IPS = env_list("ISPAT_WP_IPS", "")                    # facultatif : IP du serveur WordPress
ISPAT_DERRIERE_PROXY = os.getenv("ISPAT_DERRIERE_PROXY", "False").lower() in ("1", "true", "oui", "yes")

# Logo des documents officiels (bulletins, relevés) : PNG à fond transparent
ISPAT_LOGO = Path(os.getenv("ISPAT_LOGO", BASE_DIR / "ressources" / "logo_ispat.png"))

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
        "core.permissions.PermissionISPAT",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 50,
    "DATETIME_FORMAT": "%Y-%m-%dT%H:%M:%S%z",
    "EXCEPTION_HANDLER": "core.exceptions.gestionnaire_exceptions",
    "COERCE_DECIMAL_TO_STRING": False,     # montants et coefficients en nombres JSON
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=int(os.getenv("JWT_ACCESS_MINUTES", "60"))),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=int(os.getenv("JWT_REFRESH_DAYS", "7"))),
    "ROTATE_REFRESH_TOKENS": True,
    "UPDATE_LAST_LOGIN": True,
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
    "AUTH_HEADER_TYPES": ("Bearer",),
}

CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS", "http://localhost:4200")
CORS_ALLOW_HEADERS = [
    "accept", "authorization", "content-type", "origin", "x-requested-with",
    "x-motif",            # motif de modification d'une note / moyenne validée
]

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}

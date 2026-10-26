#!/bin/sh
# Démarrage de l'API : attente de la base, migrations Django, Gunicorn.
set -eu

python - <<'PY'
import os, time, psycopg
for essai in range(60):
    try:
        psycopg.connect(host=os.environ["DB_HOST"], port=os.environ.get("DB_PORT", "5432"),
                        dbname=os.environ["DB_NAME"], user=os.environ["DB_USER"],
                        password=os.environ["DB_PASSWORD"], connect_timeout=3).close()
        break
    except Exception as e:
        print(f"Base indisponible ({e.__class__.__name__}), nouvel essai…", flush=True)
        time.sleep(2)
else:
    raise SystemExit("Base injoignable après 2 minutes.")
PY

python manage.py migrate --noinput -v 0

# Dossiers des fichiers (le volume peut être vide au premier démarrage).
mkdir -p "${MEDIA_ROOT:-/data/media}"

exec gunicorn config.wsgi:application \
     --bind 0.0.0.0:8000 \
     --workers "${GUNICORN_WORKERS:-3}" \
     --timeout 120 \
     --forwarded-allow-ips "*" \
     --access-logfile - \
     --error-logfile -

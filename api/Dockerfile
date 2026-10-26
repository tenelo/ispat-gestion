# API ISPAT Gestion — Django + Gunicorn
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY ispat_api/requirements.txt /app/requirements.txt
RUN pip install -r requirements.txt gunicorn==23.0.0

COPY ispat_api/ /app/
COPY api/entrypoint.sh /entrypoint.sh

RUN rm -f /app/.env \
 && useradd --system --uid 1000 --home /app ispat \
 && mkdir -p /data/media \
 && chown -R ispat:ispat /data /app \
 && chmod +x /entrypoint.sh

USER ispat
EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]

"""
Analyse de la prospection — GET /api/commercial/analyse/   (JSON, ou ?export=xlsx | csv)

Filtres : ?campagne=<id> | ?annee=active|<id> ; ?du=&au= (date de contact) ; ?agent=moi|<id> ; ?source= ; ?filiere=

Indicateurs par prospect :
  contacté    : statut ≠ NOUVEAU ou au moins une relance
  pré-inscrit : pré-inscription enregistrée, ou inscription (même en attente), ou statut PREINSCRIT / INSCRIT
  inscrit     : inscription VALIDÉE (ou abandon après validation) rattachée au prospect
Taux :
  taux de pré-inscription = pré-inscrits / prospects
  taux d'inscription      = inscrits / prospects            (« taux de prospects inscrits »)
  taux de conversion      = inscrits / pré-inscrits
Axes : global, ville, école, genre, filière souhaitée, source, agent, mois de contact.
"""
from django.db import connection
from django.shortcuts import get_object_or_404
from django.utils.dateparse import parse_date
from rest_framework import serializers
from rest_framework.response import Response

from core.exports import reponse_export
from referentiels.models import AnneeAcademique
from scolarite.listes import VueListe

from .models import CampagneProspection

AXES = [
    ("ville", "Ville", "ville"),
    ("ecole", "École", "ecole"),
    ("genre", "Genre", "CASE sexe WHEN 'F' THEN 'Féminin' ELSE 'Masculin' END"),
    ("filiere", "Filière souhaitée", "filiere"),
    ("source", "Source", "source_libelle"),
    ("agent", "Agent", "agent"),
]
SOURCES = {"TERRAIN": "Terrain", "SITE_WEB": "Site web", "SALON": "Salon / forum",
           "RESEAUX_SOCIAUX": "Réseaux sociaux", "RECOMMANDATION": "Recommandation", "AUTRE": "Autre"}


def _taux(n, d):
    return round(100.0 * n / d, 1) if d else None


def _indicateurs(nb, contactes, preinscrits, inscrits, perdus):
    return {"prospects": nb, "contactes": contactes, "preinscrits": preinscrits, "inscrits": inscrits,
            "perdus": perdus, "taux_contact": _taux(contactes, nb), "taux_preinscription": _taux(preinscrits, nb),
            "taux_inscription": _taux(inscrits, nb), "taux_conversion": _taux(inscrits, preinscrits)}


class AnalyseView(VueListe):
    permission_lire = "commercial.analyse.lire"
    permission_exporter = "commercial.analyse.exporter"

    def perimetre(self):
        p = self.request.query_params
        conditions, params, libelles, campagne, annee = ["p.deleted_at IS NULL"], [], [], None, None
        if p.get("campagne"):
            campagne = get_object_or_404(CampagneProspection.objects.select_related("annee"), pk=p["campagne"])
            conditions.append("p.campagne_id = %s")
            params.append(campagne.pk)
            libelles.append(f"Campagne « {campagne.libelle} »")
            annee = campagne.annee
        elif p.get("annee"):
            annee = AnneeAcademique.objects.filter(est_active=True).first() if p["annee"] == "active" \
                else get_object_or_404(AnneeAcademique, pk=p["annee"])
            if annee is None:
                raise serializers.ValidationError({"annee": "Aucune année active."})
            conditions.append("c.annee_id = %s")
            params.append(annee.pk)
            libelles.append(f"Année {annee.libelle}")
        for cle, sql in (("du", "p.date_contact >= %s"), ("au", "p.date_contact <= %s")):
            if p.get(cle):
                if parse_date(p[cle]) is None:
                    raise serializers.ValidationError({cle: "Date au format AAAA-MM-JJ."})
                conditions.append(sql)
                params.append(p[cle])
                libelles.append(f"{'depuis' if cle == 'du' else 'jusqu’au'} {p[cle]}")
        if p.get("agent"):
            conditions.append("p.agent_id = %s")
            params.append(self.request.user.pk if p["agent"] == "moi" else p["agent"])
        if p.get("source"):
            conditions.append("p.source = %s")
            params.append(p["source"].upper())
        if p.get("filiere"):
            conditions.append("p.filiere_souhaitee_id = %s")
            params.append(p["filiere"])
        return conditions, params, campagne, annee, " · ".join(libelles) or "Tous les prospects"

    def base_sql(self, conditions):
        return f"""
            WITH base AS (
              SELECT p.id, p.sexe, p.date_contact,
                     coalesce(v.libelle, 'Non renseignée') AS ville,
                     coalesce(ec.nom, 'Non renseignée') AS ecole,
                     coalesce(f.code || ' — ' || f.libelle, 'Sans préférence') AS filiere,
                     CASE p.source {' '.join(f"WHEN '{k}' THEN '{v}'" for k, v in SOURCES.items())}
                          ELSE p.source END AS source_libelle,
                     coalesce(u.nom || ' ' || u.prenoms, 'Non attribué') AS agent,
                     (p.statut <> 'NOUVEAU'
                      OR EXISTS (SELECT 1 FROM ispat.suivi_prospect s
                                  WHERE s.prospect_id = p.id AND s.deleted_at IS NULL)) AS est_contacte,
                     (p.statut IN ('PREINSCRIT', 'INSCRIT')
                      OR EXISTS (SELECT 1 FROM ispat.preinscription pr
                                  WHERE pr.prospect_id = p.id AND pr.deleted_at IS NULL)
                      OR EXISTS (SELECT 1 FROM ispat.inscription i
                                  WHERE i.prospect_id = p.id AND i.deleted_at IS NULL AND i.etat <> 'ANNULEE'))
                       AS est_preinscrit,
                     EXISTS (SELECT 1 FROM ispat.inscription i
                              WHERE i.prospect_id = p.id AND i.deleted_at IS NULL
                                AND i.etat IN ('VALIDEE', 'ABANDON')) AS est_inscrit,
                     (p.statut = 'PERDU') AS est_perdu
                FROM ispat.prospect p
                LEFT JOIN ispat.campagne_prospection c ON c.id = p.campagne_id
                LEFT JOIN ispat.ville v ON v.id = p.ville_id
                LEFT JOIN ispat.ecole ec ON ec.id = p.ecole_id
                LEFT JOIN ispat.filiere f ON f.id = p.filiere_souhaitee_id
                LEFT JOIN ispat.utilisateur u ON u.id = p.agent_id
               WHERE {' AND '.join(conditions)})"""

    COMPTES = ("count(*), count(*) FILTER (WHERE est_contacte), count(*) FILTER (WHERE est_preinscrit), "
               "count(*) FILTER (WHERE est_inscrit), count(*) FILTER (WHERE est_perdu)")

    def get(self, request):
        fmt = self.format_export()
        conditions, params, campagne, annee, libelle = self.perimetre()
        base = self.base_sql(conditions)
        resultat = {"perimetre": libelle}
        with connection.cursor() as c:
            c.execute(f"{base} SELECT {self.COMPTES} FROM base", params)
            resultat["global"] = _indicateurs(*c.fetchone())
            for cle, _, expression in AXES:
                c.execute(f"{base} SELECT {expression} AS modalite, {self.COMPTES} FROM base "
                          f"GROUP BY 1 ORDER BY 2 DESC, 1", params)
                resultat[f"par_{cle}"] = [{"modalite": r[0], **_indicateurs(*r[1:])} for r in c.fetchall()]
            c.execute(f"{base} SELECT to_char(date_trunc('month', date_contact), 'YYYY-MM'), {self.COMPTES} "
                      "FROM base GROUP BY 1 ORDER BY 1", params)
            resultat["par_mois"] = [{"mois": r[0], **_indicateurs(*r[1:])} for r in c.fetchall()]

            if annee is not None:
                c.execute("""SELECT count(*), count(*) FILTER (WHERE pr.statut = 'EN_ATTENTE'),
                                    count(*) FILTER (WHERE pr.statut = 'VALIDEE'),
                                    count(*) FILTER (WHERE pr.statut = 'REJETEE'),
                                    count(*) FILTER (WHERE pr.statut = 'CONVERTIE'),
                                    count(*) FILTER (WHERE i.etat IN ('VALIDEE', 'ABANDON')),
                                    count(*) FILTER (WHERE pr.prospect_id IS NULL)
                               FROM ispat.preinscription pr
                               LEFT JOIN ispat.inscription i ON i.id = pr.inscription_id AND i.deleted_at IS NULL
                              WHERE pr.deleted_at IS NULL AND pr.annee_id = %s""", [annee.pk])
                t, att, val, rej, conv, insc, sans = c.fetchone()
                c.execute("""SELECT source, count(*) FROM ispat.preinscription
                              WHERE deleted_at IS NULL AND annee_id = %s GROUP BY 1 ORDER BY 2 DESC""", [annee.pk])
                resultat["preinscriptions"] = {
                    "annee": annee.libelle, "total": t, "en_attente": att, "dossiers_acceptes": val, "rejetees": rej,
                    "inscrites": conv, "inscriptions_validees": insc, "sans_prospect": sans,
                    "taux_transformation": _taux(insc, t),
                    "par_source": [{"source": r[0], "nombre": r[1]} for r in c.fetchall()],
                }

        if campagne is not None:
            resultat["campagne"] = {"id": campagne.pk, "libelle": campagne.libelle, "objectif": campagne.objectif,
                                    "taux_objectif": _taux(resultat["global"]["inscrits"], campagne.objectif)}

        if fmt:
            entetes = ["Axe", "Modalité", "Prospects", "Contactés", "Pré-inscrits", "Inscrits", "Perdus",
                       "Taux de pré-inscription (%)", "Taux d'inscription (%)", "Conversion pré-inscrits (%)"]

            def ligne(axe, modalite, x):
                return [axe, modalite, x["prospects"], x["contactes"], x["preinscrits"], x["inscrits"], x["perdus"],
                        x["taux_preinscription"], x["taux_inscription"], x["taux_conversion"]]

            lignes = [ligne("Global", "Ensemble", resultat["global"])]
            for cle, titre, _ in AXES:
                lignes += [ligne(titre, x["modalite"], x) for x in resultat[f"par_{cle}"]]
            lignes += [ligne("Mois de contact", x["mois"], x) for x in resultat["par_mois"]]
            if campagne is not None and campagne.objectif:
                lignes.append(["Objectif", f"{campagne.objectif} inscrits", None, None, None,
                               resultat["global"]["inscrits"], None, None, resultat["campagne"]["taux_objectif"], None])
            return reponse_export(fmt, "Analyse de la prospection", libelle, entetes, lignes, "analyse_prospection")
        return Response(resultat)

"""
Situation financière et caisse — /api/comptabilite/...   (JSON, ou ?export=xlsx | csv)

  situation/?annee=active&classe=&statut=<code>&etat=VALIDEE|ABANDON&solde=debiteur|solde&q=   par étudiant
  situation/classes/?annee=active                                          par classe (taux de recouvrement)
  situation/{inscription_id}/                                              détail d'une inscription
  caisse/journal/?du=AAAA-MM-JJ&au=AAAA-MM-JJ&mode=                        journal avec solde progressif
  caisse/synthese/?du=&au=                                                 totaux par catégorie, mode, mois
"""
from datetime import date
from decimal import Decimal

from django.db import connection
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from core.exports import FORMATS_EXPORT, reponse_export
from core.mixins import VueISPAT
from referentiels.models import AnneeAcademique
from scolarite.models import Inscription
from scolarite.serializers import InscriptionSerializer

from .calculs import situation_inscription
from .models import PriseEnCharge, Versement
from .serializers import PriseEnChargeSerializer, VersementSerializer

ZERO = Decimal("0")


class VueFinanciere(VueISPAT):
    permission_lire = None
    permission_exporter = None
    permissions_supplementaires = ()        # droits exigés EN PLUS (tous)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        lire = self.permission_lire if isinstance(self.permission_lire, (list, tuple)) else [self.permission_lire]
        self.permissions_requises = {"GET": list(lire)}

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        manquants = [c for c in self.permissions_supplementaires if not request.user.a_permission(c)]
        if manquants:
            raise PermissionDenied(f"Droits requis : {', '.join(manquants)}.")

    def format_export(self):
        fmt = (self.request.query_params.get("export") or "").lower()
        if not fmt:
            return None
        if fmt not in FORMATS_EXPORT:
            raise serializers.ValidationError({"export": "Formats possibles : xlsx, csv."})
        codes = self.permission_exporter if isinstance(self.permission_exporter, (list, tuple)) \
            else [self.permission_exporter]
        if not all(self.request.user.a_permission(c) for c in codes):
            raise PermissionDenied("Vous n'avez pas la permission d'exporter.")
        return fmt

    def annee(self):
        valeur = self.request.query_params.get("annee") or "active"
        if valeur == "active":
            annee = AnneeAcademique.objects.filter(est_active=True).first()
            if annee is None:
                raise serializers.ValidationError({"annee": "Aucune année académique active."})
            return annee
        return get_object_or_404(AnneeAcademique, pk=valeur)

    def periode(self):
        p = self.request.query_params
        aujourd_hui = timezone.localdate()
        du = parse_date(p["du"]) if p.get("du") else date(aujourd_hui.year, aujourd_hui.month, 1)
        au = parse_date(p["au"]) if p.get("au") else aujourd_hui
        if du is None or au is None:
            raise serializers.ValidationError("Dates au format AAAA-MM-JJ.")
        if au < du:
            raise serializers.ValidationError("La date de fin précède la date de début.")
        return du, au


def _taux(verse, du):
    return round(float(verse) * 100 / float(du), 1) if du else None


# --------------------------------------------------------------------------------------
# Situation financière
# --------------------------------------------------------------------------------------

class SituationListeView(VueFinanciere):
    permission_lire = "comptabilite.situation.lire"
    permission_exporter = "comptabilite.situation.exporter"

    def get(self, request):
        annee = self.annee()
        fmt = self.format_export()
        p = request.query_params
        sql = ["""SELECT s.inscription_id, s.matricule, s.nom, s.prenoms, s.classe, s.statut, s.etat, i.classe_id,
                         s.total_du, s.part_prise_en_charge, s.verse_etudiant, s.verse_prise_en_charge,
                         s.reste_etudiant, s.reste_prise_en_charge
                    FROM ispat.v_situation_financiere s
                    JOIN ispat.inscription i ON i.id = s.inscription_id
                    JOIN ispat.statut_etudiant st ON st.id = i.statut_etudiant_id
                   WHERE s.annee_id = %s"""]
        params = [annee.pk]
        if p.get("classe"):
            sql.append("AND i.classe_id = %s")
            params.append(p["classe"])
        if p.get("statut"):
            sql.append("AND st.code = %s")
            params.append(p["statut"].upper())
        if p.get("etat"):
            sql.append("AND s.etat = %s")
            params.append(p["etat"].upper())
        solde = (p.get("solde") or "").lower()
        if solde == "debiteur":
            sql.append("AND s.reste_etudiant > 0")
        elif solde == "solde":
            sql.append("AND s.reste_etudiant = 0")
        elif solde:
            raise serializers.ValidationError({"solde": "Valeurs possibles : debiteur, solde."})
        if p.get("q"):
            sql.append("AND (ispat.sans_accent(s.nom || ' ' || s.prenoms) LIKE '%%' || ispat.sans_accent(%s) || '%%' "
                       "OR upper(s.matricule) LIKE upper(%s) || '%%')")
            params += [p["q"].strip(), p["q"].strip()]
        sql.append("ORDER BY s.classe, s.nom, s.prenoms")

        with connection.cursor() as c:
            c.execute(" ".join(sql), params)
            colonnes = [d[0] for d in c.description]
            lignes = [dict(zip(colonnes, r)) for r in c.fetchall()]

        cles = ("total_du", "part_prise_en_charge", "verse_etudiant", "verse_prise_en_charge", "reste_etudiant",
                "reste_prise_en_charge")
        totaux = {k: sum((l[k] for l in lignes), ZERO) for k in cles}
        totaux["taux_recouvrement"] = _taux(totaux["verse_etudiant"] + totaux["verse_prise_en_charge"],
                                            totaux["total_du"])

        if fmt:
            entetes = ["Matricule", "Nom", "Prénoms", "Classe", "Statut", "État", "Total dû", "Prise en charge",
                       "Versé étudiant", "Versé organismes", "Reste étudiant", "Reste organismes"]
            donnees = [[l["matricule"], l["nom"], l["prenoms"], l["classe"], l["statut"],
                        "Abandon" if l["etat"] == "ABANDON" else "Inscrit", *[l[k] for k in cles]] for l in lignes]
            donnees.append(["TOTAL", "", "", "", "", "", *[totaux[k] for k in cles]])
            return reponse_export(fmt, "Situation financière", f"Année {annee.libelle} · {len(lignes)} étudiant(s)",
                                  entetes, donnees, f"situation_financiere_{annee.libelle}")
        return Response({"annee": annee.libelle, "nombre": len(lignes), "totaux": totaux, "etudiants": lignes})


class SituationClassesView(VueFinanciere):
    permission_lire = "comptabilite.situation.lire"
    permission_exporter = "comptabilite.situation.exporter"

    def get(self, request):
        annee = self.annee()
        fmt = self.format_export()
        with connection.cursor() as c:
            c.execute("""
                SELECT i.classe_id, s.classe, count(*) AS effectif,
                       sum(s.total_du) AS total_du, sum(s.part_prise_en_charge) AS part_prise_en_charge,
                       sum(s.verse_etudiant + s.verse_prise_en_charge) AS verse_total,
                       sum(s.reste_etudiant) AS reste_etudiant, sum(s.reste_prise_en_charge) AS reste_prise_en_charge,
                       count(*) FILTER (WHERE s.reste_etudiant > 0) AS nb_debiteurs
                  FROM ispat.v_situation_financiere s
                  JOIN ispat.inscription i ON i.id = s.inscription_id
                 WHERE s.annee_id = %s
                 GROUP BY i.classe_id, s.classe ORDER BY s.classe""", [annee.pk])
            colonnes = [d[0] for d in c.description]
            classes = [dict(zip(colonnes, r)) for r in c.fetchall()]
        for cl in classes:
            cl["taux_recouvrement"] = _taux(cl["verse_total"], cl["total_du"])
        cles = ("effectif", "total_du", "part_prise_en_charge", "verse_total", "reste_etudiant",
                "reste_prise_en_charge", "nb_debiteurs")
        totaux = {k: sum((cl[k] for cl in classes), 0) for k in cles}
        totaux["taux_recouvrement"] = _taux(totaux["verse_total"], totaux["total_du"])

        if fmt:
            entetes = ["Classe", "Effectif", "Total dû", "Prise en charge", "Total versé", "Reste étudiants",
                       "Reste organismes", "Débiteurs", "Recouvrement (%)"]
            donnees = [[cl["classe"], *[cl[k] for k in cles], cl["taux_recouvrement"]] for cl in classes]
            donnees.append(["TOTAL", *[totaux[k] for k in cles], totaux["taux_recouvrement"]])
            return reponse_export(fmt, "Situation par classe", f"Année {annee.libelle}", entetes, donnees,
                                  f"situation_classes_{annee.libelle}")
        return Response({"annee": annee.libelle, "totaux": totaux, "classes": classes})


class SituationDetailView(VueFinanciere):
    permission_lire = ["comptabilite.situation.lire", "comptabilite.versement.lire"]

    def get(self, request, inscription_id):
        inscription = get_object_or_404(
            Inscription.objects.select_related("etudiant", "classe", "annee", "statut_etudiant", "valide_par"),
            pk=inscription_id)
        contexte = {"request": request}
        versements = Versement.objects.filter(inscription=inscription).select_related(
            "inscription__etudiant", "inscription__classe", "inscription__annee", "type_frais", "prise_en_charge",
            "encaisse_par")
        pecs = PriseEnCharge.objects.filter(inscription=inscription).select_related("inscription__etudiant",
                                                                                    "type_frais")
        situation = situation_inscription(inscription.pk)
        situation["taux_recouvrement"] = _taux(situation["verse_total"], situation["total_du"])
        return Response({
            "inscription": InscriptionSerializer(inscription, context=contexte).data,
            "situation": situation,
            "prises_en_charge": PriseEnChargeSerializer(pecs, many=True, context=contexte).data,
            "versements": VersementSerializer(versements, many=True, context=contexte).data,
        })


# --------------------------------------------------------------------------------------
# Caisse
# --------------------------------------------------------------------------------------

class JournalCaisseView(VueFinanciere):
    permission_lire = "comptabilite.entree.lire"
    permissions_supplementaires = ("comptabilite.sortie.lire",)
    permission_exporter = ["comptabilite.entree.exporter", "comptabilite.sortie.exporter"]

    def get(self, request):
        du, au = self.periode()
        fmt = self.format_export()
        mode = request.query_params.get("mode")
        filtre_mode, params_mode = ("AND m.mode_paiement = %s", [mode]) if mode else ("", [])
        with connection.cursor() as c:
            c.execute(f"""SELECT coalesce(sum(CASE WHEN sens = 'ENTREE' THEN montant ELSE -montant END), 0)
                            FROM ispat.mouvement_caisse m
                           WHERE deleted_at IS NULL AND NOT annule AND date_mouvement < %s {filtre_mode}""",
                      [du, *params_mode])
            solde_initial = c.fetchone()[0]
            c.execute(f"""SELECT m.id, m.date_mouvement, m.sens, cm.libelle, m.libelle, m.tiers, m.mode_paiement,
                                 m.reference, m.montant, m.versement_id IS NOT NULL
                            FROM ispat.mouvement_caisse m
                            JOIN ispat.categorie_mouvement cm ON cm.id = m.categorie_id
                           WHERE m.deleted_at IS NULL AND NOT m.annule AND m.date_mouvement BETWEEN %s AND %s
                                 {filtre_mode}
                           ORDER BY m.date_mouvement, m.created_at""", [du, au, *params_mode])
            brut = c.fetchall()

        solde, lignes = solde_initial, []
        for (ident, jour, sens, categorie, libelle, tiers, mode_p, reference, montant, auto) in brut:
            solde = solde + montant if sens == "ENTREE" else solde - montant
            lignes.append({"id": ident, "date": jour, "sens": sens, "categorie": categorie, "libelle": libelle,
                           "tiers": tiers, "mode_paiement": mode_p, "reference": reference,
                           "entree": montant if sens == "ENTREE" else None,
                           "sortie": montant if sens == "SORTIE" else None, "solde": solde, "automatique": auto})
        total_entrees = sum((l["entree"] or ZERO for l in lignes), ZERO)
        total_sorties = sum((l["sortie"] or ZERO for l in lignes), ZERO)

        if fmt:
            entetes = ["Date", "Catégorie", "Libellé", "Tiers", "Mode", "Référence", "Entrée", "Sortie", "Solde"]
            donnees = [[du, "", "Solde initial", "", "", "", None, None, solde_initial]]
            donnees += [[l["date"], l["categorie"], l["libelle"], l["tiers"], l["mode_paiement"], l["reference"],
                         l["entree"], l["sortie"], l["solde"]] for l in lignes]
            donnees.append([au, "", "TOTAUX / SOLDE FINAL", "", "", "", total_entrees, total_sorties, solde])
            return reponse_export(fmt, "Journal de caisse", f"Du {du:%d/%m/%Y} au {au:%d/%m/%Y}", entetes, donnees,
                                  f"journal_caisse_{du}_{au}")
        return Response({"du": du, "au": au, "solde_initial": solde_initial, "total_entrees": total_entrees,
                         "total_sorties": total_sorties, "solde_final": solde, "lignes": lignes})


class SyntheseCaisseView(VueFinanciere):
    permission_lire = "comptabilite.entree.lire"
    permissions_supplementaires = ("comptabilite.sortie.lire",)

    def get(self, request):
        du, au = self.periode()
        base = ("FROM ispat.mouvement_caisse m JOIN ispat.categorie_mouvement cm ON cm.id = m.categorie_id "
                "WHERE m.deleted_at IS NULL AND NOT m.annule AND m.date_mouvement BETWEEN %s AND %s")
        with connection.cursor() as c:
            c.execute(f"SELECT m.sens, cm.code, cm.libelle, count(*), sum(m.montant) {base} "
                      "GROUP BY m.sens, cm.code, cm.libelle ORDER BY m.sens, sum(m.montant) DESC", [du, au])
            par_categorie = [{"sens": r[0], "code": r[1], "libelle": r[2], "nombre": r[3], "total": r[4]}
                             for r in c.fetchall()]
            c.execute(f"SELECT m.mode_paiement, "
                      "coalesce(sum(m.montant) FILTER (WHERE m.sens = 'ENTREE'), 0), "
                      f"coalesce(sum(m.montant) FILTER (WHERE m.sens = 'SORTIE'), 0) {base} "
                      "GROUP BY m.mode_paiement ORDER BY 1", [du, au])
            par_mode = [{"mode_paiement": r[0], "entrees": r[1], "sorties": r[2]} for r in c.fetchall()]
            c.execute(f"SELECT date_trunc('month', m.date_mouvement)::date, "
                      "coalesce(sum(m.montant) FILTER (WHERE m.sens = 'ENTREE'), 0), "
                      f"coalesce(sum(m.montant) FILTER (WHERE m.sens = 'SORTIE'), 0) {base} "
                      "GROUP BY 1 ORDER BY 1", [du, au])
            par_mois = [{"mois": r[0], "entrees": r[1], "sorties": r[2], "solde": r[1] - r[2]} for r in c.fetchall()]
        entrees = sum((x["total"] for x in par_categorie if x["sens"] == "ENTREE"), ZERO)
        sorties = sum((x["total"] for x in par_categorie if x["sens"] == "SORTIE"), ZERO)
        return Response({"du": du, "au": au, "total_entrees": entrees, "total_sorties": sorties,
                         "resultat": entrees - sorties, "par_categorie": par_categorie, "par_mode": par_mode,
                         "par_mois": par_mois})

"""
Calculs financiers d'une inscription (source unique utilisée par les contrôles, la situation et le reçu).

  total_du            = Σ (montant - remise) des frais dus
  part_pec            = Σ montants des prises en charge ACTIVES (plafonnée au total dû)
  reste_etudiant      = total_du - part_pec - versé par l'étudiant
  reste_pec           = part_pec - versé par les organismes
"""
from decimal import Decimal

from django.db import connection

ZERO = Decimal("0")


def _d(valeur):
    return Decimal(valeur or 0)


def situation_inscription(inscription_id):
    with connection.cursor() as c:
        c.execute("""
            SELECT f.type_frais_id, tf.code, tf.libelle, tf.categorie, f.id, f.montant, f.remise, f.motif_remise,
                   f.date_echeance,
                   coalesce((SELECT sum(v.montant) FROM ispat.versement v
                              WHERE v.inscription_id = f.inscription_id AND v.type_frais_id = f.type_frais_id
                                AND NOT v.annule AND v.deleted_at IS NULL), 0) AS verse_impute
              FROM ispat.frais_inscription f
              JOIN ispat.type_frais tf ON tf.id = f.type_frais_id
             WHERE f.inscription_id = %s AND f.deleted_at IS NULL
             ORDER BY tf.categorie, tf.libelle""", [inscription_id])
        frais = [{
            "type_frais_id": r[0], "code": r[1], "libelle": r[2], "categorie": r[3], "frais_id": r[4],
            "montant": _d(r[5]), "remise": _d(r[6]), "motif_remise": r[7], "date_echeance": r[8],
            "du": _d(r[5]) - _d(r[6]), "verse_impute": _d(r[9]),
        } for r in c.fetchall()]

        c.execute("""
            SELECT coalesce(sum(montant) FILTER (WHERE payeur = 'ETUDIANT'), 0),
                   coalesce(sum(montant) FILTER (WHERE payeur = 'PRISE_EN_CHARGE'), 0),
                   coalesce(sum(montant) FILTER (WHERE type_frais_id IS NULL), 0)
              FROM ispat.versement WHERE inscription_id = %s AND NOT annule AND deleted_at IS NULL""",
                  [inscription_id])
        verse_etudiant, verse_pec, verse_non_impute = (_d(x) for x in c.fetchone())

        c.execute("""
            SELECT id, organisme, type_payeur, type_frais_id, montant,
                   coalesce((SELECT sum(v.montant) FROM ispat.versement v WHERE v.prise_en_charge_id = p.id
                              AND NOT v.annule AND v.deleted_at IS NULL), 0)
              FROM ispat.prise_en_charge p
             WHERE inscription_id = %s AND statut = 'ACTIVE' AND deleted_at IS NULL""", [inscription_id])
        pecs = [{"id": r[0], "organisme": r[1], "type_payeur": r[2], "type_frais_id": r[3], "montant": _d(r[4]),
                 "verse": _d(r[5]), "reste": max(_d(r[4]) - _d(r[5]), ZERO)} for r in c.fetchall()]

    total_du = sum((f["du"] for f in frais), ZERO)
    part_pec = min(sum((p["montant"] for p in pecs), ZERO), total_du)
    return {
        "frais": frais,
        "prises_en_charge": pecs,
        "total_du": total_du,
        "part_prise_en_charge": part_pec,
        "verse_etudiant": verse_etudiant,
        "verse_prise_en_charge": verse_pec,
        "verse_total": verse_etudiant + verse_pec,
        "verse_non_impute": verse_non_impute,
        "reste_etudiant": max(total_du - part_pec - verse_etudiant, ZERO),
        "reste_prise_en_charge": max(part_pec - verse_pec, ZERO),
        "reste_total": max(total_du - verse_etudiant - verse_pec, ZERO),
    }


def du_concerne(inscription_id, type_frais_id=None):
    """Montant dû concerné par une prise en charge (un type de frais, ou tous)."""
    sql = ("SELECT coalesce(sum(montant - remise), 0) FROM ispat.frais_inscription "
           "WHERE inscription_id = %s AND deleted_at IS NULL")
    params = [inscription_id]
    if type_frais_id:
        sql += " AND type_frais_id = %s"
        params.append(type_frais_id)
    with connection.cursor() as c:
        c.execute(sql, params)
        return _d(c.fetchone()[0])


def tarif_applicable(inscription, type_frais_id):
    """Montant du barème le plus spécifique (filière, niveau, statut) pour un type de frais, ou None."""
    with connection.cursor() as c:
        c.execute("""
            SELECT t.montant FROM ispat.tarif t
              JOIN ispat.classe cl ON cl.id = %s
             WHERE t.deleted_at IS NULL AND t.annee_id = %s AND t.type_frais_id = %s
               AND (t.filiere_id IS NULL OR t.filiere_id = cl.filiere_id)
               AND (t.niveau_id IS NULL OR t.niveau_id = cl.niveau_id)
               AND (t.statut_etudiant_id IS NULL OR t.statut_etudiant_id = %s)
             ORDER BY (t.filiere_id IS NOT NULL) DESC, (t.niveau_id IS NOT NULL) DESC,
                      (t.statut_etudiant_id IS NOT NULL) DESC
             LIMIT 1""", [inscription.classe_id, inscription.annee_id, type_frais_id, inscription.statut_etudiant_id])
        ligne = c.fetchone()
    return _d(ligne[0]) if ligne else None


# --------------------------------------------------------------------------------------
# Montant en lettres (français, règles d'accord de « cent » et « vingt »)
# --------------------------------------------------------------------------------------

_UNITES = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze",
           "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"]
_DIZAINES = {2: "vingt", 3: "trente", 4: "quarante", 5: "cinquante", 6: "soixante"}


def _moins_de_cent(n, final=True):
    if n < 20:
        return _UNITES[n]
    d, u = divmod(n, 10)
    if d == 7:
        return "soixante et onze" if u == 1 else f"soixante-{_UNITES[10 + u]}"
    if d == 8:
        return ("quatre-vingts" if final else "quatre-vingt") if u == 0 else f"quatre-vingt-{_UNITES[u]}"
    if d == 9:
        return f"quatre-vingt-{_UNITES[10 + u]}"
    if u == 0:
        return _DIZAINES[d]
    if u == 1:
        return f"{_DIZAINES[d]} et un"
    return f"{_DIZAINES[d]}-{_UNITES[u]}"


def _moins_de_mille(n, final=True):
    c, r = divmod(n, 100)
    if c == 0:
        return _moins_de_cent(r, final)
    tete = "cent" if c == 1 else f"{_UNITES[c]} cent"
    if r == 0:
        return tete + ("s" if c > 1 and final else "")
    return f"{tete} {_moins_de_cent(r, final)}"


def montant_en_lettres(montant):
    n = int(montant)
    if n == 0:
        return "zéro"
    parties = []
    milliards, n = divmod(n, 10 ** 9)
    millions, n = divmod(n, 10 ** 6)
    milliers, n = divmod(n, 1000)
    if milliards:
        parties.append(f"{_moins_de_mille(milliards)} milliard{'s' if milliards > 1 else ''}")
    if millions:
        parties.append(f"{_moins_de_mille(millions)} million{'s' if millions > 1 else ''}")
    if milliers:
        parties.append("mille" if milliers == 1 else f"{_moins_de_mille(milliers, final=False)} mille")
    if n:
        parties.append(_moins_de_mille(n))
    return " ".join(parties)


def format_fcfa(montant):
    return f"{int(montant):,}".replace(",", " ") + " F CFA"

"""
Reçu de versement PDF — A4 portrait, deux exemplaires identiques (étudiant / ISPAT) séparés par un pointillé.
"""
import io

from django.utils import timezone
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

from core.exports import nom_etablissement
from referentiels.models import Parametre

from .calculs import format_fcfa, montant_en_lettres, situation_inscription

VERT = colors.HexColor("#1B6B3A")
VERT_CLAIR = colors.HexColor("#EAF3EC")
ORANGE = colors.HexColor("#C8792A")
GRIS = colors.HexColor("#555555")
LARGEUR, HAUTEUR = A4
MARGE = 15 * mm


def _ville():
    p = Parametre.objects.filter(cle="ville_etablissement").first()
    return p.valeur if p else ""


def _texte_ajuste(c, texte, police, taille, largeur_max):
    while taille > 6 and c.stringWidth(texte, police, taille) > largeur_max:
        taille -= 0.5
    return taille


def _exemplaire(c, haut, libelle_exemplaire, v, situation, etablissement, ville):
    e = v.inscription.etudiant
    x0, x1 = MARGE, LARGEUR - MARGE
    largeur = x1 - x0

    # Bandeau
    c.setFillColor(VERT)
    c.rect(x0, haut - 18 * mm, largeur, 18 * mm, stroke=0, fill=1)
    c.setFillColor(colors.white)
    taille = _texte_ajuste(c, etablissement, "Helvetica-Bold", 11, largeur * 0.62)
    c.setFont("Helvetica-Bold", taille)
    c.drawString(x0 + 4 * mm, haut - 8 * mm, etablissement)
    c.setFont("Helvetica", 8.5)
    c.drawString(x0 + 4 * mm, haut - 13.5 * mm, ville)
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(x1 - 4 * mm, haut - 8 * mm, "REÇU DE VERSEMENT")
    c.setFont("Helvetica", 10)
    c.drawRightString(x1 - 4 * mm, haut - 13.5 * mm, f"N° {v.numero_recu}")

    c.setFillColor(ORANGE)
    c.setFont("Helvetica-Oblique", 8)
    c.drawRightString(x1, haut - 22 * mm, libelle_exemplaire)

    # Détails
    objet = v.type_frais.libelle if v.type_frais_id else "Frais de scolarité et annexes (imputation globale)"
    payeur = "Étudiant / famille" if v.payeur == "ETUDIANT" else f"Prise en charge : {v.prise_en_charge.organisme}"
    mode = v.get_mode_paiement_display() + (f" — réf. {v.reference}" if v.reference else "")
    lignes = [
        ("Date du versement", v.date_versement.strftime("%d/%m/%Y")),
        ("Matricule", e.matricule or "—"),
        ("Nom et prénoms", f"{e.nom} {e.prenoms}"),
        ("Classe / année", f"{v.inscription.classe.libelle} — {v.inscription.annee.libelle}"),
        ("Payeur", payeur),
        ("Objet", objet),
        ("Mode de paiement", mode),
    ]
    y = haut - 30 * mm
    for etiquette, valeur in lignes:
        c.setFillColor(GRIS)
        c.setFont("Helvetica", 8.5)
        c.drawString(x0, y, etiquette)
        c.setFillColor(colors.black)
        taille = _texte_ajuste(c, valeur, "Helvetica-Bold", 9.5, largeur - 42 * mm)
        c.setFont("Helvetica-Bold", taille)
        c.drawString(x0 + 40 * mm, y, valeur)
        y -= 6 * mm

    # Montant
    y -= 2 * mm
    c.setFillColor(VERT_CLAIR)
    c.setStrokeColor(VERT)
    c.roundRect(x0, y - 17 * mm, largeur, 19 * mm, 2 * mm, stroke=1, fill=1)
    c.setFillColor(VERT)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(x0 + 4 * mm, y - 7 * mm, format_fcfa(v.montant))
    c.setFillColor(colors.black)
    phrase = f"Arrêté le présent reçu à la somme de : {montant_en_lettres(v.montant)} francs CFA."
    taille = _texte_ajuste(c, phrase, "Helvetica-Oblique", 9, largeur - 8 * mm)
    c.setFont("Helvetica-Oblique", taille)
    c.drawString(x0 + 4 * mm, y - 13.5 * mm, phrase)
    y -= 24 * mm

    # Situation
    c.setFont("Helvetica-Bold", 8.5)
    c.setFillColor(GRIS)
    c.drawString(x0, y, f"Situation au {timezone.localtime().strftime('%d/%m/%Y')}")
    y -= 5 * mm
    colonnes = [("Total dû", situation["total_du"]),
                ("Prise en charge", situation["part_prise_en_charge"]),
                ("Total versé", situation["verse_total"]),
                ("Reste à payer (étudiant)", situation["reste_etudiant"])]
    pas = largeur / len(colonnes)
    for i, (etiquette, valeur) in enumerate(colonnes):
        cx = x0 + i * pas
        c.setFillColor(GRIS)
        c.setFont("Helvetica", 8)
        c.drawString(cx, y, etiquette)
        c.setFillColor(ORANGE if i == 3 and valeur > 0 else colors.black)
        c.setFont("Helvetica-Bold", 10)
        c.drawString(cx, y - 5 * mm, format_fcfa(valeur))
    y -= 14 * mm

    # Signatures
    caissier = v.encaisse_par.nom_complet if v.encaisse_par_id else ""
    c.setFillColor(GRIS)
    c.setFont("Helvetica", 8.5)
    c.drawString(x0, y, f"Encaissé par : {caissier}")
    c.drawRightString(x1, y, "Signature et cachet")
    c.setStrokeColor(colors.lightgrey)
    c.line(x1 - 55 * mm, y - 14 * mm, x1, y - 14 * mm)

    if v.annule:
        c.saveState()
        c.setFillColor(colors.Color(0.8, 0.1, 0.1, alpha=0.35))
        c.setFont("Helvetica-Bold", 60)
        c.translate(LARGEUR / 2, haut - 70 * mm)
        c.rotate(18)
        c.drawCentredString(0, 0, "ANNULÉ")
        c.restoreState()
        c.setFillColor(colors.HexColor("#B01515"))
        c.setFont("Helvetica-Bold", 8.5)
        c.drawString(x0, y - 6 * mm, f"Annulé — motif : {v.motif_annulation or ''}"[:80])


def generer_recu_pdf(versement):
    situation = situation_inscription(versement.inscription_id)
    etablissement, ville = nom_etablissement(), _ville()
    tampon = io.BytesIO()
    c = canvas.Canvas(tampon, pagesize=A4)
    c.setTitle(f"Reçu {versement.numero_recu}")
    c.setAuthor(etablissement)

    moitie = HAUTEUR / 2
    _exemplaire(c, HAUTEUR - 12 * mm, "Exemplaire étudiant", versement, situation, etablissement, ville)
    c.setStrokeColor(colors.grey)
    c.setDash(3, 3)
    c.line(MARGE / 2, moitie, LARGEUR - MARGE / 2, moitie)
    c.setDash()
    c.setFont("Helvetica", 7)
    c.setFillColor(colors.grey)
    c.drawCentredString(LARGEUR / 2, moitie + 1.5 * mm, "- - - découper ici - - -")
    _exemplaire(c, moitie - 10 * mm, "Exemplaire ISPAT", versement, situation, etablissement, ville)

    c.showPage()
    c.save()
    return tampon.getvalue()

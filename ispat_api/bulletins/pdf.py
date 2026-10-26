"""
Mise en page PDF des bulletins de semestre et des relevés d'examen (A4 portrait, une page par étudiant).

  En-tête  : logo ISPAT (fond transparent) + nom de l'établissement + titre + numéro
  Bloc     : identité de l'étudiant (+ photo si disponible)
  Tableau  : matières, coefficients, crédits, CC, examen, moyenne, moyenne de classe, résultat
  Synthèse : moyenne, rang, crédits, décision, mention, statistiques de la classe
  Pied     : lieu / date, signatures, mention légale, pagination
  Filigrane « PROVISOIRE » pour les éditions de contrôle.
"""
import io
from pathlib import Path

from django.conf import settings
from django.core.files.storage import default_storage
from django.utils import timezone
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

VERT = colors.HexColor("#1B6B3A")
VERT_CLAIR = colors.HexColor("#EAF3EC")
ORANGE = colors.HexColor("#C8792A")
GRIS = colors.HexColor("#5B5B5B")
GRIS_TRAIT = colors.HexColor("#B7C9BC")
ROUGE = colors.HexColor("#B01515")
LARGEUR, HAUTEUR = A4
MARGE = 12 * mm
UTILE = LARGEUR - 2 * MARGE

S_ETAB = ParagraphStyle("etab", fontName="Helvetica-Bold", fontSize=11.5, leading=14, textColor=VERT)
S_ETAB2 = ParagraphStyle("etab2", fontName="Helvetica", fontSize=8, leading=10, textColor=GRIS)
S_TITRE = ParagraphStyle("titre", fontName="Helvetica-Bold", fontSize=12.5, leading=15, alignment=TA_RIGHT)
S_SOUS = ParagraphStyle("sous", fontName="Helvetica-Bold", fontSize=9.5, leading=12, alignment=TA_RIGHT,
                        textColor=VERT)
S_NUM = ParagraphStyle("num", fontName="Helvetica", fontSize=8, leading=10, alignment=TA_RIGHT, textColor=GRIS)
S_ETIQ = ParagraphStyle("etiq", fontName="Helvetica", fontSize=7.5, leading=9, textColor=GRIS)
S_VAL = ParagraphStyle("val", fontName="Helvetica-Bold", fontSize=9, leading=11)
S_CEL = ParagraphStyle("cel", fontName="Helvetica", fontSize=8.5, leading=10)
S_CEL_C = ParagraphStyle("celc", parent=S_CEL, alignment=TA_CENTER)
S_ENT = ParagraphStyle("ent", fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=colors.white,
                       alignment=TA_CENTER)
S_PETIT = ParagraphStyle("petit", fontName="Helvetica", fontSize=7, leading=8.5, textColor=GRIS)
S_SIGN = ParagraphStyle("sign", fontName="Helvetica-Bold", fontSize=8.5, leading=11, alignment=TA_CENTER)


def hx(couleur):
    """Couleur reportlab -> « #rrggbb » (format attendu dans les balises <font color>)."""
    return "#%02x%02x%02x" % tuple(round(x * 255) for x in (couleur.red, couleur.green, couleur.blue))


def note(v, vide="—"):
    return vide if v is None else f"{v:.2f}".replace(".", ",")


def coef(v):
    return f"{v:g}".replace(".", ",")


def _date(d):
    return d.strftime("%d/%m/%Y") if d else "—"


def _logo(hauteur):
    chemin = Path(getattr(settings, "ISPAT_LOGO", ""))
    if not chemin.is_file():
        return Spacer(hauteur, hauteur)
    img = Image(str(chemin))
    ratio = img.imageWidth / img.imageHeight
    img.drawHeight, img.drawWidth = hauteur, hauteur * ratio
    return img


def _photo(chemin):
    if not chemin or not default_storage.exists(chemin):
        return None
    with default_storage.open(chemin, "rb") as f:
        img = Image(io.BytesIO(f.read()))
    ratio = img.imageWidth / img.imageHeight
    img.drawHeight = 30 * mm
    img.drawWidth = 30 * mm * ratio
    return img


# --------------------------------------------------------------------------------------
# Blocs communs
# --------------------------------------------------------------------------------------

def _entete(etab, titre, sous_titre, annee, numero):
    t = Table([[_logo(24 * mm),
                [Paragraph(etab["nom"], S_ETAB), Paragraph(etab["ligne2"], S_ETAB2)],
                [Paragraph(titre, S_TITRE), Paragraph(sous_titre, S_SOUS), Paragraph(annee, S_NUM),
                 Paragraph(f"N° {numero}" if numero else "Édition de contrôle (non numérotée)", S_NUM)]]],
              colWidths=[28 * mm, UTILE * 0.45, UTILE - 28 * mm - UTILE * 0.45])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW", (0, 0), (-1, 0), 2, VERT),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
    ]))
    return t


def _identite(d):
    def cell(etiquette, valeur):
        return [Paragraph(etiquette, S_ETIQ), Paragraph(str(valeur) if valeur not in (None, "") else "—", S_VAL)]

    naissance = _date(d["date_naissance"]) + (f" à {d['lieu_naissance']}" if d.get("lieu_naissance") else "")
    grille = [
        [cell("Matricule", d["matricule"]), cell("Nom et prénoms", f"{d['nom']} {d['prenoms']}")],
        [cell("Né(e) le", naissance), cell("Sexe", "Féminin" if d["sexe"] == "F" else "Masculin")],
        [cell("Filière", d["filiere"]), cell("Niveau", d["niveau"])],
        [cell("Classe", d["classe"]), cell("Statut", d["statut"])],
    ]
    largeur_texte = UTILE - 34 * mm
    infos = Table(grille, colWidths=[largeur_texte * 0.45, largeur_texte * 0.55])
    infos.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                               ("TOPPADDING", (0, 0), (-1, -1), 1), ("LEFTPADDING", (0, 0), (-1, -1), 4)]))
    photo = _photo(d.get("photo_chemin")) or Paragraph("Photo", ParagraphStyle("ph", parent=S_PETIT,
                                                                               alignment=TA_CENTER))
    bloc = Table([[infos, photo]], colWidths=[largeur_texte, 34 * mm], rowHeights=[None])
    bloc.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, GRIS_TRAIT), ("BACKGROUND", (0, 0), (0, 0), VERT_CLAIR),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("ALIGN", (1, 0), (1, 0), "CENTER"),
        ("LINEBEFORE", (1, 0), (1, 0), 0.6, GRIS_TRAIT), ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return bloc


def _style_tableau(nb_lignes, colonnes_centrees_depuis=2):
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), VERT),
        ("GRID", (0, 0), (-1, -1), 0.4, GRIS_TRAIT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (colonnes_centrees_depuis, 1), (-1, -1), "CENTER"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), 8.5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    for i in range(1, nb_lignes + 1):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#F6FAF7")))
    return style


def _synthese(cases):
    """Cases [(étiquette, valeur, couleur)] sur une ligne."""
    largeur = UTILE / len(cases)
    t = Table([[Paragraph(e, S_ETIQ) for e, _, _ in cases],
               [Paragraph(f'<font color="{hx(c) if c else "#000000"}">{v}</font>', S_VAL)
                for _, v, c in cases]],
              colWidths=[largeur] * len(cases))
    t.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, VERT), ("INNERGRID", (0, 0), (-1, -1), 0.4, GRIS_TRAIT),
        ("BACKGROUND", (0, 0), (-1, 0), VERT_CLAIR), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def _signatures(etab):
    lieu = f"Fait à {etab['ville']}, le {timezone.localtime():%d/%m/%Y}" if etab["ville"] \
        else f"Fait le {timezone.localtime():%d/%m/%Y}"
    t = Table([[Paragraph("Le Directeur des études", S_SIGN), Paragraph(lieu + "<br/>Le Directeur général", S_SIGN)],
               [Spacer(1, 18 * mm), Spacer(1, 18 * mm)]], colWidths=[UTILE / 2, UTILE / 2])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    return t


# --------------------------------------------------------------------------------------
# Contenus
# --------------------------------------------------------------------------------------

def _contenu_semestre(d, etab, numero):
    flux = [_entete(etab, "BULLETIN DE NOTES", f"Semestre {d['semestre']}", f"Année académique {d['annee']}",
                    numero),
            Spacer(1, 4 * mm), _identite(d), Spacer(1, 4 * mm)]

    entetes = ["Code", "Matière", "Coef.", "Crédits", "Moy. CC", "Examen", "Moyenne /20", "Moy. classe",
               "Crédits acquis"]
    lignes = [[Paragraph(h, S_ENT) for h in entetes]]
    for l in d["lignes"]:
        examen = note(l["examen"]) + (" (R)" if l["rattrapage"] else "")
        moyenne = note(l["moyenne"])
        if l["moyenne"] is not None and l["moyenne"] < etab["seuil"]:
            moyenne = f'<font color="{hx(ROUGE)}">{moyenne}</font>'
        lignes.append([l["code"], Paragraph(l["libelle"], S_CEL), coef(l["coefficient"]), l["credits"],
                       note(l["moyenne_cc"]), examen, Paragraph(f"<b>{moyenne}</b>", S_CEL_C),
                       note(l["moyenne_classe"]), l["credits_acquis"]])
    lignes.append(["", Paragraph("<b>TOTAL</b>", S_CEL), coef(d["total_coefficients"]), d["total_credits"], "", "",
                   "", "", d["credits_acquis"]])
    t = Table(lignes, colWidths=[19 * mm, None, 12 * mm, 14 * mm, 16 * mm, 18 * mm, 20 * mm, 18 * mm, 16 * mm],
              repeatRows=1)
    style = _style_tableau(len(d["lignes"]))
    style += [("BACKGROUND", (0, -1), (-1, -1), VERT_CLAIR), ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")]
    t.setStyle(TableStyle(style))
    flux += [t, Spacer(1, 2 * mm),
             Paragraph("(R) : note de 2e session retenue. Moyenne = CC × poids CC + examen × poids examen. "
                       f"Seuil de validation : {note(etab['seuil'])}/20.", S_PETIT), Spacer(1, 4 * mm)]

    couleur_decision = VERT if d["decision"] and d["decision"].startswith("Admis") else ORANGE
    flux.append(_synthese([
        ("Moyenne du semestre", f"{note(d['moyenne'])} / 20", None),
        ("Rang", f"{d['rang']}e / {d['effectif']}" if d["rang"] else "—", None),
        ("Crédits acquis", f"{d['credits_acquis']} / {d['total_credits']}", None),
        ("Mention", d["mention"] or "—", None),
        ("Décision", d["decision"] or "—", couleur_decision),
    ]))
    flux += [Spacer(1, 2 * mm), Paragraph(
        f"Classe : moyenne {note(d['moyenne_classe'])} · plus forte {note(d['plus_forte'])} · "
        f"plus faible {note(d['plus_faible'])} · effectif {d['effectif']}", S_PETIT)]
    if d.get("appreciation"):
        flux += [Spacer(1, 3 * mm), Paragraph(f"<b>Appréciation :</b> {d['appreciation']}", S_CEL)]
    flux += [Spacer(1, 6 * mm), _signatures(etab)]
    return flux


def _contenu_releve(d, etab, numero):
    session = d["session"]
    flux = [_entete(etab, "RELEVÉ DE NOTES D'EXAMEN", f"{'1re' if session == 1 else '2e'} session · Semestre {d['semestre']}",
                    f"Année académique {d['annee']}", numero),
            Spacer(1, 4 * mm), _identite(d), Spacer(1, 4 * mm)]
    entetes = ["Code", "Matière", "Coef.", "Crédits", "Moy. CC", f"Examen S{session}",
               "Moyenne /20" if session == 1 else "Moyenne retenue", "Moy. classe", "Résultat"]
    lignes = [[Paragraph(h, S_ENT) for h in entetes]]
    for l in d["lignes"]:
        couleur = VERT if l["resultat"] in ("Validée", "Compensée") else ORANGE
        lignes.append([l["code"], Paragraph(l["libelle"], S_CEL), coef(l["coefficient"]), l["credits"],
                       note(l["moyenne_cc"]), note(l["examen"]), Paragraph(f"<b>{note(l['moyenne'])}</b>", S_CEL_C),
                       note(l["moyenne_classe"]),
                       Paragraph(f'<font color="{hx(couleur)}"><b>{l["resultat"]}</b></font>', S_CEL_C)])
    if len(lignes) == 1:
        lignes.append(["", Paragraph("Aucune matière présentée à cette session.", S_CEL), "", "", "", "", "", "", ""])
    t = Table(lignes, colWidths=[19 * mm, None, 12 * mm, 14 * mm, 16 * mm, 18 * mm, 20 * mm, 18 * mm, 22 * mm],
              repeatRows=1)
    t.setStyle(TableStyle(_style_tableau(len(lignes) - 1)))
    flux += [t, Spacer(1, 4 * mm)]
    couleur_decision = VERT if d["decision"] and d["decision"].startswith("Admis") else ORANGE
    flux.append(_synthese([
        ("Moyenne du semestre" + (" (1re session)" if session == 1 else " (après 2e session)"),
         f"{note(d['moyenne'])} / 20", None),
        ("Mention", d["mention"] or "—", None),
        ("Résultat", d["decision"] or "—", couleur_decision),
    ]))
    flux += [Spacer(1, 2 * mm), Paragraph(
        "Validée : moyenne au moins égale au seuil. Compensée : matière sous le seuil, compensée par la moyenne "
        f"du semestre. Seuil : {note(d['seuil'])}/20.", S_PETIT),
        Spacer(1, 6 * mm), _signatures(etab)]
    return flux


# --------------------------------------------------------------------------------------
# Génération
# --------------------------------------------------------------------------------------

def _decor(provisoire, etab):
    def dessiner(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 6.8)
        canvas.setFillColor(GRIS)
        canvas.drawString(MARGE, 8 * mm, f"{etab['nom']} — document édité le "
                                         f"{timezone.localtime():%d/%m/%Y à %H:%M}. Toute rature ou surcharge annule ce document.")
        canvas.drawRightString(LARGEUR - MARGE, 8 * mm, f"Page {doc.page}")
        canvas.setStrokeColor(ORANGE)
        canvas.setLineWidth(1)
        canvas.line(MARGE, 11 * mm, LARGEUR - MARGE, 11 * mm)
        if provisoire:
            canvas.setFillColor(colors.Color(0.78, 0.47, 0.16, alpha=0.18))
            canvas.setFont("Helvetica-Bold", 70)
            canvas.translate(LARGEUR / 2, HAUTEUR / 2)
            canvas.rotate(40)
            canvas.drawCentredString(0, 0, "PROVISOIRE")
        canvas.restoreState()
    return dessiner


def generer_pdf(documents, etab, provisoire=False, titre="Bulletins"):
    """documents : liste de (donnees, numero) ; une page par document."""
    tampon = io.BytesIO()
    doc = SimpleDocTemplate(tampon, pagesize=A4, leftMargin=MARGE, rightMargin=MARGE, topMargin=10 * mm,
                            bottomMargin=15 * mm, title=titre, author=etab["nom"])
    flux = []
    for rang, (d, numero) in enumerate(documents):
        if rang:
            flux.append(PageBreak())
        flux += _contenu_semestre(d, etab, numero) if d["type"] == "SEMESTRE" else _contenu_releve(d, etab, numero)
    decor = _decor(provisoire, etab)
    doc.build(flux, onFirstPage=decor, onLaterPages=decor)
    return tampon.getvalue()

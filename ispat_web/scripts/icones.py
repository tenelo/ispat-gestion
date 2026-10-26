#!/usr/bin/env python3
"""
Réduit la police d'icônes Material Symbols (4 Mo) aux seules icônes utilisées par l'application (~50 Ko),
pour une installation rapide et un fonctionnement hors ligne léger.

Usage (depuis le dossier ispat_web) :
    pip install fonttools brotli
    python3 scripts/icones.py

À relancer après avoir utilisé une nouvelle icône dans le code (les noms sont détectés automatiquement
dans src/ : <mat-icon>nom</mat-icon>, icone: 'nom', class="material-symbols-outlined">nom<, etc.).
Résultat : src/assets-icones/material-symbols-ispat.woff2 (référencé par src/icones.scss).
"""
import pathlib
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

RACINE = pathlib.Path(__file__).resolve().parent.parent
SOURCE = RACINE / "node_modules/material-symbols/material-symbols-outlined.woff2"
CIBLE = RACINE / "src/assets-icones/material-symbols-ispat.woff2"


def ligatures(police):
    """{nom de l'icône: glyphe} à partir de la table GSUB (fonction « rlig »)."""
    nom_vers_car = {g: chr(c) for c, g in police.getBestCmap().items()}
    resultat = {}
    for lookup in police["GSUB"].table.LookupList.Lookup:
        for st in lookup.SubTable:
            if st.LookupType == 7:                      # extension
                st = st.ExtSubTable
            if getattr(st, "LookupType", None) != 4:    # substitution de ligature
                continue
            for premier, ligs in st.ligatures.items():
                for lig in ligs:
                    noms = [premier, *lig.Component]
                    if all(n in nom_vers_car for n in noms):
                        resultat["".join(nom_vers_car[n] for n in noms)] = lig.LigGlyph
    return resultat


def noms_utilises(candidats):
    texte = "\n".join(p.read_text(encoding="utf-8") for p in (RACINE / "src").rglob("*")
                      if p.suffix in (".ts", ".html") and p.is_file())
    jetons = set(re.findall(r"[>'\"`]\s*([a-z0-9_]+)\s*[<'\"`]", texte))
    return sorted(n for n in jetons if n in candidats)


def main():
    police = TTFont(SOURCE)
    toutes = ligatures(police)
    noms = noms_utilises(toutes)
    if not noms:
        sys.exit("Aucune icône trouvée dans src/.")
    lettres = [police.getBestCmap()[ord(c)] for c in "abcdefghijklmnopqrstuvwxyz0123456789_" if ord(c) in police.getBestCmap()]
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["rlig", "rclt", "liga"]   # Material Symbols : ligatures dans « rlig »
    options.layout_closure = False
    options.notdef_outline = False
    options.name_IDs = ["*"]
    sous = subset.Subsetter(options)
    sous.populate(glyphs=lettres + [toutes[n] for n in noms], unicodes=[ord(c) for c in "abcdefghijklmnopqrstuvwxyz0123456789_"])
    sous.subset(police)
    CIBLE.parent.mkdir(parents=True, exist_ok=True)
    police.flavor = "woff2"
    police.save(CIBLE)
    print(f"{len(noms)} icônes -> {CIBLE.relative_to(RACINE)} ({CIBLE.stat().st_size // 1024} Ko)")
    print(", ".join(noms))


if __name__ == "__main__":
    main()

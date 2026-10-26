"""
Assemblage des données d'un bulletin / relevé, contrôles préalables et numérotation.

  * Bulletin de semestre : exige la moyenne de semestre VALIDEE (sinon : édition provisoire uniquement).
  * Relevé d'examen session N : exige les notes d'examen de la session VALIDEE et les moyennes calculées.
"""
from decimal import Decimal

from django.db import connection
from django.db.models import Avg, Max, Min
from django.utils import timezone

from notes.models import Evaluation, MoyenneMatiere, MoyenneSemestre, Note
from notes.outils import seuil_validation
from referentiels.models import Matiere, Parametre
from scolarite.models import Inscription

from .models import Bulletin

DECISIONS = {"ADMIS": "Admis(e)", "AJOURNE": "Ajourné(e)", "SESSION2": "Autorisé(e) à composer en 2e session"}


def parametre(cle, defaut=""):
    p = Parametre.objects.filter(cle=cle).first()
    return p.valeur if p else defaut


def mention(moyenne):
    if moyenne is None:
        return None
    if moyenne >= 16:
        return "Très bien"
    if moyenne >= 14:
        return "Bien"
    if moyenne >= 12:
        return "Assez bien"
    if moyenne >= 10:
        return "Passable"
    return "Insuffisant"


def _moyenne_ponderee(paires):
    paires = [(v, c) for v, c in paires if v is not None]
    total_coef = sum((c for _, c in paires), Decimal("0"))
    if not total_coef:
        return None
    return (sum((v * c for v, c in paires), Decimal("0")) / total_coef).quantize(Decimal("0.01"))


# --------------------------------------------------------------------------------------
# Statistiques de classe (calculées une fois par édition de classe)
# --------------------------------------------------------------------------------------

def statistiques_classe(classe, semestre):
    inscrits = Inscription.objects.filter(classe=classe, etat="VALIDEE")
    par_matiere = {
        r["matiere_id"]: r for r in MoyenneMatiere.objects.filter(inscription__in=inscrits, semestre=semestre)
        .values("matiere_id").annotate(moy_finale=Avg("moyenne_finale"), moy_s1=Avg("moyenne_session1"))
    }
    sem = MoyenneSemestre.objects.filter(inscription__in=inscrits, semestre=semestre).aggregate(
        moy_classe=Avg("moyenne"), plus_forte=Max("moyenne"), plus_faible=Min("moyenne"))
    return {
        "effectif": inscrits.count(),
        "par_matiere": par_matiere,
        "moyenne": sem["moy_classe"].quantize(Decimal("0.01")) if sem["moy_classe"] is not None else None,
        "plus_forte": sem["plus_forte"],
        "plus_faible": sem["plus_faible"],
    }


# --------------------------------------------------------------------------------------
# Données
# --------------------------------------------------------------------------------------

def _entete_etudiant(ins, semestre, stats):
    e = ins.etudiant
    return {
        "inscription_id": ins.pk, "etudiant_id": e.pk, "matricule": e.matricule, "nom": e.nom, "prenoms": e.prenoms,
        "sexe": e.sexe, "date_naissance": e.date_naissance, "lieu_naissance": e.lieu_naissance,
        "photo_chemin": e.photo_chemin, "classe": ins.classe.libelle, "filiere": ins.classe.filiere.libelle,
        "niveau": ins.classe.niveau.libelle, "annee": ins.annee.libelle, "statut": ins.statut_etudiant.libelle,
        "semestre": semestre.numero, "effectif": stats["effectif"],
    }


def donnees_bulletin_semestre(ins, semestre, stats):
    matieres = Matiere.objects.filter(filiere_id=ins.classe.filiere_id, niveau_id=ins.classe.niveau_id,
                                      semestre_numero=semestre.numero).order_by("code")
    mm = {m.matiere_id: m for m in MoyenneMatiere.objects.filter(inscription=ins, semestre=semestre)}
    ms = MoyenneSemestre.objects.filter(inscription=ins, semestre=semestre).first()
    lignes = []
    for m in matieres:
        x = mm.get(m.pk)
        classe_m = stats["par_matiere"].get(m.pk, {})
        lignes.append({
            "code": m.code, "libelle": m.libelle, "coefficient": m.coefficient, "credits": m.credits,
            "moyenne_cc": x.moyenne_cc if x else None,
            "examen": (x.note_examen_s2 if x and x.note_examen_s2 is not None else (x.note_examen_s1 if x else None)),
            "rattrapage": bool(x and x.note_examen_s2 is not None),
            "moyenne": x.moyenne_finale if x else None,
            "moyenne_classe": classe_m.get("moy_finale"),
            "credits_acquis": x.credits_acquis if x else 0,
        })
    moyenne = ms.moyenne if ms else None
    return {
        "type": "SEMESTRE", **_entete_etudiant(ins, semestre, stats), "lignes": lignes,
        "total_coefficients": sum((l["coefficient"] for l in lignes), Decimal("0")),
        "total_credits": sum(l["credits"] for l in lignes),
        "moyenne": moyenne, "rang": ms.rang if ms else None,
        "credits_acquis": ms.credits_acquis if ms else sum(l["credits_acquis"] for l in lignes),
        "decision": DECISIONS.get(ms.decision) if ms else None, "mention": mention(moyenne),
        "appreciation": ms.appreciation if ms else None,
        "moyenne_classe": stats["moyenne"], "plus_forte": stats["plus_forte"], "plus_faible": stats["plus_faible"],
        "statut_moyenne": ms.statut if ms else None,
    }


def donnees_releve(ins, semestre, session, stats):
    seuil = seuil_validation()
    matieres = Matiere.objects.filter(filiere_id=ins.classe.filiere_id, niveau_id=ins.classe.niveau_id,
                                      semestre_numero=semestre.numero).order_by("code")
    mm = {m.matiere_id: m for m in MoyenneMatiere.objects.filter(inscription=ins, semestre=semestre)}
    ms = MoyenneSemestre.objects.filter(inscription=ins, semestre=semestre).first()

    if session == 1:
        moyenne_semestre = _moyenne_ponderee([(mm[m.pk].moyenne_session1, m.coefficient) for m in matieres if m.pk in mm])
        admis_semestre = moyenne_semestre is not None and moyenne_semestre >= seuil
        lignes = []
        for m in matieres:
            x = mm.get(m.pk)
            moy = x.moyenne_session1 if x else None
            if moy is None:
                resultat = "Incomplet"
            elif moy >= seuil:
                resultat = "Validée"
            elif admis_semestre:
                resultat = "Compensée"
            else:
                resultat = "2e session"
            lignes.append({"code": m.code, "libelle": m.libelle, "coefficient": m.coefficient, "credits": m.credits,
                           "moyenne_cc": x.moyenne_cc if x else None, "examen": x.note_examen_s1 if x else None,
                           "moyenne": moy, "moyenne_classe": stats["par_matiere"].get(m.pk, {}).get("moy_s1"),
                           "resultat": resultat})
        a_rattraper = [l["code"] for l in lignes if l["resultat"] in ("2e session", "Incomplet")]
        decision = "Admis(e) en 1re session" if admis_semestre else (
            f"Autorisé(e) à composer en 2e session ({', '.join(a_rattraper)})" if a_rattraper else "Ajourné(e)")
    else:
        lignes = []
        for m in matieres:
            x = mm.get(m.pk)
            if not x or x.note_examen_s2 is None:
                continue
            lignes.append({"code": m.code, "libelle": m.libelle, "coefficient": m.coefficient, "credits": m.credits,
                           "moyenne_cc": x.moyenne_cc, "examen": x.note_examen_s2, "moyenne": x.moyenne_finale,
                           "moyenne_classe": None,
                           "resultat": "Validée" if (x.moyenne_finale or 0) >= seuil else "Non validée"})
        moyenne_semestre = ms.moyenne if ms else None
        decision = DECISIONS.get(ms.decision) if ms else None
        if ms and ms.decision == "SESSION2":
            decision = "Ajourné(e)"           # après la 2e session il n'y a plus de rattrapage possible
    return {
        "type": "RELEVE_EXAMEN", "session": session, **_entete_etudiant(ins, semestre, stats), "lignes": lignes,
        "moyenne": moyenne_semestre, "mention": mention(moyenne_semestre), "decision": decision,
        "seuil": seuil,
    }


# --------------------------------------------------------------------------------------
# Contrôles avant édition officielle
# --------------------------------------------------------------------------------------

def blocages_semestre(inscriptions, semestre):
    validees = set(MoyenneSemestre.objects.filter(inscription__in=inscriptions, semestre=semestre, statut="VALIDEE")
                   .values_list("inscription_id", flat=True))
    return [{"matricule": i.etudiant.matricule, "nom": f"{i.etudiant.nom} {i.etudiant.prenoms}",
             "raison": "Moyenne du semestre non validée."} for i in inscriptions if i.pk not in validees]


def blocages_session(classe, semestre, session, inscriptions):
    examens = Evaluation.objects.filter(classe=classe, semestre=semestre, type_eval="EXAMEN", session=session)
    if not examens.exists():
        return [{"raison": f"Aucun examen de session {session} pour cette classe et ce semestre."}]
    raisons = []
    non_validees = Note.objects.filter(evaluation__in=examens, statut="SAISIE") \
        .values_list("evaluation__matiere__code", flat=True).distinct()
    for code in sorted(set(non_validees)):
        raisons.append({"raison": f"Notes d'examen non validées : {code}."})
    if not MoyenneMatiere.objects.filter(inscription__in=inscriptions, semestre=semestre).exists():
        raisons.append({"raison": "Moyennes non calculées."})
    return raisons


# --------------------------------------------------------------------------------------
# Numérotation
# --------------------------------------------------------------------------------------

def enregistrer_edition(ins, semestre, type_bulletin, session, utilisateur):
    """Crée (ou met à jour) la trace d'édition et retourne le Bulletin avec son numéro."""
    trace = Bulletin.objects.filter(inscription=ins, semestre=semestre, type_bulletin=type_bulletin,
                                    session=session).first()
    if trace is None:
        prefixe = "BUL" if type_bulletin == "SEMESTRE" else "REL"
        suffixe = f"S{semestre.numero}" + (f"-SES{session}" if session else "")
        annee = f"{ins.annee.date_debut:%Y}"
        with connection.cursor() as c:
            c.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [f"bulletin-{prefixe}-{annee}-{suffixe}"])
        rang = Bulletin.tous.filter(type_bulletin=type_bulletin, session=session, semestre__numero=semestre.numero,
                                    inscription__annee_id=ins.annee_id).count() + 1
        trace = Bulletin(inscription=ins, semestre=semestre, type_bulletin=type_bulletin, session=session,
                         numero=f"{prefixe}-{annee}-{suffixe}-{rang:05d}", date_edition=timezone.now(),
                         edite_par=utilisateur)
        trace.save()
    else:
        trace.date_edition = timezone.now()
        trace.edite_par = utilisateur
        trace.save(update_fields=["date_edition", "edite_par"])
    trace.refresh_from_db()
    return trace

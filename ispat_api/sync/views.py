"""
Synchronisation hors ligne — /api/sync/...

GET  etat/                          filigrane, tables reçues, opérations d'envoi autorisées pour l'utilisateur
GET  pull/?depuis=<sync_seq>&limite=1000&tables=a,b[&initial=true]
       -> {"filigrane", "jusqu_a", "complet", "reinitialiser", "tables": {nom: [lignes brutes]}}
       Changements (suppressions logiques comprises) avec depuis < sync_seq <= jusqu_a.
       Rappeler avec depuis = jusqu_a tant que complet = false.
       Premier chargement : depuis = 0 et initial=true sur toutes les pages -> lignes supprimées exclues.
POST push/  {"operations": [{"op_id", "table", "action", "id", "version"?, "donnees"?, "motif"?}, ...]}
       -> {"resultats": [{"op_id", "statut", "code", "id", "ligne" | "erreurs" | "serveur"}], "filigrane"}
       statut : ok | deja_traite | conflit | refuse | erreur | invalide
       * op_id      : UUID généré par le client ; une opération réussie n'est jamais appliquée deux fois
       * version    : obligatoire pour modifier / supprimer (verrou optimiste) ; différente -> conflit + ligne serveur
       * chaque opération dans son propre point de sauvegarde : un échec n'annule pas les autres
       * l'opération passe par la vue métier du module (mêmes contrôles et mêmes droits qu'en ligne)
"""
import json
import logging
import uuid

from django.db import connection, transaction
from django.test.client import RequestFactory
from rest_framework import serializers
from rest_framework.response import Response

from core.mixins import VueISPAT
from core.permissions import AUTHENTIFIE

from .models import SyncOperation
from .registre import PAR_NOM, TABLES

journal = logging.getLogger("ispat.sync")
LIMITE_DEFAUT, LIMITE_MAX = 1000, 5000
OPERATIONS_MAX = 200
ACTIONS_SUR_LIGNE_VERSIONNEE = ("modifier", "supprimer")


def filigrane():
    with connection.cursor() as c:
        c.execute("SELECT ispat.sync_filigrane()")
        return c.fetchone()[0]


def sequence_courante():
    with connection.cursor() as c:
        c.execute("SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ispat.sync_seq")
        return c.fetchone()[0]


def ligne_brute(table, pk):
    return table.modele.tous.filter(pk=pk).values(*table.champs()).first()


class EtatView(VueISPAT):
    permissions_requises = {"GET": AUTHENTIFIE}

    def get(self, request):
        u = request.user
        return Response({
            "filigrane": filigrane(),
            "tables": [t.nom for t in TABLES if t.lisible(u)],
            "envoi": {t.nom: sorted(t.envoi) for t in TABLES if t.envoi and t.lisible(u)},
            "operations_max": OPERATIONS_MAX,
            "limite_max": LIMITE_MAX,
        })


# --------------------------------------------------------------------------------------
# Pull
# --------------------------------------------------------------------------------------

class PullView(VueISPAT):
    permissions_requises = {"GET": AUTHENTIFIE}

    def get(self, request):
        p = request.query_params
        try:
            depuis = int(p.get("depuis") or 0)
            limite = min(max(int(p.get("limite") or LIMITE_DEFAUT), 1), LIMITE_MAX)
        except ValueError as exc:
            raise serializers.ValidationError("« depuis » et « limite » doivent être des entiers.") from exc
        demandees = {t.strip() for t in (p.get("tables") or "").split(",") if t.strip()}
        inconnues = demandees - set(PAR_NOM)
        if inconnues:
            raise serializers.ValidationError({"tables": f"Tables inconnues : {', '.join(sorted(inconnues))}."})

        haut = filigrane()                       # tout sync_seq <= haut est validé (voir ispat.sync_filigrane)
        if depuis > haut:                        # base restaurée / client d'une autre base
            return Response({"filigrane": haut, "jusqu_a": haut, "complet": True, "reinitialiser": True,
                             "tables": {}})

        u = request.user
        initial = depuis == 0 or (p.get("initial") or "").lower() in ("1", "true", "oui")
        tables = [t for t in TABLES if t.lisible(u) and (not demandees or t.nom in demandees)]
        portees = []
        for t in tables:
            qs, restreint = t.queryset(u)
            qs = qs.filter(sync_seq__gt=depuis, sync_seq__lte=haut)
            if initial:                          # premier chargement : inutile d'envoyer les suppressions
                qs = qs.filter(deleted_at__isnull=True)
            portees.append((t, qs, restreint))

        # Borne de la page : le « limite »-ième plus petit sync_seq parmi toutes les tables
        jusqu_a, complet = haut, True
        if portees:
            seqs = portees[0][1].order_by().values_list("sync_seq", flat=True)
            union = seqs.union(*[qs.order_by().values_list("sync_seq", flat=True) for _, qs, _ in portees[1:]],
                               all=True)
            page = list(union.order_by("sync_seq")[:limite + 1])
            if len(page) > limite:
                jusqu_a, complet = page[limite - 1], False

        resultat = {}
        for t, qs, restreint in portees:
            lignes = list(qs.filter(sync_seq__lte=jusqu_a).order_by("sync_seq").values(*t.champs(restreint)))
            if lignes:
                resultat[t.nom] = lignes
        return Response({"filigrane": haut, "jusqu_a": jusqu_a, "complet": complet, "reinitialiser": False,
                         "tables": resultat})


# --------------------------------------------------------------------------------------
# Push
# --------------------------------------------------------------------------------------

class Echec(Exception):
    def __init__(self, statut, code, contenu):
        super().__init__(statut)
        self.statut, self.code, self.contenu = statut, code, contenu


def _statut_pour(code):
    if code == 409:
        return "conflit"
    if code in (401, 403):
        return "refuse"
    return "erreur"


def _donnees_json(valeur):
    """Rend la réponse DRF sérialisable en JSON (UUID, Decimal, dates, ErrorDetail)."""
    from rest_framework.utils.encoders import JSONEncoder
    return json.loads(json.dumps(valeur, cls=JSONEncoder))


class PushView(VueISPAT):
    permissions_requises = {"POST": AUTHENTIFIE}
    fabrique = RequestFactory()

    def post(self, request):
        operations = request.data.get("operations")
        if not isinstance(operations, list) or not operations:
            raise serializers.ValidationError({"operations": "Liste d'opérations obligatoire."})
        if len(operations) > OPERATIONS_MAX:
            raise serializers.ValidationError({"operations": f"{OPERATIONS_MAX} opérations au maximum par envoi."})
        resultats = [self.traiter(request, op) for op in operations]
        return Response({"resultats": resultats, "filigrane": sequence_courante(),
                         "bilan": {s: sum(1 for r in resultats if r["statut"] == s)
                                   for s in ("ok", "deja_traite", "conflit", "refuse", "erreur", "invalide")}})

    # -- une opération --------------------------------------------------------------------
    def traiter(self, request, op):
        base = {"op_id": op.get("op_id") if isinstance(op, dict) else None}
        try:
            op_id, table, action, pk = self.controler(op)
        except Echec as e:
            return {**base, "statut": e.statut, "code": e.code, "erreurs": e.contenu}

        deja = SyncOperation.objects.filter(op_id=op_id, statut="OK").first()
        if deja is not None:
            if deja.utilisateur_id != request.user.pk:
                return {**base, "statut": "invalide", "code": 400, "erreurs": "op_id déjà utilisé."}
            return {**base, "statut": "deja_traite", "code": deja.code_http, "id": deja.enregistrement_id,
                    "ligne": ligne_brute(table, deja.enregistrement_id) if deja.enregistrement_id else None}

        try:
            with transaction.atomic():
                with connection.cursor() as c:
                    c.execute("SELECT set_config('app.motif', '', true)")
                pk_resultat, reponse = self.appliquer(request, op, table, action, pk)
                SyncOperation.objects.create(op_id=op_id, utilisateur=request.user, table_nom=table.nom,
                                             action=action, enregistrement_id=pk_resultat, statut="OK",
                                             code_http=reponse.status_code)
        except Echec as e:
            if isinstance(e.contenu, dict) and "serveur" in e.contenu:      # conflit : ligne serveur jointe
                return {**base, "statut": e.statut, "code": e.code, "id": pk, **e.contenu}
            return {**base, "statut": e.statut, "code": e.code, "id": pk, "erreurs": e.contenu}
        except Exception:                                   # noqa: BLE001 — une opération ne doit pas tout bloquer
            journal.exception("Échec de l'opération de synchronisation %s", op_id)
            return {**base, "statut": "erreur", "code": 500, "id": pk, "erreurs": "Erreur interne du serveur."}

        resultat = {**base, "statut": "ok", "code": reponse.status_code, "id": pk_resultat,
                    "ligne": ligne_brute(table, pk_resultat) if pk_resultat else None}
        if action not in ("creer", "modifier", "supprimer"):
            resultat["reponse"] = _donnees_json(reponse.data)
        return resultat

    def controler(self, op):
        if not isinstance(op, dict):
            raise Echec("invalide", 400, "Opération mal formée.")
        try:
            op_id = uuid.UUID(str(op.get("op_id")))
        except ValueError as exc:
            raise Echec("invalide", 400, "op_id : UUID obligatoire.") from exc
        table = PAR_NOM.get(op.get("table"))
        if table is None:
            raise Echec("invalide", 400, f"Table inconnue : {op.get('table')}.")
        action = op.get("action")
        if action not in table.envoi:
            raise Echec("invalide", 400, f"Action « {action} » non autorisée hors ligne sur {table.nom} "
                                         f"(possibles : {', '.join(sorted(table.envoi)) or 'aucune'}).")
        pk = None
        _, _, _, sur_ligne = table.envoi[action]
        if sur_ligne or action == "creer":
            try:
                pk = uuid.UUID(str(op.get("id")))
            except ValueError as exc:
                raise Echec("invalide", 400, "id : UUID obligatoire.") from exc
        if op.get("donnees") is not None and not isinstance(op["donnees"], dict):
            raise Echec("invalide", 400, "donnees : objet attendu.")
        return op_id, table, action, pk

    def appliquer(self, request, op, table, action, pk):
        viewset, methode, action_vue, sur_ligne = table.envoi[action]
        donnees = dict(op.get("donnees") or {})

        if action == "creer":
            if table.modele.tous.filter(pk=pk).exists():
                raise Echec("conflit", 409, {"erreurs": "Cet identifiant existe déjà sur le serveur.",
                                             "serveur": ligne_brute(table, pk)})
            donnees["id"] = str(pk)
        elif action in ACTIONS_SUR_LIGNE_VERSIONNEE:
            ligne = table.modele.tous.select_for_update().filter(pk=pk).first()
            if ligne is None:
                raise Echec("erreur", 404, "Enregistrement introuvable sur le serveur.")
            if ligne.deleted_at is not None:
                raise Echec("conflit", 409, {"erreurs": "Enregistrement supprimé sur le serveur.",
                                             "serveur": ligne_brute(table, pk)})
            version = op.get("version")
            if not isinstance(version, int):
                raise Echec("invalide", 400, "version : entier obligatoire pour modifier / supprimer.")
            if ligne.version != version:
                raise Echec("conflit", 409, {"erreurs": f"Modifié sur le serveur entre-temps (version serveur "
                                                        f"{ligne.version}, version du client {version}).",
                                             "serveur": ligne_brute(table, pk)})

        entetes = {"HTTP_HOST": request.get_host(), "SERVER_NAME": request.META.get("SERVER_NAME", "localhost"),
                   "REMOTE_ADDR": request.META.get("REMOTE_ADDR", "")}
        if op.get("motif"):
            entetes["HTTP_X_MOTIF"] = str(op["motif"])
        appel = getattr(self.fabrique, methode)(
            f"/api/sync/push/{table.nom}/{action}/", data=json.dumps(donnees) if methode != "delete" else None,
            content_type="application/json", **entetes)
        appel._force_auth_user = request.user                 # authentification déjà faite pour ce push
        appel._force_auth_token = request.auth
        vue = viewset.as_view({methode: action_vue})
        reponse = vue(appel, pk=str(pk)) if sur_ligne else vue(appel)

        if reponse.status_code >= 400:
            raise Echec(_statut_pour(reponse.status_code), reponse.status_code, _donnees_json(reponse.data))

        if action == "nouvelle":
            return reponse.data.get("inscription_id"), reponse
        if action == "creer":
            return reponse.data.get("id", pk), reponse
        return pk, reponse

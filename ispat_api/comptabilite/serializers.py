from decimal import Decimal

from django.utils import timezone
from rest_framework import serializers

from core.base_serializers import SerializerSynchro, champs

from .calculs import du_concerne, situation_inscription, tarif_applicable
from .models import FraisInscription, MouvementCaisse, PriseEnCharge, Versement

ETATS_FINANCABLES = ("VALIDEE", "ABANDON")      # une dette d'abandon reste encaissable
MODES_AVEC_REFERENCE = ("MOBILE_MONEY", "VIREMENT", "CHEQUE")


def _valeur(attrs, instance, nom):
    if nom in attrs:
        return attrs[nom]
    return getattr(instance, nom, None) if instance is not None else None


def _infos_etudiant(serializer_field_source):
    return serializers.CharField(source=serializer_field_source, read_only=True, default=None)


# --------------------------------------------------------------------------------------
# Frais dus (scolarité + frais annexes)
# --------------------------------------------------------------------------------------

class FraisInscriptionSerializer(SerializerSynchro):
    type_frais_code = serializers.CharField(source="type_frais.code", read_only=True)
    type_frais_libelle = serializers.CharField(source="type_frais.libelle", read_only=True)
    categorie = serializers.CharField(source="type_frais.categorie", read_only=True)
    etudiant_matricule = _infos_etudiant("inscription.etudiant.matricule")
    etudiant_nom = serializers.SerializerMethodField()
    classe_libelle = serializers.CharField(source="inscription.classe.libelle", read_only=True)
    montant = serializers.DecimalField(max_digits=14, decimal_places=0, min_value=Decimal("0"), required=False)
    remise = serializers.DecimalField(max_digits=14, decimal_places=0, min_value=Decimal("0"), required=False)
    montant_du = serializers.DecimalField(max_digits=14, decimal_places=0, read_only=True)

    class Meta:
        model = FraisInscription
        fields = champs("inscription", "etudiant_matricule", "etudiant_nom", "classe_libelle", "type_frais",
                        "type_frais_code", "type_frais_libelle", "categorie", "montant", "remise", "motif_remise",
                        "montant_du", "date_echeance")

    def get_etudiant_nom(self, obj):
        e = obj.inscription.etudiant
        return f"{e.nom} {e.prenoms}"

    def validate(self, attrs):
        inst = self.instance
        inscription = _valeur(attrs, inst, "inscription")
        type_frais = _valeur(attrs, inst, "type_frais")
        if inst is not None and (("inscription" in attrs and attrs["inscription"].pk != inst.inscription_id)
                                 or ("type_frais" in attrs and attrs["type_frais"].pk != inst.type_frais_id)):
            raise serializers.ValidationError("L'inscription et le type de frais ne se modifient pas.")
        if inscription.etat not in ETATS_FINANCABLES:
            raise serializers.ValidationError({"inscription": "L'inscription doit être validée."})

        if inst is None:
            if FraisInscription.objects.filter(inscription=inscription, type_frais=type_frais).exists():
                raise serializers.ValidationError({"type_frais": "Ces frais sont déjà affectés à cette inscription."})
            if attrs.get("montant") is None:
                montant = tarif_applicable(inscription, type_frais.pk)
                if montant is None:
                    raise serializers.ValidationError({"montant": "Aucun tarif pour ces frais : montant obligatoire."})
                attrs["montant"] = montant

        montant = _valeur(attrs, inst, "montant")
        remise = _valeur(attrs, inst, "remise") or Decimal("0")
        if remise > montant:
            raise serializers.ValidationError({"remise": "La remise dépasse le montant."})
        if remise > 0 and not (_valeur(attrs, inst, "motif_remise") or "").strip():
            raise serializers.ValidationError({"motif_remise": "Motif obligatoire pour une remise."})

        if inst is not None and ("montant" in attrs or "remise" in attrs):
            situation = situation_inscription(inscription.pk)
            nouveau_du = situation["total_du"] - inst.montant_du + (montant - remise)
            if nouveau_du < situation["verse_total"]:
                raise serializers.ValidationError(
                    f"Impossible : le total dû ({nouveau_du}) serait inférieur au total déjà versé "
                    f"({situation['verse_total']}).")
            ligne = next((f for f in situation["frais"] if f["frais_id"] == inst.pk), None)
            if ligne and (montant - remise) < ligne["verse_impute"]:
                raise serializers.ValidationError(
                    f"Impossible : {ligne['verse_impute']} déjà versés sur ces frais.")
        return attrs


class AffectationClasseSerializer(serializers.Serializer):
    """Affecter un frais annexe à toute une classe (ex : sortie terrain)."""

    classe = serializers.UUIDField()
    type_frais = serializers.UUIDField()
    montant = serializers.DecimalField(max_digits=14, decimal_places=0, min_value=Decimal("0"), required=False)
    date_echeance = serializers.DateField(required=False)


# --------------------------------------------------------------------------------------
# Prises en charge
# --------------------------------------------------------------------------------------

class PriseEnChargeSerializer(SerializerSynchro):
    etudiant_matricule = _infos_etudiant("inscription.etudiant.matricule")
    etudiant_nom = serializers.SerializerMethodField()
    type_frais_libelle = serializers.CharField(source="type_frais.libelle", read_only=True, default=None)
    montant = serializers.DecimalField(max_digits=14, decimal_places=0, min_value=Decimal("0"), required=False)
    taux = serializers.DecimalField(max_digits=5, decimal_places=2, min_value=Decimal("0"), max_value=Decimal("100"),
                                    required=False, allow_null=True)

    class Meta:
        model = PriseEnCharge
        fields = champs("inscription", "etudiant_matricule", "etudiant_nom", "type_frais", "type_frais_libelle",
                        "type_payeur", "organisme", "taux", "montant", "reference_doc", "date_accord", "statut")

    def get_etudiant_nom(self, obj):
        e = obj.inscription.etudiant
        return f"{e.nom} {e.prenoms}"

    def validate_organisme(self, valeur):
        return " ".join(valeur.split())

    def validate(self, attrs):
        inst = self.instance
        inscription = _valeur(attrs, inst, "inscription")
        if inst is not None and "inscription" in attrs and attrs["inscription"].pk != inst.inscription_id:
            raise serializers.ValidationError({"inscription": "L'inscription ne se modifie pas."})
        if inscription.etat not in ETATS_FINANCABLES:
            raise serializers.ValidationError({"inscription": "L'inscription doit être validée."})

        type_frais = _valeur(attrs, inst, "type_frais")
        concerne = du_concerne(inscription.pk, type_frais.pk if type_frais else None)
        if type_frais and concerne == 0:
            raise serializers.ValidationError({"type_frais": "Ces frais ne sont pas dus par cette inscription."})

        taux = _valeur(attrs, inst, "taux")
        if "montant" not in attrs and ("taux" in attrs or "type_frais" in attrs or inst is None):
            if taux is None:
                raise serializers.ValidationError({"montant": "Fournir un montant ou un taux."})
            attrs["montant"] = (concerne * taux / Decimal("100")).quantize(Decimal("1"))
        montant = _valeur(attrs, inst, "montant")
        if montant > concerne:
            raise serializers.ValidationError({"montant": f"Le montant dépasse les frais concernés ({concerne})."})

        statut = _valeur(attrs, inst, "statut") or "ACTIVE"
        if statut == "ACTIVE":
            autres = PriseEnCharge.objects.filter(inscription=inscription, statut="ACTIVE")
            if inst is not None:
                autres = autres.exclude(pk=inst.pk)
            total = sum((p.montant for p in autres), Decimal("0")) + montant
            total_du = du_concerne(inscription.pk)
            if total > total_du:
                raise serializers.ValidationError(
                    {"montant": f"Le total des prises en charge ({total}) dépasse le total dû ({total_du})."})
        if inst is not None and statut != "ACTIVE" and inst.versements.filter(annule=False).exists():
            raise serializers.ValidationError({"statut": "Des versements de cet organisme existent : annuler d'abord ces versements."})
        return attrs


# --------------------------------------------------------------------------------------
# Versements
# --------------------------------------------------------------------------------------

class VersementSerializer(SerializerSynchro):
    etudiant_id = serializers.UUIDField(source="inscription.etudiant_id", read_only=True)
    etudiant_matricule = _infos_etudiant("inscription.etudiant.matricule")
    etudiant_nom = serializers.SerializerMethodField()
    classe_libelle = serializers.CharField(source="inscription.classe.libelle", read_only=True)
    annee_libelle = serializers.CharField(source="inscription.annee.libelle", read_only=True)
    type_frais_libelle = serializers.CharField(source="type_frais.libelle", read_only=True, default=None)
    organisme = serializers.CharField(source="prise_en_charge.organisme", read_only=True, default=None)
    encaisse_par_nom = serializers.SerializerMethodField()
    montant = serializers.DecimalField(max_digits=14, decimal_places=0, min_value=Decimal("1"))

    class Meta:
        model = Versement
        fields = champs("inscription", "etudiant_id", "etudiant_matricule", "etudiant_nom", "classe_libelle",
                        "annee_libelle", "type_frais", "type_frais_libelle", "payeur", "prise_en_charge", "organisme",
                        "montant", "date_versement", "mode_paiement", "reference", "numero_recu", "annule",
                        "motif_annulation", "encaisse_par", "encaisse_par_nom")
        read_only_fields = ["numero_recu", "annule", "motif_annulation", "encaisse_par"]

    def get_etudiant_nom(self, obj):
        e = obj.inscription.etudiant
        return f"{e.nom} {e.prenoms}"

    def get_encaisse_par_nom(self, obj):
        return obj.encaisse_par.nom_complet if obj.encaisse_par_id else None

    def validate_reference(self, valeur):
        return (valeur or "").strip() or None

    def validate_date_versement(self, valeur):
        if valeur > timezone.localdate():
            raise serializers.ValidationError("Date future impossible.")
        return valeur

    def validate(self, attrs):
        if self.instance is not None:
            raise serializers.ValidationError("Un versement ne se modifie pas : l'annuler puis le ressaisir.")
        inscription = attrs["inscription"]
        if inscription.etat not in ETATS_FINANCABLES:
            raise serializers.ValidationError({"inscription": "L'inscription doit être validée."})
        if attrs["mode_paiement"] in MODES_AVEC_REFERENCE and not attrs.get("reference"):
            raise serializers.ValidationError({"reference": "Référence obligatoire (n° de transaction ou de chèque)."})

        situation = situation_inscription(inscription.pk)
        montant = attrs["montant"]
        payeur = attrs.get("payeur") or "ETUDIANT"
        pec = attrs.get("prise_en_charge")

        if payeur == "PRISE_EN_CHARGE":
            if pec is None:
                raise serializers.ValidationError({"prise_en_charge": "Prise en charge obligatoire pour ce payeur."})
            if pec.inscription_id != inscription.pk or pec.statut != "ACTIVE":
                raise serializers.ValidationError({"prise_en_charge": "Prise en charge inactive ou d'une autre inscription."})
            reste_pec = next((p["reste"] for p in situation["prises_en_charge"] if p["id"] == pec.pk), Decimal("0"))
            if montant > reste_pec:
                raise serializers.ValidationError({"montant": f"Dépasse le reste dû par l'organisme ({reste_pec})."})
            if not attrs.get("type_frais") and pec.type_frais_id:
                attrs["type_frais"] = pec.type_frais
        else:
            if pec is not None:
                raise serializers.ValidationError({"prise_en_charge": "Uniquement pour un versement d'organisme."})
            if montant > situation["reste_etudiant"]:
                raise serializers.ValidationError(
                    {"montant": f"Dépasse le reste à payer par l'étudiant ({situation['reste_etudiant']})."})

        type_frais = attrs.get("type_frais")
        if type_frais:
            ligne = next((f for f in situation["frais"] if f["type_frais_id"] == type_frais.pk), None)
            if ligne is None:
                raise serializers.ValidationError({"type_frais": "Ces frais ne sont pas dus par cette inscription."})
            reste_type = ligne["du"] - ligne["verse_impute"]
            if montant > reste_type:
                raise serializers.ValidationError({"montant": f"Dépasse le reste de « {ligne['libelle']} » ({reste_type})."})
        attrs["payeur"] = payeur
        return attrs


# --------------------------------------------------------------------------------------
# Mouvements de caisse (entrées / sorties)
# --------------------------------------------------------------------------------------

class MouvementCaisseSerializer(SerializerSynchro):
    categorie_code = serializers.CharField(source="categorie.code", read_only=True)
    categorie_libelle = serializers.CharField(source="categorie.libelle", read_only=True)
    saisi_par_nom = serializers.SerializerMethodField()
    numero_recu = serializers.CharField(source="versement.numero_recu", read_only=True, default=None)
    justificatif_url = serializers.SerializerMethodField()
    montant = serializers.DecimalField(max_digits=14, decimal_places=0, min_value=Decimal("1"))
    justificatif = serializers.FileField(write_only=True, required=False)

    class Meta:
        model = MouvementCaisse
        fields = champs("sens", "categorie", "categorie_code", "categorie_libelle", "montant", "date_mouvement",
                        "libelle", "tiers", "mode_paiement", "reference", "versement", "numero_recu", "annule",
                        "saisi_par", "saisi_par_nom", "justificatif_url", "justificatif")
        read_only_fields = ["sens", "versement", "annule", "saisi_par"]

    def get_saisi_par_nom(self, obj):
        return obj.saisi_par.nom_complet if obj.saisi_par_id else None

    def get_justificatif_url(self, obj):
        if not obj.justificatif_chemin:
            return None
        from django.urls import reverse
        return reverse("mouvement-caisse-justificatif", kwargs={"pk": obj.pk})

    def validate_libelle(self, valeur):
        return " ".join(valeur.split())

    def validate_date_mouvement(self, valeur):
        if valeur > timezone.localdate():
            raise serializers.ValidationError("Date future impossible.")
        return valeur

    def validate(self, attrs):
        inst = self.instance
        if inst is not None and inst.versement_id:
            raise serializers.ValidationError("Écriture générée par un versement : passer par le versement.")
        if inst is not None and inst.annule:
            raise serializers.ValidationError("Écriture annulée : modification impossible.")
        categorie = _valeur(attrs, inst, "categorie")
        if categorie.code == "VERSEMENT_SCOLARITE":
            raise serializers.ValidationError({"categorie": "Catégorie réservée aux versements des étudiants."})
        if (_valeur(attrs, inst, "mode_paiement") in MODES_AVEC_REFERENCE
                and not (_valeur(attrs, inst, "reference") or "").strip()):
            raise serializers.ValidationError({"reference": "Référence obligatoire pour ce mode de paiement."})
        attrs["sens"] = categorie.sens
        if inst is not None and categorie.sens != inst.sens:
            raise serializers.ValidationError({"categorie": "Une entrée ne peut pas devenir une sortie (et inversement)."})
        return attrs

    def create(self, validated_data):
        fichier = validated_data.pop("justificatif", None)
        if fichier is not None:
            from scolarite.fichiers import enregistrer_piece
            validated_data["justificatif_chemin"] = enregistrer_piece(fichier, dossier="justificatifs")[0]
        return super().create(validated_data)

    def update(self, instance, validated_data):
        validated_data.pop("justificatif", None)
        return super().update(instance, validated_data)

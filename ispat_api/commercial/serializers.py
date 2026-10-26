from datetime import date, timedelta

from django.utils import timezone
from rest_framework import serializers

from core.base_serializers import SerializerSynchro, champs
from referentiels.models import AnneeAcademique, Ecole
from scolarite.serializers import normaliser_telephone

from .models import CampagneProspection, Preinscription, Prospect, SuiviProspect


def _valeur(attrs, instance, nom):
    if nom in attrs:
        return attrs[nom]
    return getattr(instance, nom, None) if instance is not None else None


class IdentiteMixin:
    """Normalisation commune prospect / pré-inscription."""

    def validate_nom(self, valeur):
        return " ".join(valeur.split()).upper()

    def validate_prenoms(self, valeur):
        return " ".join(valeur.split()).title()

    def validate_telephone(self, valeur):
        return normaliser_telephone(valeur)

    def validate_email(self, valeur):
        return (valeur or "").strip().lower() or None

    def validate_serie_bac(self, valeur):
        return (valeur or "").strip().upper() or None

    def validate_date_naissance(self, valeur):
        if valeur and not (date(1950, 1, 1) <= valeur <= timezone.localdate()):
            raise serializers.ValidationError("Date de naissance invalide.")
        return valeur

    def resoudre_ecole(self, attrs):
        """« ecole_nom » libre : école retrouvée (sans accents ni casse) dans la ville, sinon créée."""
        nom = " ".join((attrs.pop("ecole_nom", "") or "").split())
        if not nom or attrs.get("ecole"):
            return attrs
        ville = _valeur(attrs, self.instance, "ville")
        qs = Ecole.objects.filter(nom__unaccent__iexact=nom)
        qs = qs.filter(ville=ville) if ville else qs.filter(ville__isnull=True)
        attrs["ecole"] = qs.first() or Ecole.objects.create(nom=nom, ville=ville, type_ecole="LYCEE")
        return attrs


# --------------------------------------------------------------------------------------
# Campagnes
# --------------------------------------------------------------------------------------

class CampagneSerializer(SerializerSynchro):
    annee_libelle = serializers.CharField(source="annee.libelle", read_only=True)
    objectif = serializers.IntegerField(min_value=1, required=False, allow_null=True)
    nb_prospects = serializers.IntegerField(read_only=True, required=False)
    nb_preinscrits = serializers.IntegerField(read_only=True, required=False)
    nb_inscrits = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = CampagneProspection
        fields = champs("annee", "annee_libelle", "libelle", "date_debut", "date_fin", "objectif",
                        "nb_prospects", "nb_preinscrits", "nb_inscrits")

    def validate_libelle(self, valeur):
        return " ".join(valeur.split())

    def validate(self, attrs):
        debut, fin = _valeur(attrs, self.instance, "date_debut"), _valeur(attrs, self.instance, "date_fin")
        if debut and fin and fin < debut:
            raise serializers.ValidationError({"date_fin": "La date de fin précède la date de début."})
        return attrs


# --------------------------------------------------------------------------------------
# Prospects
# --------------------------------------------------------------------------------------

STATUTS_MANUELS = ("NOUVEAU", "CONTACTE", "PERDU")


class ProspectSerializer(IdentiteMixin, SerializerSynchro):
    campagne_libelle = serializers.CharField(source="campagne.libelle", read_only=True, default=None)
    ville_libelle = serializers.CharField(source="ville.libelle", read_only=True, default=None)
    ecole_libelle = serializers.CharField(source="ecole.nom", read_only=True, default=None)
    filiere_souhaitee_code = serializers.CharField(source="filiere_souhaitee.code", read_only=True, default=None)
    agent_nom = serializers.SerializerMethodField()
    etudiant_matricule = serializers.CharField(source="etudiant.matricule", read_only=True, default=None)
    email = serializers.EmailField(required=False, allow_null=True, allow_blank=True)
    telephone_parent = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    ecole_nom = serializers.CharField(write_only=True, required=False, allow_blank=True)
    nb_relances = serializers.IntegerField(read_only=True, required=False)
    derniere_relance = serializers.DateTimeField(read_only=True, required=False)
    prochaine_relance = serializers.DateField(read_only=True, required=False)

    class Meta:
        model = Prospect
        fields = champs("campagne", "campagne_libelle", "nom", "prenoms", "sexe", "date_naissance", "telephone",
                        "telephone_parent", "email", "ville", "ville_libelle", "ecole", "ecole_libelle", "ecole_nom",
                        "niveau_etude", "serie_bac", "filiere_souhaitee", "filiere_souhaitee_code", "source", "agent",
                        "agent_nom", "date_contact", "statut", "etudiant", "etudiant_matricule", "observations",
                        "nb_relances", "derniere_relance", "prochaine_relance")
        read_only_fields = ["agent", "etudiant"]

    def get_agent_nom(self, obj):
        return obj.agent.nom_complet if obj.agent_id else None

    def validate_telephone_parent(self, valeur):
        return normaliser_telephone(valeur)

    def validate_date_contact(self, valeur):
        if valeur > timezone.localdate():
            raise serializers.ValidationError("Date future impossible.")
        return valeur

    def validate(self, attrs):
        inst = self.instance
        if "statut" in attrs:
            ancien = inst.statut if inst else "NOUVEAU"
            if attrs["statut"] != ancien and attrs["statut"] not in STATUTS_MANUELS:
                raise serializers.ValidationError(
                    {"statut": "Pré-inscrit et inscrit sont attribués automatiquement (pré-inscription, inscription)."})
            if inst is not None and ancien == "INSCRIT" and attrs["statut"] != "INSCRIT":
                raise serializers.ValidationError({"statut": "Prospect inscrit : statut figé."})
        campagne = _valeur(attrs, inst, "campagne")
        date_contact = _valeur(attrs, inst, "date_contact") or timezone.localdate()
        if campagne and date_contact < campagne.date_debut:
            raise serializers.ValidationError({"date_contact": "Date antérieure au début de la campagne."})
        if not (_valeur(attrs, inst, "telephone") or _valeur(attrs, inst, "telephone_parent")):
            raise serializers.ValidationError({"telephone": "Au moins un numéro (prospect ou parent) est obligatoire."})
        filiere = attrs.get("filiere_souhaitee")
        if filiere is not None and not filiere.active:
            raise serializers.ValidationError({"filiere_souhaitee": "Filière désactivée."})
        return self.resoudre_ecole(attrs)


class SuiviSerializer(SerializerSynchro):
    prospect_nom = serializers.SerializerMethodField()
    agent_nom = serializers.SerializerMethodField()

    class Meta:
        model = SuiviProspect
        fields = champs("prospect", "prospect_nom", "date_suivi", "canal", "resultat", "prochaine_relance", "agent",
                        "agent_nom")
        read_only_fields = ["agent"]

    def get_prospect_nom(self, obj):
        return f"{obj.prospect.nom} {obj.prospect.prenoms}"

    def get_agent_nom(self, obj):
        return obj.agent.nom_complet if obj.agent_id else None

    def validate(self, attrs):
        inst = self.instance
        if inst is not None and "prospect" in attrs and attrs["prospect"].pk != inst.prospect_id:
            raise serializers.ValidationError({"prospect": "Une relance ne change pas de prospect."})
        quand = _valeur(attrs, inst, "date_suivi") or timezone.now()
        if quand > timezone.now() + timedelta(minutes=5):
            raise serializers.ValidationError({"date_suivi": "Date future impossible (utiliser « prochaine_relance »)."})
        prochaine = attrs.get("prochaine_relance")
        if prochaine and prochaine < timezone.localdate():
            raise serializers.ValidationError({"prochaine_relance": "La prochaine relance doit être aujourd'hui ou plus tard."})
        return attrs


# --------------------------------------------------------------------------------------
# Pré-inscriptions
# --------------------------------------------------------------------------------------

class PreinscriptionSerializer(IdentiteMixin, SerializerSynchro):
    annee_libelle = serializers.CharField(source="annee.libelle", read_only=True)
    ville_libelle = serializers.CharField(source="ville.libelle", read_only=True, default=None)
    ecole_libelle = serializers.CharField(source="ecole.nom", read_only=True, default=None)
    filiere_souhaitee_code = serializers.CharField(source="filiere_souhaitee.code", read_only=True, default=None)
    filiere_souhaitee_libelle = serializers.CharField(source="filiere_souhaitee.libelle", read_only=True, default=None)
    niveau_souhaite_code = serializers.CharField(source="niveau_souhaite.code", read_only=True, default=None)
    prospect_statut = serializers.CharField(source="prospect.statut", read_only=True, default=None)
    traite_par_nom = serializers.SerializerMethodField()
    inscription_etat = serializers.CharField(source="inscription.etat", read_only=True, default=None)
    matricule = serializers.CharField(source="inscription.etudiant.matricule", read_only=True, default=None)
    email = serializers.EmailField(required=False, allow_null=True, allow_blank=True)
    ecole_nom = serializers.CharField(write_only=True, required=False, allow_blank=True)
    nb_pieces = serializers.IntegerField(read_only=True, required=False)
    annee = serializers.PrimaryKeyRelatedField(queryset=AnneeAcademique.objects.all(), required=False)

    class Meta:
        model = Preinscription
        fields = champs("annee", "annee_libelle", "prospect", "prospect_statut", "nom", "prenoms", "sexe",
                        "date_naissance", "lieu_naissance", "telephone", "email", "ville", "ville_libelle", "ecole",
                        "ecole_libelle", "ecole_nom", "serie_bac", "filiere_souhaitee", "filiere_souhaitee_code",
                        "filiere_souhaitee_libelle", "niveau_souhaite", "niveau_souhaite_code", "source", "wp_entry_id",
                        "statut", "inscription", "inscription_etat", "matricule", "traite_par", "traite_par_nom",
                        "traite_le", "motif_rejet", "nb_pieces")
        read_only_fields = ["statut", "inscription", "traite_par", "traite_le", "motif_rejet", "wp_entry_id"]

    def get_traite_par_nom(self, obj):
        return obj.traite_par.nom_complet if obj.traite_par_id else None

    def validate(self, attrs):
        inst = self.instance
        if inst is not None and inst.statut in ("CONVERTIE", "REJETEE"):
            raise serializers.ValidationError("Pré-inscription inscrite ou rejetée : modification impossible.")
        if inst is None and not attrs.get("annee"):
            annee = AnneeAcademique.objects.filter(est_active=True).first()
            if annee is None:
                raise serializers.ValidationError({"annee": "Aucune année active : préciser l'année."})
            attrs["annee"] = annee
        if not _valeur(attrs, inst, "telephone"):
            raise serializers.ValidationError({"telephone": "Téléphone obligatoire."})
        filiere = attrs.get("filiere_souhaitee")
        if filiere is not None and not filiere.active:
            raise serializers.ValidationError({"filiere_souhaitee": "Filière désactivée."})
        prospect = attrs.get("prospect")
        if prospect is not None and prospect.statut == "INSCRIT":
            raise serializers.ValidationError({"prospect": "Ce prospect est déjà inscrit."})
        return self.resoudre_ecole(attrs)


class InscrireSerializer(serializers.Serializer):
    """Conversion prospect / pré-inscription -> inscription (EN_ATTENTE, validée ensuite par la scolarité)."""

    id = serializers.UUIDField(required=False)
    classe = serializers.UUIDField()
    statut_etudiant = serializers.UUIDField()
    etudiant_id = serializers.UUIDField(required=False)
    forcer = serializers.BooleanField(required=False, default=False)
    etudiant = serializers.DictField(required=False, default=dict)      # compléments (lieu de naissance, ...)
    observations = serializers.CharField(required=False, allow_blank=True, allow_null=True)


class MotifSerializer(serializers.Serializer):
    motif = serializers.CharField(min_length=3)

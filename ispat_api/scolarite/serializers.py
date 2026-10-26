import re
from datetime import date

from django.urls import reverse
from rest_framework import serializers

from core.base_serializers import SerializerSynchro, champs

from .models import ContactEtudiant, Etudiant, Inscription, PieceJointe


def _valeur(attrs, instance, nom):
    if nom in attrs:
        return attrs[nom]
    return getattr(instance, nom, None) if instance is not None else None


def normaliser_telephone(valeur):
    if not valeur:
        return None
    propre = re.sub(r"[^\d+]", "", valeur)
    if len(re.sub(r"\D", "", propre)) < 8:
        raise serializers.ValidationError("Numéro de téléphone trop court.")
    return propre


# --------------------------------------------------------------------------------------
# Étudiants
# --------------------------------------------------------------------------------------

class ContactEtudiantSerializer(SerializerSynchro):
    class Meta:
        model = ContactEtudiant
        fields = champs("etudiant", "lien", "nom_complet", "telephone", "profession", "est_urgence")
        extra_kwargs = {"etudiant": {"required": False}}

    def validate_nom_complet(self, valeur):
        return " ".join(valeur.split())

    def validate_telephone(self, valeur):
        return normaliser_telephone(valeur)

    def validate(self, attrs):
        if self.instance is None and "etudiant" not in attrs and not self.context.get("etudiant_fourni"):
            raise serializers.ValidationError({"etudiant": "Étudiant obligatoire."})
        if self.instance is not None and "etudiant" in attrs and attrs["etudiant"].pk != self.instance.etudiant_id:
            raise serializers.ValidationError({"etudiant": "Un contact ne peut pas changer d'étudiant."})
        return attrs


class EtudiantSerializer(SerializerSynchro):
    email = serializers.EmailField(required=False, allow_null=True, allow_blank=True)
    ville_libelle = serializers.CharField(source="ville.libelle", read_only=True, default=None)
    ecole_origine_nom = serializers.CharField(source="ecole_origine.nom", read_only=True, default=None)
    photo_url = serializers.SerializerMethodField()

    class Meta:
        model = Etudiant
        fields = champs("matricule", "nom", "prenoms", "sexe", "date_naissance", "lieu_naissance", "nationalite",
                        "num_piece_identite", "telephone", "email", "adresse", "ville", "ville_libelle",
                        "ecole_origine", "ecole_origine_nom", "serie_bac", "annee_bac", "photo_url")
        read_only_fields = ["matricule"]

    def get_photo_url(self, obj):
        if not obj.photo_chemin:
            return None
        return reverse("etudiant-photo", kwargs={"pk": obj.pk}) + f"?v={obj.version}"

    def validate_nom(self, valeur):
        return " ".join(valeur.split()).upper()

    def validate_prenoms(self, valeur):
        return " ".join(valeur.split()).title()

    def validate_telephone(self, valeur):
        return normaliser_telephone(valeur)

    def validate_email(self, valeur):
        return (valeur or "").strip().lower() or None

    def validate_date_naissance(self, valeur):
        if valeur and not (date(1940, 1, 1) <= valeur <= date.today()):
            raise serializers.ValidationError("Date de naissance invalide.")
        return valeur

    def validate_annee_bac(self, valeur):
        if valeur and not (1960 <= valeur <= date.today().year):
            raise serializers.ValidationError("Année du BAC invalide.")
        return valeur

    def validate_serie_bac(self, valeur):
        return (valeur or "").strip().upper() or None


# --------------------------------------------------------------------------------------
# Inscriptions
# --------------------------------------------------------------------------------------

class InscriptionSerializer(SerializerSynchro):
    etudiant_matricule = serializers.CharField(source="etudiant.matricule", read_only=True, default=None)
    etudiant_nom = serializers.CharField(source="etudiant.nom", read_only=True)
    etudiant_prenoms = serializers.CharField(source="etudiant.prenoms", read_only=True)
    etudiant_sexe = serializers.CharField(source="etudiant.sexe", read_only=True)
    annee_libelle = serializers.CharField(source="annee.libelle", read_only=True)
    classe_libelle = serializers.CharField(source="classe.libelle", read_only=True)
    statut_etudiant_libelle = serializers.CharField(source="statut_etudiant.libelle", read_only=True)
    valide_par_nom = serializers.SerializerMethodField()

    class Meta:
        model = Inscription
        fields = champs("etudiant", "etudiant_matricule", "etudiant_nom", "etudiant_prenoms", "etudiant_sexe",
                        "annee", "annee_libelle", "classe", "classe_libelle", "statut_etudiant",
                        "statut_etudiant_libelle", "type_inscription", "date_inscription", "etat", "source",
                        "prospect_id", "valide_par", "valide_par_nom", "valide_le", "observations")
        read_only_fields = ["annee", "etat", "valide_par", "valide_le"]

    def get_valide_par_nom(self, obj):
        return obj.valide_par.nom_complet if obj.valide_par_id else None

    def validate(self, attrs):
        inst = self.instance
        etudiant = _valeur(attrs, inst, "etudiant")
        classe = _valeur(attrs, inst, "classe")

        if inst is not None:
            if "etudiant" in attrs and attrs["etudiant"].pk != inst.etudiant_id:
                raise serializers.ValidationError({"etudiant": "L'étudiant d'une inscription ne peut pas être changé."})
            if inst.etat in ("ANNULEE", "ABANDON"):
                raise serializers.ValidationError("Inscription annulée ou abandonnée : modification impossible.")
            if "classe" in attrs and classe.annee_id != inst.annee_id:
                raise serializers.ValidationError({"classe": "La nouvelle classe doit être de la même année académique."})
            if inst.etat == "VALIDEE" and "statut_etudiant" in attrs and attrs["statut_etudiant"].pk != inst.statut_etudiant_id:
                raise serializers.ValidationError(
                    {"statut_etudiant": "Statut modifiable uniquement avant validation (les frais ont été générés)."})
        else:
            attrs["annee"] = classe.annee
            doublon = Inscription.objects.filter(etudiant=etudiant, annee=classe.annee).exclude(etat="ANNULEE")
            if doublon.exists():
                raise serializers.ValidationError(
                    {"etudiant": f"Cet étudiant est déjà inscrit pour l'année {classe.annee.libelle}."})
        return attrs


class NouvelleInscriptionSerializer(serializers.Serializer):
    """
    Inscription complète en un appel (guichet ou saisie hors ligne) :
      * soit "etudiant" (nouvel étudiant), soit "etudiant_id" (réinscription d'un étudiant existant) ;
      * "contacts" facultatifs ;
      * la photo s'envoie ensuite : POST /etudiants/{id}/photo/.
    """

    id = serializers.UUIDField(required=False)                       # UUID client de l'inscription
    etudiant = serializers.DictField(required=False)
    etudiant_id = serializers.UUIDField(required=False)
    contacts = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    classe = serializers.UUIDField()
    statut_etudiant = serializers.UUIDField()
    type_inscription = serializers.ChoiceField(choices=Inscription.TYPES, required=False)
    date_inscription = serializers.DateField(required=False)
    source = serializers.ChoiceField(choices=Inscription.SOURCES, required=False, default="GUICHET")
    prospect_id = serializers.UUIDField(required=False, allow_null=True)
    observations = serializers.CharField(required=False, allow_blank=True, allow_null=True)

    def validate(self, attrs):
        if bool(attrs.get("etudiant")) == bool(attrs.get("etudiant_id")):
            raise serializers.ValidationError("Fournir soit « etudiant » (nouveau), soit « etudiant_id » (existant).")
        return attrs


# --------------------------------------------------------------------------------------
# Pièces jointes
# --------------------------------------------------------------------------------------

class PieceJointeSerializer(SerializerSynchro):
    type_piece_code = serializers.CharField(source="type_piece.code", read_only=True)
    type_piece_libelle = serializers.CharField(source="type_piece.libelle", read_only=True)
    url = serializers.SerializerMethodField()
    fichier = serializers.FileField(write_only=True)

    class Meta:
        model = PieceJointe
        fields = champs("type_piece", "type_piece_code", "type_piece_libelle", "etudiant", "inscription",
                        "preinscription_id", "nom_fichier", "mime_type", "taille_octets", "verifie", "verifie_par",
                        "url", "fichier")
        read_only_fields = ["nom_fichier", "mime_type", "taille_octets", "verifie", "verifie_par"]

    def get_url(self, obj):
        return reverse("piece-jointe-fichier", kwargs={"pk": obj.pk})

    def validate(self, attrs):
        if self.instance is not None:
            raise serializers.ValidationError("Une pièce ne se modifie pas : supprimer puis renvoyer le fichier.")
        etudiant = attrs.get("etudiant")
        inscription = attrs.get("inscription")
        if not etudiant and not inscription:
            raise serializers.ValidationError("Rattacher la pièce à un étudiant ou à une inscription.")
        if inscription:
            if etudiant and etudiant.pk != inscription.etudiant_id:
                raise serializers.ValidationError({"inscription": "Cette inscription n'est pas celle de l'étudiant."})
            attrs["etudiant"] = inscription.etudiant
        return attrs

    def create(self, validated_data):
        from .fichiers import enregistrer_piece

        chemin, mime, taille, nom_origine = enregistrer_piece(validated_data.pop("fichier"))
        validated_data.update(chemin=chemin, mime_type=mime, taille_octets=taille, nom_fichier=nom_origine)
        return super().create(validated_data)

from decimal import Decimal

from rest_framework import serializers

from core.base_serializers import SerializerSynchro, champs

from .models import (
    AnneeAcademique, CategorieMouvement, Classe, Ecole, Enseignant, Enseignement, Filiere, Matiere, Niveau,
    Parametre, Semestre, StatutEtudiant, Tarif, TypeFrais, TypePiece, Ville,
)


def _valeur(attrs, instance, nom):
    """Valeur d'un champ en tenant compte d'un PATCH partiel."""
    if nom in attrs:
        return attrs[nom]
    return getattr(instance, nom, None) if instance is not None else None


# --------------------------------------------------------------------------------------
# Calendrier
# --------------------------------------------------------------------------------------

class SemestreSerializer(SerializerSynchro):
    annee_libelle = serializers.CharField(source="annee.libelle", read_only=True)

    class Meta:
        model = Semestre
        fields = champs("annee", "annee_libelle", "numero", "date_debut", "date_fin", "cloture")
        read_only_fields = ["annee", "numero"]

    def validate(self, attrs):
        debut = _valeur(attrs, self.instance, "date_debut")
        fin = _valeur(attrs, self.instance, "date_fin")
        if debut and fin and fin <= debut:
            raise serializers.ValidationError({"date_fin": "La date de fin doit être postérieure au début."})
        return attrs


class SemestreCourtSerializer(serializers.ModelSerializer):
    class Meta:
        model = Semestre
        fields = ["id", "numero", "date_debut", "date_fin", "cloture"]


class AnneeAcademiqueSerializer(SerializerSynchro):
    semestres = SemestreCourtSerializer(many=True, read_only=True)

    class Meta:
        model = AnneeAcademique
        fields = champs("libelle", "date_debut", "date_fin", "est_active", "semestres")

    def validate_libelle(self, valeur):
        return valeur.strip()

    def validate(self, attrs):
        debut = _valeur(attrs, self.instance, "date_debut")
        fin = _valeur(attrs, self.instance, "date_fin")
        if debut and fin and fin <= debut:
            raise serializers.ValidationError({"date_fin": "La date de fin doit être postérieure au début."})
        return attrs

    def update(self, instance, validated_data):
        validated_data.pop("est_active", None)          # activation uniquement via /activer/
        return super().update(instance, validated_data)


# --------------------------------------------------------------------------------------
# Offre de formation
# --------------------------------------------------------------------------------------

class FiliereSerializer(SerializerSynchro):
    class Meta:
        model = Filiere
        fields = champs("code", "libelle", "description", "active")

    def validate_code(self, valeur):
        code = valeur.strip().upper()
        if not code.isalnum() or not 2 <= len(code) <= 5:
            raise serializers.ValidationError("Code de 2 à 5 caractères alphanumériques (3 lettres conseillées : il entre dans le matricule).")
        return code


class NiveauSerializer(SerializerSynchro):
    class Meta:
        model = Niveau
        fields = champs("code", "libelle", "ordre")

    def validate_code(self, valeur):
        return valeur.strip().upper()


class ClasseSerializer(SerializerSynchro):
    annee_libelle = serializers.CharField(source="annee.libelle", read_only=True)
    filiere_code = serializers.CharField(source="filiere.code", read_only=True)
    filiere_libelle = serializers.CharField(source="filiere.libelle", read_only=True)
    niveau_code = serializers.CharField(source="niveau.code", read_only=True)

    class Meta:
        model = Classe
        fields = champs("annee", "annee_libelle", "filiere", "filiere_code", "filiere_libelle",
                        "niveau", "niveau_code", "libelle", "groupe", "capacite")
        extra_kwargs = {"libelle": {"required": False}}

    def validate_groupe(self, valeur):
        return (valeur or "").strip().upper() or None

    def validate_capacite(self, valeur):
        if valeur is not None and valeur <= 0:
            raise serializers.ValidationError("La capacité doit être positive.")
        return valeur

    def validate(self, attrs):
        filiere = _valeur(attrs, self.instance, "filiere")
        niveau = _valeur(attrs, self.instance, "niveau")
        groupe = _valeur(attrs, self.instance, "groupe")
        if "filiere" in attrs and not filiere.active:
            raise serializers.ValidationError({"filiere": "Cette filière est désactivée."})
        if not (attrs.get("libelle") or "").strip() and (self.instance is None or "libelle" in attrs):
            attrs["libelle"] = f"{niveau.code} {filiere.libelle}" + (f" {groupe}" if groupe else "")
        return attrs


class MatiereSerializer(SerializerSynchro):
    filiere_libelle = serializers.CharField(source="filiere.libelle", read_only=True)
    niveau_code = serializers.CharField(source="niveau.code", read_only=True)
    coefficient = serializers.DecimalField(max_digits=4, decimal_places=2, min_value=Decimal("0.01"), required=False)
    credits = serializers.IntegerField(min_value=0, max_value=60, required=False)

    class Meta:
        model = Matiere
        fields = champs("code", "libelle", "filiere", "filiere_libelle", "niveau", "niveau_code",
                        "semestre_numero", "coefficient", "credits", "volume_horaire")

    def validate_code(self, valeur):
        return valeur.strip().upper()


class EnseignantSerializer(SerializerSynchro):
    utilisateur_login = serializers.CharField(source="utilisateur.login", read_only=True, default=None)

    class Meta:
        model = Enseignant
        fields = champs("utilisateur", "utilisateur_login", "nom", "prenoms", "sexe", "telephone", "email",
                        "specialite", "type_contrat")

    def validate_nom(self, valeur):
        return valeur.strip().upper()

    def validate_prenoms(self, valeur):
        return valeur.strip()


class EnseignementSerializer(SerializerSynchro):
    enseignant_nom = serializers.SerializerMethodField()
    matiere_libelle = serializers.CharField(source="matiere.libelle", read_only=True)
    classe_libelle = serializers.CharField(source="classe.libelle", read_only=True)
    semestre_numero = serializers.IntegerField(source="semestre.numero", read_only=True)

    class Meta:
        model = Enseignement
        fields = champs("enseignant", "enseignant_nom", "matiere", "matiere_libelle", "classe", "classe_libelle",
                        "semestre", "semestre_numero")

    def get_enseignant_nom(self, obj):
        return f"{obj.enseignant.nom} {obj.enseignant.prenoms}"

    def validate(self, attrs):
        matiere = _valeur(attrs, self.instance, "matiere")
        classe = _valeur(attrs, self.instance, "classe")
        semestre = _valeur(attrs, self.instance, "semestre")
        erreurs = {}
        if matiere.filiere_id != classe.filiere_id or matiere.niveau_id != classe.niveau_id:
            erreurs["matiere"] = "Cette matière n'appartient pas à la filière / au niveau de la classe."
        if semestre.annee_id != classe.annee_id:
            erreurs["semestre"] = "Ce semestre n'appartient pas à l'année de la classe."
        elif semestre.numero != matiere.semestre_numero:
            erreurs["semestre"] = f"Cette matière est enseignée au semestre {matiere.semestre_numero}."
        if erreurs:
            raise serializers.ValidationError(erreurs)
        return attrs


# --------------------------------------------------------------------------------------
# Listes de valeurs
# --------------------------------------------------------------------------------------

class _CodeLibelleSerializer(SerializerSynchro):
    def validate_code(self, valeur):
        return valeur.strip().upper()


class StatutEtudiantSerializer(_CodeLibelleSerializer):
    class Meta:
        model = StatutEtudiant
        fields = champs("code", "libelle")


class TypePieceSerializer(_CodeLibelleSerializer):
    class Meta:
        model = TypePiece
        fields = champs("code", "libelle", "obligatoire")


class VilleSerializer(SerializerSynchro):
    class Meta:
        model = Ville
        fields = champs("libelle", "region")

    def validate_libelle(self, valeur):
        return valeur.strip()


class EcoleSerializer(SerializerSynchro):
    ville_libelle = serializers.CharField(source="ville.libelle", read_only=True, default=None)

    class Meta:
        model = Ecole
        fields = champs("nom", "ville", "ville_libelle", "type_ecole")

    def validate_nom(self, valeur):
        return valeur.strip()


# --------------------------------------------------------------------------------------
# Finances
# --------------------------------------------------------------------------------------

class TypeFraisSerializer(_CodeLibelleSerializer):
    class Meta:
        model = TypeFrais
        fields = champs("code", "libelle", "categorie", "obligatoire")


class TarifSerializer(SerializerSynchro):
    annee_libelle = serializers.CharField(source="annee.libelle", read_only=True)
    type_frais_code = serializers.CharField(source="type_frais.code", read_only=True)
    type_frais_libelle = serializers.CharField(source="type_frais.libelle", read_only=True)
    filiere_libelle = serializers.CharField(source="filiere.libelle", read_only=True, default=None)
    niveau_code = serializers.CharField(source="niveau.code", read_only=True, default=None)
    statut_etudiant_libelle = serializers.CharField(source="statut_etudiant.libelle", read_only=True, default=None)
    montant = serializers.DecimalField(max_digits=14, decimal_places=0, min_value=Decimal("0"))
    nb_tranches = serializers.IntegerField(min_value=1, max_value=12, required=False)

    class Meta:
        model = Tarif
        fields = champs("annee", "annee_libelle", "type_frais", "type_frais_code", "type_frais_libelle",
                        "filiere", "filiere_libelle", "niveau", "niveau_code",
                        "statut_etudiant", "statut_etudiant_libelle", "montant", "nb_tranches")


class CategorieMouvementSerializer(_CodeLibelleSerializer):
    class Meta:
        model = CategorieMouvement
        fields = champs("code", "libelle", "sens")


# --------------------------------------------------------------------------------------
# Paramètres
# --------------------------------------------------------------------------------------

PARAMETRES_PONDERATION = {"poids_cc", "poids_examen"}


class ParametreSerializer(SerializerSynchro):
    class Meta:
        model = Parametre
        fields = champs("cle", "valeur", "description")
        read_only_fields = ["cle"]

    def validate_valeur(self, valeur):
        valeur = valeur.strip()
        cle = self.instance.cle if self.instance else None
        if cle in PARAMETRES_PONDERATION:
            raise serializers.ValidationError("Modifier la pondération via /parametres/ponderation/ (les deux poids ensemble).")
        if cle == "seuil_validation":
            try:
                seuil = Decimal(valeur)
            except Exception as exc:
                raise serializers.ValidationError("Nombre attendu.") from exc
            if not Decimal("0") <= seuil <= Decimal("20"):
                raise serializers.ValidationError("Le seuil doit être compris entre 0 et 20.")
        if cle == "regle_session2" and valeur not in ("REMPLACE", "MEILLEURE"):
            raise serializers.ValidationError("Valeurs possibles : REMPLACE ou MEILLEURE.")
        if not valeur:
            raise serializers.ValidationError("Valeur obligatoire.")
        return valeur


class PonderationSerializer(serializers.Serializer):
    poids_cc = serializers.DecimalField(max_digits=3, decimal_places=2, min_value=Decimal("0"), max_value=Decimal("1"))
    poids_examen = serializers.DecimalField(max_digits=3, decimal_places=2, min_value=Decimal("0"),
                                            max_value=Decimal("1"))

    def validate(self, attrs):
        if attrs["poids_cc"] + attrs["poids_examen"] != Decimal("1"):
            raise serializers.ValidationError("La somme poids_cc + poids_examen doit être égale à 1.")
        return attrs

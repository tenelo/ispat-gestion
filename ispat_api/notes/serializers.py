from decimal import Decimal

from rest_framework import serializers

from core.base_serializers import SerializerSynchro, champs

from .models import Evaluation, MoyenneMatiere, MoyenneSemestre, Note

NOTE_MIN, NOTE_MAX = Decimal("0"), Decimal("20")


def _valeur(attrs, instance, nom):
    if nom in attrs:
        return attrs[nom]
    return getattr(instance, nom, None) if instance is not None else None


class EvaluationSerializer(SerializerSynchro):
    classe_libelle = serializers.CharField(source="classe.libelle", read_only=True)
    matiere_code = serializers.CharField(source="matiere.code", read_only=True)
    matiere_libelle = serializers.CharField(source="matiere.libelle", read_only=True)
    semestre_numero = serializers.IntegerField(source="semestre.numero", read_only=True)
    poids = serializers.DecimalField(max_digits=4, decimal_places=2, min_value=Decimal("0.01"), required=False)
    nb_notes = serializers.IntegerField(read_only=True, required=False)
    nb_validees = serializers.IntegerField(read_only=True, required=False)

    class Meta:
        model = Evaluation
        fields = champs("classe", "classe_libelle", "matiere", "matiere_code", "matiere_libelle", "semestre",
                        "semestre_numero", "type_eval", "session", "libelle", "date_eval", "poids",
                        "nb_notes", "nb_validees")

    def validate_libelle(self, valeur):
        return " ".join(valeur.split())

    def validate(self, attrs):
        inst = self.instance
        classe = _valeur(attrs, inst, "classe")
        matiere = _valeur(attrs, inst, "matiere")
        semestre = _valeur(attrs, inst, "semestre")
        type_eval = _valeur(attrs, inst, "type_eval")
        session = _valeur(attrs, inst, "session") or 1

        if inst is not None and any(k in attrs and getattr(attrs[k], "pk", attrs[k]) != getattr(inst, f"{k}_id")
                                    for k in ("classe", "matiere", "semestre")):
            if inst.notes.exists():
                raise serializers.ValidationError("Des notes existent : classe, matière et semestre ne se modifient plus.")
        erreurs = {}
        if matiere.filiere_id != classe.filiere_id or matiere.niveau_id != classe.niveau_id:
            erreurs["matiere"] = "Cette matière n'appartient pas à la filière / au niveau de la classe."
        if semestre.annee_id != classe.annee_id:
            erreurs["semestre"] = "Ce semestre n'appartient pas à l'année de la classe."
        elif semestre.numero != matiere.semestre_numero:
            erreurs["semestre"] = f"Cette matière est enseignée au semestre {matiere.semestre_numero}."
        if semestre.cloture:
            erreurs["semestre"] = "Semestre clôturé : saisie fermée."
        if type_eval != "EXAMEN" and session != 1:
            erreurs["session"] = "La 2e session ne concerne que les examens."
        if erreurs:
            raise serializers.ValidationError(erreurs)

        if type_eval == "EXAMEN":
            doublon = Evaluation.objects.filter(classe=classe, matiere=matiere, semestre=semestre,
                                                type_eval="EXAMEN", session=session)
            if inst is not None:
                doublon = doublon.exclude(pk=inst.pk)
            if doublon.exists():
                raise serializers.ValidationError({"session": f"L'examen de session {session} existe déjà pour cette matière."})
            if session == 2 and not Evaluation.objects.filter(classe=classe, matiere=matiere, semestre=semestre,
                                                              type_eval="EXAMEN", session=1).exists():
                raise serializers.ValidationError({"session": "Créer d'abord l'examen de 1re session."})
        attrs["session"] = session
        return attrs


class NoteSerializer(SerializerSynchro):
    matricule = serializers.CharField(source="inscription.etudiant.matricule", read_only=True, default=None)
    nom = serializers.CharField(source="inscription.etudiant.nom", read_only=True)
    prenoms = serializers.CharField(source="inscription.etudiant.prenoms", read_only=True)
    evaluation_libelle = serializers.CharField(source="evaluation.libelle", read_only=True)
    type_eval = serializers.CharField(source="evaluation.type_eval", read_only=True)
    valeur = serializers.DecimalField(max_digits=4, decimal_places=2, min_value=NOTE_MIN, max_value=NOTE_MAX,
                                      required=False, allow_null=True)
    motif = serializers.CharField(write_only=True, required=False, allow_blank=True)

    class Meta:
        model = Note
        fields = champs("evaluation", "evaluation_libelle", "type_eval", "inscription", "matricule", "nom", "prenoms",
                        "valeur", "absent", "statut", "saisi_par", "valide_par", "valide_le", "motif")
        read_only_fields = ["evaluation", "inscription", "statut", "saisi_par", "valide_par", "valide_le"]

    def validate(self, attrs):
        valeur = _valeur(attrs, self.instance, "valeur")
        absent = _valeur(attrs, self.instance, "absent")
        if absent:
            attrs["valeur"] = None
        elif valeur is None:
            raise serializers.ValidationError({"valeur": "Note obligatoire (ou absent = true)."})
        return attrs

    def update(self, instance, validated_data):
        validated_data.pop("motif", None)
        return super().update(instance, validated_data)


class LigneSaisieSerializer(serializers.Serializer):
    inscription = serializers.UUIDField()
    valeur = serializers.DecimalField(max_digits=4, decimal_places=2, min_value=NOTE_MIN, max_value=NOTE_MAX,
                                      required=False, allow_null=True)
    absent = serializers.BooleanField(required=False, default=False)


class SaisieSerializer(serializers.Serializer):
    """Saisie groupée : valeur + absent=false -> note ; absent=true -> absent ; valeur=null et absent=false -> effacer."""

    notes = LigneSaisieSerializer(many=True, allow_empty=False)


class MoyenneMatiereSerializer(SerializerSynchro):
    matricule = serializers.CharField(source="inscription.etudiant.matricule", read_only=True, default=None)
    nom = serializers.CharField(source="inscription.etudiant.nom", read_only=True)
    prenoms = serializers.CharField(source="inscription.etudiant.prenoms", read_only=True)
    matiere_code = serializers.CharField(source="matiere.code", read_only=True)
    matiere_libelle = serializers.CharField(source="matiere.libelle", read_only=True)
    coefficient = serializers.DecimalField(source="matiere.coefficient", max_digits=4, decimal_places=2,
                                           read_only=True)
    credits = serializers.IntegerField(source="matiere.credits", read_only=True)

    class Meta:
        model = MoyenneMatiere
        fields = champs("inscription", "matricule", "nom", "prenoms", "matiere", "matiere_code", "matiere_libelle",
                        "coefficient", "credits", "semestre", "moyenne_cc", "note_examen_s1", "note_examen_s2",
                        "moyenne_session1", "moyenne_finale", "credits_acquis", "statut", "valide_par", "valide_le")
        read_only_fields = [f for f in fields if f not in ("id",)]


class MoyenneSemestreSerializer(SerializerSynchro):
    matricule = serializers.CharField(source="inscription.etudiant.matricule", read_only=True, default=None)
    nom = serializers.CharField(source="inscription.etudiant.nom", read_only=True)
    prenoms = serializers.CharField(source="inscription.etudiant.prenoms", read_only=True)
    sexe = serializers.CharField(source="inscription.etudiant.sexe", read_only=True)

    class Meta:
        model = MoyenneSemestre
        fields = champs("inscription", "matricule", "nom", "prenoms", "sexe", "semestre", "moyenne", "credits_acquis",
                        "credits_total", "rang", "decision", "appreciation", "statut", "valide_par", "valide_le")
        read_only_fields = [f for f in fields if f not in ("id", "appreciation")]


class ModificationMoyenneSerializer(serializers.Serializer):
    moyenne = serializers.DecimalField(max_digits=5, decimal_places=2, min_value=NOTE_MIN, max_value=NOTE_MAX)
    motif = serializers.CharField(min_length=5)


class ModificationSemestreSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=MoyenneSemestre.DECISIONS, required=False)
    appreciation = serializers.CharField(required=False, allow_blank=True)
    motif = serializers.CharField(min_length=5, required=False)

    def validate(self, attrs):
        if "decision" in attrs and not attrs.get("motif"):
            raise serializers.ValidationError({"motif": "Motif obligatoire pour changer une décision."})
        if not attrs:
            raise serializers.ValidationError("Rien à modifier.")
        return attrs


class ClasseSemestreSerializer(serializers.Serializer):
    classe = serializers.UUIDField()
    semestre = serializers.UUIDField()
    matiere = serializers.UUIDField(required=False)
    motif = serializers.CharField(required=False, allow_blank=True)
    forcer = serializers.BooleanField(required=False, default=False)

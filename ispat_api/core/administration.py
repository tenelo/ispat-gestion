"""
Administration des comptes : utilisateurs, rôles et permissions.

  utilisateurs/                        GET liste (?q=, ?role=CODE, ?actif=true|false) / POST création
  utilisateurs/{id}/                   GET / PATCH (roles = liste complète des codes) / DELETE (suppression logique)
  utilisateurs/{id}/mot-de-passe/      POST {mot_de_passe}   réinitialisation par l'administrateur
  roles/                               GET rôles + codes de permissions + nombre d'utilisateurs
  roles/{id}/permissions/              PUT {permissions: [codes]}  (rôle ADMIN non modifiable)
  permissions/                         GET catalogue des permissions (module, ressource, action, libellé)
  auth/mot-de-passe/                   POST {actuel, nouveau}  changement par l'utilisateur lui-même

Garde-fous : on ne peut ni se désactiver, ni se supprimer, ni se retirer le rôle ADMIN ; le dernier
administrateur actif ne peut pas perdre ce rôle.
"""
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Count, Q
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .exceptions import Conflit
from .filtres import FiltreSimpleMixin, filtre_booleen
from .mixins import VueISPAT, ViewSetISPAT
from .models import Permission, Role, RolePermission, Utilisateur, UtilisateurRole
from .permissions import permissions_crud

ADMIN = "ADMIN"


def _valider_mot_de_passe(valeur, utilisateur=None):
    try:
        validate_password(valeur, user=utilisateur)
    except DjangoValidationError as exc:
        traductions = {
            "password_too_short": "Mot de passe trop court (8 caractères minimum).",
            "password_too_common": "Mot de passe trop courant.",
            "password_entirely_numeric": "Le mot de passe ne peut pas être uniquement composé de chiffres.",
            "password_too_similar": "Mot de passe trop proche de l'identifiant ou du nom.",
        }
        raise serializers.ValidationError([traductions.get(e.code, e.messages[0]) for e in exc.error_list]) from exc
    return valeur


def _admins_actifs(exclure=None):
    qs = Utilisateur.objects.filter(actif=True, liens_roles__deleted_at__isnull=True, liens_roles__role__code=ADMIN)
    if exclure is not None:
        qs = qs.exclude(pk=exclure.pk)
    return qs.distinct().count()


# --------------------------------------------------------------------------------------
# Utilisateurs
# --------------------------------------------------------------------------------------

class UtilisateurSerializer(serializers.ModelSerializer):
    roles = serializers.ListField(child=serializers.CharField(), required=False)
    mot_de_passe = serializers.CharField(write_only=True, required=False, trim_whitespace=False)
    email = serializers.EmailField(required=False, allow_null=True, allow_blank=True)

    class Meta:
        model = Utilisateur
        fields = ["id", "login", "nom", "prenoms", "email", "telephone", "actif", "roles", "mot_de_passe",
                  "last_login", "created_at", "updated_at", "version"]
        read_only_fields = ["last_login", "created_at", "updated_at", "version"]

    def to_representation(self, instance):
        donnees = super().to_representation(instance)
        donnees["roles"] = sorted(instance.codes_roles())
        donnees["derniere_connexion"] = donnees.pop("last_login")
        return donnees

    def validate_login(self, valeur):
        valeur = valeur.strip()
        if len(valeur) < 3 or any(c.isspace() for c in valeur):
            raise serializers.ValidationError("Identifiant : 3 caractères minimum, sans espace.")
        return valeur

    def validate_nom(self, valeur):
        return " ".join(valeur.split()).upper()

    def validate_prenoms(self, valeur):
        return " ".join(valeur.split())

    def validate_email(self, valeur):
        return (valeur or "").strip().lower() or None

    def validate_roles(self, codes):
        codes = sorted(set(codes))
        connus = set(Role.objects.filter(code__in=codes).values_list("code", flat=True))
        inconnus = [c for c in codes if c not in connus]
        if inconnus:
            raise serializers.ValidationError(f"Rôle(s) inconnu(s) : {', '.join(inconnus)}.")
        return codes

    def validate(self, attrs):
        inst = self.instance
        if inst is None:
            if not attrs.get("mot_de_passe"):
                raise serializers.ValidationError({"mot_de_passe": "Obligatoire à la création."})
            if not attrs.get("roles"):
                raise serializers.ValidationError({"roles": "Attribuer au moins un rôle."})
            provisoire = Utilisateur(login=attrs["login"], nom=attrs["nom"], prenoms=attrs["prenoms"],
                                     email=attrs.get("email"))
            try:
                _valider_mot_de_passe(attrs["mot_de_passe"], provisoire)
            except serializers.ValidationError as exc:
                raise serializers.ValidationError({"mot_de_passe": exc.detail}) from exc
            return attrs

        if "mot_de_passe" in attrs:
            raise serializers.ValidationError({"mot_de_passe": "Utiliser la réinitialisation du mot de passe."})
        moi = self.context["request"].user
        if inst.pk == moi.pk:
            if attrs.get("actif") is False:
                raise serializers.ValidationError({"actif": "Vous ne pouvez pas désactiver votre propre compte."})
            if "roles" in attrs and inst.a_role(ADMIN) and ADMIN not in attrs["roles"]:
                raise serializers.ValidationError({"roles": "Vous ne pouvez pas vous retirer le rôle Administrateur."})
        perd_admin = inst.a_role(ADMIN) and (
            attrs.get("actif") is False or ("roles" in attrs and ADMIN not in attrs["roles"]))
        if perd_admin and inst.actif and _admins_actifs(exclure=inst) == 0:
            raise serializers.ValidationError("Il doit rester au moins un administrateur actif.")
        return attrs

    def _enregistrer_roles(self, utilisateur, codes):
        actuels = {lien.role.code: lien for lien in
                   UtilisateurRole.objects.filter(utilisateur=utilisateur).select_related("role")}
        for code, lien in actuels.items():
            if code not in codes:
                lien.supprimer()
        for role in Role.objects.filter(code__in=[c for c in codes if c not in actuels]):
            UtilisateurRole.objects.create(utilisateur=utilisateur, role=role)
        for attribut in ("_codes_roles", "_codes_permissions"):
            utilisateur.__dict__.pop(attribut, None)

    def create(self, validated_data):
        roles = validated_data.pop("roles")
        mot_de_passe = validated_data.pop("mot_de_passe")
        utilisateur = Utilisateur(**validated_data)
        utilisateur.set_password(mot_de_passe)
        utilisateur.save()
        self._enregistrer_roles(utilisateur, roles)
        return utilisateur

    def update(self, instance, validated_data):
        roles = validated_data.pop("roles", None)
        validated_data.pop("id", None)
        for champ, valeur in validated_data.items():
            setattr(instance, champ, valeur)
        instance.save()
        if roles is not None:
            self._enregistrer_roles(instance, roles)
        return instance


class MotDePasseSerializer(serializers.Serializer):
    mot_de_passe = serializers.CharField(trim_whitespace=False)


class UtilisateurViewSet(FiltreSimpleMixin, ViewSetISPAT):
    serializer_class = UtilisateurSerializer
    filtres = {
        "actif": filtre_booleen("actif"),
        "role": lambda qs, v: qs.filter(liens_roles__deleted_at__isnull=True, liens_roles__role__code=v.upper()).distinct(),
    }
    champs_recherche = ("login__unaccent", "nom__unaccent", "prenoms__unaccent", "email", "telephone")
    permissions_requises = permissions_crud("administration.utilisateur", mot_de_passe="administration.utilisateur.modifier")

    def get_queryset(self):
        return Utilisateur.objects.all().order_by("nom", "prenoms")

    def perform_update(self, serializer):
        serializer.save().refresh_from_db()

    def perform_destroy(self, instance):
        if instance.pk == self.request.user.pk:
            raise Conflit("Vous ne pouvez pas supprimer votre propre compte.")
        if instance.a_role(ADMIN) and instance.actif and _admins_actifs(exclure=instance) == 0:
            raise Conflit("Il doit rester au moins un administrateur actif.")
        for lien in UtilisateurRole.objects.filter(utilisateur=instance):
            lien.supprimer()
        instance.supprimer()

    @action(detail=True, methods=["post"], url_path="mot-de-passe")
    def mot_de_passe(self, request, pk=None):
        utilisateur = self.get_object()
        s = MotDePasseSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        try:
            _valider_mot_de_passe(s.validated_data["mot_de_passe"], utilisateur)
        except serializers.ValidationError as exc:
            raise serializers.ValidationError({"mot_de_passe": exc.detail}) from exc
        utilisateur.set_password(s.validated_data["mot_de_passe"])
        utilisateur.save(update_fields=["password"])
        return Response({"detail": "Mot de passe réinitialisé."})


# --------------------------------------------------------------------------------------
# Rôles et permissions
# --------------------------------------------------------------------------------------

class PermissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Permission
        fields = ["id", "code", "module", "ressource", "action", "libelle"]


class RoleSerializer(serializers.ModelSerializer):
    permissions = serializers.SerializerMethodField()
    nb_utilisateurs = serializers.IntegerField(read_only=True)
    modifiable = serializers.SerializerMethodField()

    class Meta:
        model = Role
        fields = ["id", "code", "libelle", "description", "permissions", "nb_utilisateurs", "modifiable", "version"]

    def get_permissions(self, obj):
        return sorted(l.permission.code for l in obj.liens_permissions.all()
                      if l.deleted_at is None and l.permission.deleted_at is None)

    def get_modifiable(self, obj):
        return obj.code != ADMIN


class PermissionsRoleSerializer(serializers.Serializer):
    permissions = serializers.ListField(child=serializers.CharField(), allow_empty=True)


class RoleViewSet(ViewSetISPAT):
    serializer_class = RoleSerializer
    pagination_class = None
    http_method_names = ["get", "put", "head", "options"]
    permissions_requises = {
        "list": ["administration.role.lire", "administration.utilisateur.lire"],
        "retrieve": ["administration.role.lire", "administration.utilisateur.lire"],
        "permissions": "administration.role.modifier",
    }

    def get_queryset(self):
        return (Role.objects.all()
                .annotate(nb_utilisateurs=Count("liens_utilisateurs", filter=Q(
                    liens_utilisateurs__deleted_at__isnull=True,
                    liens_utilisateurs__utilisateur__deleted_at__isnull=True), distinct=True))
                .prefetch_related("liens_permissions__permission")
                .order_by("code"))

    @action(detail=True, methods=["put"])
    def permissions(self, request, pk=None):
        role = self.get_object()
        if role.code == ADMIN:
            raise Conflit("Le rôle Administrateur a toujours tous les droits : il n'est pas modifiable.")
        s = PermissionsRoleSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        codes = set(s.validated_data["permissions"])
        catalogue = {p.code: p for p in Permission.objects.filter(code__in=codes)}
        inconnus = sorted(codes - set(catalogue))
        if inconnus:
            raise serializers.ValidationError({"permissions": f"Permission(s) inconnue(s) : {', '.join(inconnus)}."})
        actuels = {l.permission.code: l for l in RolePermission.objects.filter(role=role).select_related("permission")}
        for code, lien in actuels.items():
            if code not in codes:
                lien.supprimer()
        for code in sorted(codes - set(actuels)):
            RolePermission.objects.create(role=role, permission=catalogue[code])
        return Response(RoleSerializer(self.get_queryset().get(pk=role.pk)).data)


class PermissionViewSet(ViewSetISPAT):
    serializer_class = PermissionSerializer
    pagination_class = None
    http_method_names = ["get", "head", "options"]
    permissions_requises = {"*": ["administration.role.lire", "administration.utilisateur.lire"]}

    def get_queryset(self):
        return Permission.objects.all().order_by("module", "ressource", "action")


# --------------------------------------------------------------------------------------
# Mot de passe de l'utilisateur connecté
# --------------------------------------------------------------------------------------

class ChangementMotDePasseSerializer(serializers.Serializer):
    actuel = serializers.CharField(trim_whitespace=False)
    nouveau = serializers.CharField(trim_whitespace=False)


class MonMotDePasseView(VueISPAT):
    permission_classes = [IsAuthenticated]
    permission_libre = True

    def post(self, request):
        s = ChangementMotDePasseSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        moi = request.user
        if not moi.check_password(s.validated_data["actuel"]):
            raise serializers.ValidationError({"actuel": "Mot de passe actuel incorrect."})
        if s.validated_data["actuel"] == s.validated_data["nouveau"]:
            raise serializers.ValidationError({"nouveau": "Le nouveau mot de passe doit être différent."})
        try:
            _valider_mot_de_passe(s.validated_data["nouveau"], moi)
        except serializers.ValidationError as exc:
            raise serializers.ValidationError({"nouveau": exc.detail}) from exc
        moi.set_password(s.validated_data["nouveau"])
        moi.save(update_fields=["password"])
        return Response({"detail": "Mot de passe modifié."})

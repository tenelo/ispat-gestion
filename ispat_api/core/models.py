"""
Modèles du noyau : base de synchronisation + sécurité (utilisateurs, rôles, permissions).

Toutes les tables existent déjà dans le schéma `ispat` (ispat_gestion_schema.sql) :
  * managed = False -> Django ne crée / ne modifie jamais ces tables.
  * Les colonnes techniques (created_at, updated_at, version, sync_seq, created_by, updated_by)
    sont alimentées par le trigger PostgreSQL `a_colonnes_techniques`.
"""
import uuid

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import connection, models
from django.db.models.expressions import RawSQL
from django.db.models.functions import Now
from django.utils import timezone


# --------------------------------------------------------------------------------------
# Base commune à toutes les tables synchronisées
# --------------------------------------------------------------------------------------

class ActifsQuerySet(models.QuerySet):
    def actifs(self):
        return self.filter(deleted_at__isnull=True)

    def depuis(self, sync_seq):
        """Enregistrements modifiés (y compris supprimés logiquement) après un curseur de synchro."""
        return self.filter(sync_seq__gt=sync_seq).order_by("sync_seq")


class ActifsManager(models.Manager.from_queryset(ActifsQuerySet)):
    """Manager par défaut : exclut les enregistrements supprimés logiquement."""

    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


class ModeleSynchro(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)          # peut venir du client (hors ligne)
    created_at = models.DateTimeField(db_default=Now(), editable=False)
    updated_at = models.DateTimeField(db_default=Now(), editable=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    version = models.IntegerField(db_default=1, editable=False)
    sync_seq = models.BigIntegerField(db_default=RawSQL("nextval('ispat.sync_seq')", []), editable=False)
    created_by = models.UUIDField(null=True, blank=True, editable=False)
    updated_by = models.UUIDField(null=True, blank=True, editable=False)

    objects = ActifsManager()
    tous = models.Manager.from_queryset(ActifsQuerySet)()                 # inclut les supprimés (synchro)

    class Meta:
        abstract = True

    def supprimer(self):
        """Suppression logique (tombstone propagé aux clients hors ligne)."""
        self.deleted_at = timezone.now()
        self.save(update_fields=["deleted_at"])
        self.refresh_from_db(fields=["version", "sync_seq", "updated_at", "updated_by"])


# --------------------------------------------------------------------------------------
# Sécurité
# --------------------------------------------------------------------------------------

class Role(ModeleSynchro):
    code = models.TextField(unique=True)
    libelle = models.TextField()
    description = models.TextField(null=True, blank=True)

    class Meta:
        managed = False
        db_table = "role"
        ordering = ["code"]

    def __str__(self):
        return self.code


class Permission(ModeleSynchro):
    code = models.TextField(unique=True)
    module = models.TextField()
    ressource = models.TextField()
    action = models.TextField()
    libelle = models.TextField()

    class Meta:
        managed = False
        db_table = "permission"
        ordering = ["code"]

    def __str__(self):
        return self.code


class RolePermission(ModeleSynchro):
    role = models.ForeignKey(Role, on_delete=models.DO_NOTHING, db_column="role_id", related_name="liens_permissions")
    permission = models.ForeignKey(Permission, on_delete=models.DO_NOTHING, db_column="permission_id",
                                   related_name="liens_roles")

    class Meta:
        managed = False
        db_table = "role_permission"


class GestionnaireUtilisateur(BaseUserManager.from_queryset(ActifsQuerySet)):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)

    def get_by_natural_key(self, login):
        return self.get(login__iexact=login.strip())

    def creer_utilisateur(self, login, mot_de_passe, nom, prenoms, **autres):
        utilisateur = self.model(login=login.strip(), nom=nom.strip(), prenoms=prenoms.strip(), **autres)
        utilisateur.set_password(mot_de_passe)
        utilisateur.save(using=self._db)
        return utilisateur


class Utilisateur(AbstractBaseUser, ModeleSynchro):
    login = models.TextField()
    email = models.TextField(null=True, blank=True)
    password = models.CharField(max_length=255, db_column="mot_de_passe_hash")
    nom = models.TextField()
    prenoms = models.TextField()
    telephone = models.TextField(null=True, blank=True)
    actif = models.BooleanField(default=True)
    last_login = models.DateTimeField(null=True, blank=True, db_column="derniere_connexion")

    objects = GestionnaireUtilisateur()

    USERNAME_FIELD = "login"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS = ["nom", "prenoms"]

    class Meta:
        managed = False
        db_table = "utilisateur"
        ordering = ["nom", "prenoms"]

    def __str__(self):
        return f"{self.login} ({self.nom} {self.prenoms})"

    @property
    def is_active(self):
        return self.actif and self.deleted_at is None

    @property
    def nom_complet(self):
        return f"{self.nom} {self.prenoms}"

    # --- Rôles et permissions (mis en cache sur l'instance, donc pour la durée d'une requête) ---

    def codes_roles(self):
        if not hasattr(self, "_codes_roles"):
            self._codes_roles = frozenset(
                UtilisateurRole.objects.filter(utilisateur_id=self.id, role__deleted_at__isnull=True)
                .values_list("role__code", flat=True)
            )
        return self._codes_roles

    def codes_permissions(self):
        if not hasattr(self, "_codes_permissions"):
            with connection.cursor() as curseur:
                curseur.execute(
                    "SELECT code FROM ispat.v_permissions_utilisateur WHERE utilisateur_id = %s",
                    [self.id],
                )
                self._codes_permissions = frozenset(ligne[0] for ligne in curseur.fetchall())
        return self._codes_permissions

    def a_permission(self, code):
        return code in self.codes_permissions()

    def a_role(self, code):
        return code in self.codes_roles()


class UtilisateurRole(ModeleSynchro):
    utilisateur = models.ForeignKey(Utilisateur, on_delete=models.DO_NOTHING, db_column="utilisateur_id",
                                    related_name="liens_roles")
    role = models.ForeignKey(Role, on_delete=models.DO_NOTHING, db_column="role_id", related_name="liens_utilisateurs")

    class Meta:
        managed = False
        db_table = "utilisateur_role"

from django.contrib.auth.backends import ModelBackend


class LoginInsensibleCasseBackend(ModelBackend):
    """
    Authentification sur ispat.utilisateur :
      * login insensible à la casse et aux espaces (index unique lower(login) côté base) ;
      * refus des comptes inactifs ou supprimés logiquement (Utilisateur.is_active).
    Les permissions Django natives ne sont pas utilisées : voir core.permissions.PermissionISPAT.
    """

    def authenticate(self, request, username=None, password=None, **kwargs):
        if username is None:
            username = kwargs.get("login")
        if username is None or password is None:
            return None
        return super().authenticate(request, username=username.strip(), password=password)

    def get_all_permissions(self, user_obj, obj=None):
        return set()

    def has_perm(self, user_obj, perm, obj=None):
        return user_obj.is_active and user_obj.a_permission(perm)

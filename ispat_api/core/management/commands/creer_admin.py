"""
Création d'un compte administrateur ISPAT (rôle ADMIN).

    python manage.py creer_admin --login admin --nom OUATTARA --prenoms "Tenelo Étienne" --email x@y.ci
    (le mot de passe est demandé de façon masquée ; --mot-de-passe pour un usage non interactif)
"""
import getpass

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import Role, Utilisateur, UtilisateurRole


class Command(BaseCommand):
    help = "Crée un utilisateur avec le rôle ADMIN."

    def add_arguments(self, parser):
        parser.add_argument("--login", required=True)
        parser.add_argument("--nom", required=True)
        parser.add_argument("--prenoms", required=True)
        parser.add_argument("--email")
        parser.add_argument("--telephone")
        parser.add_argument("--mot-de-passe", dest="mot_de_passe")

    def handle(self, *args, **opts):
        login = opts["login"].strip()
        if Utilisateur.objects.filter(login__iexact=login).exists():
            raise CommandError(f"Le login « {login} » existe déjà.")

        try:
            role_admin = Role.objects.get(code="ADMIN")
        except Role.DoesNotExist as exc:
            raise CommandError("Rôle ADMIN introuvable : le script ispat_gestion_schema.sql a-t-il été exécuté ?") from exc

        mot_de_passe = opts["mot_de_passe"]
        if not mot_de_passe:
            mot_de_passe = getpass.getpass("Mot de passe : ")
            if mot_de_passe != getpass.getpass("Confirmation : "):
                raise CommandError("Les mots de passe ne correspondent pas.")

        utilisateur_test = Utilisateur(login=login, nom=opts["nom"], prenoms=opts["prenoms"])
        try:
            validate_password(mot_de_passe, user=utilisateur_test)
        except ValidationError as exc:
            raise CommandError(" ".join(exc.messages)) from exc

        with transaction.atomic():
            utilisateur = Utilisateur.objects.creer_utilisateur(
                login=login,
                mot_de_passe=mot_de_passe,
                nom=opts["nom"],
                prenoms=opts["prenoms"],
                email=opts.get("email"),
                telephone=opts.get("telephone"),
            )
            UtilisateurRole.objects.create(utilisateur=utilisateur, role=role_admin)

        self.stdout.write(self.style.SUCCESS(f"Administrateur « {login} » créé (id {utilisateur.id})."))

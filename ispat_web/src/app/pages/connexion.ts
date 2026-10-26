import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute, Router } from '@angular/router';

import { AuthService } from '../core/auth/auth.service';
import { ReseauService } from '../core/reseau.service';
import { SyncService, texteErreur } from '../core/sync/sync.service';

@Component({
  selector: 'app-connexion',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule,
    MatProgressSpinnerModule],
  template: `
    <main class="fond">
      <section class="carte-connexion">
        <img src="logo-ispat.png" alt="Logo ISPAT" width="92" height="92" />
        <h1>ISPAT Gestion</h1>
        <p class="sous-titre">Institut Supérieur Privé d'Agriculture et Technologie</p>

        @if (auth.reconnexionRequise()) {
          <p class="info">Votre session a expiré. Reconnectez-vous : vos saisies en attente seront ensuite envoyées.</p>
        }
        @if (!reseau.enLigne()) {
          <p class="info" data-test="info-hors-ligne">
            <mat-icon>wifi_off</mat-icon>
            Pas de connexion au serveur. La connexion nécessite le réseau ; ensuite l'application fonctionne hors ligne.
          </p>
        }
        @if (erreur()) {
          <p class="erreur-formulaire" data-test="erreur-connexion">{{ erreur() }}</p>
        }

        <form [formGroup]="formulaire" (ngSubmit)="valider()">
          <mat-form-field appearance="outline">
            <mat-label>Identifiant</mat-label>
            <input matInput formControlName="login" autocomplete="username" data-test="login" />
            <mat-icon matPrefix>person</mat-icon>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Mot de passe</mat-label>
            <input matInput [type]="voir() ? 'text' : 'password'" formControlName="motDePasse"
                   autocomplete="current-password" data-test="mot-de-passe" />
            <mat-icon matPrefix>lock</mat-icon>
            <button mat-icon-button matSuffix type="button" (click)="voir.set(!voir())"
                    [attr.aria-label]="voir() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'">
              <mat-icon>{{ voir() ? 'visibility_off' : 'visibility' }}</mat-icon>
            </button>
          </mat-form-field>
          <button mat-flat-button type="submit" [disabled]="envoi() || formulaire.invalid" data-test="se-connecter">
            @if (envoi()) {
              <mat-progress-spinner mode="indeterminate" diameter="18" />
            } @else {
              Se connecter
            }
          </button>
        </form>
      </section>
      <p class="pied">© ISPAT — Ferkessédougou</p>
    </main>
  `,
  styles: `
    .fond {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      box-sizing: border-box;
      background:
        radial-gradient(circle at 15% 10%, rgba(240, 125, 22, 0.08), transparent 40%),
        linear-gradient(160deg, #0f5a46 0%, #0a3f31 100%);
    }
    .carte-connexion {
      width: 100%;
      max-width: 400px;
      background: #fff;
      border-radius: 16px;
      padding: 32px 28px 28px;
      box-sizing: border-box;
      text-align: center;
      border-top: 4px solid var(--ispat-orange);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    }
    img { object-fit: contain; }
    h1 { margin-top: 12px; }
    .sous-titre { margin: 0 0 20px; color: #5d6f68; font-size: 0.88rem; }
    form { display: flex; flex-direction: column; text-align: left; }
    button[type='submit'] { height: 46px; margin-top: 4px; }
    .info {
      display: flex; gap: 8px; align-items: flex-start; text-align: left;
      background: var(--ispat-orange-clair); color: #7a3b04;
      padding: 10px 12px; border-radius: 8px; font-size: 0.85rem; margin: 0 0 16px;
    }
    .info mat-icon { font-size: 18px; width: 18px; height: 18px; flex: none; }
    .erreur-formulaire { text-align: left; font-size: 0.88rem; }
    .pied { color: rgba(255, 255, 255, 0.7); font-size: 0.8rem; margin-top: 20px; }
  `,
})
export class ConnexionPage {
  readonly auth = inject(AuthService);
  readonly reseau = inject(ReseauService);
  private readonly sync = inject(SyncService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly voir = signal(false);
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);

  readonly formulaire = inject(FormBuilder).nonNullable.group({
    login: [this.auth.utilisateur()?.login ?? '', Validators.required],
    motDePasse: ['', Validators.required],
  });

  async valider(): Promise<void> {
    if (this.formulaire.invalid) {
      return;
    }
    this.envoi.set(true);
    this.erreur.set(null);
    const { login, motDePasse } = this.formulaire.getRawValue();
    try {
      await this.auth.connecter(login.trim(), motDePasse);
      void this.sync.synchroniser();
      const retour = this.route.snapshot.queryParamMap.get('retour');
      await this.router.navigateByUrl(retour && retour.startsWith('/') && !retour.startsWith('/connexion') ? retour : '/');
    } catch (e) {
      this.erreur.set(this.message(e));
      void this.reseau.verifier();
    } finally {
      this.envoi.set(false);
    }
  }

  private message(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      if (e.status === 0) {
        return 'Serveur injoignable. Vérifiez la connexion réseau.';
      }
      if (e.status === 401 || e.status === 400) {
        return 'Identifiant ou mot de passe incorrect.';
      }
      if (e.status === 429) {
        return 'Trop de tentatives. Patientez quelques minutes.';
      }
      return texteErreur(e.error) || `Erreur du serveur (${e.status}).`;
    }
    return e instanceof Error ? e.message : String(e);
  }
}

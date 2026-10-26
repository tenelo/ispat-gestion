import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

/** Écran prévu à l'étape 12 (le menu et les droits sont déjà en place). */
@Component({
  selector: 'app-en-construction',
  imports: [MatButtonModule, RouterLink],
  template: `
    <div class="page">
      <div class="carte centre" data-test="en-construction">
        <span class="material-symbols-outlined grande">construction</span>
        <h1>{{ titre() }}</h1>
        <p class="texte-secondaire">
          Cet écran sera livré à la prochaine étape. Les données nécessaires sont déjà disponibles côté serveur
          et, pour la plupart, copiées sur ce poste pour le travail hors ligne.
        </p>
        <a mat-stroked-button routerLink="/tableau-de-bord">Retour au tableau de bord</a>
      </div>
    </div>
  `,
  styles: `
    .centre { text-align: center; padding: 48px 24px; max-width: 560px; margin: 40px auto; }
    .grande { font-size: 48px; color: var(--ispat-orange); }
  `,
})
export class EnConstructionPage {
  readonly titre = toSignal(inject(ActivatedRoute).data.pipe(map((d) => d['titre'] as string)), { initialValue: '' });
}

@Component({
  selector: 'app-acces-refuse',
  imports: [MatButtonModule, RouterLink],
  template: `
    <div class="page">
      <div class="carte centre" data-test="acces-refuse">
        <span class="material-symbols-outlined grande">lock</span>
        <h1>Accès refusé</h1>
        <p class="texte-secondaire">Votre rôle ne donne pas accès à cet écran. Adressez-vous à l'administrateur si nécessaire.</p>
        <a mat-flat-button routerLink="/tableau-de-bord">Retour au tableau de bord</a>
      </div>
    </div>
  `,
  styles: `
    .centre { text-align: center; padding: 48px 24px; max-width: 520px; margin: 40px auto; }
    .grande { font-size: 48px; color: var(--ispat-rouge); }
  `,
})
export class AccesRefusePage {}

@Component({
  selector: 'app-introuvable',
  imports: [MatButtonModule, RouterLink],
  template: `
    <div class="page">
      <div class="carte centre">
        <span class="material-symbols-outlined grande">explore_off</span>
        <h1>Page introuvable</h1>
        <a mat-flat-button routerLink="/tableau-de-bord">Retour au tableau de bord</a>
      </div>
    </div>
  `,
  styles: `
    .centre { text-align: center; padding: 48px 24px; max-width: 520px; margin: 40px auto; }
    .grande { font-size: 48px; color: #9fb5ac; }
  `,
})
export class IntrouvablePage {}

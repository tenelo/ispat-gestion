import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSidenav, MatSidenavModule } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { filter, map } from 'rxjs';

import { AuthService } from '../core/auth/auth.service';
import { InstallationService } from '../core/installation.service';
import { MENU } from '../core/navigation';
import { ReseauService } from '../core/reseau.service';
import { SyncService } from '../core/sync/sync.service';
import { confirmer } from '../shared/confirmation';

/** Cadre de l'application : barre du haut (logo, état réseau / synchro, utilisateur) et menu latéral. */
@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive, MatSidenavModule, MatToolbarModule, MatListModule, MatIconModule,
    MatButtonModule, MatMenuModule, MatTooltipModule, MatBadgeModule, MatProgressSpinnerModule,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  readonly auth = inject(AuthService);
  readonly reseau = inject(ReseauService);
  readonly sync = inject(SyncService);
  readonly installation = inject(InstallationService);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly swUpdate = inject(SwUpdate);

  readonly mobile = toSignal(
    inject(BreakpointObserver).observe('(max-width: 959px)').pipe(map((r) => r.matches)),
    { initialValue: false },
  );

  readonly groupes = computed(() =>
    MENU.map((g) => ({ ...g, entrees: g.entrees.filter((e) => this.auth.peut(e.droits)) })).filter(
      (g) => g.entrees.length > 0,
    ),
  );

  /** Groupes du menu dépliés (tous repliés par défaut ; celui de la page affichée s'ouvre seul). */
  private readonly ouverts = signal<ReadonlySet<string>>(new Set());

  estOuvert(libelle: string): boolean {
    return this.ouverts().has(libelle);
  }

  basculer(libelle: string): void {
    this.ouverts.update((s) => {
      const n = new Set(s);
      if (!n.delete(libelle)) {
        n.add(libelle);
      }
      return n;
    });
  }

  /** Déplie le groupe qui contient la page affichée, pour que l'entrée active reste visible. */
  private ouvrirGroupeActif(url: string): void {
    const chemin = url.split(/[?#]/)[0].replace(/^\//, '');
    const groupe = chemin.startsWith('synchronisation')
      ? 'Hors ligne'
      : this.groupes().find((g) => g.entrees.some((e) => chemin === e.chemin || chemin.startsWith(e.chemin + '/')))?.libelle;
    if (groupe && !this.ouverts().has(groupe)) {
      this.ouverts.update((s) => new Set(s).add(groupe));
    }
  }

  readonly initiales = computed(() => {
    const u = this.auth.utilisateur();
    return u ? `${u.prenoms?.[0] ?? ''}${u.nom?.[0] ?? ''}`.toUpperCase() : '';
  });

  readonly etatReseau = computed(() => {
    switch (this.reseau.etat()) {
      case 'en_ligne':
        return { icone: 'cloud_done', libelle: 'En ligne', classe: 'en-ligne' };
      case 'serveur_injoignable':
        return { icone: 'cloud_off', libelle: 'Serveur injoignable', classe: 'hors-ligne' };
      default:
        return { icone: 'wifi_off', libelle: 'Hors ligne', classe: 'hors-ligne' };
    }
  });

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e) => {
      this.ouvrirGroupeActif(e.urlAfterRedirects);
      this.fermerSiMobile();
    });
    this.ouvrirGroupeActif(this.router.url);
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates.pipe(filter((e) => e.type === 'VERSION_READY')).subscribe(() => {
        this.snack
          .open('Une nouvelle version d\'ISPAT Gestion est prête.', 'Mettre à jour', { duration: 0 })
          .onAction()
          .subscribe(() => document.location.reload());
      });
    }
  }

  private readonly sidenav = viewChild(MatSidenav);

  private fermerSiMobile(): void {
    const menu = this.sidenav();
    if (this.mobile() && menu?.opened) {
      void menu.close();
    }
  }

  async changerMotDePasse(): Promise<void> {
    const { MotDePasse } = await import('../shared/mot-de-passe');
    this.dialog
      .open(MotDePasse, { width: '440px', maxWidth: '94vw' })
      .afterClosed()
      .subscribe((ok) => ok && this.snack.open('Mot de passe modifié.', 'OK', { duration: 3000 }));
  }

  async deconnecter(): Promise<void> {
    const enAttente = await this.auth.deconnecter();
    if (enAttente === 0) {
      return;
    }
    const ok = await confirmer(this.dialog, {
      titre: 'Saisies non envoyées',
      message:
        `${enAttente} saisie(s) n'ont pas encore été envoyées au serveur.\n` +
        'Si vous vous déconnectez maintenant, elles seront définitivement perdues.\n\n' +
        'Conseil : reconnectez-vous au réseau et attendez la fin de la synchronisation.',
      confirmer: 'Me déconnecter et perdre les saisies',
      annuler: 'Rester connecté',
      danger: true,
    });
    if (ok) {
      await this.auth.deconnecter(true);
    }
  }
}

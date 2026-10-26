import { Injectable, signal } from '@angular/core';

interface EvenementInstallation extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Bouton « Installer l'application » (Chrome, Edge : installation sur le PC comme un logiciel). */
@Injectable({ providedIn: 'root' })
export class InstallationService {
  private evenement: EvenementInstallation | null = null;
  readonly disponible = signal(false);
  readonly installee = signal(
    typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches,
  );

  ecouter(): void {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.evenement = e as EvenementInstallation;
      this.disponible.set(true);
    });
    window.addEventListener('appinstalled', () => {
      this.disponible.set(false);
      this.installee.set(true);
    });
  }

  async installer(): Promise<void> {
    if (!this.evenement) {
      return;
    }
    await this.evenement.prompt();
    await this.evenement.userChoice;
    this.evenement = null;
    this.disponible.set(false);
  }
}

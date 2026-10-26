import { Component, ElementRef, OnDestroy, inject, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { reduireImage } from '../core/scolarite';

/**
 * Photo d'identité : webcam du PC (ou caméra du téléphone) ou fichier image.
 * Renvoie un JPEG réduit (800 px), prêt à être envoyé — même hors ligne (file d'envoi).
 */
@Component({
  selector: 'app-prise-photo',
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Photo d'identité</h2>
    <mat-dialog-content>
      <div class="cadre">
        @if (apercu()) {
          <img [src]="apercu()" alt="Aperçu de la photo" data-test="photo-apercu" />
        } @else if (camera()) {
          <video #video autoplay playsinline muted></video>
          <div class="gabarit"></div>
        } @else {
          <div class="vide">
            <mat-icon>photo_camera</mat-icon>
            <span>{{ message() }}</span>
          </div>
        }
      </div>
      <p class="texte-secondaire">Visage centré, de face, fond clair. La photo est réduite automatiquement.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <label class="fichier">
        <input type="file" accept="image/jpeg,image/png" (change)="choisirFichier($event)" data-test="photo-fichier" />
        <mat-icon>upload</mat-icon> Choisir un fichier
      </label>
      @if (apercu()) {
        <button mat-button (click)="recommencer()">Reprendre</button>
        <button mat-flat-button (click)="valider()" data-test="photo-valider">Utiliser cette photo</button>
      } @else if (camera()) {
        <button mat-flat-button (click)="capturer()" data-test="photo-capturer"><mat-icon>photo_camera</mat-icon> Prendre la photo</button>
      } @else {
        <button mat-button (click)="demarrerCamera()">Activer la caméra</button>
      }
      <button mat-button mat-dialog-close>Annuler</button>
    </mat-dialog-actions>
  `,
  styles: `
    .cadre {
      position: relative; width: 100%; max-width: 420px; aspect-ratio: 3 / 4; margin: 0 auto; border-radius: 12px;
      overflow: hidden; background: #0a3f31; display: flex; align-items: center; justify-content: center;
    }
    video, img { width: 100%; height: 100%; object-fit: cover; }
    .gabarit {
      position: absolute; inset: 12% 20% 22%; border: 2px dashed rgba(255, 255, 255, 0.7); border-radius: 50% 50% 45% 45%;
      pointer-events: none;
    }
    .vide { color: #cfe3dc; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px; text-align: center; }
    .vide mat-icon { font-size: 48px; width: 48px; height: 48px; }
    .fichier { position: relative; overflow: hidden; display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
      border: 1px solid var(--mat-sys-outline); border-radius: 999px; padding: 0 16px; height: 40px; color: var(--ispat-vert); }
    .fichier input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  `,
})
export class PrisePhoto implements OnDestroy {
  private readonly ref = inject(MatDialogRef<PrisePhoto>);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private flux: MediaStream | null = null;
  private resultat: Blob | null = null;

  readonly camera = signal(false);
  readonly apercu = signal<string | null>(null);
  readonly message = signal('Activation de la caméra…');

  constructor() {
    void this.demarrerCamera();
  }

  async demarrerCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.message.set('Caméra indisponible sur ce poste : choisissez un fichier.');
      return;
    }
    try {
      this.flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
      this.camera.set(true);
      setTimeout(() => {
        const v = this.video()?.nativeElement;
        if (v && this.flux) {
          v.srcObject = this.flux;
        }
      });
    } catch {
      this.message.set('Caméra refusée ou absente : choisissez un fichier.');
    }
  }

  async capturer(): Promise<void> {
    const v = this.video()?.nativeElement;
    if (!v || !v.videoWidth) {
      return;
    }
    // Recadrage 3:4 centré.
    const hauteur = v.videoHeight;
    const largeur = Math.min(v.videoWidth, Math.round((hauteur * 3) / 4));
    const toile = document.createElement('canvas');
    toile.width = largeur;
    toile.height = hauteur;
    toile.getContext('2d')!.drawImage(v, (v.videoWidth - largeur) / 2, 0, largeur, hauteur, 0, 0, largeur, hauteur);
    const blob = await new Promise<Blob | null>((ok) => toile.toBlob(ok, 'image/jpeg', 0.9));
    if (blob) {
      await this.definir(blob);
    }
  }

  async choisirFichier(e: Event): Promise<void> {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) {
      await this.definir(f);
    }
  }

  private async definir(source: Blob): Promise<void> {
    this.resultat = await reduireImage(source);
    this.liberer(false);
    this.apercu.set(URL.createObjectURL(this.resultat));
  }

  recommencer(): void {
    this.apercu.set(null);
    this.resultat = null;
    void this.demarrerCamera();
  }

  valider(): void {
    this.ref.close(this.resultat);
  }

  private liberer(apercuAussi = true): void {
    this.flux?.getTracks().forEach((t) => t.stop());
    this.flux = null;
    this.camera.set(false);
    if (apercuAussi && this.apercu()) {
      URL.revokeObjectURL(this.apercu()!);
    }
  }

  ngOnDestroy(): void {
    this.liberer();
  }
}

export async function prendrePhoto(dialog: MatDialog): Promise<Blob | null> {
  const ref = dialog.open(PrisePhoto, { width: '520px', maxWidth: '96vw' });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}

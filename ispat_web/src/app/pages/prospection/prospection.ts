import { DatePipe } from '@angular/common';
import { Component, computed, inject, resource, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';

import { AuthService } from '../../core/auth/auth.service';
import { db } from '../../core/db';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { normaliser } from '../../core/texte';
import { ProspectFormulaire } from './prospect-formulaire';

const STATUTS: Record<string, string> = {
  NOUVEAU: 'Nouveau', CONTACTE: 'Contacté', PREINSCRIT: 'Pré-inscrit', INSCRIT: 'Inscrit', PERDU: 'Perdu',
};

@Component({
  selector: 'app-prospection',
  imports: [MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, DatePipe],
  template: `
    <div class="page">
      <div class="page-entete">
        <div>
          <h1>Prospection</h1>
          <p class="sous-titre">Prospects enregistrés sur ce poste ({{ total() }}). Saisie possible sans connexion.</p>
        </div>
        @if (peutCreer()) {
          <button mat-flat-button (click)="nouveau()" data-test="nouveau-prospect">
            <mat-icon>person_add</mat-icon> Nouveau prospect
          </button>
        }
      </div>

      <section class="carte">
        <div class="filtres">
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="champ-texte">
            <mat-icon matPrefix>search</mat-icon>
            <mat-label>Nom, prénoms ou téléphone</mat-label>
            <input matInput [value]="texte()" (input)="texte.set($any($event.target).value)" data-test="filtre-prospect" />
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Statut</mat-label>
            <mat-select [value]="statut()" (selectionChange)="statut.set($event.value)">
              <mat-option value="">Tous</mat-option>
              @for (s of statuts; track s[0]) {
                <mat-option [value]="s[0]">{{ s[1] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        @if (liste().length) {
          <div class="defilement-horizontal">
            <table class="tableau" data-test="liste-prospects">
              <thead>
                <tr><th>Nom et prénoms</th><th>Sexe</th><th>Téléphone</th><th>Ville / école</th><th>Filière</th><th>Contact</th><th>Statut</th></tr>
              </thead>
              <tbody>
                @for (p of liste(); track p.id) {
                  <tr [attr.data-id]="p.id">
                    <td><strong>{{ p['nom'] }}</strong> {{ p['prenoms'] }}</td>
                    <td>{{ p['sexe'] === 'F' ? 'F' : 'G' }}</td>
                    <td>{{ p['telephone'] ?? '—' }}</td>
                    <td>
                      {{ refs.value()?.villes?.get(p['ville_id']) ?? '—' }}
                      <div class="texte-secondaire">{{ refs.value()?.ecoles?.get(p['ecole_id']) ?? p['_ecole_nom'] ?? '' }}</div>
                    </td>
                    <td>{{ refs.value()?.filieres?.get(p['filiere_souhaitee_id']) ?? '—' }}</td>
                    <td>{{ p['date_contact'] | date: 'dd/MM/yyyy' }}</td>
                    <td>
                      @if (p['_en_attente']) {
                        <span class="pastille attente" data-test="en-attente"><mat-icon>schedule</mat-icon> À envoyer</span>
                      } @else {
                        <span class="pastille" [class.neutre]="p['statut'] === 'PERDU'">{{ libelleStatut(p['statut']) }}</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (filtres().length > liste().length) {
            <p class="texte-secondaire">{{ liste().length }} premiers résultats affichés sur {{ filtres().length }} : précisez la recherche.</p>
          }
        } @else {
          <p class="vide">
            <span class="material-symbols-outlined">person_search</span>
            Aucun prospect{{ texte() || statut() ? ' pour ces critères' : '' }}.
          </p>
        }
      </section>
      <p class="texte-secondaire note">
        Listes par ville, école ou genre, inscription des prospects et analyses : écrans de l'étape suivante.
      </p>
    </div>
  `,
  styles: `
    .filtres { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .champ-texte { flex: 1; min-width: 240px; }
    .pastille mat-icon { font-size: 14px; width: 14px; height: 14px; }
    .note { margin-top: 12px; }
  `,
})
export class ProspectionPage {
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly reseau = inject(ReseauService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly statuts = Object.entries(STATUTS);
  readonly texte = signal('');
  readonly statut = signal('');
  readonly peutCreer = computed(() => this.auth.peut('commercial.prospection.creer'));

  readonly prospects = resource({
    params: () => ({ r: this.sync.revision() }),
    loader: async () =>
      (await db.table_('prospect').toArray()).sort(
        (a, b) => String(b['date_contact']).localeCompare(String(a['date_contact'])) || String(a['nom']).localeCompare(String(b['nom']), 'fr'),
      ),
  });

  readonly refs = resource({
    params: () => ({ r: this.sync.revision() }),
    loader: async () => ({
      villes: new Map((await db.table_('ville').toArray()).map((v) => [v.id, v['libelle']])),
      ecoles: new Map((await db.table_('ecole').toArray()).map((e) => [e.id, e['nom']])),
      filieres: new Map((await db.table_('filiere').toArray()).map((f) => [f.id, f['code']])),
    }),
  });

  readonly total = computed(() => this.prospects.value()?.length ?? 0);

  readonly filtres = computed(() => {
    const mots = normaliser(this.texte()).split(' ').filter(Boolean);
    const statut = this.statut();
    return (this.prospects.value() ?? []).filter((p) => {
      if (statut && p['statut'] !== statut) {
        return false;
      }
      const t = normaliser(`${p['nom']} ${p['prenoms']} ${p['telephone'] ?? ''} ${p['telephone_parent'] ?? ''}`);
      return mots.every((m) => t.includes(m));
    });
  });

  readonly liste = computed(() => this.filtres().slice(0, 200));

  libelleStatut(s: string): string {
    return STATUTS[s] ?? s;
  }

  nouveau(): void {
    this.dialog
      .open(ProspectFormulaire, { width: '760px', maxWidth: '96vw', autoFocus: 'first-tabbable' })
      .afterClosed()
      .subscribe((ok) => {
        if (ok) {
          this.snack.open(
            this.reseau.enLigne() ? 'Prospect enregistré.' : 'Prospect enregistré sur ce poste : il sera envoyé au retour de la connexion.',
            'OK',
            { duration: 4000 },
          );
        }
      });
  }
}

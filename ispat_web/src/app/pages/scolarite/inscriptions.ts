import { DatePipe } from '@angular/common';
import { Component, computed, inject, resource, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';

import { AuthService } from '../../core/auth/auth.service';
import { db } from '../../core/db';
import { ETATS_INSCRIPTION, TYPES_INSCRIPTION, classeEtat, referentielsScolarite } from '../../core/scolarite';
import { SyncService } from '../../core/sync/sync.service';
import { normaliser } from '../../core/texte';

/** Inscriptions de l'année : données du poste (fonctionne hors ligne), filtres et accès au dossier. */
@Component({
  selector: 'app-inscriptions',
  imports: [MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, RouterLink, DatePipe],
  template: `
    <div class="page large">
      <div class="page-entete">
        <div>
          <h1>Inscriptions</h1>
          <p class="sous-titre">Saisie possible sans connexion ; la validation (matricule, frais) se fait en ligne.</p>
        </div>
        @if (peutCreer()) {
          <a mat-flat-button routerLink="/scolarite/inscriptions/nouvelle" data-test="nouvelle-inscription">
            <mat-icon>person_add</mat-icon> Nouvelle inscription
          </a>
        }
      </div>

      <section class="compteurs">
        @for (c of compteurs(); track c.libelle) {
          <button type="button" class="carte compteur" [class.actif]="etat() === c.etat" (click)="etat.set(etat() === c.etat ? '' : c.etat)"
                  [attr.data-test]="'compteur-' + (c.etat || 'total')">
            <span class="valeur">{{ c.valeur }}</span><span class="libelle">{{ c.libelle }}</span>
          </button>
        }
      </section>

      <section class="carte">
        <div class="filtres">
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="recherche">
            <mat-icon matPrefix>search</mat-icon>
            <mat-label>Matricule, nom, prénoms ou téléphone</mat-label>
            <input matInput [value]="texte()" (input)="texte.set($any($event.target).value)" data-test="recherche-inscription" />
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Année</mat-label>
            <mat-select [value]="anneeId()" (selectionChange)="anneeId.set($event.value); classeId.set('')">
              @for (a of ref.value()?.annees ?? []; track a.id) {
                <mat-option [value]="a.id">{{ a['libelle'] }}{{ a['est_active'] ? ' (active)' : '' }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Classe</mat-label>
            <mat-select [value]="classeId()" (selectionChange)="classeId.set($event.value)" data-test="filtre-classe">
              <mat-option value="">Toutes</mat-option>
              @for (c of classesAnnee(); track c.id) { <mat-option [value]="c.id">{{ c['libelle'] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Statut</mat-label>
            <mat-select [value]="statutId()" (selectionChange)="statutId.set($event.value)">
              <mat-option value="">Tous</mat-option>
              @for (s of ref.value()?.statuts ?? []; track s.id) { <mat-option [value]="s.id">{{ s['libelle'] }}</mat-option> }
            </mat-select>
          </mat-form-field>
        </div>

        <div class="defilement-horizontal">
          <table class="tableau" data-test="liste-inscriptions">
            <thead>
              <tr><th>Matricule</th><th>Nom et prénoms</th><th>Sexe</th><th>Classe</th><th>Statut</th><th>Type</th><th>Date</th><th>État</th></tr>
            </thead>
            <tbody>
              @for (l of affichees(); track l.inscription.id) {
                <tr class="cliquable" (click)="ouvrir(l.etudiant?.id)" [attr.data-id]="l.inscription.id">
                  <td class="matricule">{{ l.etudiant?.['matricule'] ?? '—' }}</td>
                  <td><strong>{{ l.etudiant?.['nom'] }}</strong> {{ l.etudiant?.['prenoms'] }}</td>
                  <td>{{ l.etudiant?.['sexe'] }}</td>
                  <td>{{ l.classe }}</td>
                  <td>{{ l.statut }}</td>
                  <td>{{ l.type }}</td>
                  <td>{{ l.inscription['date_inscription'] | date: 'dd/MM/yyyy' }}</td>
                  <td>
                    @if (l.inscription['_en_attente']) {
                      <span class="pastille attente" data-test="a-envoyer"><mat-icon>schedule</mat-icon> À envoyer</span>
                    } @else {
                      <span class="pastille" [class]="classeEtat(l.inscription['etat'])">{{ etats[l.inscription['etat']] }}</span>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="vide">Aucune inscription pour ces critères.</td></tr>
              }
            </tbody>
          </table>
        </div>
        @if (filtrees().length > affichees().length) {
          <p class="texte-secondaire">{{ affichees().length }} premières lignes sur {{ filtrees().length }} : précisez la recherche.</p>
        }
      </section>
    </div>
  `,
  styles: `
    .large { max-width: 1400px; }
    .compteurs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .compteur { display: flex; flex-direction: column; text-align: left; cursor: pointer; font: inherit; padding: 14px 16px; }
    .compteur.actif { border-color: var(--ispat-vert); box-shadow: inset 3px 0 0 var(--ispat-orange); }
    .valeur { font-family: var(--ispat-police-titres); font-size: 1.4rem; font-weight: 700; color: var(--ispat-vert-fonce); }
    .libelle { font-size: 0.82rem; color: #5d6f68; }
    .filtres { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .filtres mat-form-field { flex: 1 1 170px; }
    .recherche { flex: 3 1 260px !important; }
    .cliquable { cursor: pointer; }
    .cliquable:hover td { background: #f6faf8; }
    .pastille mat-icon { font-size: 14px; width: 14px; height: 14px; }
  `,
})
export class InscriptionsPage {
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly router = inject(Router);

  readonly etats = ETATS_INSCRIPTION;
  readonly classeEtat = classeEtat;
  readonly texte = signal('');
  readonly anneeId = signal<string>('');
  readonly classeId = signal('');
  readonly statutId = signal('');
  readonly etat = signal('');
  readonly peutCreer = computed(() => this.auth.peut('scolarite.inscription.creer'));

  readonly ref = resource({
    params: () => ({ r: this.sync.revision() }),
    loader: async () => {
      const r = await referentielsScolarite();
      if (!this.anneeId() && r.anneeActive) {
        this.anneeId.set(r.anneeActive.id);
      }
      return r;
    },
  });

  readonly classesAnnee = computed(() => (this.ref.value()?.classes ?? []).filter((c) => c['annee_id'] === this.anneeId()));

  private readonly donnees = resource({
    params: () => ({ r: this.sync.revision(), annee: this.anneeId() }),
    loader: async ({ params }) => {
      const inscriptions = params.annee ? await db.table_('inscription').where('annee_id').equals(params.annee).toArray() : [];
      const etudiants = new Map((await db.table_('etudiant').bulkGet(inscriptions.map((i) => i['etudiant_id']))).filter(Boolean).map((e) => [e!.id, e!]));
      return { inscriptions, etudiants };
    },
  });

  readonly lignes = computed(() => {
    const d = this.donnees.value();
    const r = this.ref.value();
    if (!d || !r) {
      return [];
    }
    const types = Object.fromEntries(TYPES_INSCRIPTION);
    return d.inscriptions
      .map((i) => ({
        inscription: i,
        etudiant: d.etudiants.get(i['etudiant_id']),
        classe: r.parId.get(i['classe_id'])?.['libelle'] ?? '—',
        statut: r.parId.get(i['statut_etudiant_id'])?.['libelle'] ?? '—',
        type: types[i['type_inscription']] ?? i['type_inscription'],
      }))
      .sort((a, b) => `${a.etudiant?.['nom']} ${a.etudiant?.['prenoms']}`.localeCompare(`${b.etudiant?.['nom']} ${b.etudiant?.['prenoms']}`, 'fr'));
  });

  readonly compteurs = computed(() => {
    const l = this.lignes().filter((x) => !this.classeId() || x.inscription['classe_id'] === this.classeId());
    const nb = (etat: string) => l.filter((x) => x.inscription['etat'] === etat).length;
    return [
      { etat: '', libelle: 'Inscriptions', valeur: l.length },
      { etat: 'EN_ATTENTE', libelle: 'En attente de validation', valeur: nb('EN_ATTENTE') },
      { etat: 'VALIDEE', libelle: 'Validées', valeur: nb('VALIDEE') },
      { etat: 'ABANDON', libelle: 'Abandons', valeur: nb('ABANDON') },
      { etat: 'ANNULEE', libelle: 'Annulées', valeur: nb('ANNULEE') },
    ];
  });

  readonly filtrees = computed(() => {
    const mots = normaliser(this.texte()).split(' ').filter(Boolean);
    return this.lignes().filter((l) => {
      const i = l.inscription;
      if ((this.classeId() && i['classe_id'] !== this.classeId()) || (this.statutId() && i['statut_etudiant_id'] !== this.statutId())) {
        return false;
      }
      if (this.etat() && i['etat'] !== this.etat()) {
        return false;
      }
      const e = l.etudiant;
      const t = normaliser(`${e?.['matricule'] ?? ''} ${e?.['nom'] ?? ''} ${e?.['prenoms'] ?? ''} ${e?.['telephone'] ?? ''}`);
      return mots.every((m) => t.includes(m));
    });
  });

  readonly affichees = computed(() => this.filtrees().slice(0, 300));

  ouvrir(etudiantId: string | undefined): void {
    if (etudiantId) {
      void this.router.navigate(['/scolarite/etudiants', etudiantId]);
    }
  }
}

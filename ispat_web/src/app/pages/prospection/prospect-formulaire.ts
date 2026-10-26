import { Component, computed, inject, resource, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { AuthService } from '../../core/auth/auth.service';
import { Ligne, db } from '../../core/db';
import { anneeActive } from '../../core/recherche-locale';
import { SyncService } from '../../core/sync/sync.service';
import { aujourdhui, normaliser, nouvelId } from '../../core/texte';

export const SOURCES_PROSPECT: [string, string][] = [
  ['TERRAIN', 'Terrain'], ['SITE_WEB', 'Site web'], ['SALON', 'Salon / forum'],
  ['RESEAUX_SOCIAUX', 'Réseaux sociaux'], ['RECOMMANDATION', 'Recommandation'], ['AUTRE', 'Autre'],
];

const NIVEAUX_ETUDE = ['3e', 'Seconde', 'Première', 'Terminale', 'Bachelier', 'Autre'];

/** Saisie d'un prospect : enregistrée sur le poste, envoyée au serveur dès que possible. */
@Component({
  selector: 'app-prospect-formulaire',
  imports: [ReactiveFormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatButtonToggleModule, MatAutocompleteModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Nouveau prospect</h2>
    <form [formGroup]="f" (ngSubmit)="enregistrer()">
      <mat-dialog-content>
        @if (doublons.value()?.length) {
          <div class="alerte-doublon" data-test="alerte-doublon">
            <mat-icon>warning</mat-icon>
            <div>
              <strong>Personne peut-être déjà enregistrée sur ce poste :</strong>
              @for (d of doublons.value(); track d.id) {
                <div>{{ d['nom'] }} {{ d['prenoms'] }} · {{ d['telephone'] ?? 'sans téléphone' }}</div>
              }
            </div>
          </div>
        }
        <div class="grille-formulaire">
          <mat-form-field appearance="outline">
            <mat-label>Nom</mat-label>
            <input matInput formControlName="nom" data-test="p-nom" autocomplete="off" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Prénoms</mat-label>
            <input matInput formControlName="prenoms" data-test="p-prenoms" autocomplete="off" />
          </mat-form-field>
          <div class="champ-sexe">
            <span class="texte-secondaire">Sexe</span>
            <mat-button-toggle-group formControlName="sexe" data-test="p-sexe">
              <mat-button-toggle value="F">Fille</mat-button-toggle>
              <mat-button-toggle value="M">Garçon</mat-button-toggle>
            </mat-button-toggle-group>
          </div>
          <mat-form-field appearance="outline">
            <mat-label>Téléphone</mat-label>
            <input matInput formControlName="telephone" type="tel" data-test="p-telephone" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Téléphone d'un parent</mat-label>
            <input matInput formControlName="telephone_parent" type="tel" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>E-mail</mat-label>
            <input matInput formControlName="email" type="email" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Ville</mat-label>
            <mat-select formControlName="ville" data-test="p-ville">
              <mat-option [value]="null">—</mat-option>
              @for (v of ref.value()?.villes ?? []; track v.id) {
                <mat-option [value]="v.id">{{ v['libelle'] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>École d'origine</mat-label>
            <input matInput formControlName="ecole_nom" [matAutocomplete]="ecoles" data-test="p-ecole" />
            <mat-autocomplete #ecoles="matAutocomplete">
              @for (e of ecolesProposees(); track e.id) {
                <mat-option [value]="e['nom']">{{ e['nom'] }}</mat-option>
              }
            </mat-autocomplete>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Niveau d'études</mat-label>
            <mat-select formControlName="niveau_etude">
              <mat-option [value]="null">—</mat-option>
              @for (n of niveaux; track n) {
                <mat-option [value]="n">{{ n }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Série du bac</mat-label>
            <input matInput formControlName="serie_bac" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Filière souhaitée</mat-label>
            <mat-select formControlName="filiere_souhaitee" data-test="p-filiere">
              <mat-option [value]="null">—</mat-option>
              @for (fi of ref.value()?.filieres ?? []; track fi.id) {
                <mat-option [value]="fi.id">{{ fi['code'] }} — {{ fi['libelle'] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Source</mat-label>
            <mat-select formControlName="source">
              @for (s of sources; track s[0]) {
                <mat-option [value]="s[0]">{{ s[1] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Campagne</mat-label>
            <mat-select formControlName="campagne" data-test="p-campagne">
              <mat-option [value]="null">—</mat-option>
              @for (c of ref.value()?.campagnes ?? []; track c.id) {
                <mat-option [value]="c.id">{{ c['libelle'] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Date du contact</mat-label>
            <input matInput type="date" formControlName="date_contact" [max]="aujourdhui" />
          </mat-form-field>
          <mat-form-field appearance="outline" class="pleine-largeur">
            <mat-label>Observations</mat-label>
            <textarea matInput formControlName="observations" rows="2"></textarea>
          </mat-form-field>
        </div>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <span class="texte-secondaire note">Enregistré sur ce poste, envoyé dès que la connexion le permet.</span>
        <button mat-button type="button" mat-dialog-close>Annuler</button>
        <button mat-flat-button type="submit" [disabled]="f.invalid || envoi()" data-test="p-enregistrer">Enregistrer</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .champ-sexe { display: flex; flex-direction: column; gap: 4px; margin-bottom: 20px; }
    .alerte-doublon {
      display: flex; gap: 10px; background: var(--ispat-orange-clair); color: #7a3b04;
      padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 0.88rem;
    }
    .note { margin-right: auto; font-size: 0.8rem; padding-left: 8px; }
  `,
})
export class ProspectFormulaire {
  private readonly sync = inject(SyncService);
  private readonly auth = inject(AuthService);
  private readonly ref$ = inject(MatDialogRef<ProspectFormulaire>);

  readonly sources = SOURCES_PROSPECT;
  readonly niveaux = NIVEAUX_ETUDE;
  readonly aujourdhui = aujourdhui();
  readonly envoi = signal(false);

  readonly f = inject(FormBuilder).group({
    nom: ['', [Validators.required, Validators.maxLength(100)]],
    prenoms: ['', [Validators.required, Validators.maxLength(150)]],
    sexe: ['F', Validators.required],
    telephone: [''],
    telephone_parent: [''],
    email: ['', Validators.email],
    ville: [null as string | null],
    ecole_nom: [''],
    niveau_etude: [null as string | null],
    serie_bac: [''],
    filiere_souhaitee: [null as string | null],
    source: ['TERRAIN', Validators.required],
    campagne: [null as string | null],
    date_contact: [aujourdhui(), Validators.required],
    observations: [''],
  });

  private readonly valeurs = toSignal(this.f.valueChanges, { initialValue: this.f.getRawValue() });

  readonly ref = resource({
    loader: async () => {
      const annee = await anneeActive();
      const campagnes = (await db.table_('campagne_prospection').toArray())
        .filter((c) => !annee || c['annee_id'] === annee.id)
        .sort((a, b) => String(b['date_debut'] ?? '').localeCompare(String(a['date_debut'] ?? '')));
      const tri = (cle: string) => (a: Ligne, b: Ligne) => String(a[cle] ?? '').localeCompare(String(b[cle] ?? ''), 'fr');
      const filieres = (await db.table_('filiere').toArray()).filter((x) => x['active'] !== false).sort(tri('code'));
      const villes = (await db.table_('ville').toArray()).sort(tri('libelle'));
      const ecolesListe = (await db.table_('ecole').toArray()).sort(tri('nom'));
      if (campagnes.length && !this.f.controls.campagne.value) {
        this.f.controls.campagne.setValue(campagnes[0].id);
      }
      return { campagnes, filieres, villes, ecoles: ecolesListe };
    },
  });

  readonly ecolesProposees = computed(() => {
    const v = this.valeurs();
    const texte = normaliser(v.ecole_nom ?? '');
    return (this.ref.value()?.ecoles ?? [])
      .filter((e) => !v.ville || e['ville_id'] === v.ville)
      .filter((e) => !texte || normaliser(e['nom']).includes(texte))
      .slice(0, 8);
  });

  /** Contrôle local des doublons (même téléphone, ou mêmes nom et prénoms) ; le serveur refait le contrôle. */
  readonly doublons = resource({
    params: () => {
      const v = this.valeurs();
      return { nom: normaliser(v.nom ?? ''), prenoms: normaliser(v.prenoms ?? ''), tel: (v.telephone ?? '').replace(/\D/g, '') };
    },
    loader: async ({ params }) => {
      if ((!params.nom || !params.prenoms) && params.tel.length < 8) {
        return [];
      }
      return db.table_('prospect')
        .filter((p) =>
          (params.tel.length >= 8 && String(p['telephone'] ?? '').replace(/\D/g, '').endsWith(params.tel.slice(-8))) ||
          (!!params.nom && !!params.prenoms && normaliser(p['nom']) === params.nom && normaliser(p['prenoms']) === params.prenoms))
        .limit(3)
        .toArray();
    },
  });

  async enregistrer(): Promise<void> {
    if (this.f.invalid) {
      return;
    }
    this.envoi.set(true);
    const v = this.f.getRawValue();
    const vide = (x: string | null | undefined) => (x && x.trim() ? x.trim() : null);
    const id = nouvelId();
    const donnees: Record<string, any> = {
      campagne: v.campagne, nom: v.nom!.trim(), prenoms: v.prenoms!.trim(), sexe: v.sexe,
      telephone: vide(v.telephone), telephone_parent: vide(v.telephone_parent), email: vide(v.email),
      ville: v.ville, niveau_etude: v.niveau_etude, serie_bac: vide(v.serie_bac),
      filiere_souhaitee: v.filiere_souhaitee, source: v.source, date_contact: v.date_contact,
      observations: vide(v.observations),
    };
    if (vide(v.ecole_nom)) {
      donnees['ecole_nom'] = vide(v.ecole_nom);
    }
    // Ligne locale au format de la base (colonnes *_id), remplacée par celle du serveur après l'envoi.
    const ligne: Ligne = {
      id, version: 0, campagne_id: v.campagne, nom: donnees['nom'].toUpperCase(), prenoms: donnees['prenoms'],
      sexe: v.sexe, telephone: donnees['telephone'], telephone_parent: donnees['telephone_parent'], email: donnees['email'],
      ville_id: v.ville, ecole_id: null, _ecole_nom: donnees['ecole_nom'] ?? null, niveau_etude: v.niveau_etude,
      serie_bac: donnees['serie_bac'], filiere_souhaitee_id: v.filiere_souhaitee, source: v.source,
      agent_id: this.auth.utilisateur()?.id ?? null, date_contact: v.date_contact, statut: 'NOUVEAU',
      etudiant_id: null, observations: donnees['observations'],
    };
    try {
      await this.sync.enregistrer(
        { table: 'prospect', action: 'creer', id, donnees, libelle: `Prospect ${ligne['nom']} ${ligne['prenoms']}` },
        ligne,
      );
      this.ref$.close(true);
    } finally {
      this.envoi.set(false);
    }
  }
}

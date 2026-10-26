import { Component, OnDestroy, computed, inject, resource, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { Ligne, db } from '../../core/db';
import { ResultatEtudiant, rechercherEtudiants } from '../../core/recherche-locale';
import { ReseauService } from '../../core/reseau.service';
import {
  LIENS_CONTACT, SEXES, TAILLE_MAX_PIECE, TYPES_INSCRIPTION, TYPES_PIECE_ACCEPTES, referentielsScolarite,
} from '../../core/scolarite';
import { SyncService } from '../../core/sync/sync.service';
import { aujourdhui, normaliser, nouvelId } from '../../core/texte';
import { prendrePhoto } from '../../shared/prise-photo';

interface PieceChoisie {
  typeId: string;
  fichier: File;
}

/**
 * Inscription au guichet : nouvel étudiant ou réinscription, contacts, classe, photo et pièces.
 * Tout est enregistré sur le poste puis envoyé (y compris photo et pièces) dès que la connexion le permet.
 */
@Component({
  selector: 'app-nouvelle-inscription',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatButtonToggleModule,
    MatCheckboxModule, MatIconModule, RouterLink],
  templateUrl: './nouvelle-inscription.html',
  styleUrl: './nouvelle-inscription.scss',
})
export class NouvelleInscriptionPage implements OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly router = inject(Router);
  readonly reseau = inject(ReseauService);

  readonly sexes = SEXES;
  readonly liens = LIENS_CONTACT;
  readonly types = TYPES_INSCRIPTION;
  readonly accepte = TYPES_PIECE_ACCEPTES;

  /** 'nouveau' : nouvel étudiant ; 'existant' : réinscription d'un étudiant connu. */
  readonly mode = signal<'nouveau' | 'existant'>('nouveau');
  readonly existant = signal<ResultatEtudiant | null>(null);
  readonly recherche = signal('');
  readonly photo = signal<Blob | null>(null);
  readonly photoUrl = signal<string | null>(null);
  readonly pieces = signal<PieceChoisie[]>([]);
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);

  readonly ref = resource({ loader: () => referentielsScolarite() });

  readonly etudiant = this.fb.group({
    nom: ['', [Validators.required, Validators.maxLength(100)]],
    prenoms: ['', [Validators.required, Validators.maxLength(150)]],
    sexe: ['', Validators.required],
    date_naissance: [''],
    lieu_naissance: [''],
    nationalite: ['Ivoirienne'],
    num_piece_identite: [''],
    telephone: [''],
    email: ['', Validators.email],
    adresse: [''],
    ville: [null as string | null],
    ecole_origine: [null as string | null],
    serie_bac: [''],
    annee_bac: [null as number | null, [Validators.min(1980), Validators.max(2100)]],
  });

  readonly contacts = this.fb.array<FormGroup>([]);

  readonly inscription = this.fb.group({
    classe: ['', Validators.required],
    statut_etudiant: ['', Validators.required],
    type_inscription: ['NOUVELLE', Validators.required],
    date_inscription: [aujourdhui(), Validators.required],
    observations: [''],
  });

  private readonly valeursEtudiant = toSignal(this.etudiant.valueChanges, { initialValue: this.etudiant.getRawValue() });

  readonly classesActives = computed(() => {
    const r = this.ref.value();
    return (r?.classes ?? []).filter((c) => c['annee_id'] === r?.anneeActive?.id);
  });

  readonly ecolesVille = computed(() => {
    const ville = this.valeursEtudiant().ville;
    return (this.ref.value()?.ecoles ?? []).filter((e) => !ville || e['ville_id'] === ville);
  });

  readonly resultats = resource({
    params: () => ({ q: this.recherche() }),
    loader: ({ params }) => rechercherEtudiants(params.q, 8),
  });

  /** Même nom, prénoms (et date de naissance si saisie) déjà présent sur le poste. */
  readonly doublons = resource({
    params: () => {
      const v = this.valeursEtudiant();
      return { nom: normaliser(v.nom), prenoms: normaliser(v.prenoms), naissance: v.date_naissance ?? '', mode: this.mode() };
    },
    loader: async ({ params }) => {
      if (params.mode !== 'nouveau' || !params.nom || !params.prenoms) {
        return [];
      }
      return db.table_('etudiant')
        .filter((e) => normaliser(e['nom']) === params.nom && normaliser(e['prenoms']) === params.prenoms
          && (!params.naissance || !e['date_naissance'] || e['date_naissance'] === params.naissance))
        .limit(3).toArray();
    },
  });

  readonly piecesManquantes = computed(() => {
    const presentes = new Set(this.pieces().map((p) => p.typeId));
    return (this.ref.value()?.typesPiece ?? [])
      .filter((t) => t['obligatoire'] && !presentes.has(t.id) && !(t['code'] === 'PHOTO' && this.photo()))
      .map((t) => t['libelle']);
  });

  constructor() {
    const id = inject(ActivatedRoute).snapshot.queryParamMap.get('etudiant');
    if (id) {
      void this.preselectionner(id);
    }
    this.ajouterContact();
  }

  private async preselectionner(id: string): Promise<void> {
    const r = (await rechercherEtudiants((await db.table_('etudiant').get(id))?.['matricule'] ?? '', 1))[0];
    const e = await db.table_('etudiant').get(id);
    if (e) {
      this.choisirExistant(r?.etudiant.id === id ? r : { etudiant: e, classe: null, annee: null, etat: null });
    }
  }

  changerMode(mode: 'nouveau' | 'existant'): void {
    this.mode.set(mode);
    this.existant.set(null);
    this.inscription.controls.type_inscription.setValue(mode === 'nouveau' ? 'NOUVELLE' : 'REINSCRIPTION');
  }

  choisirExistant(r: ResultatEtudiant): void {
    this.mode.set('existant');
    this.existant.set(r);
    this.recherche.set('');
    this.inscription.controls.type_inscription.setValue('REINSCRIPTION');
    this.contacts.clear();
  }

  ajouterContact(): void {
    this.contacts.push(this.fb.group({
      lien: ['PERE', Validators.required],
      nom_complet: [''],
      telephone: [''],
      profession: [''],
      est_urgence: [this.contacts.length === 0],
    }));
  }

  retirerContact(i: number): void {
    this.contacts.removeAt(i);
  }

  async photoDialogue(): Promise<void> {
    const blob = await prendrePhoto(this.dialog);
    if (blob) {
      this.photo.set(blob);
      this.libererApercu();
      this.photoUrl.set(URL.createObjectURL(blob));
    }
  }

  retirerPhoto(): void {
    this.photo.set(null);
    this.libererApercu();
  }

  ajouterPiece(typeId: string, e: Event): void {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) {
      return;
    }
    if (f.size > TAILLE_MAX_PIECE) {
      this.snack.open(`« ${f.name} » dépasse 5 Mo.`, 'OK', { duration: 5000 });
      return;
    }
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)) {
      this.snack.open('Formats acceptés : PDF, JPEG, PNG.', 'OK', { duration: 5000 });
      return;
    }
    this.pieces.update((l) => [...l.filter((p) => p.typeId !== typeId), { typeId, fichier: f }]);
  }

  retirerPiece(typeId: string): void {
    this.pieces.update((l) => l.filter((p) => p.typeId !== typeId));
  }

  piecePour(typeId: string): PieceChoisie | undefined {
    return this.pieces().find((p) => p.typeId === typeId);
  }

  formulaireValide(): boolean {
    const etudiantOk = this.mode() === 'existant' ? !!this.existant() : this.etudiant.valid;
    return etudiantOk && this.inscription.valid && this.contacts.valid;
  }

  async enregistrer(): Promise<void> {
    this.etudiant.markAllAsTouched();
    this.inscription.markAllAsTouched();
    this.contacts.markAllAsTouched();
    if (!this.formulaireValide()) {
      this.erreur.set(this.mode() === 'existant' && !this.existant()
        ? 'Choisir l\'étudiant à réinscrire.'
        : 'Compléter les champs obligatoires signalés.');
      return;
    }
    this.erreur.set(null);
    this.envoi.set(true);
    try {
      const r = this.ref.value()!;
      const vide = (x: any) => (typeof x === 'string' ? x.trim() || null : x ?? null);
      const i = this.inscription.getRawValue();
      const classe = r.parId.get(i.classe!)!;
      const inscriptionId = nouvelId();
      let etudiantId: string;
      const donnees: Record<string, any> = {
        id: inscriptionId,
        classe: i.classe,
        statut_etudiant: i.statut_etudiant,
        type_inscription: i.type_inscription,
        date_inscription: i.date_inscription,
        observations: vide(i.observations),
        source: 'GUICHET',
      };
      const autres: { table: string; ligne: Ligne }[] = [];

      if (this.mode() === 'existant') {
        etudiantId = this.existant()!.etudiant.id;
        donnees['etudiant_id'] = etudiantId;
      } else {
        etudiantId = nouvelId();
        const e = this.etudiant.getRawValue();
        const etu: Record<string, any> = {
          id: etudiantId, nom: e.nom!.trim(), prenoms: e.prenoms!.trim(), sexe: e.sexe,
          date_naissance: vide(e.date_naissance), lieu_naissance: vide(e.lieu_naissance), nationalite: vide(e.nationalite),
          num_piece_identite: vide(e.num_piece_identite), telephone: vide(e.telephone), email: vide(e.email),
          adresse: vide(e.adresse), ville: e.ville, ecole_origine: e.ecole_origine, serie_bac: vide(e.serie_bac),
          annee_bac: e.annee_bac || null,
        };
        donnees['etudiant'] = etu;
        const { ville, ecole_origine, ...reste } = etu;
        autres.push({
          table: 'etudiant',
          ligne: { ...reste, id: etudiantId, version: 0, matricule: null, nom: etu['nom'].toUpperCase(), ville_id: ville,
            ecole_origine_id: ecole_origine, photo_chemin: null },
        });
      }

      donnees['contacts'] = this.contacts.getRawValue()
        .filter((c) => vide(c['nom_complet']) || vide(c['telephone']))
        .map((c) => ({ id: nouvelId(), lien: c['lien'], nom_complet: vide(c['nom_complet']), telephone: vide(c['telephone']),
          profession: vide(c['profession']), est_urgence: !!c['est_urgence'] }));
      for (const c of donnees['contacts']) {
        autres.push({ table: 'contact_etudiant', ligne: { ...c, etudiant_id: etudiantId, version: 0 } });
      }

      const nomAffiche = this.mode() === 'existant'
        ? `${this.existant()!.etudiant['nom']} ${this.existant()!.etudiant['prenoms']}`
        : `${donnees['etudiant'].nom.toUpperCase()} ${donnees['etudiant'].prenoms}`;
      await this.sync.enregistrer(
        { table: 'inscription', action: 'nouvelle', id: inscriptionId, donnees, libelle: `Inscription ${nomAffiche} — ${classe['libelle']}` },
        {
          id: inscriptionId, version: 0, etudiant_id: etudiantId, annee_id: classe['annee_id'], classe_id: i.classe,
          statut_etudiant_id: i.statut_etudiant, type_inscription: i.type_inscription, date_inscription: i.date_inscription,
          etat: 'EN_ATTENTE', source: 'GUICHET', observations: donnees['observations'],
        },
        autres,
      );

      if (this.photo()) {
        await this.sync.ajouterFichier({ type: 'photo', etudiant_id: etudiantId, inscription_id: inscriptionId, blob: this.photo()!,
          nom: 'photo.jpg', mime: 'image/jpeg', libelle: `Photo de ${nomAffiche}` });
      }
      for (const p of this.pieces()) {
        const type = r.parId.get(p.typeId);
        await this.sync.ajouterFichier({ type: 'piece', etudiant_id: etudiantId, inscription_id: inscriptionId, type_piece_id: p.typeId,
          blob: p.fichier, nom: p.fichier.name, mime: p.fichier.type, libelle: `${type?.['libelle'] ?? 'Pièce'} — ${nomAffiche}` });
      }
      this.snack.open(
        this.reseau.enLigne() ? 'Inscription enregistrée : envoi en cours.' : 'Inscription enregistrée sur ce poste : elle sera envoyée au retour de la connexion.',
        'OK', { duration: 5000 },
      );
      await this.router.navigate(['/scolarite/etudiants', etudiantId]);
    } catch (e) {
      this.erreur.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.envoi.set(false);
    }
  }

  private libererApercu(): void {
    if (this.photoUrl()) {
      URL.revokeObjectURL(this.photoUrl()!);
      this.photoUrl.set(null);
    }
  }

  ngOnDestroy(): void {
    this.libererApercu();
  }

  contactGroupe(i: number): FormGroup {
    return this.contacts.at(i) as FormGroup;
  }

  get contactsControles(): FormArray {
    return this.contacts;
  }
}

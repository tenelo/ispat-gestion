import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, DestroyRef, OnDestroy, computed, effect, inject, input, resource, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { Ligne, db } from '../../core/db';
import { ReseauService } from '../../core/reseau.service';
import {
  ETATS_INSCRIPTION, LIENS_CONTACT, TAILLE_MAX_PIECE, TYPES_INSCRIPTION, TYPES_PIECE_ACCEPTES, classeEtat, referentielsScolarite,
} from '../../core/scolarite';
import { SyncService } from '../../core/sync/sync.service';
import { nouvelId } from '../../core/texte';
import { choisir } from '../../shared/choix';
import { confirmer } from '../../shared/confirmation';
import { prendrePhoto } from '../../shared/prise-photo';
import { EtudiantFormulaire } from './etudiant-formulaire';

interface DossierServeur {
  etudiant: any;
  inscriptions: any[];
  pieces: any[];
  pieces_manquantes: { code: string; libelle: string }[];
}

/** Dossier d'un étudiant : identité, photo, contacts, inscriptions (validation, annulation, abandon), pièces. */
@Component({
  selector: 'app-dossier-etudiant',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatProgressBarModule, MatTooltipModule, RouterLink, DatePipe, DecimalPipe],
  templateUrl: './dossier-etudiant.html',
  styleUrl: './dossier-etudiant.scss',
})
export class DossierEtudiantPage implements OnDestroy {
  readonly id = input.required<string>();

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);

  readonly etats = ETATS_INSCRIPTION;
  readonly classeEtat = classeEtat;
  readonly types = Object.fromEntries(TYPES_INSCRIPTION);
  readonly liens = Object.fromEntries(LIENS_CONTACT);
  readonly accepte = TYPES_PIECE_ACCEPTES;

  readonly serveur = signal<DossierServeur | null>(null);
  readonly chargementServeur = signal(false);
  readonly photoUrl = signal<string | null>(null);
  readonly action = signal(false);

  readonly peutModifier = computed(() => this.auth.peut('scolarite.inscription.modifier'));
  readonly peutValider = computed(() => this.auth.peut('scolarite.inscription.valider'));
  readonly peutCreer = computed(() => this.auth.peut('scolarite.inscription.creer'));

  readonly local = resource({
    params: () => ({ id: this.id(), r: this.sync.revision() }),
    loader: async ({ params }) => {
      const [etudiant, inscriptions, contacts, fichiers, ref] = await Promise.all([
        db.table_('etudiant').get(params.id),
        db.table_('inscription').where('etudiant_id').equals(params.id).toArray(),
        db.table_('contact_etudiant').where('etudiant_id').equals(params.id).toArray(),
        db.fichiers.where('etudiant_id').equals(params.id).toArray(),
        referentielsScolarite(),
      ]);
      inscriptions.sort((a, b) => String(b['date_inscription']).localeCompare(String(a['date_inscription'])));
      contacts.sort((a, b) => Number(b['est_urgence']) - Number(a['est_urgence']));
      return { etudiant, inscriptions, contacts, fichiers, ref };
    },
  });

  readonly etudiant = computed(() => this.local.value()?.etudiant);
  readonly enAttente = computed(() => !!this.etudiant()?.['_en_attente']);
  readonly anneeActive = computed(() => this.local.value()?.ref.anneeActive);

  /** Inscriptions : données du poste, complétées par le serveur (validé par, le…). */
  readonly inscriptions = computed(() => {
    const l = this.local.value();
    if (!l) {
      return [];
    }
    const srv = new Map((this.serveur()?.inscriptions ?? []).map((i) => [i.id, i]));
    return l.inscriptions.map((i): Ligne => ({
      ...i,
      classe: l.ref.parId.get(i['classe_id'])?.['libelle'] ?? '—',
      annee: l.ref.parId.get(i['annee_id'])?.['libelle'] ?? '—',
      statut: l.ref.parId.get(i['statut_etudiant_id'])?.['libelle'] ?? '—',
      valide_par_nom: srv.get(i.id)?.valide_par_nom ?? null,
      valide_le: srv.get(i.id)?.valide_le ?? i['valide_le'] ?? null,
    }));
  });

  readonly peutReinscrire = computed(() => {
    const active = this.anneeActive();
    return !!active && this.peutCreer() && !this.enAttente()
      && !this.inscriptions().some((i) => i['annee_id'] === active.id && i['etat'] !== 'ANNULEE');
  });

  readonly piecesEnAttente = computed(() => (this.local.value()?.fichiers ?? []).filter((f) => f.type === 'piece'));
  readonly photoEnAttente = computed(() => (this.local.value()?.fichiers ?? []).find((f) => f.type === 'photo') ?? null);

  constructor() {
    // Dossier complet (pièces, pièces manquantes) et photo : depuis le serveur quand c'est possible.
    effect(() => {
      const id = this.id();
      this.sync.revision();
      if (this.reseau.enLigne()) {
        void this.chargerServeur(id);
      }
    });
    effect(() => {
      const attente = this.photoEnAttente();
      const srv = this.serveur();
      void this.afficherPhoto(attente?.blob ?? null, srv?.etudiant?.photo_url ?? null);
    });
    inject(DestroyRef).onDestroy(() => this.libererPhoto());
  }

  private async chargerServeur(id: string): Promise<void> {
    if (this.enAttente()) {
      this.serveur.set(null);
      return;
    }
    this.chargementServeur.set(true);
    try {
      this.serveur.set(await this.api.get<DossierServeur>(`/api/scolarite/etudiants/${id}/dossier/`));
    } catch (e) {
      if ((e as ErreurApi).statut !== 404) {
        this.snack.open((e as ErreurApi).message, 'OK', { duration: 4000 });
      }
    } finally {
      this.chargementServeur.set(false);
    }
  }

  private derniereSourcePhoto: Blob | string | null = null;

  private async afficherPhoto(blob: Blob | null, url: string | null): Promise<void> {
    const source = blob ?? url;
    if (source === this.derniereSourcePhoto) {
      return;
    }
    this.derniereSourcePhoto = source;
    this.libererPhoto();
    if (blob) {
      this.photoUrl.set(URL.createObjectURL(blob));
    } else if (url && this.reseau.enLigne()) {
      try {
        const f = await this.api.fichier(url);
        this.photoUrl.set(URL.createObjectURL(f.blob));
      } catch {
        this.photoUrl.set(null);
      }
    }
  }

  private libererPhoto(): void {
    if (this.photoUrl()) {
      URL.revokeObjectURL(this.photoUrl()!);
      this.photoUrl.set(null);
    }
  }

  ngOnDestroy(): void {
    this.libererPhoto();
  }

  initiales(): string {
    const e = this.etudiant();
    return e ? `${String(e['prenoms'] ?? '')[0] ?? ''}${String(e['nom'] ?? '')[0] ?? ''}`.toUpperCase() : '';
  }

  libelleType(id: string): string {
    return this.local.value()?.ref.parId.get(id)?.['libelle'] ?? 'Pièce';
  }

  // -- Identité, photo, contacts (utilisables hors ligne) --------------------------------------

  modifierIdentite(): void {
    this.dialog.open(EtudiantFormulaire, { data: this.etudiant(), width: '760px', maxWidth: '96vw' })
      .afterClosed().subscribe((ok) => ok && this.snack.open('Identité enregistrée.', 'OK', { duration: 3000 }));
  }

  async changerPhoto(): Promise<void> {
    const blob = await prendrePhoto(this.dialog);
    const e = this.etudiant();
    if (blob && e) {
      await this.sync.ajouterFichier({ type: 'photo', etudiant_id: e.id, blob, nom: 'photo.jpg', mime: 'image/jpeg',
        libelle: `Photo de ${e['nom']} ${e['prenoms']}` });
      this.snack.open('Photo enregistrée.', 'OK', { duration: 3000 });
    }
  }

  async ajouterContact(): Promise<void> {
    const e = this.etudiant();
    if (!e) {
      return;
    }
    const lien = await choisir(this.dialog, { titre: 'Nouveau contact', libelle: 'Lien avec l\'étudiant', options: LIENS_CONTACT, confirmer: 'Suivant' });
    if (!lien) {
      return;
    }
    const nom = await choisir(this.dialog, { titre: 'Nouveau contact', libelle: 'Nom et prénoms', confirmer: 'Suivant', minimum: 2 });
    if (!nom) {
      return;
    }
    const tel = await choisir(this.dialog, { titre: 'Nouveau contact', libelle: 'Téléphone', confirmer: 'Enregistrer', minimum: 8 });
    if (!tel) {
      return;
    }
    const id = nouvelId();
    const donnees = { etudiant: e.id, lien, nom_complet: nom.trim(), telephone: tel.trim(), est_urgence: false };
    await this.sync.enregistrer(
      { table: 'contact_etudiant', action: 'creer', id, donnees, libelle: `Contact ${nom.trim()} (${e['nom']} ${e['prenoms']})` },
      { id, version: 0, etudiant_id: e.id, lien, nom_complet: nom.trim(), telephone: tel.trim(), est_urgence: false },
    );
  }

  async retirerContact(c: Ligne): Promise<void> {
    const ok = await confirmer(this.dialog, { titre: 'Retirer le contact', message: `${c['nom_complet'] ?? ''} sera retiré du dossier.`, confirmer: 'Retirer', danger: true });
    if (!ok) {
      return;
    }
    await this.sync.enregistrer({ table: 'contact_etudiant', action: 'supprimer', id: c.id, version: c.version, libelle: `Retrait du contact ${c['nom_complet'] ?? ''}` });
    await db.table_('contact_etudiant').delete(c.id);
    this.sync.revision.update((v) => v + 1);
  }

  // -- Pièces -----------------------------------------------------------------------------------

  async ajouterPiece(typeId: string, inscriptionId: string | null, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    const e = this.etudiant();
    if (!f || !e) {
      return;
    }
    if (f.size > TAILLE_MAX_PIECE || !['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)) {
      this.snack.open('Formats acceptés : PDF, JPEG, PNG, 5 Mo maximum.', 'OK', { duration: 5000 });
      return;
    }
    await this.sync.ajouterFichier({ type: 'piece', etudiant_id: e.id, inscription_id: inscriptionId, type_piece_id: typeId, blob: f,
      nom: f.name, mime: f.type, libelle: `${this.libelleType(typeId)} — ${e['nom']} ${e['prenoms']}` });
    this.snack.open('Pièce ajoutée : elle sera envoyée à la synchronisation.', 'OK', { duration: 3000 });
  }

  async ouvrirPiece(p: any): Promise<void> {
    try {
      const f = await this.api.fichier(p.url);
      const url = URL.createObjectURL(f.blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 4000 });
    }
  }

  async verifierPiece(p: any): Promise<void> {
    await this.executer(() => this.api.post(`/api/scolarite/pieces/${p.id}/verifier/`), 'Pièce marquée comme vérifiée.');
  }

  async supprimerPiece(p: any): Promise<void> {
    const ok = await confirmer(this.dialog, { titre: 'Supprimer la pièce', message: `« ${p.type_piece_libelle} » (${p.nom_fichier}) sera supprimée.`, confirmer: 'Supprimer', danger: true });
    if (ok) {
      await this.executer(() => this.api.supprimer(`/api/scolarite/pieces/${p.id}/`), 'Pièce supprimée.');
    }
  }

  // -- Inscriptions (validation en ligne) ---------------------------------------------------------

  async valider(i: Ligne, forcer = false): Promise<void> {
    this.action.set(true);
    try {
      const r = await this.api.post(`/api/scolarite/inscriptions/${i.id}/valider/`, forcer ? { forcer: true } : {});
      await this.sync.synchroniser();
      await confirmer(this.dialog, {
        titre: 'Inscription validée',
        message: `Matricule : ${r.matricule}\nFrais générés : ${r.frais_generes} — total dû : ${new Intl.NumberFormat('fr-FR').format(r.total_du)} FCFA`
          + (r.pieces_manquantes?.length ? `\n\nPièces encore manquantes : ${r.pieces_manquantes.map((p: any) => p.libelle).join(', ')}` : ''),
        information: true,
      });
      await this.chargerServeur(this.id());
    } catch (e) {
      const err = e as ErreurApi;
      const manquantes = err.brut?.pieces_manquantes as { libelle: string }[] | undefined;
      if (err.statut === 409 && manquantes?.length && !forcer) {
        const ok = await confirmer(this.dialog, {
          titre: 'Pièces obligatoires manquantes',
          message: `${manquantes.map((p) => '• ' + p.libelle).join('\n')}\n\nValider quand même l'inscription ? Les pièces pourront être ajoutées plus tard.`,
          confirmer: 'Valider quand même',
        });
        if (ok) {
          this.action.set(false);
          await this.valider(i, true);
        }
      } else {
        this.snack.open(err.message, 'OK', { duration: 7000 });
      }
    } finally {
      this.action.set(false);
    }
  }

  async changerEtat(i: Ligne, action: 'annuler' | 'abandon'): Promise<void> {
    const motif = await choisir(this.dialog, {
      titre: action === 'annuler' ? 'Annuler l\'inscription' : 'Déclarer un abandon',
      message: action === 'annuler'
        ? 'L\'inscription et ses frais sont annulés (refusé si des versements existent).'
        : 'L\'étudiant quitte l\'établissement ; sa situation financière reste consultable.',
      libelle: 'Motif', minimum: 3, confirmer: action === 'annuler' ? 'Annuler l\'inscription' : 'Déclarer l\'abandon',
    });
    if (motif) {
      await this.executer(() => this.api.post(`/api/scolarite/inscriptions/${i.id}/${action}/`, { motif }),
        action === 'annuler' ? 'Inscription annulée.' : 'Abandon enregistré.');
    }
  }

  async changerClasse(i: Ligne): Promise<void> {
    const ref = this.local.value()!.ref;
    const options = ref.classes.filter((c) => c['annee_id'] === i['annee_id'] && c.id !== i['classe_id']).map((c) => [c.id, c['libelle']] as [string, string]);
    const classe = await choisir(this.dialog, { titre: 'Changer de classe', libelle: 'Nouvelle classe', options, confirmer: 'Changer' });
    if (!classe) {
      return;
    }
    await this.sync.enregistrer(
      { table: 'inscription', action: 'modifier', id: i.id, version: i.version, donnees: { classe },
        libelle: `Changement de classe — ${this.etudiant()?.['nom']} ${this.etudiant()?.['prenoms']}` },
      { ...this.local.value()!.inscriptions.find((x) => x.id === i.id)!, classe_id: classe },
    );
  }

  private async executer(fn: () => Promise<any>, message: string): Promise<void> {
    this.action.set(true);
    try {
      await fn();
      this.snack.open(message, 'OK', { duration: 3000 });
      await this.sync.synchroniser();
      await this.chargerServeur(this.id());
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 7000 });
    } finally {
      this.action.set(false);
    }
  }
}

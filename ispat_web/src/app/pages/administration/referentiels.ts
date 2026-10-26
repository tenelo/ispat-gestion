import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { TableCrud } from '../../shared/crud/table-crud';
import { descripteursReferentiels } from './referentiels.descripteurs';

/** Administration des référentiels : calendrier, offre de formation, enseignants, listes, finances. */
@Component({
  selector: 'app-referentiels',
  imports: [TableCrud],
  template: `
    <div class="page large">
      <div class="page-entete">
        <div>
          <h1>Référentiels</h1>
          <p class="sous-titre">Paramétrage de l'établissement. Les modifications sont copiées sur les postes à la synchronisation suivante.</p>
        </div>
      </div>
      <div class="disposition">
        <nav class="carte sommaire" data-test="sommaire-referentiels">
          @for (g of groupes; track g.libelle) {
            <div class="groupe">{{ g.libelle }}</div>
            @for (d of g.descripteurs; track d.code) {
              <button type="button" class="lien" [class.actif]="d.code === actif().code" (click)="choisir(d.code)"
                      [attr.data-test]="'ref-' + d.code">{{ d.titre }}</button>
            }
          }
        </nav>
        <section class="carte contenu">
          <app-table-crud [descripteur]="actif()" />
        </section>
      </div>
    </div>
  `,
  styles: `
    .large { max-width: 1400px; }
    .disposition { display: grid; grid-template-columns: 230px 1fr; gap: 20px; align-items: start; }
    .sommaire { padding: 8px 0; position: sticky; top: 16px; }
    .groupe { padding: 14px 16px 4px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6c8079; }
    .lien {
      display: block; width: 100%; text-align: left; border: 0; background: none; cursor: pointer;
      padding: 8px 16px; font: inherit; color: inherit; border-left: 3px solid transparent;
    }
    .lien:hover { background: #f2f6f4; }
    .lien.actif { background: var(--ispat-vert-clair); color: var(--ispat-vert); font-weight: 600; border-left-color: var(--ispat-orange); }
    .contenu { min-width: 0; }
    @media (max-width: 900px) {
      .disposition { grid-template-columns: 1fr; }
      .sommaire { position: static; display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; }
      .groupe { display: none; }
      .lien { width: auto; border-left: 0; border-radius: 999px; padding: 6px 12px; background: #f2f6f4; }
    }
  `,
})
export class ReferentielsPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly groupes = descripteursReferentiels(inject(ApiService), inject(MatDialog), inject(MatSnackBar));
  private readonly tous = this.groupes.flatMap((g) => g.descripteurs);
  private readonly code = toSignal(this.route.queryParamMap.pipe(map((p) => p.get('table'))), { initialValue: null });
  readonly actif = computed(() => this.tous.find((d) => d.code === this.code()) ?? this.tous[0]);

  choisir(code: string): void {
    void this.router.navigate([], { queryParams: { table: code }, replaceUrl: true });
  }
}

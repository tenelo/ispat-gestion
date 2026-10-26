import { Parametres } from '../../core/api.service';

/**
 * Description d'une table administrable (référentiels, etc.) : le composant TableCrud
 * en tire la liste, les filtres, le formulaire d'ajout / modification et la suppression.
 */
export type TypeChamp = 'texte' | 'zone' | 'nombre' | 'date' | 'booleen' | 'choix' | 'multichoix' | 'reference' | 'motdepasse';

export interface ReferenceChamp {
  chemin: string;                         // ex. /api/referentiels/filieres/
  params?: Parametres;
  libelle: (ligne: any) => string;
  valeur?: (ligne: any) => any;           // par défaut : id
}

export interface ChampCrud {
  cle: string;
  libelle: string;
  type: TypeChamp;
  obligatoire?: boolean;
  choix?: [string | number, string][];
  reference?: ReferenceChamp;
  pleineLargeur?: boolean;
  aide?: string;
  creationSeulement?: boolean;            // modifiable seulement à la création
  lectureSeule?: boolean;                 // affiché mais jamais envoyé
  defaut?: any | (() => any);
  min?: number;
  max?: number;
  majuscules?: boolean;
}

export interface ColonneCrud {
  libelle: string;
  cle?: string;
  valeur?: (ligne: any) => string | number | null | undefined;
  type?: 'texte' | 'booleen' | 'nombre' | 'date' | 'code' | 'pastille';
  pastille?: (ligne: any) => { texte: string; classe?: string } | null;
}

export interface FiltreCrud {
  cle: string;                            // paramètre d'URL
  libelle: string;
  choix?: [string, string][];
  reference?: ReferenceChamp;
  defaut?: string;
}

export interface ActionCrud {
  libelle: string;
  icone: string;
  droits: string[];
  visible?: (ligne: any) => boolean;
  executer: (ligne: any) => Promise<boolean | void>;   // true -> recharger la liste
}

export interface Descripteur {
  code: string;
  titre: string;
  singulier: string;                      // « une classe » -> « Nouvelle classe » géré par feminin
  feminin?: boolean;
  chemin: string;
  colonnes: ColonneCrud[];
  champs: ChampCrud[];
  filtres?: FiltreCrud[];
  droits: { creer: string[]; modifier: string[]; supprimer: string[] };
  creation?: boolean;                     // défaut true
  suppression?: boolean;                  // défaut true
  actions?: ActionCrud[];
  aide?: string;
  tri?: (a: any, b: any) => number;
  /** Transforme les valeurs du formulaire avant envoi. */
  preparer?: (donnees: Record<string, any>, ligne: any | null) => Record<string, any>;
}

export function valeurDefaut(c: ChampCrud): any {
  if (typeof c.defaut === 'function') {
    return c.defaut();
  }
  if (c.defaut !== undefined) {
    return c.defaut;
  }
  if (c.type === 'multichoix') {
    return [];
  }
  return c.type === 'booleen' ? false : null;
}

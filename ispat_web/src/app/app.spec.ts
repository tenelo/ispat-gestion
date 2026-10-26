import { TOUTES_ENTREES } from './core/navigation';
import { texteErreur } from './core/sync/sync.service';
import { normaliser, nouvelId } from './core/texte';

describe('Fonctions de base', () => {
  it('normalise sans accents ni casse', () => {
    expect(normaliser('  KONÉ   Awa ')).toBe('kone awa');
    expect(normaliser('Ferkessédougou')).toBe('ferkessedougou');
  });

  it('génère des identifiants UUID', () => {
    const a = nouvelId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(nouvelId()).not.toBe(a);
  });

  it('rend lisibles les erreurs de l\'API', () => {
    expect(texteErreur({ telephone: ['Numéro invalide.'] })).toBe('telephone : Numéro invalide.');
    expect(texteErreur({ detail: 'Prospect déjà enregistré.', doublons: [{ id: 1 }] })).toBe('Prospect déjà enregistré.');
    expect(texteErreur(null)).toBe('');
  });

  it('menu : chemins uniques et droits renseignés', () => {
    const chemins = TOUTES_ENTREES.map((e) => e.chemin);
    expect(new Set(chemins).size).toBe(chemins.length);
    expect(TOUTES_ENTREES.every((e) => e.droits.length > 0)).toBe(true);
  });
});

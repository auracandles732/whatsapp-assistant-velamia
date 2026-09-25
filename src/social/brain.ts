import { BusinessProfile } from '../config/businessProfile';
import { writeCaptions, CaptionRequest } from './ai';
import { pickProducts, CatalogItem, PublishingSettings } from './posts';

/**
 * El "cerebro" del agente de redes: decide qué publicar cada día y escribe los textos. Es independiente del asistente
 * que responde los mensajes: su propia clave de OpenAI y su propio modelo (ai.ts). Por ahora decide con reglas —lo que menos ha
 * salido, variando la categoría y dando prioridad a la temporada— y la IA solo escribe los textos. El cerebro definitivo
 * se enchufa aquí (useBrain) sin tocar el calendario, la publicación ni el CRM.
 */

export interface PlanInput {
  /** Días y horas libres que hay que llenar. */
  slots: Date[];
  catalog: CatalogItem[];
  /** Productos publicados últimamente, del más nuevo al más viejo. */
  recent: string[];
  settings: PublishingSettings;
  month: number;
  profile: BusinessProfile;
}

export interface PlannedPost { theme: string; products: CatalogItem[] }

export interface SocialBrain {
  name: string;
  /** Qué mostrar en cada día libre (puede devolver menos si no hay qué publicar). */
  plan(input: PlanInput): Promise<PlannedPost[]>;
  /** Un texto por publicación, en el mismo orden. */
  write(posts: CaptionRequest[], profile: BusinessProfile): Promise<string[]>;
}

export const ruleBrain: SocialBrain = {
  name: 'reglas',
  async plan({ slots, catalog, recent, settings, month }) {
    return pickProducts(catalog, recent, slots.length, settings.photosPerPost, month);
  },
  // Los textos los escribe la IA propia del agente (su clave y su modelo, nunca los del asistente de mensajes).
  write: (posts, profile) => writeCaptions(posts, profile)
};

let brain: SocialBrain = ruleBrain;

export const currentBrain = () => brain;

/** Cambia el cerebro del agente (lo usan las pruebas y, más adelante, el cerebro definitivo). */
export function useBrain(next: SocialBrain) {
  brain = next;
}

/**
 * Agente de redes: módulo independiente del asistente de mensajes. Programa y publica en Instagram y Facebook,
 * guarda la biblioteca de fotos y videos, importa catálogos de proveedores y mide los resultados.
 *
 * - posts.ts      calendario y configuración de publicaciones
 * - planner.ts    prepara la semana usando el cerebro
 * - brain.ts      el cerebro (qué publicar y los textos), intercambiable
 * - publisher.ts  publica en Meta a la hora programada
 * - images.ts     arma las fotos para Instagram (4:5 y 9:16, sin recortar)
 * - library.ts    fotos y videos subidos por la empresa
 * - suppliers.ts  catálogos PDF de proveedores → Catálogo con precio por tamaño
 * - insights.ts   me gusta, comentarios, visualizaciones y alcance
 * - routes.ts     rutas del CRM
 */
import { startSocialPostsScheduler } from './publisher';
import { startMetricsCollector } from './insights';

export { socialRouter } from './routes';

export function startSocialAgent() {
  startSocialPostsScheduler();
  startMetricsCollector();
}

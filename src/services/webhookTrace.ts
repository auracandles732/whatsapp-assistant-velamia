/**
 * Cuenta de los avisos que Meta envía al servidor desde que arrancó, para ver en /health si llegan los de cada canal
 * sin entrar a los registros. Solo cantidades y horas: nunca contenido, nombres ni identificadores.
 */

type Source = 'whatsapp' | 'instagram' | 'facebook' | 'otro';

const startedAt = Date.now();
const received: Record<Source, { count: number; lastAt: number }> = {
  whatsapp: { count: 0, lastAt: 0 },
  instagram: { count: 0, lastAt: 0 },
  facebook: { count: 0, lastAt: 0 },
  otro: { count: 0, lastAt: 0 }
};
const rejected = { count: 0, lastAt: 0 };
const notes: { at: number; text: string }[] = [];

const SOURCES: Record<string, Source> = { whatsapp_business_account: 'whatsapp', instagram: 'instagram', page: 'facebook' };

export function noteWebhook(object: unknown) {
  const slot = received[SOURCES[String(object)] || 'otro'];
  slot.count++;
  slot.lastAt = Date.now();
}

export function noteRejectedWebhook() {
  rejected.count++;
  rejected.lastAt = Date.now();
}

/** Qué pasó con un aviso de Instagram o Facebook. Se guardan los últimos cinco. */
export function noteSocialOutcome(text: string) {
  notes.push({ at: Date.now(), text });
  if (notes.length > 5) notes.shift();
}

const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000);
  return minutes < 1 ? 'hace menos de 1 min' : minutes < 120 ? `hace ${minutes} min` : `hace ${Math.round(minutes / 60)} h`;
};

export function webhookTrace(now = Date.now()) {
  const line = (slot: { count: number; lastAt: number }) => (slot.count ? `${slot.count} (último ${ago(slot.lastAt, now)})` : '0');
  return {
    servidor_encendido: ago(startedAt, now),
    whatsapp: line(received.whatsapp),
    instagram: line(received.instagram),
    facebook: line(received.facebook),
    firma_invalida: line(rejected),
    ultimos_de_redes: notes.map(n => `${ago(n.at, now)}: ${n.text}`)
  };
}

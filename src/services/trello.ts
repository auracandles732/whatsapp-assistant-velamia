import { getConfig, setConfig, getAllProducts, getActiveTenants, updateOrderStatus, OrderStatus } from './supabase';
import { supabase, tenantOp, tenantValue } from './supabase';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { encryptSecret, decryptSecret, runWithTenant, currentTenant, TenantContext } from './tenant';
import { profile, BusinessProfile } from '../config/businessProfile';

/**
 * Tablero de producción en Trello (API oficial). La dueña ya trabaja con un tablero ("PEDIDOS DE VELA" en VELAMIA):
 * cada pedido es una tarjeta "CANTIDAD-CLIENTA-FECHA" con las instrucciones, la fecha de entrega, las fotos y los
 * miembros de producción (Trello les manda el correo). El CRM crea esas tarjetas, muestra el tablero con sus listas y
 * mueve las tarjetas de etapa; lo que se mueva en Trello también se ve en el CRM y el asistente sabe la etapa.
 */

const API = 'https://api.trello.com/1';

// Las fotos subidas a Trello se muestran con una dirección firmada (una imagen no puede mandar la sesión del CRM).
// La firma cambia al reiniciar el servidor; el tablero se vuelve a pedir cada 30 s.
const IMAGE_SECRET = randomBytes(32);
const signature = (businessId: string, cardId: string, attachmentId: string) => createHmac('sha256', IMAGE_SECRET).update(`${businessId}:${cardId}:${attachmentId}`).digest('base64url').slice(0, 32);

export function attachmentUrl(cardId: string, attachmentId: string): string {
  const businessId = currentTenant()?.businessId || '';
  return `/api/trello/attachment/${cardId}/${attachmentId}?b=${encodeURIComponent(businessId)}&s=${signature(businessId, cardId, attachmentId)}`;
}

/** La empresa de una foto firmada, o null si la firma no es válida. undefined = VELAMIA. */
export async function tenantForAttachment(businessId: string, cardId: string, attachmentId: string, sig: string): Promise<TenantContext | undefined | null> {
  const expected = Buffer.from(signature(businessId, cardId, attachmentId));
  const given = Buffer.from(String(sig || ''));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!businessId) return undefined;
  return (await getActiveTenants().catch(() => [])).find(t => t.businessId === businessId) || null;
}
const SETTINGS_KEY = 'trello';
const LINKS_KEY = 'trello_cards';

export interface TrelloSettings { key: string; token: string; boardId: string; newListId: string; memberIds: string[] }
export interface TrelloLink { cardId: string; url: string; stage: string }

async function readSettings(): Promise<TrelloSettings> {
  try {
    const s = JSON.parse((await getConfig(SETTINGS_KEY)) || '{}');
    return { key: String(s.key || ''), token: String(s.token || ''), boardId: String(s.boardId || ''), newListId: String(s.newListId || ''), memberIds: Array.isArray(s.memberIds) ? s.memberIds.map(String) : [] };
  } catch {
    return { key: '', token: '', boardId: '', newListId: '', memberIds: [] };
  }
}

export async function saveTrelloSettings(input: { key: string; token: string; boardId: string; newListId: string; memberIds: string[] }) {
  await setConfig(SETTINGS_KEY, JSON.stringify({ ...input, key: encryptSecret(input.key), token: encryptSecret(input.token) }));
}

function credentials(s: TrelloSettings) {
  try {
    return { key: decryptSecret(s.key), token: decryptSecret(s.token) };
  } catch {
    return { key: '', token: '' };
  }
}

export async function trelloConnected(): Promise<boolean> {
  const s = await readSettings();
  const c = credentials(s);
  return !!(c.key && c.token && s.boardId);
}

async function call(method: 'GET' | 'POST' | 'PUT', path: string, params: Record<string, string> = {}): Promise<any> {
  const s = await readSettings();
  const c = credentials(s);
  if (!c.key || !c.token) throw new Error('Trello no está conectado');
  const qs = new URLSearchParams({ ...params, key: c.key, token: c.token });
  const res = await fetch(`${API}${path}?${qs}`, { method, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) throw new Error('Trello rechazó la llave: hay que volver a conectar Trello');
  if (!res.ok) throw new Error(`Trello respondió ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

async function readLinks(): Promise<Record<string, TrelloLink>> {
  try {
    const raw = JSON.parse((await getConfig(LINKS_KEY)) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

const writeLinks = (links: Record<string, TrelloLink>) => setConfig(LINKS_KEY, JSON.stringify(links));

export const trelloLinks = readLinks;

/** Etapa del pedido según la lista de Trello: "Enviado" y "Entregado" cambian el estado que ve la clienta. */
export function statusForList(listName: string): OrderStatus | null {
  const name = String(listName || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/entregad/.test(name)) return 'delivered';
  if (/enviad/.test(name)) return 'shipped';
  return null;
}

const MONTHS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
const round2 = (n: number) => Math.round(n * 100) / 100;

function linesOf(order: any): any[] {
  try {
    return typeof order.products === 'string' ? JSON.parse(order.products) : (order.products || []);
  } catch {
    return [];
  }
}

/**
 * La tarjeta con el mismo formato que usa la dueña: título "2 DOCENAS-CLIENTA-19 OCTUBRE" (el inventario lo lee así)
 * y en la descripción lo que producción necesita: producto, personalización, empaque, notas, entrega y pago.
 */
export function cardFromOrder(order: any, catalog: any[] = [], p: BusinessProfile = profile()) {
  const lines = linesOf(order);
  const items = lines.filter(i => i && !i.type && i.name);
  const qty = items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
  const unit = p.sales.unitSingular.toUpperCase();
  const units = p.sales.unitPlural.toUpperCase();
  const perUnit = Number(p.sales.piecesPerUnit) || 0;
  const qtyText = Number.isInteger(qty) || !perUnit
    ? `${round2(qty)} ${qty === 1 ? unit : units}`
    : `${Math.round(qty * perUnit)} UNIDADES`;
  const customer = String(order.customer_name || order.customer_phone || 'CLIENTA')
    .replace(/[^\p{L}\p{N}\s.]/gu, '').replace(/\s+/g, ' ').trim().toUpperCase() || 'CLIENTA';
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(order.delivery_date || '')) ? String(order.delivery_date).slice(0, 10) : '';
  const dateText = date ? `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}` : 'SIN FECHA';
  const name = `${qtyText}-${customer}-${dateText}`;

  const desc: string[] = [];
  for (const i of items) {
    desc.push(`PRODUCTO: ${i.name} · ${round2(Number(i.quantity) || 0)} ${Number(i.quantity) === 1 ? unit : units}`);
    if (i.personalization) desc.push(`PERSONALIZACIÓN: ${i.personalization}`);
    if (i.packaging) desc.push(`EMPAQUE: ${i.packaging}${i.packagingChanged ? ' (cambiado por la clienta)' : ''}`);
    desc.push('');
  }
  const notes = lines.filter(i => i?.type === 'note' && i.text).map(i => String(i.text));
  if (notes.length) desc.push(`NOTAS: ${notes.join(' ')}`, '');
  const shipping = lines.find(i => i?.type === 'shipping');
  const place = order.customer_address || (shipping ? String(shipping.name || '').replace(/^Envío a\s*/i, '') : '');
  desc.push(`ENTREGA: ${date ? date.split('-').reverse().join('/') : 'por definir'}${place ? ` · envío a ${place}` : ''}`);
  desc.push(`TOTAL: $${Number(order.total_amount || 0).toFixed(2)} · ${order.status === 'pending' ? 'PENDIENTE DE PAGO' : 'PAGADO'}`);
  desc.push(`Pedido del CRM · código ${String(order.id || '').slice(0, 8).toUpperCase()}`);

  // Fotos: la de cada producto del catálogo y la del diseño que mandó la clienta (si está en las notas).
  const byName = new Map(catalog.map((c: any) => [String(c.name).trim().toLowerCase(), c]));
  const images = [
    ...lines.filter(i => i?.type === 'note' && i.image).map(i => String(i.image)),
    ...items.map(i => byName.get(String(i.name).trim().toLowerCase())?.image_url).filter(Boolean)
  ].filter((u, k, all) => /^https:\/\//.test(u) && all.indexOf(u) === k).slice(0, 4);

  return { name: name.slice(0, 160), desc: desc.join('\n').trim().slice(0, 4000), due: date ? `${date}T14:00:00.000Z` : '', images };
}

async function getOrder(orderId: string) {
  const { data, error } = await supabase.from('orders').select('*').eq('id', orderId).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  if (error) throw new Error(`Error leyendo el pedido: ${error.message}`);
  return data;
}

/** Envía el pedido a producción: crea su tarjeta en la lista de pedidos confirmados, con fotos y miembros. */
export async function sendOrderToTrello(orderId: string): Promise<TrelloLink> {
  const s = await readSettings();
  if (!s.newListId) throw new Error('Trello no está conectado');
  const links = await readLinks();
  if (links[orderId]) return links[orderId];
  const order = await getOrder(orderId);
  if (!order) throw new Error('Pedido no encontrado');
  const card = cardFromOrder(order, await getAllProducts().catch(() => []));
  const created = await call('POST', '/cards', {
    idList: s.newListId, name: card.name, desc: card.desc, pos: 'top',
    ...(card.due ? { due: card.due } : {}),
    ...(s.memberIds.length ? { idMembers: s.memberIds.join(',') } : {})
  });
  for (const [k, url] of card.images.entries()) {
    await call('POST', `/cards/${created.id}/attachments`, { url, name: k === 0 ? 'Foto del pedido' : `Foto ${k + 1}`, ...(k === 0 ? { setCover: 'true' } : {}) }).catch(() => undefined);
  }
  const lists: any[] = await call('GET', `/boards/${s.boardId}/lists`, { fields: 'name' }).catch(() => []);
  const link: TrelloLink = { cardId: created.id, url: created.shortUrl || created.url || '', stage: lists.find(l => l.id === s.newListId)?.name || '' };
  await writeLinks({ ...(await readLinks()), [orderId]: link });
  return link;
}

/** Mueve la tarjeta a otra lista (etapa) y, si es "Enviado" o "Entregado", actualiza el estado del pedido. */
export async function moveTrelloCard(cardId: string, listId: string) {
  const s = await readSettings();
  const lists: any[] = await call('GET', `/boards/${s.boardId}/lists`, { fields: 'name' });
  const list = lists.find(l => l.id === listId);
  if (!list) throw new Error('Esa lista no es del tablero');
  await call('PUT', `/cards/${cardId}`, { idList: listId });
  await applyStage(cardId, list.name);
  return { stage: list.name };
}

async function applyStage(cardId: string, stage: string) {
  const links = await readLinks();
  const orderId = Object.keys(links).find(id => links[id].cardId === cardId);
  if (!orderId || links[orderId].stage === stage) return;
  await writeLinks({ ...links, [orderId]: { ...links[orderId], stage } });
  const status = statusForList(stage);
  if (status) await updateOrderStatus(orderId, status).catch(() => undefined);
}

/** El tablero tal como está en Trello: listas en orden y sus tarjetas, con el pedido del CRM de cada una. */
export async function trelloBoard() {
  if (!(await trelloConnected())) return { connected: false };
  const s = await readSettings();
  const [board, lists, cards, links] = await Promise.all([
    call('GET', `/boards/${s.boardId}`, { fields: 'name,url,prefs' }),
    call('GET', `/boards/${s.boardId}/lists`, { fields: 'name,pos', filter: 'open' }),
    call('GET', `/boards/${s.boardId}/cards`, { fields: 'name,desc,idList,due,dueComplete,labels,shortUrl,dateLastActivity,idAttachmentCover', attachments: 'true', attachment_fields: 'url,mimeType,isUpload,previews', filter: 'open' }),
    readLinks()
  ]);
  const orderOfCard = new Map(Object.entries(links).map(([orderId, l]) => [l.cardId, orderId]));
  // Lo que se movió directo en Trello también llega al CRM.
  for (const c of cards) {
    const orderId = orderOfCard.get(c.id);
    const stage = lists.find((l: any) => l.id === c.idList)?.name;
    if (orderId && stage && links[orderId].stage !== stage) await applyStage(c.id, stage).catch(() => undefined);
  }
  return {
    connected: true,
    board: { name: board.name, url: board.url, background: board.prefs?.backgroundTopColor || board.prefs?.backgroundColor || '', backgroundImage: board.prefs?.backgroundImage || '' },
    lists: lists.map((l: any) => ({ id: l.id, name: l.name, isNew: l.id === s.newListId })),
    cards: cards.map((c: any) => {
      const cover = (c.attachments || []).find((a: any) => a.id === c.idAttachmentCover) || (c.attachments || []).find((a: any) => /^image\//.test(a.mimeType || ''));
      return {
        id: c.id, name: c.name, desc: String(c.desc || '').slice(0, 600), listId: c.idList, due: c.due, dueComplete: !!c.dueComplete, url: c.shortUrl,
        labels: (c.labels || []).map((l: any) => ({ name: l.name, color: l.color })),
        cover: cover ? (cover.isUpload ? attachmentUrl(c.id, cover.id) : cover.url) : '',
        attachments: (c.attachments || []).length, orderId: orderOfCard.get(c.id) || null, activity: c.dateLastActivity
      };
    })
  };
}

/** Las fotos subidas a Trello piden la llave para verlas: el CRM las trae y las muestra (solo las de este tablero). */
export async function trelloAttachment(cardId: string, attachmentId: string): Promise<{ type: string; body: Buffer }> {
  const s = await readSettings();
  const c = credentials(s);
  const att = await call('GET', `/cards/${cardId}/attachments/${attachmentId}`, { fields: 'url,mimeType,idMember' });
  const card = await call('GET', `/cards/${cardId}`, { fields: 'idBoard' });
  if (card.idBoard !== s.boardId) throw new Error('Esa foto no es del tablero');
  const res = await fetch(att.url, { headers: { Authorization: `OAuth oauth_consumer_key="${c.key}", oauth_token="${c.token}"` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Trello respondió ${res.status}`);
  return { type: att.mimeType || res.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
}

/** Cada 5 minutos: lo que se movió en Trello pasa al CRM aunque nadie tenga el tablero abierto. */
export function startTrelloSync() {
  const tick = async () => {
    const run = async () => { if (await trelloConnected()) await trelloBoard(); };
    await runWithTenant(undefined, run).catch(error => console.warn('⚠️ Trello:', error.message));
    for (const tenant of await getActiveTenants().catch(() => [])) await runWithTenant(tenant, run).catch(() => undefined);
  };
  setTimeout(() => { void tick(); }, 3 * 60_000);
  setInterval(() => { void tick(); }, 5 * 60_000);
}

import { getConfig, setConfig, getActiveTenants } from './supabase';
import { runWithTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { localParts } from '../social/posts';
import { askSocialJson, getSocialAi } from '../social/ai';
import { adsAccess, adResults, listAds } from './ads';
import { metaGet, RESULT_ACTIONS, actionValue, builderZone, short } from './adBuilder';

/**
 * Memoria de estrategias de anuncios (para todas las empresas): guarda los resultados de TODOS los anuncios de la cuenta
 * publicitaria (también los que no se crearon en el CRM) con su formato, público, objetivo y lo que vendieron en el CRM, y
 * los agrupa para ver qué funciona. La IA del agente de redes saca aprendizajes y estrategias nuevas para probar; lo
 * aprendido se usa al armar las campañas siguientes. Solo lee de Meta (API oficial): no cambia nada en la cuenta.
 */

const MEMORY_KEY = 'ad_memory';
const JOURNAL_KEY = 'ad_strategy_journal';
const CAMPAIGNS_KEY = 'ad_campaigns_created';
const MAX_ROWS = 300;
const MAX_ENTRIES = 20;
const REFRESH_EVERY_MS = 24 * 3600_000;
const ANALYZE_EVERY_MS = 7 * 24 * 3600_000;

export interface MemoryAd {
  adId: string; name: string; campaign: string; campaignId: string; objective: string; destination: 'web' | 'whatsapp' | 'anuncio' | '';
  optimization: string; format: 'video' | 'carrusel' | 'foto';
  audience: { ageMin: number; ageMax: number; gender: string; interests: string[]; cities: string[]; advantage: boolean };
  category: string; products: string[]; angle: string; text: string; createdAt: string; status: string; from: string; to: string;
  spend: number; impressions: number; reach: number; clicks: number; ctr: number; resultLabel: string; results: number; costPerResult: number | null;
  conversations: number; addToCart: number; purchases: number; purchaseValue: number; chats: number; sales: number; revenue: number; roas: number | null;
}

interface MemoryData { refreshedAt: string; since: string; rows: MemoryAd[]; error: string }

export interface Learning { tipo: 'funciona' | 'no_funciona' | 'duda'; titulo: string; evidencia: string; confianza: 'alta' | 'media' | 'baja' }
export interface Strategy { titulo: string; como_probarlo: string; por_que: string; prioridad: 'alta' | 'media' | 'baja' }
export interface JournalEntry { at: string; resumen: string; aprendizajes: Learning[]; estrategias: Strategy[]; que_hacer_ahora: string[]; basadoEn: { anuncios: number; gasto: number; desde: string } }

const OBJECTIVE_LABEL: Record<string, string> = {
  OUTCOME_SALES: 'Ventas', OUTCOME_ENGAGEMENT: 'Interacción', OUTCOME_TRAFFIC: 'Tráfico', OUTCOME_AWARENESS: 'Reconocimiento', OUTCOME_LEADS: 'Clientes potenciales',
  MESSAGES: 'Mensajes', CONVERSIONS: 'Conversiones', LINK_CLICKS: 'Tráfico', POST_ENGAGEMENT: 'Interacción', REACH: 'Alcance', VIDEO_VIEWS: 'Reproducciones'
};

const EVENT_TYPES: Record<string, string[]> = {
  PURCHASE: RESULT_ACTIONS.PURCHASE, ADD_TO_CART: RESULT_ACTIONS.ADD_TO_CART, INITIATED_CHECKOUT: RESULT_ACTIONS.INITIATED_CHECKOUT,
  CONTENT_VIEW: ['offsite_conversion.fb_pixel_view_content', 'omni_view_content', 'view_content']
};

/** Qué cuenta como resultado de un anuncio según lo que optimizaba su conjunto. Sin efectos. */
export function resultOf(optimization: string, event: string, row: any): { label: string; value: number } {
  const actions = row?.actions || [];
  switch (optimization) {
    case 'CONVERSATIONS': return { label: 'Chats', value: actionValue(actions, RESULT_ACTIONS.whatsapp) };
    case 'OFFSITE_CONVERSIONS': return { label: event === 'PURCHASE' ? 'Compras' : event === 'CONTENT_VIEW' ? 'Productos vistos' : event === 'INITIATED_CHECKOUT' ? 'Pagos iniciados' : 'Al carrito', value: actionValue(actions, EVENT_TYPES[event] || RESULT_ACTIONS.ADD_TO_CART) };
    case 'POST_ENGAGEMENT': return { label: 'Interacciones', value: actionValue(actions, ['post_engagement', 'page_engagement']) };
    case 'THRUPLAY': return { label: 'Reproducciones', value: actionValue(row?.video_thruplay_watched_actions || [], ['video_view']) || actionValue(actions, ['video_view']) };
    case 'LANDING_PAGE_VIEWS': return { label: 'Visitas a la web', value: actionValue(actions, ['landing_page_view', 'omni_landing_page_view']) };
    case 'LINK_CLICKS': return { label: 'Clics', value: Number(row?.inline_link_clicks || 0) };
    case 'REACH': return { label: 'Alcance', value: Number(row?.reach || 0) };
    default: {
      const chats = actionValue(actions, RESULT_ACTIONS.whatsapp);
      return chats ? { label: 'Chats', value: chats } : { label: 'Clics', value: Number(row?.inline_link_clicks || 0) };
    }
  }
}

/** Formato, destino y público de un anuncio a partir de lo que devuelve Meta. Sin efectos. */
export function describeAd(ad: any): Pick<MemoryAd, 'format' | 'destination' | 'optimization' | 'audience'> & { event: string } {
  const spec = ad?.creative?.object_story_spec || {};
  const isVideo = !!spec.video_data || !!ad?.creative?.video_id || String(ad?.creative?.object_type || '').toUpperCase() === 'VIDEO' || (ad?.creative?.asset_feed_spec?.videos || []).length > 0;
  const isCarousel = (spec.link_data?.child_attachments || []).length > 1;
  const set = ad?.adset || {};
  const t = set.targeting || {};
  const dest = String(set.destination_type || '').toUpperCase();
  const optimization = String(set.optimization_goal || '');
  const link = String(spec.link_data?.link || spec.video_data?.call_to_action?.value?.link || '');
  const destination: MemoryAd['destination'] = dest === 'WHATSAPP' || /wa\.me|whatsapp/i.test(link) || optimization === 'CONVERSATIONS' ? 'whatsapp'
    : dest === 'ON_POST' || dest === 'ON_VIDEO' || optimization === 'POST_ENGAGEMENT' || optimization === 'THRUPLAY' ? 'anuncio'
      : dest === 'WEBSITE' || optimization === 'OFFSITE_CONVERSIONS' || optimization === 'LANDING_PAGE_VIEWS' || /^https?:/i.test(link) ? 'web' : '';
  const genders = Array.isArray(t.genders) ? t.genders : [];
  return {
    format: isVideo ? 'video' : isCarousel ? 'carrusel' : 'foto', destination, optimization, event: String(set.promoted_object?.custom_event_type || ''),
    audience: {
      ageMin: Number(t.age_min || 18), ageMax: Number(t.age_max || 65), gender: genders.length === 1 ? (genders[0] === 2 ? 'mujeres' : 'hombres') : 'todos',
      interests: (t.flexible_spec || []).flatMap((f: any) => (f.interests || []).map((i: any) => String(i.name || ''))).filter(Boolean).slice(0, 10),
      cities: (t.geo_locations?.cities || []).map((c: any) => String(c.name || '')).filter(Boolean).slice(0, 10),
      advantage: Number(t.targeting_automation?.advantage_audience || 0) === 1
    }
  };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getConfig(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** Todas las páginas de una lectura de Meta (con el cursor "after"). */
async function allPages(path: string, token: string, max = 2000): Promise<any[]> {
  const out: any[] = [];
  let after = '';
  for (let i = 0; i < 30 && out.length < max; i++) {
    const page = await metaGet(`${path}${after ? `&after=${encodeURIComponent(after)}` : ''}`, token);
    out.push(...(page?.data || []));
    after = page?.paging?.next ? String(page?.paging?.cursors?.after || '') : '';
    if (!after) break;
  }
  return out;
}

/** Lee de Meta el último año de anuncios con gasto (resultados, formato, público) y lo junta con las ventas del CRM. */
export async function refreshMemory(): Promise<MemoryData> {
  const a = await adsAccess();
  if (!a) throw new Error('Conecta primero la cuenta publicitaria de Meta.');
  const now = new Date();
  const zone = builderZone();
  const day = (d: Date) => { const p = localParts(d, zone); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
  const since = day(new Date(now.getTime() - 365 * 86_400_000));
  const range = encodeURIComponent(JSON.stringify({ since, until: day(now) }));
  const fields = 'ad_id,ad_name,campaign_id,campaign_name,objective,spend,impressions,reach,inline_link_clicks,actions,action_values,video_thruplay_watched_actions,date_start,date_stop';
  const insights = (await allPages(`${a.accountId}/insights?level=ad&time_range=${range}&fields=${fields}&limit=200`, a.token)).filter(r => Number(r.spend || 0) > 0);
  insights.sort((x, y) => Number(y.spend) - Number(x.spend));
  const top = insights.slice(0, MAX_ROWS);
  const details = new Map<string, any>();
  const detailFields = 'created_time,effective_status,creative{object_type,video_id,object_story_spec{video_data{video_id,call_to_action},link_data{link,child_attachments{name}}},asset_feed_spec{videos}},adset{optimization_goal,destination_type,targeting,promoted_object}';
  for (let i = 0; i < top.length; i += 50) {
    const ids = top.slice(i, i + 50).map(r => r.ad_id);
    const got = await metaGet(`?ids=${ids.join(',')}&fields=${encodeURIComponent(detailFields)}`, a.token).catch(() => ({}));
    for (const id of ids) if (got?.[id]) details.set(id, got[id]);
  }
  const [registry, crm, created] = await Promise.all([
    listAds().catch(() => []),
    adResults(new Date(now.getTime() - 365 * 86_400_000), now).catch(() => null),
    readJson<any[]>(CAMPAIGNS_KEY, [])
  ]);
  const reg = new Map(registry.map(r => [r.ad_id, r]));
  const sales = new Map((crm?.results || []).map(r => [r.adId, r]));
  const angles = new Map<string, string>();
  for (const c of Array.isArray(created) ? created : []) for (const s of c.adsets || []) for (const ad of s.ads || []) if (ad.angle) angles.set(String(ad.adId), String(ad.angle));
  const rows: MemoryAd[] = top.map(r => {
    const d = details.get(r.ad_id);
    const info = describeAd(d);
    const result = resultOf(info.optimization, info.event, r);
    const g = reg.get(r.ad_id);
    const c = sales.get(r.ad_id);
    const spend = Number(r.spend || 0);
    const impressions = Number(r.impressions || 0);
    const clicks = Number(r.inline_link_clicks || 0);
    const purchaseValue = actionValue(r.action_values, RESULT_ACTIONS.PURCHASE);
    const revenue = c?.revenue || 0;
    return {
      adId: String(r.ad_id), name: String(r.ad_name || ''), campaign: String(r.campaign_name || ''), campaignId: String(r.campaign_id || ''),
      objective: OBJECTIVE_LABEL[r.objective] || String(r.objective || ''), destination: info.destination, optimization: info.optimization, format: info.format,
      audience: info.audience, category: g?.category || '', products: (g?.products || []).slice(0, 6), angle: angles.get(String(r.ad_id)) || '',
      text: short(g?.body || '', 160), createdAt: String(d?.created_time || ''), status: String(d?.effective_status || ''), from: String(r.date_start || ''), to: String(r.date_stop || ''),
      spend: round(spend), impressions, reach: Number(r.reach || 0), clicks, ctr: impressions ? round((clicks / impressions) * 100) : 0,
      resultLabel: result.label, results: result.value, costPerResult: result.value ? round(spend / result.value) : null,
      conversations: actionValue(r.actions, RESULT_ACTIONS.whatsapp), addToCart: actionValue(r.actions, RESULT_ACTIONS.ADD_TO_CART),
      purchases: actionValue(r.actions, RESULT_ACTIONS.PURCHASE), purchaseValue: round(purchaseValue),
      chats: c?.chats || 0, sales: c?.sales || 0, revenue: round(revenue), roas: spend > 0 && purchaseValue + revenue > 0 ? round((purchaseValue + revenue) / spend, 1) : null
    };
  });
  const data: MemoryData = { refreshedAt: now.toISOString(), since, rows, error: '' };
  await setConfig(MEMORY_KEY, JSON.stringify(data));
  return data;
}

export async function readMemory(): Promise<MemoryData> {
  return readJson<MemoryData>(MEMORY_KEY, { refreshedAt: '', since: '', rows: [], error: '' });
}

export interface GroupSummary {
  dimension: string; value: string; ads: number; spend: number; impressions: number; ctr: number; chats: number; conversations: number;
  purchases: number; sales: number; income: number; roas: number | null; costPerChat: number | null; costPerPurchase: number | null;
}

/** Agrupa los anuncios por formato, objetivo, categoría, público, interés y ángulo, con sus resultados. Sin efectos. */
export function summarize(rows: MemoryAd[], minSpend = 1): GroupSummary[] {
  const groups = new Map<string, { dimension: string; value: string; rows: MemoryAd[] }>();
  const put = (dimension: string, value: string, r: MemoryAd) => {
    if (!value) return;
    const key = `${dimension}|${value}`;
    const g = groups.get(key) || { dimension, value, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  };
  const DEST: Record<string, string> = { web: 'web', whatsapp: 'WhatsApp', anuncio: 'en el anuncio' };
  for (const r of rows) {
    put('Formato', r.format, r);
    put('Objetivo', `${r.objective}${r.destination ? ` → ${DEST[r.destination]}` : ''}`, r);
    put('Categoría', r.category, r);
    put('Público', r.audience.gender === 'todos' ? 'Mujeres y hombres' : r.audience.gender === 'mujeres' ? 'Mujeres' : 'Hombres', r);
    put('Edades', `${r.audience.ageMin}-${r.audience.ageMax}`, r);
    put('Segmentación', r.audience.advantage ? 'Abierta (Advantage+)' : r.audience.interests.length ? 'Detallada (intereses)' : 'Solo edad y género', r);
    for (const i of r.audience.interests) put('Interés', i, r);
    for (const c of r.audience.cities) put('Ciudad', c, r);
    put('Ángulo', r.angle, r);
  }
  const out: GroupSummary[] = [];
  for (const g of groups.values()) {
    const s = (f: (r: MemoryAd) => number) => g.rows.reduce((t, r) => t + f(r), 0);
    const spend = s(r => r.spend);
    if (spend < minSpend) continue;
    const impressions = s(r => r.impressions);
    const chats = s(r => r.chats);
    const conversations = s(r => r.conversations);
    const purchases = s(r => r.purchases);
    const sales = s(r => r.sales);
    const income = s(r => r.purchaseValue + r.revenue);
    out.push({
      dimension: g.dimension, value: g.value, ads: g.rows.length, spend: round(spend), impressions, ctr: impressions ? round((s(r => r.clicks) / impressions) * 100) : 0,
      chats, conversations, purchases, sales, income: round(income), roas: spend > 0 && income > 0 ? round(income / spend, 1) : null,
      costPerChat: Math.max(chats, conversations) ? round(spend / Math.max(chats, conversations)) : null, costPerPurchase: purchases + sales ? round(spend / (purchases + sales)) : null
    });
  }
  return out.sort((a, b) => a.dimension.localeCompare(b.dimension) || (b.roas ?? -1) - (a.roas ?? -1) || b.spend - a.spend);
}

export async function readJournal(): Promise<JournalEntry[]> {
  const list = await readJson<JournalEntry[]>(JOURNAL_KEY, []);
  return Array.isArray(list) ? list : [];
}

/** Lo aprendido, en pocas líneas, para la IA que arma campañas y escribe textos. */
export async function learningsForPrompt(): Promise<string> {
  const [entry] = await readJournal();
  if (entry) {
    const lines = [
      ...entry.aprendizajes.filter(l => l.tipo === 'funciona').slice(0, 6).map(l => `- Funciona: ${l.titulo} (${l.evidencia})`),
      ...entry.aprendizajes.filter(l => l.tipo === 'no_funciona').slice(0, 5).map(l => `- No funciona: ${l.titulo} (${l.evidencia})`),
      ...entry.estrategias.slice(0, 4).map(s => `- Por probar: ${s.titulo}`)
    ];
    return lines.join('\n').slice(0, 2500);
  }
  // Sin análisis todavía: los grupos que mejor vendieron según los datos.
  const memory = await readMemory();
  const best = summarize(memory.rows, 5).filter(g => g.roas !== null).sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0)).slice(0, 5);
  return best.map(g => `- Mejor retorno: ${g.dimension} "${g.value}" (gasto $${g.spend}, retorno ${g.roas}x)`).join('\n');
}

const BEST_PRACTICES = [
  'Prácticas que hoy funcionan en Meta (úsalas para proponer pruebas nuevas, adaptadas al negocio):',
  '- Video vertical corto (6 a 15 s) con gancho en los primeros 3 segundos; testimonios reales de clientas (contenido tipo UGC) y videos del proceso hecho a mano.',
  '- Probar 3 a 6 anuncios distintos por conjunto (distinto gancho o formato) y dejar que Meta reparta; carrusel con variedad de modelos para comparar.',
  '- No tocar presupuesto ni textos en los primeros 3 a 7 días (aprendizaje de Meta); para crecer, subir de a 20-30% cada 3 o 4 días.',
  '- Comparar segmentación detallada (intereses) contra público abierto (Advantage+) con el mismo anuncio, en conjuntos separados.',
  '- Volver a mostrar anuncios a quien visitó la web o escribió (públicos personalizados) y públicos similares a compradoras.',
  '- Calendario de ocasiones (Ecuador): San Valentín (febrero), Día de la Madre (mayo), Día del Padre (junio), graduaciones, Halloween (octubre), Navidad (diciembre); baby shower, bautizos y cumpleaños todo el año. Empezar 3 a 4 semanas antes.',
  '- Ofertas solo si son reales (por ejemplo un descuento que de verdad existe), con fecha clara.'
].join('\n');

/** La IA lee la memoria (grupos y mejores/peores anuncios) y deja aprendizajes y estrategias nuevas en el diario. */
export async function analyzeMemory(): Promise<JournalEntry> {
  let memory = await readMemory();
  if (!memory.refreshedAt || Date.now() - Date.parse(memory.refreshedAt) > 12 * 3600_000) memory = await refreshMemory();
  const rows = memory.rows.filter(r => r.spend > 0);
  if (!rows.length) throw new Error('Todavía no hay anuncios con gasto para analizar.');
  const groups = summarize(rows, 2);
  const brief = (r: MemoryAd) => ({
    anuncio: r.name, campana: r.campaign, objetivo: r.objective, destino: r.destination, formato: r.format, categoria: r.category, angulo: r.angle,
    publico: `${r.audience.gender} ${r.audience.ageMin}-${r.audience.ageMax}${r.audience.interests.length ? ` · intereses: ${r.audience.interests.join(', ')}` : r.audience.advantage ? ' · abierto' : ''}`,
    gasto: r.spend, ctr: r.ctr, resultado: `${r.results} ${r.resultLabel}`, costo_por_resultado: r.costPerResult, chats_crm: r.chats, ventas_crm: r.sales,
    compras_web: r.purchases, ingresos: round(r.purchaseValue + r.revenue), retorno: r.roas, desde: r.from, hasta: r.to
  });
  const byIncome = [...rows].sort((a, b) => (b.purchaseValue + b.revenue) - (a.purchaseValue + a.revenue) || (a.costPerResult ?? 1e9) - (b.costPerResult ?? 1e9));
  const worst = [...rows].filter(r => r.spend >= 3 && r.purchaseValue + r.revenue === 0 && r.chats === 0).sort((a, b) => b.spend - a.spend);
  const previous = (await readJournal()).slice(0, 2).map(e => ({ fecha: e.at.slice(0, 10), aprendizajes: e.aprendizajes.map(l => `${l.tipo}: ${l.titulo}`), probado: e.estrategias.map(s => s.titulo) }));
  const b = profile().business;
  const now = localParts(new Date(), builderZone());
  const system = [
    `Eres quien analiza la publicidad en Meta de ${b.name}, ${b.description}. Con los datos dados (los calcula el sistema: nunca inventes cifras), escribe para la dueña, en palabras simples:`,
    '- "aprendizajes": qué FUNCIONA y qué NO FUNCIONA (formato, objetivo y destino, público, intereses, categoría, ángulo, presupuesto), cada uno con su evidencia en números ("3 videos: $12 gastados, 9 chats a $1.33") y la confianza (alta si hay bastante gasto y diferencia clara; baja si hay poco dato). "duda" si los datos no alcanzan para decidir.',
    '- La meta son VENTAS e ingresos (compras en la web y ventas del CRM) y después chats; clics y vistas solo si no hay ventas.',
    '- "estrategias": 3 a 6 pruebas NUEVAS y concretas para las próximas campañas (qué crear, con qué presupuesto y por cuántos días, y qué comparar), que no se hayan probado ya. Mezcla lo que dicen los datos con las prácticas actuales.',
    '- "que_hacer_ahora": 2 a 4 acciones para esta semana. "resumen": 2 o 3 frases.',
    BEST_PRACTICES
  ].join('\n');
  const user = JSON.stringify({
    hoy: `${now.day}/${now.month}/${now.year}`, datos_desde: memory.since, anuncios_con_gasto: rows.length, gasto_total: round(rows.reduce((t, r) => t + r.spend, 0)),
    grupos: groups.slice(0, 80), mejores: byIncome.slice(0, 15).map(brief), sin_resultados: worst.slice(0, 10).map(brief), analisis_anteriores: previous
  });
  const schema = {
    type: 'object', additionalProperties: false, required: ['resumen', 'aprendizajes', 'estrategias', 'que_hacer_ahora'],
    properties: {
      resumen: { type: 'string' },
      aprendizajes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tipo', 'titulo', 'evidencia', 'confianza'], properties: { tipo: { type: 'string', enum: ['funciona', 'no_funciona', 'duda'] }, titulo: { type: 'string' }, evidencia: { type: 'string' }, confianza: { type: 'string', enum: ['alta', 'media', 'baja'] } } } },
      estrategias: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['titulo', 'como_probarlo', 'por_que', 'prioridad'], properties: { titulo: { type: 'string' }, como_probarlo: { type: 'string' }, por_que: { type: 'string' }, prioridad: { type: 'string', enum: ['alta', 'media', 'baja'] } } } },
      que_hacer_ahora: { type: 'array', items: { type: 'string' } }
    }
  };
  const out = await askSocialJson<Omit<JournalEntry, 'at' | 'basadoEn'>>({ system, user, schemaName: 'memoria', schema, maxTokens: 6000 });
  const entry: JournalEntry = {
    at: new Date().toISOString(), resumen: short(out.resumen, 800),
    aprendizajes: (out.aprendizajes || []).slice(0, 14).map(l => ({ tipo: l.tipo, titulo: short(l.titulo, 200), evidencia: short(l.evidencia, 300), confianza: l.confianza })),
    estrategias: (out.estrategias || []).slice(0, 8).map(s => ({ titulo: short(s.titulo, 200), como_probarlo: short(s.como_probarlo, 500), por_que: short(s.por_que, 300), prioridad: s.prioridad })),
    que_hacer_ahora: (out.que_hacer_ahora || []).map(t => short(t, 300)).filter(Boolean).slice(0, 5),
    basadoEn: { anuncios: rows.length, gasto: round(rows.reduce((t, r) => t + r.spend, 0)), desde: memory.since }
  };
  await setConfig(JOURNAL_KEY, JSON.stringify([entry, ...(await readJournal())].slice(0, MAX_ENTRIES)));
  return entry;
}

/** Para el CRM: la memoria agrupada, los anuncios con mejores y peores resultados y el diario de aprendizajes. */
export async function memoryOverview() {
  const [memory, journal] = await Promise.all([readMemory(), readJournal()]);
  const rows = memory.rows.filter(r => r.spend > 0);
  const income = (r: MemoryAd) => r.purchaseValue + r.revenue;
  return {
    refreshedAt: memory.refreshedAt || null, since: memory.since, error: memory.error,
    totals: { ads: rows.length, spend: round(rows.reduce((t, r) => t + r.spend, 0)), income: round(rows.reduce((t, r) => t + income(r), 0)), chats: rows.reduce((t, r) => t + Math.max(r.chats, r.conversations), 0) },
    groups: summarize(rows, 1),
    best: [...rows].filter(r => income(r) > 0 || r.chats > 0).sort((a, b) => income(b) - income(a) || b.chats - a.chats).slice(0, 10),
    worst: [...rows].filter(r => r.spend >= 3 && income(r) === 0 && r.chats === 0 && r.conversations === 0).sort((a, b) => b.spend - a.spend).slice(0, 8),
    journal: journal.slice(0, 6)
  };
}

// ---------- Revisión automática ----------

let running = false;

async function tickCurrent(who: string) {
  if (!(await adsAccess())) return;
  const memory = await readMemory();
  if (!memory.refreshedAt || Date.now() - Date.parse(memory.refreshedAt) > REFRESH_EVERY_MS - 3600_000) {
    try {
      const data = await refreshMemory();
      console.log(`🧠 Memoria de anuncios de ${who}: ${data.rows.length} anuncios con gasto`);
    } catch (error: any) {
      await setConfig(MEMORY_KEY, JSON.stringify({ ...memory, error: String(error.message).slice(0, 300) })).catch(() => undefined);
      throw error;
    }
  }
  // Una vez por semana la IA saca aprendizajes nuevos (si hay clave de IA y anuncios con gasto).
  const [last] = await readJournal();
  if ((!last || Date.now() - Date.parse(last.at) > ANALYZE_EVERY_MS) && (await getSocialAi().catch(() => null))?.apiKey && (await readMemory()).rows.some(r => r.spend > 0)) {
    await analyzeMemory();
    console.log(`🧠 Aprendizajes de anuncios de ${who} actualizados`);
  }
}

export async function runAdMemory() {
  if (running) return;
  running = true;
  try {
    await runWithTenant(undefined, () => tickCurrent('VELAMIA')).catch(error => console.warn('⚠️ Memoria de anuncios de VELAMIA:', error.message));
    for (const tenant of await getActiveTenants().catch(() => [])) {
      await runWithTenant(tenant, () => tickCurrent(tenant.name)).catch(error => console.warn(`⚠️ Memoria de anuncios de ${tenant.name}:`, error.message));
    }
  } finally {
    running = false;
  }
}

export function startAdMemory() {
  setTimeout(() => { void runAdMemory(); }, 12 * 60 * 1000);
  setInterval(() => { void runAdMemory(); }, 6 * 3600_000);
}


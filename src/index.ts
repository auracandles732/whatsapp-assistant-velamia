// Debe ir primero: los servicios leen variables de entorno al importarse.
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import { buildCrm, BuiltCrm } from './services/crmBuild';
import { randomUUID } from 'crypto';
import {
  supabase,
  initDatabase,
  saveMessage,
  setConfig,
  getConfig,
  getAllConversations,
  getMessages,
  getSalesMetrics,
  getAllProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  pauseBot,
  resumeBot,
  getConversationById,
  deleteConversationCompletely,
  getAllQuotations,
  updateQuotationStatus,
  getQuotationById,
  updateQuotationCustomer,
  createQuotation,
  updateQuotationItems,
  createOrder,
  getAllOrders,
  updateOrderStatus,
  ORDER_STATUSES,
  OrderStatus,
  parseDbTimestamp,
  createBusiness,
  getAllBusinesses,
  getSubscriptionSummary,
  getBusinessPayments,
  recordSubscriptionPayment,
  getBusinessRow,
  toPublicBusiness,
  updateBusinessCredentials,
  updateBusinessInfo,
  deleteBusinessCompletely,
  getBusinessReadiness,
  markWebhookConnected,
  getUsageByBusiness,
  getTenantUsage,
  BusinessCredentials,
  BusinessRow,
  createBusinessUser,
  getBusinessUsers,
  getBusinessUser,
  updateBusinessUser,
  deactivateBusinessUser,
  authenticateBusinessUser,
  changeOwnPassword
} from './db';
import { removeFilesByPublicUrls, storagePath, uploadBufferToStorage } from './services/storage';
import { toWhatsAppVoice, isRecordedAudio } from './services/audio';
import { maskPhone } from './services/privacy';
import { createSignupCode, isSignupCodeUsable, useSignupCode } from './services/signupCodes';
import { splitPhone, platformMeta, addNumberAndRequestCode, verifyAndRegister } from './services/metaNumbers';
import { currentTenant, decryptSecret, runWithTenant, hasAddon } from './services/tenant';
import {
  listPosts, getPost, insertPosts, updatePost, deletePost, getSavedSettings, saveSettings, planUpcomingPosts, rewriteCaption,
  DEFAULT_SETTINGS, EDITABLE_STATUSES, POST_CHANNELS, toPostProduct, fallbackCaption, PostStatus, PostChannel
} from './services/socialPosts';
import { claimAndPublish, startSocialPostsScheduler } from './services/socialPublisher';
import { currentAiProblem } from './services/aiStatus';
import { buildSale, quotationDelivery } from './services/manualSales';
import { loadTenant } from './services/supabase';
import { handleWebhookMessage, handleEchoMessage, flushPendingResponses, forgetConversation, startPhotoNudgeScheduler } from './controllers/messageController';
import { handleSocialWebhook } from './controllers/socialController';
import { subscribePage, isSocialAddress, socialStatus, connectUrl, createConnectState, readConnectState, completeConnection, publishingStatus } from './services/metaChannels';
import {
  requireCrmSession,
  requireAdminSession,
  requireOwnerRole,
  requireEditorRole,
  getCrmSession,
  VELAMIA_ID,
  isPasswordValid,
  weakMasterPassword,
  issueSessionToken,
  verifyWebhookSignature
} from './middleware/auth';
import { sendTextMessage, sendImageMessage, sendAudioMessage, getSentMessageId, describeWhatsAppError } from './services/whatsapp';
import { startFollowUpScheduler } from './services/followups';
import { getTodaySummary, getListOverview, getConversationSummary } from './services/crmOverview';
import { planTurn } from './services/openai';
import {
  markConversationRead,
  setConversationTags,
  setConversationStatus,
  addConversationNote,
  deleteConversationNote,
  addConversationTask,
  setConversationTaskDone,
  deleteConversationTask
} from './db';
import { testBusinessCredentials, startHealthCheck, runHealthCheck } from './services/health';
import { loadBusinessProfile, saveBusinessProfile, profile, publicProfile, normalizeProfile, PROFILE_PRESETS, findPackaging, usesProductUnits, usesGenderTagging } from './config/businessProfile';

const app = express();
const PORT = process.env.PORT || 3000;

// Render pone un proxy delante: sin esto todas las peticiones parecerían venir de la misma IP.
app.set('trust proxy', 1);

app.disable('x-powered-by');

/**
 * Cabeceras de seguridad. La política de contenido deja cargar scripts solo del propio servidor y de unpkg (React y
 * Babel, con huella verificada), y conectar solo con el propio servidor: aunque alguien lograra meter código en la
 * pantalla, no podría enviar las sesiones a otro sitio. Tampoco se puede mostrar el CRM dentro de otra página.
 */
// Solo el almacenamiento de fotos de este proyecto, no cualquier proyecto de Supabase.
const STORAGE_ORIGIN = (() => {
  try { return new URL(process.env.SUPABASE_URL || '').origin; } catch { return 'https://*.supabase.co'; }
})();

// El CRM se traduce al arrancar (ver crmBuild): así la página no necesita código en línea ni evaluado. Si la traducción
// fallara, se sirve como antes (Babel en el navegador) y solo entonces se permiten.
const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
let builtCrm: BuiltCrm | null = null;
try {
  builtCrm = buildCrm(readFileSync(path.join(DASHBOARD_DIR, 'index.html'), 'utf8'));
  console.log(`🧩 CRM preparado en el servidor (versión ${builtCrm.version})`);
} catch (error: any) {
  console.error('⚠️ No se pudo preparar el CRM; se sirve con Babel en el navegador:', error.message);
}
const SCRIPT_SOURCES = builtCrm?.strictScripts
  ? "script-src 'self' https://unpkg.com"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  SCRIPT_SOURCES,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${STORAGE_ORIGIN}`,
  `media-src 'self' blob: ${STORAGE_ORIGIN}`,
  "font-src 'self' data:",
  `connect-src 'self' https://unpkg.com ${STORAGE_ORIGIN}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  next();
});

// El raw body es necesario para validar la firma HMAC que envía Meta. Solo las rutas que reciben fotos o audios
// aceptan cuerpos grandes; el resto (incluido el ingreso y el registro, que son públicos) tiene un límite chico.
const keepRawBody = (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; };
const bigJson = express.json({ limit: '15mb', verify: keepRawBody });
const smallJson = express.json({ limit: '1mb', verify: keepRawBody });
const BIG_BODY_PATHS = new Set(['/api/upload-image', '/api/send-image', '/api/send-audio']);
app.use((req: Request, res: Response, next: NextFunction) => (BIG_BODY_PATHS.has(req.path) ? bigJson : smallJson)(req, res, next));

// La app instalable es de la plataforma (Nexly), igual para todas las empresas: la marca de cada empresa
// se ve recién dentro de su cuenta.
app.get('/crm/manifest.json', (_req: Request, res: Response) => {
  res.json({
    name: 'Nexly',
    short_name: 'Nexly',
    description: 'Nexly · CRM y asistentes de WhatsApp para empresas',
    start_url: '/crm/index.html',
    scope: '/crm/',
    display: 'standalone',
    background_color: '#F3F6FD',
    theme_color: '#4F5BD5',
    orientation: 'portrait',
    icons: [
      { src: 'nexly-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'nexly-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'nexly-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  });
});

app.get(['/crm/', '/crm/index.html'], (_req: Request, res: Response, next: NextFunction) => {
  if (!builtCrm) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(builtCrm.html);
});
// El nombre lleva la versión (app.js?v=...): cada publicación cambia la dirección y el navegador nunca usa una vieja.
app.get('/crm/app.js', (_req: Request, res: Response, next: NextFunction) => {
  if (!builtCrm) return next();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('application/javascript').send(builtCrm.js);
});

// Sin esto el navegador se queda con la versión vieja del CRM después de publicar cambios.
app.use('/crm', express.static(DASHBOARD_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.get('/', (_req: Request, res: Response) => res.redirect('/crm/'));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rechaza ids mal formados antes de consultar la base. */
function requireUuidParam(req: Request, res: Response, next: NextFunction) {
  if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
  next();
}

// ---------- WhatsApp ----------

app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Token inválido');
  }
});

app.post('/webhook', verifyWebhookSignature, (req: Request, res: Response) => {
  const data = req.body;

  // Meta exige respuesta en pocos segundos; transcribir audio o analizar fotos tarda más,
  // así que se confirma primero y el procesamiento sigue en segundo plano.
  res.status(200).send('EVENT_RECEIVED');

  // Instagram y la página de Facebook llegan por la misma dirección, con su propio formato.
  if (data?.object === 'page' || data?.object === 'instagram') {
    handleSocialWebhook(data).catch(error => console.error('Error procesando aviso de Instagram/Facebook:', error));
    return;
  }

  if (data?.object !== 'whatsapp_business_account') return;

  // Un mismo aviso de Meta puede traer varios mensajes: se procesan todos.
  for (const entry of data.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      for (const echo of value?.message_echoes || []) {
        handleEchoMessage(echo, value);
      }
      for (const message of value?.messages || []) {
        handleWebhookMessage(message, value).catch(error => {
          console.error('Error procesando mensaje:', error);
        });
      }
    }
  }
});

/** Conecta la página de Facebook (y su Instagram) para que Meta envíe mensajes y comentarios. Solo VELAMIA por ahora. */
app.post('/api/me/connect-social', requireCrmSession, requireOwnerRole, async (_req: Request, res: Response) => {
  if (currentTenant()) return res.status(400).json({ error: 'Instagram y Facebook todavía no están disponibles para esta empresa' });
  try {
    res.json({ success: true, detail: await subscribePage() });
  } catch (error: any) {
    res.status(500).json({ error: error.response?.data?.error?.message || error.message });
  }
});

// ---------- Conectar Facebook e Instagram desde el CRM ----------

const metaRedirectUri = () =>
  `${(process.env.RENDER_EXTERNAL_URL || 'https://whatsapp-assistant-velamia.onrender.com').replace(/\/$/, '')}/api/meta/callback`;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function metaResultPage(ok: boolean, lines: string[]) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar con Facebook</title>
<style>body{font-family:system-ui,sans-serif;background:#F5F6FB;color:#1B2140;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.card{background:#fff;border-radius:16px;padding:28px;max-width:440px;box-shadow:0 8px 30px rgba(20,30,80,.08)}h1{font-size:20px;margin:0 0 12px}p{margin:6px 0;line-height:1.5}</style></head>
<body><div class="card"><h1>${ok ? '✅ Conectado' : '⚠️ No se pudo conectar'}</h1>${lines.map(l => `<p>${escapeHtml(l)}</p>`).join('')}
<p style="margin-top:16px;color:#6B7599">Ya puedes cerrar esta ventana y volver al CRM.</p></div></body></html>`;
}

app.get('/api/meta/connect-url', requireCrmSession, requireOwnerRole, async (_req: Request, res: Response) => {
  // Las demás empresas conectan su página solo para publicar (servicio adicional); los mensajes siguen siendo de VELAMIA.
  if (currentTenant() && !hasAddon('publicaciones')) return res.status(400).json({ error: 'Instagram y Facebook todavía no están disponibles para esta empresa' });
  try {
    res.json({ url: await connectUrl(metaRedirectUri(), createConnectState()) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Facebook devuelve aquí a quien aceptó los permisos. No lleva la sesión del CRM: la protege el sello de un solo uso.
app.get('/api/meta/callback', async (req: Request, res: Response) => {
  if (req.query.error) {
    return res.status(400).send(metaResultPage(false, ['Se canceló la conexión en Facebook. Vuelve a intentarlo desde el CRM y acepta todos los permisos.']));
  }
  const businessId = readConnectState(req.query.state);
  if (!businessId) {
    return res.status(400).send(metaResultPage(false, ['El enlace venció o ya se usó. Vuelve a presionar "Conectar con Facebook" en el CRM.']));
  }
  try {
    // El sello dice de qué empresa era: la conexión se guarda en esa empresa y en ninguna otra.
    const tenant = businessId === VELAMIA_ID ? undefined : await loadTenant(businessId);
    if (businessId !== VELAMIA_ID && !tenant) {
      return res.status(404).send(metaResultPage(false, ['La empresa no existe o está suspendida.']));
    }
    const result = await runWithTenant(tenant || undefined, () => completeConnection(String(req.query.code || ''), metaRedirectUri()));
    const lines = [`Página de Facebook: ${result.pageName}`];
    lines.push(result.instagramUsername ? `Instagram: @${result.instagramUsername}` : 'Instagram: esta página no tiene una cuenta de Instagram profesional conectada.');
    if (result.subscribed === false) lines.push('Aviso: la página no quedó suscrita a la App; revisa el estado en el CRM.');
    res.send(metaResultPage(true, lines));
  } catch (error: any) {
    console.error('❌ Error conectando con Facebook:', error.response?.data || error.message);
    res.status(500).send(metaResultPage(false, [error.response?.data?.error?.message || error.message]));
  }
});

app.get('/api/meta/status', requireCrmSession, async (_req: Request, res: Response) => {
  res.json(await socialStatus().catch(() => ({ estado: 'no se pudo revisar' })));
});

// ---------- Publicaciones en redes (servicio adicional) ----------

const ADDONS = ['publicaciones'];
const CAPTION_LIMIT = 2200; // Instagram no acepta textos más largos.

function requirePublishing(_req: Request, res: Response, next: NextFunction) {
  if (hasAddon('publicaciones')) return next();
  res.status(403).json({ error: 'Publicaciones en redes es un servicio adicional: pide que lo activen para tu empresa.', code: 'ADDON_REQUIRED' });
}

function requirePostId(req: Request, res: Response, next: NextFunction) {
  if (!UUID_PATTERN.test(req.params.postId || '')) return res.status(400).json({ error: 'Publicación inválida' });
  next();
}

/** Productos del catálogo por nombre exacto: una publicación nunca muestra algo que no está en el catálogo. */
async function catalogProducts(names: unknown) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('Elige al menos un producto');
  const catalog = await getAllProducts();
  const found = names.slice(0, 10).map(n => catalog.find((c: any) => c.name === String(n) && c.image_url));
  if (found.some(f => !f)) throw new Error('Algún producto no está en el catálogo o no tiene foto');
  return found.map(toPostProduct);
}

function cleanChannels(value: unknown) {
  const channels = Array.isArray(value) ? POST_CHANNELS.filter(c => value.includes(c)) : [];
  if (channels.length === 0) throw new Error('Elige al menos una red donde publicar');
  return channels;
}

app.get('/api/posts', requireCrmSession, async (req: Request, res: Response) => {
  // Sin el servicio se responde igual: el CRM muestra qué ofrece y cómo pedirlo.
  if (!hasAddon('publicaciones')) return res.json({ enabled: false });
  try {
    const now = Date.now();
    const from = new Date(Number.isFinite(Date.parse(String(req.query.from))) ? String(req.query.from) : now - 30 * 86_400_000).toISOString();
    const to = new Date(Number.isFinite(Date.parse(String(req.query.to))) ? String(req.query.to) : now + 60 * 86_400_000).toISOString();
    const [posts, saved, status] = await Promise.all([
      listPosts(from, to),
      getSavedSettings(),
      publishingStatus().catch(error => ({ connected: false, error: error.message }))
    ]);
    res.json({ enabled: true, posts, settings: saved || DEFAULT_SETTINGS, settingsSaved: !!saved, status, timezone: profile().business.timezone });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/posts/settings', requireCrmSession, requireOwnerRole, requirePublishing, async (req: Request, res: Response) => {
  try {
    const settings = await saveSettings(req.body);
    // Al encender el modo automático la IA programa de una vez los próximos 7 días (no espera a la revisión de cada hora).
    const created = settings.autoPlan ? await planUpcomingPosts(new Date(), 7, settings) : [];
    res.json({ settings, created: created.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Prepara los próximos 7 días con la configuración guardada (o la de siempre si aún no se guardó). */
app.post('/api/posts/plan', requireCrmSession, requireEditorRole, requirePublishing, async (_req: Request, res: Response) => {
  try {
    const created = await planUpcomingPosts(new Date(), 7, (await getSavedSettings()) || DEFAULT_SETTINGS);
    res.json({ created });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/posts', requireCrmSession, requireEditorRole, requirePublishing, async (req: Request, res: Response) => {
  try {
    const when = new Date(String(req.body?.scheduled_at || ''));
    if (!Number.isFinite(when.getTime())) return res.status(400).json({ error: 'Elige el día y la hora' });
    if (when.getTime() < Date.now() - 2 * 60 * 1000) return res.status(400).json({ error: 'Esa hora ya pasó: elige otra (o créala y usa "Publicar ahora")' });
    let caption = String(req.body?.caption || '').trim();
    if (caption.length > CAPTION_LIMIT) return res.status(400).json({ error: `El texto pasa de ${CAPTION_LIMIT} caracteres` });
    const products = await catalogProducts(req.body?.products);
    const channels = cleanChannels(req.body?.channels);
    const theme = String(req.body?.theme || '').trim().slice(0, 80) || 'Nuestros productos';
    // Sin texto, lo escribe la IA; si no responde, va el texto de respaldo (siempre se puede cambiar antes de que salga).
    if (!caption) {
      const draft = { theme, products } as any;
      caption = await rewriteCaption(draft, ((await getSavedSettings()) || DEFAULT_SETTINGS).notes).catch(() => fallbackCaption(draft));
    }
    const [post] = await insertPosts([{
      // Queda programada: se publica sola a esa hora, sin pedir aprobación.
      scheduled_at: when.toISOString(), status: 'approved', channels, caption, products, theme, results: {}, error: null
    }]);
    // La publicación trae su propio campo "error" (motivo de un fallo): va envuelta para que el CRM no lo tome como error de la petición.
    res.status(201).json({ post });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/posts/:postId', requireCrmSession, requireEditorRole, requirePublishing, requirePostId, async (req: Request, res: Response) => {
  try {
    const post = await getPost(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
    if (!EDITABLE_STATUSES.includes(post.status)) return res.status(400).json({ error: 'Esta publicación ya no se puede cambiar' });

    const changes: Record<string, any> = {};
    if (req.body?.caption !== undefined) {
      changes.caption = String(req.body.caption).trim();
      if (changes.caption.length > CAPTION_LIMIT) return res.status(400).json({ error: `El texto pasa de ${CAPTION_LIMIT} caracteres` });
    }
    if (req.body?.scheduled_at !== undefined) {
      const when = new Date(String(req.body.scheduled_at));
      if (!Number.isFinite(when.getTime())) return res.status(400).json({ error: 'Fecha inválida' });
      changes.scheduled_at = when.toISOString();
    }
    if (req.body?.channels !== undefined) changes.channels = cleanChannels(req.body.channels);
    if (req.body?.products !== undefined) changes.products = await catalogProducts(req.body.products);
    if (req.body?.status !== undefined) {
      const status = String(req.body.status) as PostStatus;
      if (!['draft', 'approved', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
      changes.status = status;
    }

    // Cambiar una publicación la deja programada otra vez (también a una que falló) si su hora es futura.
    if (changes.status === undefined && post.status !== 'approved' && new Date(changes.scheduled_at || post.scheduled_at).getTime() > Date.now()) {
      changes.status = 'approved';
    }
    const final = { ...post, ...changes };
    if (final.status === 'approved') {
      if (!final.caption && final.channels.some((c: PostChannel) => c !== 'instagram_story')) return res.status(400).json({ error: 'Escribe el texto de la publicación' });
      // Programar algo con hora pasada lo publicaría de golpe: para eso está "Publicar ahora".
      if (new Date(final.scheduled_at).getTime() < Date.now()) return res.status(400).json({ error: 'La hora ya pasó: elige otra o usa "Publicar ahora"' });
      changes.error = null;
    }
    const updated = await updatePost(post.id, changes, EDITABLE_STATUSES);
    if (!updated) return res.status(409).json({ error: 'La publicación cambió mientras la editabas; recarga' });
    res.json({ post: updated });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/posts/:postId/publish', requireCrmSession, requireEditorRole, requirePublishing, requirePostId, async (req: Request, res: Response) => {
  try {
    const post = await getPost(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
    if (!post.caption.trim() && post.channels.some(c => c !== 'instagram_story')) return res.status(400).json({ error: 'Escribe el texto antes de publicar' });
    const done = await claimAndPublish(post, EDITABLE_STATUSES);
    if (!done) return res.status(409).json({ error: 'Esta publicación ya se está publicando o ya salió' });
    res.json({ post: done });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Elimina una publicación que todavía no salió: desaparece del calendario y su día queda libre. */
app.delete('/api/posts/:postId', requireCrmSession, requireEditorRole, requirePublishing, requirePostId, async (req: Request, res: Response) => {
  try {
    if (!(await deletePost(req.params.postId))) return res.status(409).json({ error: 'Esta publicación ya salió o se está publicando: no se puede eliminar' });
    res.json({ deleted: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Otro texto hecho por la IA; no se guarda hasta que la empresa lo acepte. */
app.post('/api/posts/:postId/rewrite', requireCrmSession, requireEditorRole, requirePublishing, requirePostId, async (req: Request, res: Response) => {
  try {
    const post = await getPost(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
    const settings = (await getSavedSettings()) || DEFAULT_SETTINGS;
    res.json({ caption: await rewriteCaption(post, settings.notes) });
  } catch (error: any) {
    const noCredits = /credit|quota/i.test(error.message);
    res.status(500).json({ error: noCredits ? 'La IA no tiene créditos en OpenAI: escribe el texto a mano o recarga créditos.' : `No se pudo escribir otro texto: ${error.message}` });
  }
});

// ---------- Salud ----------

app.get('/health', async (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    // Solo indica si la configuración existe, nunca su valor.
    followups: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ? 'activo' : 'falta WHATSAPP_BUSINESS_ACCOUNT_ID',
    // Público: solo el estado. Permisos, cuenta y vencimiento se ven en el CRM (/api/meta/status, con sesión).
    instagram_messenger: (await socialStatus().catch(() => ({ estado: 'no se pudo revisar' }))).estado
  });
});

// ---------- Acceso al CRM ----------

// Límite de intentos fallidos por IP para que no se pueda adivinar la contraseña a la fuerza.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();
// Intentos fallidos por cuenta (desde cualquier IP) y un tope general para "admin": frena a quien pruebe desde muchas IP.
const ACCOUNT_MAX_FAILURES = 10;
const ADMIN_MAX_FAILURES_PER_HOUR = 30;
const accountFailures = new Map<string, { count: number; resetAt: number }>();
function accountBlocked(username: string, now: number): boolean {
  const record = accountFailures.get(username);
  if (!record) return false;
  if (record.resetAt < now) { accountFailures.delete(username); return false; }
  return record.count >= (username === 'admin' ? ADMIN_MAX_FAILURES_PER_HOUR : ACCOUNT_MAX_FAILURES);
}
function countAccountFailure(username: string, now: number) {
  const record = accountFailures.get(username);
  const windowMs = username === 'admin' ? 60 * 60 * 1000 : LOGIN_WINDOW_MS;
  if (!record || record.resetAt < now) accountFailures.set(username, { count: 1, resetAt: now + windowMs });
  else record.count++;
}

/**
 * Una sola pantalla de ingreso: usuario "admin" con la contraseña maestra para la administradora;
 * correo y contraseña para los usuarios de cada empresa, que solo ven la suya.
 */
app.post('/api/login', async (req: Request, res: Response) => {
  if (!process.env.CRM_PASSWORD) {
    return res.status(503).json({ error: 'Falta configurar la variable CRM_PASSWORD en el servidor' });
  }

  const ip = req.ip || 'desconocida';
  const now = Date.now();
  const record = loginFailures.get(ip);
  if (record && record.resetAt < now) loginFailures.delete(ip);

  const current = loginFailures.get(ip);
  if (current && current.count >= LOGIN_MAX_FAILURES) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' });
  }

  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const fail = () => {
    loginFailures.set(ip, { count: (current?.count || 0) + 1, resetAt: current?.resetAt || now + LOGIN_WINDOW_MS });
    if (username) countAccountFailure(username, now);
    res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  };

  if (!username) return fail();
  if (accountBlocked(username, now)) {
    console.warn(`🔒 Ingreso bloqueado temporalmente por demasiados intentos: ${username === 'admin' ? 'admin' : 'usuario de empresa'}`);
    return res.status(429).json({ error: 'Demasiados intentos con esta cuenta. Espera un rato e intenta de nuevo.' });
  }

  // Administradora: usuario "admin" con la contraseña maestra.
  if (username === 'admin') {
    if (!isPasswordValid(password)) return fail();
    loginFailures.delete(ip);
    accountFailures.delete(username);
    return res.json({ token: issueSessionToken(), role: 'admin' });
  }

  try {
    const user = await authenticateBusinessUser(username, password);
    if (!user) return fail();
    loginFailures.delete(ip);
    accountFailures.delete(username);
    res.json({ token: issueSessionToken(user), role: user.role, businessId: user.businessId });
  } catch (error: any) {
    console.error('Error validando acceso:', error.message);
    res.status(500).json({ error: 'No se pudo validar el acceso, intenta de nuevo' });
  }
});

/** La administradora crea un código de registro (por ahora a mano; después lo generará solo el pago aprobado). */
app.post('/api/signup-codes', requireAdminSession, async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.body?.days) || 30, 1), 365);
    const entry = await createSignupCode(days);
    console.log('🎟️ Código de registro creado');
    res.status(201).json(entry);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Registro de una empresa nueva por su cuenta: crea la empresa con la plantilla que eligió, su usuario dueño y la deja
 * dentro del CRM. El bot no atiende a nadie hasta que conecte su número de WhatsApp.
 */
const SIGNUP_MAX_PER_HOUR = 3;
const signupsByIp = new Map<string, number[]>();
// Códigos que se están canjeando en este momento: dos registros simultáneos con el mismo código no pasan ambos.
const redeemingCodes = new Set<string>();

app.post('/api/signup', async (req: Request, res: Response) => {
  // Campo trampa: las personas no lo ven ni lo llenan, los programas automáticos sí.
  if (req.body?.website) return res.status(201).json({ ok: true });

  const ip = req.ip || 'desconocida';
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = (signupsByIp.get(ip) || []).filter(at => at > hourAgo);
  if (recent.length >= SIGNUP_MAX_PER_HOUR) return res.status(429).json({ error: 'Demasiados registros desde este lugar. Intenta más tarde.' });

  // Solo se registra quien ya pagó su mensualidad: el código se entrega al pagar.
  const signupCode = String(req.body?.code || '');
  const codeKey = signupCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!codeKey || redeemingCodes.has(codeKey) || !(await isSignupCodeUsable(signupCode))) {
    return res.status(403).json({ error: 'Necesitas un código de registro válido. Lo recibes al pagar tu mensualidad.' });
  }
  redeemingCodes.add(codeKey);
  res.on('finish', () => redeemingCodes.delete(codeKey));

  const businessName = String(req.body?.businessName || '').trim().slice(0, 80);
  const fullName = String(req.body?.fullName || '').trim().slice(0, 80);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (businessName.length < 2) return res.status(400).json({ error: 'Escribe el nombre de tu negocio' });
  if (fullName.length < 2) return res.status(400).json({ error: 'Escribe tu nombre' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Escribe un correo válido' });

  let businessId = '';
  try {
    const preset = PROFILE_PRESETS[String(req.body?.preset || 'tienda')] || PROFILE_PRESETS.tienda;
    const base = normalizeProfile(preset.profile, preset.profile);
    const profile = normalizeProfile({ ...base, business: { ...base.business, name: businessName } }, base);

    const business = await createBusiness(businessName, profile);
    businessId = business.id;
    try {
      const user = await createBusinessUser(business.id, email, fullName, 'owner', password);
      signupsByIp.set(ip, [...recent, Date.now()]);
      await useSignupCode(signupCode, business.id);
      console.log(`🆕 Empresa nueva por registro propio: ${businessName} (${email})`);
      res.status(201).json({ token: issueSessionToken({ userId: user.id, businessId: business.id }), role: 'owner', businessId: business.id });
    } catch (error) {
      // Sin dueño la empresa quedaría huérfana: se deshace.
      await deleteBusinessCompletely(business.id).catch(() => {});
      throw error;
    }
  } catch (error: any) {
    console.error('Error en registro:', error.message);
    const message = String(error.message || error);
    if (/ya existe/.test(message)) return res.status(409).json({ error: 'Ese correo ya tiene una cuenta. Inicia sesión.' });
    if (/contraseña debe/.test(message)) return res.status(400).json({ error: message });
    res.status(500).json({ error: 'No se pudo crear la cuenta, intenta de nuevo' });
  }
});

// ---------- Perfil del negocio ----------

app.get('/api/business-profile', requireCrmSession, (_req: Request, res: Response) => {
  res.json(publicProfile());
});

app.get('/api/business-profile/presets', requireCrmSession, (_req: Request, res: Response) => {
  res.json(Object.entries(PROFILE_PRESETS).map(([id, preset]) => ({ id, label: preset.label, profile: publicProfile(preset.profile) })));
});

// Prueba real del asistente: pasa un mensaje de cliente por el mismo camino que un chat de verdad (planTurn) y devuelve
// lo que respondería. No envía nada por WhatsApp ni guarda mensajes; sí gasta tokens de la clave de OpenAI del negocio.
const previewLastAt = new Map<string, number>();
const PREVIEWS_PER_DAY = 60;
const previewsToday = new Map<string, { day: string; count: number }>();

app.post('/api/business-profile/preview', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const businessKey = currentTenant()?.businessId ?? 'velamia';
    if (Date.now() - (previewLastAt.get(businessKey) || 0) < 4000) {
      return res.status(429).json({ error: 'Espera unos segundos entre pruebas' });
    }
    previewLastAt.set(businessKey, Date.now());
    // Las pruebas gastan la IA de la plataforma: un tope diario por empresa evita abusos.
    const day = new Date().toISOString().slice(0, 10);
    const used = previewsToday.get(businessKey);
    const count = used?.day === day ? used.count : 0;
    if (count >= PREVIEWS_PER_DAY) return res.status(429).json({ error: 'Llegaste al límite de pruebas de hoy. Mañana puedes seguir probando.' });
    previewsToday.set(businessKey, { day, count: count + 1 });

    const message = String(req.body?.message || 'Hola').trim().slice(0, 300) || 'Hola';
    // Con el perfil que la persona tiene en pantalla (aunque no lo haya guardado), para probar antes de aplicar cambios.
    const testProfile = req.body?.profile && typeof req.body.profile === 'object' ? normalizeProfile(req.body.profile, profile()) : profile();
    const [catalog, customPrompt] = await Promise.all([getAllProducts(), getConfig('system_prompt')]);

    const plan = await planTurn({ history: [], userMessage: message, catalog, customPrompt, sentProducts: [], profile: testProfile });
    res.json({
      reply: plan.reply,
      photos: plan.show_products,
      intent: plan.intent,
      handoff: plan.handoff,
      ownerQuestion: plan.owner_question,
      sendBankDetails: plan.send_bank_details,
      orderTotal: plan.order_total
    });
  } catch (error: any) {
    console.error('❌ Prueba del asistente:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/business-profile', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Perfil inválido' });
    const saved = await saveBusinessProfile(req.body);
    console.log(`🏪 Perfil del negocio actualizado: ${saved.business.name}`);
    res.json(publicProfile(saved));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Conversaciones ----------
// Supabase bloquea el acceso directo del navegador (RLS), así que el CRM lee por aquí.

app.get('/api/conversations', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getAllConversations());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id/messages', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
  try {
    // El chat debe ser del negocio en que se trabaja: los mensajes no llevan business_id propio.
    if (!(await getConversationById(req.params.id))) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json(await getMessages(req.params.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Elimina el chat por completo: mensajes, cotizaciones, pedidos, seguimientos, avisos
 * y los archivos que envió el cliente.
 */
app.delete('/api/conversations/:id', requireCrmSession, requireUuidParam, requireOwnerRole, async (req: Request, res: Response) => {
  try {
    const conv = await getConversationById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    const { mediaUrls } = await deleteConversationCompletely(req.params.id);
    forgetConversation(conv.phone_number, conv.id);

    // Si falla el borrado de archivos, los datos ya se eliminaron: se registra sin revertir.
    let filesRemoved = 0;
    try {
      filesRemoved = await removeFilesByPublicUrls(mediaUrls);
    } catch (error: any) {
      console.error('No se pudieron borrar archivos del chat:', error.message);
    }

    console.log(`🗑️ Chat ${maskPhone(conv.phone_number)} eliminado (${filesRemoved} archivo(s))`);
    res.json({ success: true, filesRemoved });
  } catch (error: any) {
    console.error('Error eliminando chat:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** Pausa el bot en una conversación. Sin "minutes" queda pausado hasta reactivarlo. */
app.post('/api/conversations/:id/pause', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await getConversationById(req.params.id))) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const minutes = Number(req.body?.minutes);
    const validMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 60 * 24 * 30) : undefined;
    await pauseBot(req.params.id, validMinutes);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/:id/resume', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await getConversationById(req.params.id))) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    await resumeBot(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    const [conversations, metrics] = await Promise.all([getAllConversations(), getSalesMetrics(365)]);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

    res.json({
      total: conversations.length,
      active: conversations.filter((c: any) => c.last_message_time && parseDbTimestamp(c.last_message_time).getTime() > dayAgo).length,
      orders: metrics.totalOrders,
      revenue: metrics.totalRevenue,
      // El CRM lo consulta seguido: si la IA está fallando (sin créditos) lo muestra arriba bien visible.
      aiProblem: currentAiProblem()
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Vistas del CRM: resumen de hoy, lista de chats y resumen del cliente ----------

app.get('/api/crm/today', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getTodaySummary());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/crm/list-overview', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getListOverview());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id/summary', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
  try {
    const summary = await getConversationSummary(req.params.id);
    if (!summary) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json(summary);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Vistas del CRM, fase 2: leído, etiquetas, cerrar chat, notas y próximas acciones ----------

/** Quién hace el cambio, para mostrarlo en notas y acciones. */
async function crmAuthor(req: Request): Promise<string> {
  const session = getCrmSession(req);
  if (session.role === 'admin') return 'Administradora';
  try {
    const user = session.userId ? await getBusinessUser(session.userId) : null;
    if (user?.full_name) return user.full_name;
  } catch {
    // sin nombre: se usa el genérico
  }
  return 'Equipo';
}

/** El chat debe ser del negocio en que se trabaja; si no, responde 404 y devuelve false. */
async function ownsConversation(req: Request, res: Response): Promise<boolean> {
  if (await getConversationById(req.params.id)) return true;
  res.status(404).json({ error: 'Conversación no encontrada' });
  return false;
}

function requireUuidTaskParam(req: Request, res: Response, next: NextFunction) {
  const value = req.params.noteId ?? req.params.taskId;
  if (!UUID_PATTERN.test(String(value))) return res.status(400).json({ error: 'Id inválido' });
  next();
}

app.post('/api/conversations/:id/read', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
  try {
    if (!(await ownsConversation(req, res))) return;
    await markConversationRead(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/conversations/:id/tags', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await ownsConversation(req, res))) return;
    const raw: unknown[] = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const item of raw) {
      const tag = String(item ?? '').trim().slice(0, 24);
      if (tag && !seen.has(tag.toLowerCase())) {
        seen.add(tag.toLowerCase());
        tags.push(tag);
      }
    }
    await setConversationTags(req.params.id, tags.slice(0, 8));
    res.json({ success: true, tags: tags.slice(0, 8) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/conversations/:id/status', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await ownsConversation(req, res))) return;
    const status = req.body?.status === 'closed' ? 'closed' : 'active';
    await setConversationStatus(req.params.id, status);
    res.json({ success: true, status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/:id/notes', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await ownsConversation(req, res))) return;
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Escribe la nota' });
    if (content.length > 1000) return res.status(400).json({ error: 'La nota no puede superar 1000 caracteres' });
    res.json(await addConversationNote(req.params.id, await crmAuthor(req), content));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/conversations/:id/notes/:noteId', requireCrmSession, requireUuidParam, requireUuidTaskParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await ownsConversation(req, res))) return;
    await deleteConversationNote(req.params.id, req.params.noteId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/:id/tasks', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await ownsConversation(req, res))) return;
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Escribe qué hay que hacer' });
    if (title.length > 160) return res.status(400).json({ error: 'La acción no puede superar 160 caracteres' });
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.dueDate || '')) ? String(req.body.dueDate) : null;
    res.json(await addConversationTask(req.params.id, title, dueDate, await crmAuthor(req)));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/conversations/:id/tasks/:taskId', requireCrmSession, requireUuidParam, requireUuidTaskParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await ownsConversation(req, res))) return;
    await setConversationTaskDone(req.params.id, req.params.taskId, !!req.body?.done);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/conversations/:id/tasks/:taskId', requireCrmSession, requireUuidParam, requireUuidTaskParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    if (!(await ownsConversation(req, res))) return;
    await deleteConversationTask(req.params.id, req.params.taskId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Cotizaciones ----------

app.get('/api/quotations', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getAllQuotations());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/quotations/:id', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const { status } = req.body || {};
    if (!['pending', 'sent', 'accepted', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const updated = await updateQuotationStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Cotización hecha a mano desde el CRM para un chat: se calcula igual que las del asistente. */
app.post('/api/quotations', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const conv = await conversationForSending(req, res);
    if (!conv) return;
    const sale = buildSale(req.body || {}, await getAllProducts());
    const quotation = await createQuotation(conv.id, conv.phone_number, sale.products, sale.total);
    res.status(201).json({ ...quotation, packagingPending: sale.packagingPending });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

/** Cambia productos, cantidades, ciudad o nombre de la clienta; el total se vuelve a calcular. */
app.put('/api/quotations/:id', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const current = await getQuotationById(req.params.id);
    if (!current) return res.status(404).json({ error: 'Cotización no encontrada' });
    if (req.body?.items !== undefined) {
      const sale = buildSale(req.body, await getAllProducts());
      await updateQuotationItems(current.id, sale.products, sale.total);
      // Cambiarla le da 3 días más de validez: una vencida vuelve a quedar pendiente.
      if (current.status === 'expired') await updateQuotationStatus(current.id, 'pending');
    }
    if (typeof req.body?.customer_name === 'string') await updateQuotationCustomer(current.id, req.body.customer_name.trim().slice(0, 120));
    res.json(await getQuotationById(current.id));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * Le envía la cotización a la clienta con las fotos de los productos, por su chat (WhatsApp, Instagram o Messenger) o por
 * otro chat que se elija. Como todo mensaje escrito desde el CRM, pausa el bot en ese chat.
 */
app.post('/api/quotations/:id/send', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const quotation = await getQuotationById(req.params.id);
    if (!quotation) return res.status(404).json({ error: 'Cotización no encontrada' });
    const targetId = String(req.body?.conversationId || quotation.conversation_id);
    if (!UUID_PATTERN.test(targetId)) return res.status(400).json({ error: 'Conversación inválida' });
    const conv = await getConversationById(targetId);
    if (!conv) return res.status(404).json({ error: 'El chat de esta cotización ya no existe' });
    let products: any[] = [];
    try {
      products = typeof quotation.products === 'string' ? JSON.parse(quotation.products) : (quotation.products || []);
    } catch {
      products = [];
    }
    const delivery = quotationDelivery(products, Number(quotation.total_amount || 0), await getAllProducts());
    await pauseBot(conv.id);
    // Una foto que no se pueda enviar no frena la cotización: el texto con el total siempre sale.
    let photosSent = 0;
    for (const photo of delivery.photos) {
      try {
        const sent = await sendImageMessage(conv.phone_number, photo.url, photo.caption);
        await saveMessage(conv.id, 'human', 'image', `${photo.url}
${photo.caption}`, getSentMessageId(sent));
        photosSent++;
      } catch (error: any) {
        console.warn('Foto de la cotización no enviada:', error.response?.data?.error?.message || error.message);
      }
    }
    const text = delivery.text ?? (photosSent === 0 ? delivery.fullText : null);
    if (text) {
      const sent = await sendTextMessage(conv.phone_number, text);
      await saveMessage(conv.id, 'human', 'text', text, getSentMessageId(sent));
    }
    if (quotation.status !== 'accepted') await updateQuotationStatus(quotation.id, 'sent');
    res.json({ success: true, bot_paused: true, quotation: await getQuotationById(quotation.id) });
  } catch (error: any) {
    console.error('Error enviando cotización:', error.response?.data || error.message);
    res.status(500).json({ error: describeWhatsAppError(error) });
  }
});

// ---------- Pedidos ----------

/** Pedido registrado a mano desde un chat (por ejemplo, la clienta confirmó con una persona del equipo). */
app.post('/api/orders', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const conv = await conversationForSending(req, res);
    if (!conv) return;
    const sale = buildSale(req.body || {}, await getAllProducts());
    const order = await createOrder(conv.id, conv.phone_number, conv.customer_name || '', sale.products, sale.total, sale.delivery || undefined, sale.place || undefined);
    res.status(201).json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/orders', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getAllOrders());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// La dueña marca el avance del pedido; el bot lo usa para responder "¿cómo va mi pedido?".
app.patch('/api/orders/:id', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const { status } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const updated = await updateOrderStatus(req.params.id, status as OrderStatus);
    if (!updated) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Mensajería manual ----------

/** El número se toma del chat guardado, nunca del navegador: así un mensaje no puede ir a otra persona. */
async function conversationForSending(req: Request, res: Response) {
  const conversationId = String(req.body?.conversationId || '');
  if (!UUID_PATTERN.test(conversationId)) {
    res.status(400).json({ error: 'Conversación inválida' });
    return null;
  }
  const conv = await getConversationById(conversationId);
  if (!conv) res.status(404).json({ error: 'Conversación no encontrada' });
  return conv;
}

app.post('/api/send-message', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Escribe un mensaje' });
    if (text.length > 4096) return res.status(400).json({ error: 'WhatsApp no permite mensajes de más de 4096 caracteres' });
    const conv = await conversationForSending(req, res);
    if (!conv) return;
    // Una persona tomó el chat: el bot se calla aquí hasta que lo reactiven desde el CRM. Se pausa ANTES de enviar
    // para que el bot no conteste encima mientras el mensaje viaja.
    await pauseBot(conv.id);
    const sent = await sendTextMessage(conv.phone_number, text);
    await saveMessage(conv.id, 'human', 'text', text, getSentMessageId(sent));
    res.json({ success: true, bot_paused: true });
  } catch (error: any) {
    console.error('Error enviando mensaje manual:', error.response?.data || error.message);
    res.status(500).json({ error: describeWhatsAppError(error) });
  }
});

app.post('/api/send-image', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const { caption, imageBase64 } = req.body || {};
    let imageUrl = String(req.body?.imageUrl || '');
    // Foto elegida desde el computador o el celular: se guarda y se envía. WhatsApp solo acepta JPG o PNG de hasta 5 MB.
    if (imageBase64) {
      const matches = String(imageBase64).match(/^data:(image\/(?:jpeg|jpg|png));base64,(.+)$/);
      if (!matches) return res.status(400).json({ error: 'La foto debe ser JPG o PNG' });
      const buffer = Buffer.from(matches[2], 'base64');
      if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'La foto pesa más de 5 MB; WhatsApp no la podría enviar' });
      imageUrl = await uploadBufferToStorage(buffer, matches[1] === 'image/jpg' ? 'image/jpeg' : matches[1]);
    } else if (!/^https:\/\/\S+$/.test(imageUrl)) {
      return res.status(400).json({ error: 'Elige una foto para enviar' });
    }
    const conv = await conversationForSending(req, res);
    if (!conv) return;
    await pauseBot(conv.id);
    const sent = await sendImageMessage(conv.phone_number, imageUrl, caption);
    await saveMessage(conv.id, 'human', 'image', caption ? `${imageUrl}\n${caption}` : imageUrl, getSentMessageId(sent));
    res.json({ success: true, bot_paused: true });
  } catch (error: any) {
    console.error('Error enviando imagen manual:', error.response?.data || error.message);
    res.status(500).json({ error: describeWhatsAppError(error) });
  }
});

/** Nota de voz grabada en el CRM: se convierte al formato de WhatsApp, se envía y el chat pasa a atención humana. */
app.post('/api/send-audio', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const matches = String(req.body?.audioBase64 || '').match(/^data:audio\/[\w.+-]+(?:;[^,]*)?;base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'No llegó el audio' });
    const original = Buffer.from(matches[1], 'base64');
    if (original.length < 500) return res.status(400).json({ error: 'El audio quedó vacío, graba de nuevo' });
    if (original.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'La nota de voz es demasiado larga' });
    const conv = await conversationForSending(req, res);
    if (!conv) return;
    if (isSocialAddress(conv.phone_number)) return res.status(400).json({ error: 'Las notas de voz por ahora solo se envían por WhatsApp' });
    if (!isRecordedAudio(original)) return res.status(400).json({ error: 'El audio no tiene un formato válido, graba de nuevo' });
    const voice = await toWhatsAppVoice(original);
    const audioUrl = await uploadBufferToStorage(voice, 'audio/ogg');
    await pauseBot(conv.id);
    const sent = await sendAudioMessage(conv.phone_number, audioUrl);
    await saveMessage(conv.id, 'human', 'audio', audioUrl, getSentMessageId(sent));
    res.json({ success: true, bot_paused: true });
  } catch (error: any) {
    console.error('Error enviando nota de voz:', error.response?.data || error.message);
    res.status(500).json({ error: describeWhatsAppError(error) });
  }
});

// ---------- Bot general e instrucciones ----------

app.get('/api/bot-status', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json({ enabled: (await getConfig('bot_enabled')) !== 'false' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bot-status', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
  try {
    const enabled = !!req.body?.enabled;
    await setConfig('bot_enabled', enabled ? 'true' : 'false');
    res.json({ success: true, enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/system-prompt', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json({ prompt: (await getConfig('system_prompt')) || '' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/system-prompt', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
  try {
    await setConfig('system_prompt', String(req.body?.prompt || ''));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Datos de pago ----------
// Los escribe la dueña en el CRM; el bot los envía textuales cuando la clienta elige transferencia.

app.get('/api/payment-info', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json({ transfer: (await getConfig('payment_transfer_info')) || '' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payment-info', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
  try {
    const transfer = String(req.body?.transfer || '').trim();
    if (transfer.length > 1500) {
      return res.status(400).json({ error: 'Los datos bancarios no pueden superar 1500 caracteres' });
    }
    await setConfig('payment_transfer_info', transfer);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Catálogo ----------

// El nombre va entre *asteriscos* en el texto de cada foto y así se reconoce qué modelo se envió:
// un asterisco dentro del nombre rompería esa lectura.
function cleanProductName(value: unknown): string {
  return String(value ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Unidad de venta ("caja de 10", "tubo", "metro"), medida y piezas por unidad de un producto.
 * Al editar solo se tocan los campos enviados; vacíos = el producto usa la unidad del negocio.
 */
function productUnit(body: any, isUpdate = false) {
  const unit: { sale_unit?: string | null; measure?: string | null; pieces_per_unit?: number | null; gender?: string | null } = {};
  const biz = profile();

  // Solo los negocios que venden con unidad propia por producto guardan estos datos.
  if (usesProductUnits(biz)) {
    const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
    if (!isUpdate || body?.sale_unit !== undefined) unit.sale_unit = text(body?.sale_unit);
    if (!isUpdate || body?.measure !== undefined) unit.measure = text(body?.measure);
    if (!isUpdate || body?.pieces_per_unit !== undefined) {
      const pieces = Math.floor(Number(body?.pieces_per_unit));
      unit.pieces_per_unit = Number.isFinite(pieces) && pieces > 1 ? pieces : null;
    }
  }

  // Solo los negocios que marcan niño/niña/neutro (baby shower) guardan este dato.
  if (usesGenderTagging(biz) && (!isUpdate || body?.gender !== undefined)) {
    const g = String(body?.gender ?? '').trim().toLowerCase();
    unit.gender = g === 'niño' || g === 'niña' ? g : null;
  }

  return unit;
}

/** Nombre oficial del empaque (tal como está en el perfil), '' para ninguno, o null si no existe. */
function packagingName(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return findPackaging(value)?.name ?? null;
}

app.post('/api/upload-image', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    // WhatsApp solo envía fotos JPG o PNG de hasta 5 MB: otra foto nunca le llegaría a la clienta.
    const matches = String(req.body?.imageBase64 || '').match(/^data:(image\/(?:jpeg|jpg|png));base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'La foto debe ser JPG o PNG' });
    }

    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'La foto pesa más de 5 MB; WhatsApp no la podría enviar' });
    }

    const contentType = matches[1] === 'image/jpg' ? 'image/jpeg' : matches[1];
    const finalName = storagePath(contentType === 'image/png' ? 'png' : 'jpg');

    const { error } = await supabase.storage.from('product-images').upload(finalName, buffer, { contentType });
    if (error) throw error;

    const { data } = supabase.storage.from('product-images').getPublicUrl(finalName);
    res.json({ url: data.publicUrl });
  } catch (error: any) {
    console.error('Error subiendo imagen:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getAllProducts());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const { name, price, category, image_url, packaging } = req.body || {};
    const parsedPrice = Number(price);

    if (!cleanProductName(name) || !String(category || '').trim() || !Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ error: 'Nombre, categoría y un precio válido son requeridos' });
    }
    const pkg = packagingName(packaging);
    if (pkg === null) return res.status(400).json({ error: 'Ese empaque no está en el perfil del negocio' });
    if (image_url && !/^https:\/\/\S+$/.test(String(image_url))) {
      return res.status(400).json({ error: 'La foto del producto debe ser un enlace https' });
    }

    res.json(await createProduct(
      cleanProductName(name), parsedPrice, String(category).trim().toUpperCase(), image_url || undefined, pkg,
      productUnit(req.body)
    ));
  } catch (error: any) {
    console.error('Error creando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const { name, price, category, image_url, packaging } = req.body || {};
    const updates: Parameters<typeof updateProduct>[1] = { ...productUnit(req.body, true) };

    if (packaging !== undefined) {
      const pkg = packagingName(packaging);
      if (pkg === null) return res.status(400).json({ error: 'Ese empaque no está en el perfil del negocio' });
      updates.description = pkg;
    }

    if (name !== undefined) {
      updates.name = cleanProductName(name);
      if (!updates.name) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    }
    if (category !== undefined) updates.category = String(category).trim().toUpperCase();
    if (image_url !== undefined) {
      if (image_url && !/^https:\/\/\S+$/.test(String(image_url))) {
        return res.status(400).json({ error: 'La foto del producto debe ser un enlace https' });
      }
      updates.image_url = image_url;
    }
    if (price !== undefined) {
      const parsedPrice = Number(price);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({ error: 'Precio inválido' });
      }
      updates.price = parsedPrice;
    }

    const updated = await updateProduct(req.params.id, updates);
    if (!updated) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(updated);
  } catch (error: any) {
    console.error('Error actualizando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:id', requireCrmSession, requireUuidParam, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteProduct(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Producto no encontrado' });

    // La foto se borra solo si ningún otro producto la usa. Si falla, el producto ya se eliminó.
    if (deleted.image_url) {
      try {
        const stillUsed = (await getAllProducts()).some((p: any) => p.image_url === deleted.image_url);
        if (!stillUsed) await removeFilesByPublicUrls([deleted.image_url], 'product-images');
      } catch (error: any) {
        console.error('No se pudo borrar la foto del producto:', error.message);
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error eliminando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------- MULTI-NEGOCIO: ADMINISTRACIÓN (solo contraseña maestra) ----------

/** Valida los ids de empresa y usuario que vienen en la ruta. */
function requireUuidParams(req: Request, res: Response, next: NextFunction) {
  for (const name of ['businessId', 'userId']) {
    const value = req.params[name];
    if (value !== undefined && !UUID_PATTERN.test(value)) return res.status(400).json({ error: `Id inválido (${name})` });
  }
  next();
}

/** Como requireUuidParams, pero la empresa también puede ser VELAMIA (solo para sus usuarios). */
function requireCompanyParams(req: Request, res: Response, next: NextFunction) {
  if (req.params.businessId !== VELAMIA_ID) return requireUuidParams(req, res, next);
  if (req.params.userId !== undefined && !UUID_PATTERN.test(req.params.userId)) {
    return res.status(400).json({ error: 'Id inválido (userId)' });
  }
  next();
}

/** VELAMIA en la plataforma: sus datos siguen guardados como siempre y sus claves están en las variables del servidor. */
function velamiaCompany() {
  return {
    id: VELAMIA_ID,
    name: 'VELAMIA',
    meta_phone_number: '',
    active: true,
    legacy: true,
    // VELAMIA es de la plataforma: tiene todos los servicios adicionales.
    addons: { publicaciones: true },
    whatsapp_configured: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    openai_configured: !!process.env.OPENAI_API_KEY
  };
}

const companyIdOf = (req: Request) => (req.params.businessId === VELAMIA_ID ? null : req.params.businessId);

const ROLES = ['owner', 'manager', 'staff'];

/** Claves que llegan del CRM; se aceptan con los nombres del formulario. */
function credentialsFromBody(body: any): BusinessCredentials {
  const b = body || {};
  return {
    displayPhoneNumber: b.displayPhoneNumber,
    phoneNumberId: b.phoneNumberId,
    wabaId: b.wabaId,
    metaAccessToken: b.metaAccessToken,
    openaiApiKey: b.openaiApiKey
  };
}

function sendBusinessError(res: Response, error: any) {
  const message = String(error.message || error);
  const status = /ya está asignado/.test(message) ? 409 : /BUSINESS_SECRETS_KEY|No se envió/.test(message) ? 400 : 500;
  res.status(status).json({ error: message });
}

/** Anota un pago manual (transferencia, efectivo…): suma los meses pagados y deja la empresa activa. */
app.post('/api/businesses/:businessId/payments', requireAdminSession, requireUuidParams, async (req: Request, res: Response) => {
  try {
    const amount = Number(req.body?.amount);
    const months = Math.round(Number(req.body?.months) || 1);
    const method = String(req.body?.method || 'transferencia').trim().slice(0, 30) || 'transferencia';
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000) return res.status(400).json({ error: 'Escribe un monto válido' });
    if (months < 1 || months > 24) return res.status(400).json({ error: 'Los meses deben estar entre 1 y 24' });
    const business = await getBusinessRow(req.params.businessId);
    if (!business) return res.status(404).json({ error: 'Empresa no encontrada' });

    const result = await recordSubscriptionPayment(business.id, {
      amount, months, method, note: String(req.body?.note || '').trim().slice(0, 200), reference: String(req.body?.reference || '').trim().slice(0, 80)
    });
    // Si estaba suspendida por falta de pago, vuelve a atender.
    if (!business.active) await updateBusinessInfo(business.id, { active: true });
    console.log(`💵 Pago manual de ${business.name}: $${amount} por ${months} mes(es)`);
    res.status(201).json({ ...result, reactivated: !business.active });
  } catch (error: any) {
    console.error('Error registrando pago:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/businesses/:businessId/payments', requireAdminSession, requireUuidParams, async (req: Request, res: Response) => {
  try {
    res.json(await getBusinessPayments(req.params.businessId));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/businesses', requireAdminSession, async (_req: Request, res: Response) => {
  try {
    const [businesses, subscriptions] = await Promise.all([getAllBusinesses(), getSubscriptionSummary()]);
    res.json(businesses.map((b: any) => ({ ...b, subscription: subscriptions[b.id] || null })));
  } catch (error: any) {
    console.error('Error cargando negocios:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Crea un negocio. El perfil parte de una plantilla (tienda o eventos) con el nombre del negocio;
 * las claves de WhatsApp y OpenAI son opcionales aquí y se pueden cargar después.
 */
app.post('/api/businesses', requireAdminSession, async (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'El nombre del negocio es requerido' });

    const preset = PROFILE_PRESETS[String(req.body?.preset || 'tienda')] || PROFILE_PRESETS.tienda;
    const base = normalizeProfile(preset.profile, preset.profile);
    const initialProfile = normalizeProfile({ ...base, business: { ...base.business, name } }, base);

    const business = await createBusiness(name, initialProfile, credentialsFromBody(req.body));
    console.log(`🏢 Negocio creado: ${business.name}`);
    res.status(201).json(business);
  } catch (error: any) {
    console.error('Error creando negocio:', error.message);
    sendBusinessError(res, error);
  }
});

app.patch('/api/businesses/:businessId', requireAdminSession, requireUuidParams, async (req: Request, res: Response) => {
  try {
    const updates: { name?: string; active?: boolean; addons?: Record<string, boolean> } = {};
    if (req.body?.name !== undefined) {
      updates.name = String(req.body.name).trim().slice(0, 80);
      if (!updates.name) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    }
    if (typeof req.body?.active === 'boolean') updates.active = req.body.active;
    // Servicios adicionales que se venden aparte: solo la administradora de la plataforma los activa.
    if (req.body?.addons && typeof req.body.addons === 'object') {
      const row = await getBusinessRow(req.params.businessId);
      if (!row) return res.status(404).json({ error: 'Negocio no encontrado' });
      updates.addons = { ...(row.addons || {}) };
      for (const name of ADDONS) {
        if (typeof req.body.addons[name] === 'boolean') updates.addons[name] = req.body.addons[name];
      }
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nada para actualizar' });

    const updated = await updateBusinessInfo(req.params.businessId, updates);
    if (!updated) return res.status(404).json({ error: 'Negocio no encontrado' });
    if (updates.active !== undefined) console.log(`🏢 ${updated.name} ${updates.active ? 'reactivada' : 'suspendida'}`);
    res.json(updated);
  } catch (error: any) {
    sendBusinessError(res, error);
  }
});

/**
 * Elimina la empresa y todo lo suyo, sin residuos. Para evitar accidentes hay que enviar su nombre exacto
 * y la empresa debe estar suspendida antes (así el bot ya no está atendiendo mientras se borra).
 */
app.delete('/api/businesses/:businessId', requireAdminSession, requireUuidParams, async (req: Request, res: Response) => {
  try {
    const row = await getBusinessRow(req.params.businessId);
    if (!row) return res.status(404).json({ error: 'Empresa no encontrada' });
    if (row.active) return res.status(400).json({ error: 'Primero suspende la empresa y luego elimínala' });
    if (String(req.body?.confirmName || '').trim() !== row.name) {
      return res.status(400).json({ error: 'El nombre escrito no coincide con el de la empresa' });
    }

    const result = await deleteBusinessCompletely(row.id);
    console.log(`🗑️ Empresa eliminada por completo: ${row.name}`, JSON.stringify(result?.summary));
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Error eliminando empresa:', error.message);
    res.status(500).json({ error: `No se pudo eliminar por completo: ${error.message}. Puedes intentar de nuevo; lo ya borrado no vuelve.` });
  }
});

/** Carga o cambia las claves del negocio. Los campos vacíos conservan lo que ya estaba guardado. */
app.put('/api/businesses/:businessId/credentials', requireAdminSession, requireUuidParams, async (req: Request, res: Response) => {
  try {
    const updated = await updateBusinessCredentials(req.params.businessId, credentialsFromBody(req.body));
    if (!updated) return res.status(404).json({ error: 'Negocio no encontrado' });
    console.log(`🔑 Claves actualizadas del negocio ${updated.name}`);
    res.json(updated);
  } catch (error: any) {
    sendBusinessError(res, error);
  }
});

/** Prueba las claves guardadas contra Meta y OpenAI, sin enviar mensajes. */
app.post('/api/businesses/:businessId/test-credentials', requireAdminSession, requireUuidParams, async (req: Request, res: Response) => {
  try {
    const row = await getBusinessRow(req.params.businessId);
    if (!row) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(await testBusinessCredentials(row));
  } catch (error: any) {
    sendBusinessError(res, error);
  }
});

// ---------- USUARIOS DE EMPRESAS (solo admin) ----------
// La empresa de la ruta puede ser un id de negocio o "velamia".

/** Verifica que la empresa exista (VELAMIA siempre existe). */
async function companyExists(req: Request, res: Response) {
  const businessId = companyIdOf(req);
  if (businessId && !(await getBusinessRow(businessId))) {
    res.status(404).json({ error: 'Empresa no encontrada' });
    return false;
  }
  return true;
}

/** El usuario debe pertenecer a la empresa de la ruta: así no se toca un usuario de otra empresa. */
async function userOfCompany(req: Request, res: Response) {
  const user = await getBusinessUser(req.params.userId);
  if (!user || (user.business_id ?? null) !== companyIdOf(req)) {
    res.status(404).json({ error: 'Usuario no encontrado en esta empresa' });
    return null;
  }
  return user;
}

function sendUserError(res: Response, error: any) {
  const message = String(error.message || error);
  const status = /ya existe/.test(message) ? 409 : /contraseña debe/.test(message) ? 400 : 500;
  res.status(status).json({ error: message });
}

app.get('/api/businesses/:businessId/users', requireAdminSession, requireCompanyParams, async (req: Request, res: Response) => {
  try {
    res.json(await getBusinessUsers(companyIdOf(req)));
  } catch (error: any) {
    console.error('Error cargando usuarios:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/businesses/:businessId/users', requireAdminSession, requireCompanyParams, async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const fullName = String(req.body?.fullName || '').trim();
    const role = req.body?.role || 'owner';
    const password = String(req.body?.password || '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName) {
      return res.status(400).json({ error: 'Nombre y un correo válido son requeridos' });
    }
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
    if (!(await companyExists(req, res))) return;

    const user = await createBusinessUser(companyIdOf(req), email, fullName, role, password);
    console.log(`👤 Usuario creado: ${email}`);
    res.status(201).json(user);
  } catch (error: any) {
    console.error('Error creando usuario:', error.message);
    sendUserError(res, error);
  }
});

/** Cambia nombre, rol, contraseña o estado de un usuario. */
app.patch('/api/businesses/:businessId/users/:userId', requireAdminSession, requireCompanyParams, async (req: Request, res: Response) => {
  try {
    const user = await userOfCompany(req, res);
    if (!user) return;

    const { fullName, role, active, password } = req.body || {};
    if (active === false) {
      await deactivateBusinessUser(user.id);
      console.log(`👤 Usuario desactivado: ${user.email}`);
    }

    const updates: { full_name?: string; role?: any; active?: boolean; password?: string } = {};
    if (fullName) updates.full_name = String(fullName).trim();
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
      updates.role = role;
    }
    if (active === true) updates.active = true;
    if (password !== undefined) updates.password = String(password);

    const updated = Object.keys(updates).length ? await updateBusinessUser(user.id, updates) : await getBusinessUser(user.id);
    if (password !== undefined) console.log(`🔑 Contraseña cambiada por la administradora: ${user.email}`);
    res.json(updated);
  } catch (error: any) {
    console.error('Error actualizando usuario:', error.message);
    sendUserError(res, error);
  }
});

app.delete('/api/businesses/:businessId/users/:userId', requireAdminSession, requireCompanyParams, async (req: Request, res: Response) => {
  try {
    const user = await userOfCompany(req, res);
    if (!user) return;
    await deactivateBusinessUser(user.id);
    console.log(`👤 Usuario desactivado: ${user.email}`);
    res.json({ message: `Usuario ${user.email} desactivado` });
  } catch (error: any) {
    console.error('Error desactivando usuario:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/** Cada usuario cambia su propia contraseña confirmando la actual. */
app.put('/api/me/password', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const session = getCrmSession(req);
    if (!session.userId) {
      return res.status(400).json({ error: 'La contraseña de la administradora se cambia en las variables del servidor (CRM_PASSWORD)' });
    }
    const changed = await changeOwnPassword(session.userId, String(req.body?.currentPassword || ''), String(req.body?.newPassword || ''));
    if (!changed) return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    res.json({ success: true });
  } catch (error: any) {
    sendUserError(res, error);
  }
});

// ---------- MULTI-NEGOCIO: EL NEGOCIO EN QUE SE TRABAJA ----------

/** Quién entró y en qué negocio trabaja: el CRM lo usa para mostrar u ocultar la administración. */
app.get('/api/session', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const session = getCrmSession(req);
    const tenant = currentTenant();
    const row = tenant ? await getBusinessRow(tenant.businessId) : null;
    // Sin empresa elegida (administradora en la pantalla general) no hay empresa que devolver.
    const business = row ? toPublicBusiness(row) : session.businessId === VELAMIA_ID ? velamiaCompany() : null;
    res.json({ role: session.role, business });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Cuánto consumió de OpenAI cada empresa en los últimos 30 días (para saber qué cuesta cada cliente). */
app.get('/api/businesses/usage', requireAdminSession, async (req: Request, res: Response) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json({ days, usage: await getUsageByBusiness(days) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Consumo de la empresa con la que se está trabajando. */
app.get('/api/me/usage', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json(await getTenantUsage(days));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Revisa ahora mismo todas las empresas y avisa por WhatsApp si alguna dejó de poder atender. */
app.post('/api/health-check', requireAdminSession, async (_req: Request, res: Response) => {
  try {
    res.json(await runHealthCheck(true));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/me/business', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    const tenant = currentTenant();
    if (!tenant) return res.json(velamiaCompany());
    const row = await getBusinessRow(tenant.businessId);
    if (!row) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(toPublicBusiness(row));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** El dueño carga o cambia las claves de SU negocio (WhatsApp y OpenAI). */
app.put('/api/me/credentials', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
  try {
    const tenant = currentTenant();
    if (!tenant) return res.status(400).json({ error: 'Las claves de VELAMIA se configuran en las variables del servidor' });
    const updated = await updateBusinessCredentials(tenant.businessId, credentialsFromBody(req.body));
    console.log(`🔑 Claves actualizadas por el negocio ${tenant.name}`);
    res.json(updated);
  } catch (error: any) {
    sendBusinessError(res, error);
  }
});

app.post('/api/me/test-credentials', requireCrmSession, requireOwnerRole, async (_req: Request, res: Response) => {
  try {
    const tenant = currentTenant();
    if (!tenant) return res.status(400).json({ error: 'Elige un negocio primero' });
    const row = await getBusinessRow(tenant.businessId);
    if (!row) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(await testBusinessCredentials(row));
  } catch (error: any) {
    sendBusinessError(res, error);
  }
});

/**
 * Conecta el número de la empresa al bot: suscribe su cuenta de WhatsApp (WABA) a la App de Meta de esta
 * plataforma, que es la que tiene configurado el webhook. Sin esto Meta nunca envía sus mensajes al servidor.
 * Antes revisa que el número pertenezca a esa cuenta y esté habilitado para la API.
 */
async function connectBusinessWhatsApp(row: BusinessRow): Promise<{ ok: boolean; steps: { ok: boolean; detail: string }[] }> {
  const steps: { ok: boolean; detail: string }[] = [];
  const graphUrl = 'https://graph.facebook.com/v25.0';
  const token = decryptSecret(row.meta_access_token);
  if (!token || !row.meta_phone_number_id || !row.meta_business_account_id) {
    return { ok: false, steps: [{ ok: false, detail: 'Faltan claves: token de Meta, Phone Number ID y WhatsApp Business Account ID' }] };
  }
  const headers = { Authorization: `Bearer ${token}` };
  const metaError = (data: any, status: number) => data?.error?.message || `Meta respondió ${status}`;

  // 1) El número pertenece a la cuenta y está disponible para la API.
  try {
    const response = await fetch(`${graphUrl}/${row.meta_business_account_id}/phone_numbers?fields=id,display_phone_number,verified_name,platform_type,code_verification_status`, { headers });
    const data: any = await response.json();
    if (!response.ok) return { ok: false, steps: [{ ok: false, detail: `No se pudo leer la cuenta de WhatsApp: ${metaError(data, response.status)}` }] };
    const phone = (data.data || []).find((p: any) => String(p.id) === String(row.meta_phone_number_id));
    if (!phone) {
      return { ok: false, steps: [{ ok: false, detail: 'El Phone Number ID no pertenece a esa WhatsApp Business Account. Revisa ambos datos en Meta.' }] };
    }
    steps.push({ ok: true, detail: `Número encontrado: ${phone.verified_name || ''} ${phone.display_phone_number || ''}`.trim() });
    if (phone.platform_type && phone.platform_type !== 'CLOUD_API') {
      steps.push({ ok: false, detail: `El número no está registrado en la API de WhatsApp (estado: ${phone.platform_type}). Regístralo en Meta antes de conectarlo.` });
      return { ok: false, steps };
    }
  } catch (error: any) {
    return { ok: false, steps: [{ ok: false, detail: `No se pudo consultar a Meta: ${error.message}` }] };
  }

  // 2) Suscribir la cuenta a la App: desde aquí Meta envía los mensajes de ese número al webhook.
  try {
    const response = await fetch(`${graphUrl}/${row.meta_business_account_id}/subscribed_apps`, { method: 'POST', headers });
    const data: any = await response.json();
    if (!response.ok || data.success === false) {
      steps.push({ ok: false, detail: `Meta no aceptó la conexión: ${metaError(data, response.status)}` });
      return { ok: false, steps };
    }
    steps.push({ ok: true, detail: 'Cuenta suscrita: los mensajes de este número llegarán al bot' });
  } catch (error: any) {
    steps.push({ ok: false, detail: `No se pudo conectar: ${error.message}` });
    return { ok: false, steps };
  }

  return { ok: true, steps };
}

async function runConnectWhatsApp(businessId: string, res: Response) {
  const row = await getBusinessRow(businessId);
  if (!row) return res.status(404).json({ error: 'Empresa no encontrada' });
  const result = await connectBusinessWhatsApp(row);
  await markWebhookConnected(row.id, result.ok);
  console.log(`📲 Conectar WhatsApp de ${row.name}: ${result.ok ? 'conectado' : 'falló'}`);
  res.json(result);
}

app.post('/api/businesses/:businessId/connect-whatsapp', requireAdminSession, requireUuidParams, async (req: Request, res: Response) => {
  try {
    await runConnectWhatsApp(req.params.businessId, res);
  } catch (error: any) {
    sendBusinessError(res, error);
  }
});

app.post('/api/me/connect-whatsapp', requireCrmSession, requireOwnerRole, async (_req: Request, res: Response) => {
  try {
    const tenant = currentTenant();
    if (!tenant) return res.status(400).json({ error: 'El WhatsApp de VELAMIA ya está conectado desde el servidor' });
    await runConnectWhatsApp(tenant.businessId, res);
  } catch (error: any) {
    sendBusinessError(res, error);
  }
});

/**
 * Alta del número por la propia empresa: escribe su número, recibe un código por SMS o llamada y lo ingresa.
 * El número queda en la cuenta de Meta de Nexly y se conecta solo al asistente.
 */
const NUMBER_ATTEMPTS_PER_DAY = 5;
const numberAttempts = new Map<string, number[]>();

app.post('/api/me/whatsapp/start', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
  try {
    const tenant = currentTenant();
    if (!tenant) return res.status(400).json({ error: 'Elige una empresa primero' });
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const attempts = (numberAttempts.get(tenant.businessId) || []).filter(at => at > dayAgo);
    if (attempts.length >= NUMBER_ATTEMPTS_PER_DAY) return res.status(429).json({ error: 'Llegaste al límite de intentos de hoy. Intenta mañana o escríbenos.' });
    numberAttempts.set(tenant.businessId, [...attempts, Date.now()]);
    const meta = platformMeta();
    if (!meta) return res.status(503).json({ error: 'Falta configurar la cuenta de WhatsApp de Nexly en el servidor (NEXLY_WABA_ID y NEXLY_META_TOKEN)' });
    const phone = splitPhone(String(req.body?.phone || ''));
    if (!phone) return res.status(400).json({ error: 'Escribe el número completo, por ejemplo 099 123 4567 o +593 99 123 4567' });
    const displayName = String(req.body?.displayName || '').trim();
    if (displayName.length < 3 || displayName.length > 60) return res.status(400).json({ error: 'Escribe el nombre del negocio (entre 3 y 60 letras)' });
    const method = req.body?.method === 'VOICE' ? 'VOICE' : 'SMS';

    const { phoneNumberId } = await addNumberAndRequestCode(meta, phone, displayName, method);
    await updateBusinessCredentials(tenant.businessId, {
      displayPhoneNumber: `${phone.cc}${phone.national}`, phoneNumberId, wabaId: meta.wabaId, metaAccessToken: meta.token
    });
    console.log(`📲 ${tenant.name}: se pidió el código de verificación para su número (${method})`);
    res.json({ success: true, method });
  } catch (error: any) {
    console.error('Error agregando número:', error.message);
    res.status(400).json({ error: `Meta no pudo agregar el número: ${error.message}` });
  }
});

app.post('/api/me/whatsapp/verify', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
  try {
    const tenant = currentTenant();
    if (!tenant) return res.status(400).json({ error: 'Elige una empresa primero' });
    const meta = platformMeta();
    if (!meta) return res.status(503).json({ error: 'Falta configurar la cuenta de WhatsApp de Nexly en el servidor' });
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (code.length !== 6) return res.status(400).json({ error: 'El código tiene 6 números' });
    const row = await getBusinessRow(tenant.businessId);
    if (!row?.meta_phone_number_id) return res.status(400).json({ error: 'Primero escribe tu número para recibir el código' });

    await verifyAndRegister(meta, row.meta_phone_number_id, code);
    const result = await connectBusinessWhatsApp(row);
    await markWebhookConnected(row.id, result.ok);
    console.log(`📲 ${tenant.name}: número verificado y conectado (${result.ok ? 'ok' : 'falló la conexión'})`);
    res.json(result);
  } catch (error: any) {
    console.error('Error verificando número:', error.message);
    res.status(400).json({ error: `No se pudo verificar: ${error.message}` });
  }
});

/** Estado del bot de la empresa en que se trabaja (para el dueño). */
app.get('/api/me/readiness', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    const tenant = currentTenant();
    if (!tenant) return res.json(null);
    const row = await getBusinessRow(tenant.businessId);
    if (!row) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json(await getBusinessReadiness(row));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// JSON mal formado u otros errores de Express: respuesta JSON en lugar de una página HTML.
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error en petición:', error.message);
  res.status(error.status || 500).json({ error: error.expose ? error.message : 'Error interno del servidor' });
});

/**
 * Render suspende el plan gratuito tras 15 minutos sin tráfico y tarda ~50s en
 * volver, tiempo en el que se pierden mensajes de WhatsApp. Una petición propia
 * cada 10 minutos mantiene la instancia despierta.
 */
function keepAwake() {
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) return;

  setInterval(() => {
    fetch(`${externalUrl}/health`).catch(error => {
      console.error('Ping de mantenimiento falló:', error.message);
    });
  }, 10 * 60 * 1000);

  console.log('⏰ Auto-ping activo: el servidor no se dormirá');
}

// Un error inesperado en segundo plano no debe apagar el servidor y cortar la atención.
process.on('unhandledRejection', reason => console.error('Promesa rechazada sin manejar:', reason));
process.on('uncaughtException', error => console.error('Excepción no capturada:', error));

// Al publicar una versión, Render avisa con SIGTERM y da ~30 s antes de apagar la instancia anterior.
let shuttingDown = false;
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('🛑 Apagando: se responden los mensajes en espera antes de salir');
  flushPendingResponses(25_000).finally(() => process.exit(0));
});

initDatabase().catch(error => console.error('❌', error.message));

// El perfil se lee antes de atender: sin él el bot respondería con las reglas de otro negocio.
async function start() {
  try {
    const loaded = await loadBusinessProfile();
    console.log(`🏪 Perfil del negocio: ${loaded.business.name}`);
  } catch (error: any) {
    console.error('❌ No se pudo leer el perfil del negocio:', error.message);
  }
  // Si otra instancia (por ejemplo durante un despliegue) guarda cambios, se toman en pocos minutos.
  setInterval(() => loadBusinessProfile().catch(error => console.error('❌ Perfil del negocio:', error.message)), 5 * 60 * 1000);

  if (weakMasterPassword()) {
    console.warn('⚠️  La contraseña maestra del CRM (CRM_PASSWORD) es débil: usa al menos 14 caracteres con mayúsculas, minúsculas, números y símbolos.');
  }
  app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);

  const missing = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'WEBHOOK_VERIFY_TOKEN', 'CRM_PASSWORD', 'META_APP_SECRET', 'BUSINESS_SECRETS_KEY']
    .filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.warn(`⚠️  Variables de entorno sin configurar: ${missing.join(', ')}`);
  }

  keepAwake();
  startFollowUpScheduler();
  startSocialPostsScheduler();
  startPhotoNudgeScheduler();
  startHealthCheck();
  // Con la página de Facebook configurada, se suscribe sola a la App al arrancar (repetirlo no hace daño).
  if (process.env.META_PAGE_ID && process.env.META_PAGE_TOKEN) {
    subscribePage()
      .then(detail => console.log(`📘 Instagram/Messenger: ${detail}`))
      .catch(error => console.error('❌ No se pudo conectar la página de Facebook:', error.response?.data?.error?.message || error.message));
  }
  });
}

start();

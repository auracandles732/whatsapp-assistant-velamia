// Debe ir primero: los servicios leen variables de entorno al importarse.
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
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
  getAllOrders,
  updateOrderStatus,
  ORDER_STATUSES,
  OrderStatus,
  parseDbTimestamp,
  createBusiness,
  getAllBusinesses,
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
import { removeFilesByPublicUrls, storagePath } from './services/storage';
import { currentTenant, decryptSecret } from './services/tenant';
import { handleWebhookMessage, handleEchoMessage, flushPendingResponses, forgetConversation } from './controllers/messageController';
import {
  requireCrmSession,
  requireAdminSession,
  requireOwnerRole,
  requireEditorRole,
  getCrmSession,
  VELAMIA_ID,
  isPasswordValid,
  issueSessionToken,
  verifyWebhookSignature
} from './middleware/auth';
import { sendTextMessage, sendImageMessage, getSentMessageId, describeWhatsAppError } from './services/whatsapp';
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

// El raw body es necesario para validar la firma HMAC que envía Meta.
app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; }
}));

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

// Sin esto el navegador se queda con la versión vieja del CRM después de publicar cambios.
app.use('/crm', express.static(path.join(__dirname, '..', 'dashboard'), {
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

// ---------- Salud ----------

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    // Solo indica si la configuración existe, nunca su valor.
    followups: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ? 'activo' : 'falta WHATSAPP_BUSINESS_ACCOUNT_ID'
  });
});

// ---------- Acceso al CRM ----------

// Límite de intentos fallidos por IP para que no se pueda adivinar la contraseña a la fuerza.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

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
    res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  };

  if (!username) return fail();

  // Administradora: usuario "admin" con la contraseña maestra.
  if (username === 'admin') {
    if (!isPasswordValid(password)) return fail();
    loginFailures.delete(ip);
    return res.json({ token: issueSessionToken(), role: 'admin' });
  }

  try {
    const user = await authenticateBusinessUser(username, password);
    if (!user) return fail();
    loginFailures.delete(ip);
    res.json({ token: issueSessionToken(user), role: user.role, businessId: user.businessId });
  } catch (error: any) {
    console.error('Error validando acceso:', error.message);
    res.status(500).json({ error: 'No se pudo validar el acceso, intenta de nuevo' });
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

app.post('/api/business-profile/preview', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
  try {
    const businessKey = currentTenant()?.businessId ?? 'velamia';
    if (Date.now() - (previewLastAt.get(businessKey) || 0) < 4000) {
      return res.status(429).json({ error: 'Espera unos segundos entre pruebas' });
    }
    previewLastAt.set(businessKey, Date.now());

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

    console.log(`🗑️ Chat ${conv.phone_number} eliminado (${filesRemoved} archivo(s))`);
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
      revenue: metrics.totalRevenue
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
    if (!['pending', 'accepted', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const updated = await updateQuotationStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: 'Cotización no encontrada' });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Pedidos ----------

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
    const { imageUrl, caption } = req.body || {};
    if (!/^https:\/\/\S+$/.test(String(imageUrl || ''))) {
      return res.status(400).json({ error: 'La foto debe ser un enlace que empiece con https://' });
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

app.get('/api/businesses', requireAdminSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getAllBusinesses());
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
    const updates: { name?: string; active?: boolean } = {};
    if (req.body?.name !== undefined) {
      updates.name = String(req.body.name).trim().slice(0, 80);
      if (!updates.name) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    }
    if (typeof req.body?.active === 'boolean') updates.active = req.body.active;
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

  app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);

  const missing = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'WEBHOOK_VERIFY_TOKEN', 'CRM_PASSWORD', 'META_APP_SECRET', 'BUSINESS_SECRETS_KEY']
    .filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.warn(`⚠️  Variables de entorno sin configurar: ${missing.join(', ')}`);
  }

  keepAwake();
  startFollowUpScheduler();
  startHealthCheck();
  });
}

start();

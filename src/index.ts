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
  getBusinessByPhoneNumber,
  createBusiness,
  getAllBusinesses
} from './db';
import { removeFilesByPublicUrls } from './services/storage';
import { handleWebhookMessage, flushPendingResponses, forgetConversation } from './controllers/messageController';
import {
  requireCrmSession,
  isPasswordValid,
  issueSessionToken,
  verifyWebhookSignature
} from './middleware/auth';
import { sendTextMessage, sendImageMessage, getSentMessageId, describeWhatsAppError } from './services/whatsapp';
import { startFollowUpScheduler } from './services/followups';
import { loadBusinessProfile, saveBusinessProfile, profile, PROFILE_PRESETS, findPackaging } from './config/businessProfile';

const app = express();
const PORT = process.env.PORT || 3000;

// Render pone un proxy delante: sin esto todas las peticiones parecerían venir de la misma IP.
app.set('trust proxy', 1);

// El raw body es necesario para validar la firma HMAC que envía Meta.
app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; }
}));

// El nombre y el color de la app instalable salen del perfil del negocio.
app.get('/crm/manifest.json', (_req: Request, res: Response) => {
  const { business, branding } = profile();
  res.json({
    name: `${business.name} CRM`,
    short_name: business.name.slice(0, 12),
    description: `Panel de control del asistente WhatsApp de ${business.name}`,
    start_url: '/crm/index.html',
    scope: '/crm/',
    display: 'standalone',
    background_color: '#F7EFEA',
    theme_color: branding.primaryColor,
    orientation: 'portrait',
    icons: [{ src: branding.logoUrl || 'logo.png', sizes: branding.logoUrl ? 'any' : '1920x1920', type: 'image/png', purpose: 'any' }]
  });
});

app.use('/crm', express.static(path.join(__dirname, '..', 'dashboard')));
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

app.post('/api/login', (req: Request, res: Response) => {
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

  if (!isPasswordValid(String(req.body?.password || ''))) {
    loginFailures.set(ip, { count: (current?.count || 0) + 1, resetAt: current?.resetAt || now + LOGIN_WINDOW_MS });
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  loginFailures.delete(ip);
  res.json({ token: issueSessionToken() });
});

// La pantalla de ingreso muestra el nombre y el logo antes de iniciar sesión: solo datos públicos.
app.get('/api/public/branding', (_req: Request, res: Response) => {
  const { business, branding } = profile();
  res.json({ name: business.name, primaryColor: branding.primaryColor, logoUrl: branding.logoUrl, timezone: business.timezone });
});

// ---------- Perfil del negocio ----------

app.get('/api/business-profile', requireCrmSession, (_req: Request, res: Response) => {
  res.json(profile());
});

app.get('/api/business-profile/presets', requireCrmSession, (_req: Request, res: Response) => {
  res.json(Object.entries(PROFILE_PRESETS).map(([id, preset]) => ({ id, label: preset.label, profile: preset.profile })));
});

app.put('/api/business-profile', requireCrmSession, async (req: Request, res: Response) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Perfil inválido' });
    const saved = await saveBusinessProfile(req.body);
    console.log(`🏪 Perfil del negocio actualizado: ${saved.business.name}`);
    res.json(saved);
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
    res.json(await getMessages(req.params.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Elimina el chat por completo: mensajes, cotizaciones, pedidos, seguimientos, avisos
 * y los archivos que envió el cliente.
 */
app.delete('/api/conversations/:id', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
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
app.post('/api/conversations/:id/pause', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
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

app.post('/api/conversations/:id/resume', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
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

// ---------- Cotizaciones ----------

app.get('/api/quotations', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getAllQuotations());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/quotations/:id', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
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
app.patch('/api/orders/:id', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
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

app.post('/api/send-message', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Escribe un mensaje' });
    if (text.length > 4096) return res.status(400).json({ error: 'WhatsApp no permite mensajes de más de 4096 caracteres' });
    const conv = await conversationForSending(req, res);
    if (!conv) return;
    const sent = await sendTextMessage(conv.phone_number, text);
    await saveMessage(conv.id, 'bot', 'text', text, getSentMessageId(sent));
    // Una persona tomó el chat: el bot se calla aquí hasta que lo reactiven desde el CRM.
    await pauseBot(conv.id);
    res.json({ success: true, bot_paused: true });
  } catch (error: any) {
    console.error('Error enviando mensaje manual:', error.response?.data || error.message);
    res.status(500).json({ error: describeWhatsAppError(error) });
  }
});

app.post('/api/send-image', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { imageUrl, caption } = req.body || {};
    if (!/^https:\/\/\S+$/.test(String(imageUrl || ''))) {
      return res.status(400).json({ error: 'La foto debe ser un enlace que empiece con https://' });
    }
    const conv = await conversationForSending(req, res);
    if (!conv) return;
    const sent = await sendImageMessage(conv.phone_number, imageUrl, caption);
    await saveMessage(conv.id, 'bot', 'image', caption ? `${imageUrl}\n${caption}` : imageUrl, getSentMessageId(sent));
    await pauseBot(conv.id);
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

app.post('/api/bot-status', requireCrmSession, async (req: Request, res: Response) => {
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

app.post('/api/system-prompt', requireCrmSession, async (req: Request, res: Response) => {
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

app.post('/api/payment-info', requireCrmSession, async (req: Request, res: Response) => {
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

/** Nombre oficial del empaque (tal como está en el perfil), '' para ninguno, o null si no existe. */
function packagingName(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return findPackaging(value)?.name ?? null;
}

app.post('/api/upload-image', requireCrmSession, async (req: Request, res: Response) => {
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
    const finalName = `${randomUUID()}.${contentType === 'image/png' ? 'png' : 'jpg'}`;

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

app.post('/api/products', requireCrmSession, async (req: Request, res: Response) => {
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

    res.json(await createProduct(cleanProductName(name), parsedPrice, String(category).trim().toUpperCase(), image_url || undefined, pkg));
  } catch (error: any) {
    console.error('Error creando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
  try {
    const { name, price, category, image_url, packaging } = req.body || {};
    const updates: { name?: string; price?: number; category?: string; image_url?: string; description?: string } = {};

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

app.delete('/api/products/:id', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
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

// ---------- MULTI-TENANT: NEGOCIOS ----------

app.get('/api/businesses', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    const businesses = await getAllBusinesses();
    res.json(businesses);
  } catch (error: any) {
    console.error('Error cargando negocios:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/businesses', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { name, phoneNumber, accessToken } = req.body;

    if (!name || !phoneNumber || !accessToken) {
      return res.status(400).json({ error: 'Nombre, teléfono y token son requeridos' });
    }

    // Crear negocio con perfil por defecto (copia del perfil global de VELAMIA)
    const defaultProfile = profile();
    const business = await createBusiness(name, phoneNumber, accessToken, defaultProfile);

    console.log(`🏢 Negocio creado: ${business.name} (${business.meta_phone_number})`);
    res.status(201).json(business);
  } catch (error: any) {
    console.error('Error creando negocio:', error.message);
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

  const missing = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'WEBHOOK_VERIFY_TOKEN', 'CRM_PASSWORD', 'META_APP_SECRET']
    .filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.warn(`⚠️  Variables de entorno sin configurar: ${missing.join(', ')}`);
  }

  keepAwake();
  startFollowUpScheduler();
  });
}

start();

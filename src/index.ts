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
  BusinessCredentials,
  BusinessRow,
  createBusinessUser,
  getBusinessUsers,
  getBusinessUser,
  updateBusinessUser,
  deactivateBusinessUser,
  createBusinessAccessToken,
  validateBusinessAccessToken,
  authenticateBusinessUser,
  changeOwnPassword,
  listBusinessAccessTokens,
  revokeBusinessAccessToken
} from './db';
import { removeFilesByPublicUrls, storagePath } from './services/storage';
import { currentTenant, decryptSecret } from './services/tenant';
import { handleWebhookMessage, flushPendingResponses, forgetConversation } from './controllers/messageController';
import {
  requireCrmSession,
  requireAdminSession,
  requireOwnerRole,
  getCrmSession,
  VELAMIA_ID,
  isPasswordValid,
  issueSessionToken,
  verifyWebhookSignature
} from './middleware/auth';
import { sendTextMessage, sendImageMessage, getSentMessageId, describeWhatsAppError } from './services/whatsapp';
import { startFollowUpScheduler } from './services/followups';
import { loadBusinessProfile, saveBusinessProfile, profile, publicProfile, normalizeProfile, PROFILE_PRESETS, findPackaging } from './config/businessProfile';

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

/**
 * Una sola pantalla de ingreso: con la contraseña maestra entra el administrador; con el token de un negocio
 * (64 caracteres) entra su dueño o personal, que solo verá su negocio.
 */
app.post(['/api/login', '/api/auth/login/business'], async (req: Request, res: Response) => {
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
  const password = String(req.body?.password || req.body?.accessToken || '');
  const fail = () => {
    loginFailures.set(ip, { count: (current?.count || 0) + 1, resetAt: current?.resetAt || now + LOGIN_WINDOW_MS });
    res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  };

  // Administradora: usuario "admin" con la contraseña maestra.
  if (username === 'admin' || !username) {
    if (isPasswordValid(password)) {
      loginFailures.delete(ip);
      return res.json({ token: issueSessionToken(), role: 'admin' });
    }
    if (username === 'admin') return fail();
  }

  try {
    // Usuario de una empresa (correo y contraseña).
    if (username) {
      const user = await authenticateBusinessUser(username, password);
      if (!user) return fail();
      loginFailures.delete(ip);
      return res.json({ token: issueSessionToken(user), role: user.role, businessId: user.businessId });
    }

    // Tokens antiguos: se siguen aceptando mientras estén vigentes.
    const access = await validateBusinessAccessToken(password.trim());
    if (access) {
      loginFailures.delete(ip);
      return res.json({ token: issueSessionToken(access), role: access.role, businessId: access.businessId });
    }
  } catch (error: any) {
    console.error('Error validando acceso:', error.message);
    return res.status(500).json({ error: 'No se pudo validar el acceso, intenta de nuevo' });
  }

  fail();
});

// La pantalla de ingreso muestra el nombre y el logo antes de iniciar sesión: solo datos públicos.
app.get('/api/public/branding', (_req: Request, res: Response) => {
  const { business, branding } = profile();
  res.json({ name: business.name, primaryColor: branding.primaryColor, logoUrl: branding.logoUrl, timezone: business.timezone });
});

// ---------- Perfil del negocio ----------

app.get('/api/business-profile', requireCrmSession, (_req: Request, res: Response) => {
  res.json(publicProfile());
});

app.get('/api/business-profile/presets', requireCrmSession, (_req: Request, res: Response) => {
  res.json(Object.entries(PROFILE_PRESETS).map(([id, preset]) => ({ id, label: preset.label, profile: publicProfile(preset.profile) })));
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

// ---------- MULTI-NEGOCIO: ADMINISTRACIÓN (solo contraseña maestra) ----------

/** Valida los ids de negocio, usuario y token que vienen en la ruta. */
function requireUuidParams(req: Request, res: Response, next: NextFunction) {
  for (const name of ['businessId', 'userId', 'tokenId']) {
    const value = req.params[name];
    if (value !== undefined && !UUID_PATTERN.test(value)) return res.status(400).json({ error: `Id inválido (${name})` });
  }
  next();
}

/** Como requireUuidParams, pero la empresa también puede ser VELAMIA (solo para sus accesos). */
function requireCompanyParams(req: Request, res: Response, next: NextFunction) {
  if (req.params.businessId !== VELAMIA_ID) return requireUuidParams(req, res, next);
  if (req.params.tokenId !== undefined && !UUID_PATTERN.test(req.params.tokenId)) {
    return res.status(400).json({ error: 'Id inválido (tokenId)' });
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
    res.json(updated);
  } catch (error: any) {
    sendBusinessError(res, error);
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

app.post('/api/businesses/:businessId/generate-access-token', requireAdminSession, requireCompanyParams, async (req: Request, res: Response) => {
  try {
    const businessId = companyIdOf(req);
    const row = businessId ? await getBusinessRow(businessId) : null;
    if (businessId && !row) return res.status(404).json({ error: 'Negocio no encontrado' });

    const { plaintoken, expiresAt } = await createBusinessAccessToken(businessId);
    console.log(`🔐 Token de acceso generado para ${row ? row.name : 'VELAMIA'}`);
    res.status(201).json({
      accessToken: plaintoken,
      expiresAt,
      message: 'Guarda este token: solo se muestra una vez. El dueño lo escribe en la pantalla de ingreso del CRM.'
    });
  } catch (error: any) {
    sendBusinessError(res, error);
  }
});

app.get('/api/businesses/:businessId/tokens', requireAdminSession, requireCompanyParams, async (req: Request, res: Response) => {
  try {
    res.json(await listBusinessAccessTokens(companyIdOf(req)));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/businesses/:businessId/tokens/:tokenId', requireAdminSession, requireCompanyParams, async (req: Request, res: Response) => {
  try {
    const revoked = await revokeBusinessAccessToken(companyIdOf(req), req.params.tokenId);
    if (!revoked) return res.status(404).json({ error: 'Token no encontrado en este negocio' });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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

/** Consulta a Meta y a OpenAI con las claves del negocio; devuelve qué funciona y qué no, en español. */
async function testBusinessCredentials(row: BusinessRow) {
  const result: { whatsapp: { ok: boolean; detail: string }; openai: { ok: boolean; detail: string } } = {
    whatsapp: { ok: false, detail: '' },
    openai: { ok: false, detail: '' }
  };

  const token = decryptSecret(row.meta_access_token);
  if (!token || !row.meta_phone_number_id) {
    result.whatsapp.detail = 'Falta el token de Meta o el Phone Number ID';
  } else {
    try {
      const response = await fetch(`https://graph.facebook.com/v25.0/${row.meta_phone_number_id}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data: any = await response.json();
      result.whatsapp = response.ok
        ? { ok: true, detail: `Conectado: ${data.verified_name || ''} ${data.display_phone_number || ''}`.trim() }
        : { ok: false, detail: data?.error?.message || `Meta respondió ${response.status}` };
    } catch (error: any) {
      result.whatsapp.detail = `No se pudo consultar a Meta: ${error.message}`;
    }
  }

  const openaiKey = decryptSecret(row.openai_api_key);
  if (!openaiKey) {
    result.openai.detail = 'Falta la clave de OpenAI';
  } else {
    try {
      const response = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${openaiKey}` } });
      result.openai = response.ok
        ? { ok: true, detail: 'Clave válida' }
        : { ok: false, detail: response.status === 401 ? 'Clave inválida o revocada' : `OpenAI respondió ${response.status}` };
    } catch (error: any) {
      result.openai.detail = `No se pudo consultar a OpenAI: ${error.message}`;
    }
  }

  return result;
}

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
  });
}

start();

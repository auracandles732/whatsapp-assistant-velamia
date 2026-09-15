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
  parseDbTimestamp
} from './db';
import { removeFilesByPublicUrls } from './services/storage';
import { handleWebhookMessage } from './controllers/messageController';
import {
  requireCrmSession,
  isPasswordValid,
  issueSessionToken,
  verifyWebhookSignature
} from './middleware/auth';
import { sendTextMessage, sendImageMessage, getSentMessageId, describeWhatsAppError } from './services/whatsapp';
import { startFollowUpScheduler } from './services/followups';

const app = express();
const PORT = process.env.PORT || 3000;

// Render pone un proxy delante: sin esto todas las peticiones parecerían venir de la misma IP.
app.set('trust proxy', 1);

// El raw body es necesario para validar la firma HMAC que envía Meta.
app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; }
}));

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

// ---------- Mensajería manual ----------

app.post('/api/send-message', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { conversationId, phoneNumber, text } = req.body || {};
    if (!conversationId || !phoneNumber || !String(text || '').trim()) {
      return res.status(400).json({ error: 'conversationId, phoneNumber y text son requeridos' });
    }
    const sent = await sendTextMessage(phoneNumber, text);
    await saveMessage(conversationId, 'bot', 'text', text, getSentMessageId(sent));
    // Una persona tomó el chat: el bot se calla aquí hasta que lo reactiven desde el CRM.
    await pauseBot(conversationId);
    res.json({ success: true, bot_paused: true });
  } catch (error: any) {
    console.error('Error enviando mensaje manual:', error.response?.data || error.message);
    res.status(500).json({ error: describeWhatsAppError(error) });
  }
});

app.post('/api/send-image', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { conversationId, phoneNumber, imageUrl, caption } = req.body || {};
    if (!conversationId || !phoneNumber || !/^https:\/\//.test(String(imageUrl || ''))) {
      return res.status(400).json({ error: 'conversationId, phoneNumber y una URL https de la imagen son requeridos' });
    }
    const sent = await sendImageMessage(phoneNumber, imageUrl, caption);
    await saveMessage(conversationId, 'bot', 'image', caption ? `${imageUrl}\n${caption}` : imageUrl, getSentMessageId(sent));
    await pauseBot(conversationId);
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

// ---------- Información de envíos ----------
// La escribe la dueña en el CRM; el bot la usa para responder costos y tiempos de envío.

app.get('/api/shipping-info', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json({ shipping: (await getConfig('shipping_info')) || '' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipping-info', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const shipping = String(req.body?.shipping || '').trim();
    if (shipping.length > 3000) {
      return res.status(400).json({ error: 'La información de envíos no puede superar 3000 caracteres' });
    }
    await setConfig('shipping_info', shipping);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Catálogo ----------

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
    const { name, price, category, image_url } = req.body || {};
    const parsedPrice = Number(price);

    if (!String(name || '').trim() || !String(category || '').trim() || !Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ error: 'Nombre, categoría y un precio válido son requeridos' });
    }

    res.json(await createProduct(String(name).trim(), parsedPrice, String(category).trim().toUpperCase(), image_url || undefined));
  } catch (error: any) {
    console.error('Error creando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', requireCrmSession, requireUuidParam, async (req: Request, res: Response) => {
  try {
    const { name, price, category, image_url } = req.body || {};
    const updates: { name?: string; price?: number; category?: string; image_url?: string } = {};

    if (name !== undefined) updates.name = String(name).trim();
    if (category !== undefined) updates.category = String(category).trim().toUpperCase();
    if (image_url !== undefined) updates.image_url = image_url;
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

initDatabase().catch(error => console.error('❌', error.message));

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

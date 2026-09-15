import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
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
  isBotPaused,
  getConversationById,
  deleteConversationCompletely,
  getAllQuotations,
  updateQuotationStatus
} from './db';
import { removeFilesByPublicUrls } from './services/storage';
import { handleWebhookMessage } from './controllers/messageController';
import {
  requireCrmSession,
  isPasswordValid,
  issueSessionToken,
  verifyWebhookSignature
} from './middleware/auth';
import { sendTextMessage, sendImageMessage, getSentMessageId } from './services/whatsapp';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// El raw body es necesario para validar la firma HMAC que envía Meta.
app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; }
}));

app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/crm', express.static(path.join(__dirname, '..', 'dashboard')));

initDatabase();

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

  if (data.object !== 'whatsapp_business_account') return;

  const changes = data.entry?.[0]?.changes?.[0]?.value;
  const message = changes?.messages?.[0];
  if (!message) return;

  handleWebhookMessage(message, changes).catch(error => {
    console.error('Error procesando mensaje:', error);
  });
});

// ---------- Salud ----------

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------- Acceso al CRM ----------

app.post('/api/login', (req: Request, res: Response) => {
  if (!process.env.CRM_PASSWORD) {
    return res.status(503).json({
      error: 'Falta configurar la variable CRM_PASSWORD en el servidor'
    });
  }

  if (!isPasswordValid(req.body.password || '')) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  res.json({ token: issueSessionToken() });
});

// ---------- Datos del CRM ----------
// Supabase bloquea el acceso directo del navegador (RLS), así que el CRM lee por aquí.

app.get('/api/conversations', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    res.json(await getAllConversations());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Elimina el chat por completo: mensajes, cotizaciones, pedidos, seguimientos, avisos
 * y las fotos/audios que envió el cliente.
 */
app.delete('/api/conversations/:id', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const conv = await getConversationById(req.params.id);
    if (!conv) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { mediaUrls } = await deleteConversationCompletely(req.params.id);

    // Si falla el borrado de archivos, los datos ya se eliminaron: se informa sin revertir.
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

app.get('/api/conversations/:id/messages', requireCrmSession, async (req: Request, res: Response) => {
  try {
    res.json(await getMessages(req.params.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    const [conversations, metrics] = await Promise.all([
      getAllConversations(),
      getSalesMetrics(365)
    ]);

    res.json({
      total: conversations.length,
      active: conversations.filter((c: any) => c.status === 'active').length,
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

app.patch('/api/quotations/:id', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!['pending', 'accepted', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    res.json(await updateQuotationStatus(req.params.id, status));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Mensajería manual ----------

app.post('/api/send-message', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { conversationId, phoneNumber, text } = req.body;
    if (!conversationId || !phoneNumber || !text) {
      return res.status(400).json({ error: 'conversationId, phoneNumber y text son requeridos' });
    }
    const sent = await sendTextMessage(phoneNumber, text);
    await saveMessage(conversationId, 'bot', 'text', text, getSentMessageId(sent));
    // Una persona tomó el chat: el bot se calla aquí hasta que lo reactiven desde el CRM.
    await pauseBot(conversationId);
    res.json({ success: true, bot_paused: true });
  } catch (error: any) {
    console.error('Error enviando mensaje manual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/send-image', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { conversationId, phoneNumber, imageUrl, caption } = req.body;
    if (!conversationId || !phoneNumber || !imageUrl) {
      return res.status(400).json({ error: 'conversationId, phoneNumber e imageUrl son requeridos' });
    }
    const sent = await sendImageMessage(phoneNumber, imageUrl, caption);
    await saveMessage(conversationId, 'bot', 'image', caption ? `${imageUrl}\n${caption}` : imageUrl, getSentMessageId(sent));
    await pauseBot(conversationId);
    res.json({ success: true, bot_paused: true });
  } catch (error: any) {
    console.error('Error enviando imagen manual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Control del bot ----------

app.get('/api/bot-status', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    const value = await getConfig('bot_enabled');
    res.json({ enabled: value !== 'false' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bot-status', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    await setConfig('bot_enabled', enabled ? 'true' : 'false');
    res.json({ success: true, enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Instrucciones del asistente ----------

app.get('/api/system-prompt', requireCrmSession, async (_req: Request, res: Response) => {
  try {
    const prompt = await getConfig('system_prompt');
    res.json({ prompt: prompt || '' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/system-prompt', requireCrmSession, async (req: Request, res: Response) => {
  try {
    await setConfig('system_prompt', req.body.prompt || '');
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Catálogo ----------

app.post('/api/upload-image', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 es requerido' });
    }

    const matches = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    const contentType = matches ? matches[1] : 'image/jpeg';
    const base64Data = matches ? matches[2] : imageBase64;
    const buffer = Buffer.from(base64Data, 'base64');
    const finalName = `${randomUUID()}.${contentType.split('/')[1] || 'jpg'}`;

    const { error } = await supabase.storage
      .from('product-images')
      .upload(finalName, buffer, { contentType });

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
    const { name, price, category, image_url } = req.body;
    const parsedPrice = Number(price);

    if (!name?.trim() || !category?.trim() || !Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ error: 'Nombre, categoría y un precio válido son requeridos' });
    }

    res.json(await createProduct(name.trim(), '', parsedPrice, 999, category.trim(), image_url));
  } catch (error: any) {
    console.error('Error creando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { name, price, category, image_url } = req.body;
    const updates: any = {};

    if (name !== undefined) updates.name = name;
    if (category !== undefined) updates.category = category;
    if (image_url !== undefined) updates.image_url = image_url;
    if (price !== undefined) {
      const parsedPrice = Number(price);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({ error: 'Precio inválido' });
      }
      updates.price = parsedPrice;
    }

    res.json(await updateProduct(req.params.id, updates));
  } catch (error: any) {
    console.error('Error actualizando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:id', requireCrmSession, async (req: Request, res: Response) => {
  try {
    await deleteProduct(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error eliminando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Control del bot por conversación ----------

/**
 * Pausa el bot en una conversación. Sin "minutes" queda pausado hasta reactivarlo.
 */
app.post('/api/conversations/:id/pause', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const conv = await getConversationById(req.params.id);
    if (!conv) {
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

/**
 * Reactiva el bot en una conversación.
 */
app.post('/api/conversations/:id/resume', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const conv = await getConversationById(req.params.id);
    if (!conv) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    await resumeBot(req.params.id);
    res.json({ success: true, message: 'Bot reanudado' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Obtiene si el bot está pausado en una conversación.
 */
app.get('/api/conversations/:id/bot-status', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const conv = await getConversationById(req.params.id);
    if (!conv) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const paused = await isBotPaused(req.params.id);
    res.json({
      bot_paused: paused,
      paused_until: conv.bot_paused_until || null
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
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

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
  if (!process.env.CRM_PASSWORD) {
    console.warn('⚠️  Falta CRM_PASSWORD: el CRM no permitirá iniciar sesión');
  }
  keepAwake();
});

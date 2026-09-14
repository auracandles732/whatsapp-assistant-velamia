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
  deleteProduct
} from './db';
import { handleWebhookMessage } from './controllers/messageController';
import {
  requireCrmSession,
  isPasswordValid,
  issueSessionToken,
  verifyWebhookSignature
} from './middleware/auth';
import { sendTextMessage, sendImageMessage } from './services/whatsapp';

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
  const { password } = req.body;

  if (!password || !isPasswordValid(password)) {
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

// ---------- Mensajería manual ----------

app.post('/api/send-message', requireCrmSession, async (req: Request, res: Response) => {
  try {
    const { conversationId, phoneNumber, text } = req.body;
    if (!conversationId || !phoneNumber || !text) {
      return res.status(400).json({ error: 'conversationId, phoneNumber y text son requeridos' });
    }
    await sendTextMessage(phoneNumber, text);
    await saveMessage(conversationId, 'bot', 'text', text);
    res.json({ success: true });
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
    await sendImageMessage(phoneNumber, imageUrl, caption);
    await saveMessage(conversationId, 'bot', 'image', caption ? `${imageUrl}\n${caption}` : imageUrl);
    res.json({ success: true });
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

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
  if (!process.env.CRM_PASSWORD) {
    console.warn('⚠️  Falta CRM_PASSWORD: el CRM no permitirá iniciar sesión');
  }
});

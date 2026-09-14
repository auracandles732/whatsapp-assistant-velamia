import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  initDatabase,
  saveMessage,
  setConfig,
  getConfig,
  getAllProducts,
  createProduct,
  updateProduct,
  deleteProduct
} from './db';
import { handleWebhookMessage } from './controllers/messageController';
import { verifyWebhook } from './middleware/auth';
import { sendTextMessage, sendImageMessage } from './services/whatsapp';
import { supabase } from './db';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));

// Servir el CRM (dashboard) como app web instalable en /crm
app.use('/crm', express.static(path.join(__dirname, '..', 'dashboard')));

// CORS para permitir que el CRM (dashboard) llame a esta API desde el navegador
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-crm-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Autenticación simple para endpoints del CRM
function verifyCrmKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-crm-key'];
  if (key !== process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// Inicializar base de datos
initDatabase();

// Webhook verification (GET)
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

// Recibir mensajes de WhatsApp (POST)
app.post('/webhook', verifyWebhook, async (req: Request, res: Response) => {
  try {
    const data = req.body;

    if (data.object === 'whatsapp_business_account') {
      const changes = data.entry?.[0]?.changes?.[0]?.value;

      if (changes?.messages?.[0]) {
        const message = changes.messages[0];
        await handleWebhookMessage(message, changes);
      }

      res.status(200).send('EVENT_RECEIVED');
    } else {
      res.status(404).send('not found');
    }
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// CRM: enviar mensaje de texto manual real al cliente
app.post('/api/send-message', verifyCrmKey, async (req: Request, res: Response) => {
  try {
    const { conversationId, phoneNumber, text } = req.body;
    if (!phoneNumber || !text) {
      return res.status(400).json({ error: 'phoneNumber y text son requeridos' });
    }
    await sendTextMessage(phoneNumber, text);
    await saveMessage(conversationId, 'bot', 'text', text);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error enviando mensaje manual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// CRM: enviar foto manual real al cliente
app.post('/api/send-image', verifyCrmKey, async (req: Request, res: Response) => {
  try {
    const { conversationId, phoneNumber, imageUrl, caption } = req.body;
    if (!phoneNumber || !imageUrl) {
      return res.status(400).json({ error: 'phoneNumber e imageUrl son requeridos' });
    }
    await sendImageMessage(phoneNumber, imageUrl, caption);
    await saveMessage(conversationId, 'bot', 'image', caption ? `${imageUrl}\n${caption}` : imageUrl);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error enviando imagen manual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// CRM: leer/cambiar estado del bot (activado/desactivado)
app.get('/api/bot-status', verifyCrmKey, async (req: Request, res: Response) => {
  try {
    const value = await getConfig('bot_enabled');
    res.json({ enabled: value !== 'false' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bot-status', verifyCrmKey, async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    await setConfig('bot_enabled', enabled ? 'true' : 'false');
    res.json({ success: true, enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// CRM: subir foto de producto a Supabase Storage
app.post('/api/upload-image', verifyCrmKey, async (req: Request, res: Response) => {
  try {
    const { imageBase64, fileName } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 es requerido' });
    }

    const matches = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
    const contentType = matches ? matches[1] : 'image/jpeg';
    const base64Data = matches ? matches[2] : imageBase64;
    const buffer = Buffer.from(base64Data, 'base64');
    const ext = contentType.split('/')[1] || 'jpg';
    const finalName = `${randomUUID()}.${ext}`;

    const { error } = await supabase.storage
      .from('product-images')
      .upload(finalName, buffer, { contentType });

    if (error) throw error;

    const { data: publicUrlData } = supabase.storage
      .from('product-images')
      .getPublicUrl(finalName);

    res.json({ url: publicUrlData.publicUrl });
  } catch (error: any) {
    console.error('Error subiendo imagen:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Catálogo: listar productos (público, lo usa también el bot indirectamente)
app.get('/api/products', async (req: Request, res: Response) => {
  try {
    const products = await getAllProducts();
    res.json(products);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Catálogo: crear producto
app.post('/api/products', verifyCrmKey, async (req: Request, res: Response) => {
  try {
    const { name, price, category, image_url } = req.body;
    if (!name || !price || !category) {
      return res.status(400).json({ error: 'name, price y category son requeridos' });
    }
    const product = await createProduct(name, `Precio por docena: $${price}`, price, 999, category, image_url);
    res.json(product);
  } catch (error: any) {
    console.error('Error creando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Catálogo: editar producto
app.put('/api/products/:id', verifyCrmKey, async (req: Request, res: Response) => {
  try {
    const { name, price, category, image_url } = req.body;
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (price !== undefined) { updates.price = price; updates.description = `Precio por docena: $${price}`; }
    if (category !== undefined) updates.category = category;
    if (image_url !== undefined) updates.image_url = image_url;

    const product = await updateProduct(req.params.id, updates);
    res.json(product);
  } catch (error: any) {
    console.error('Error actualizando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Catálogo: eliminar producto
app.delete('/api/products/:id', verifyCrmKey, async (req: Request, res: Response) => {
  try {
    await deleteProduct(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error eliminando producto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 404
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
  console.log(`📱 Webhook URL: ${process.env.NODE_ENV === 'production' ? 'https://tu-dominio.com' : `http://localhost:${PORT}`}/webhook`);
});

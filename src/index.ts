import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { initDatabase, saveMessage, setConfig, getConfig } from './db';
import { handleWebhookMessage } from './controllers/messageController';
import { verifyWebhook } from './middleware/auth';
import { sendTextMessage, sendImageMessage } from './services/whatsapp';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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
    await saveMessage(conversationId, 'bot', 'image', caption || imageUrl);
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

// 404
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
  console.log(`📱 Webhook URL: ${process.env.NODE_ENV === 'production' ? 'https://tu-dominio.com' : `http://localhost:${PORT}`}/webhook`);
});

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { initDatabase } from './db.js';
import { handleWebhookMessage } from './controllers/messageController.js';
import { verifyWebhook } from './middleware/auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Inicializar base de datos
initDatabase();

// Webhook verification (GET)
app.get('/webhook', (req: Request, res: Response) => {
  const token = req.query.hub_verify_token;
  const challenge = req.query.hub_challenge;

  if (token === process.env.WEBHOOK_VERIFY_TOKEN) {
    res.send(challenge);
    console.log('✅ Webhook verificado');
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

// 404
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
  console.log(`📱 Webhook URL: ${process.env.NODE_ENV === 'production' ? 'https://tu-dominio.com' : `http://localhost:${PORT}`}/webhook`);
});

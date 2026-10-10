import { Router, Request, Response } from 'express';
import { requireCrmSession, requireEditorRole } from '../middleware/auth';
import { trelloBoard, sendOrderToTrello, moveTrelloCard, trelloAttachment, trelloLinks, trelloConnected, tenantForAttachment } from './trello';
import { runWithTenant } from './tenant';

const TRELLO_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tablero de producción (Trello) dentro del CRM. */
export function trelloRouter(): Router {
  const router = Router();

  router.get('/api/trello/board', requireCrmSession, async (_req: Request, res: Response) => {
    try {
      res.json(await trelloBoard());
    } catch (error: any) {
      res.status(502).json({ error: error.message });
    }
  });

  router.get('/api/trello/links', requireCrmSession, async (_req: Request, res: Response) => {
    try {
      // Si hay tablero conectado y qué pedidos ya tienen su tarjeta (con la etapa en que van).
      const connected = await trelloConnected();
      res.json({ connected, links: connected ? await trelloLinks() : {} });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/trello/orders/:orderId', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    if (!UUID.test(req.params.orderId)) return res.status(400).json({ error: 'Id inválido' });
    try {
      res.json(await sendOrderToTrello(req.params.orderId));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/api/trello/cards/:cardId', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    const listId = String(req.body?.listId || '');
    if (!TRELLO_ID.test(req.params.cardId) || !TRELLO_ID.test(listId)) return res.status(400).json({ error: 'Id inválido' });
    try {
      res.json(await moveTrelloCard(req.params.cardId, listId));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Sin sesión (una imagen no la manda): solo con la dirección firmada que da el tablero.
  router.get('/api/trello/attachment/:cardId/:attachmentId', async (req: Request, res: Response) => {
    const { cardId, attachmentId } = req.params;
    if (!TRELLO_ID.test(cardId) || !TRELLO_ID.test(attachmentId)) return res.status(400).end();
    try {
      const tenant = await tenantForAttachment(String(req.query.b || ''), cardId, attachmentId, String(req.query.s || ''));
      if (tenant === null) return res.status(403).end();
      const file = await runWithTenant(tenant, () => trelloAttachment(cardId, attachmentId));
      if (!/^image\//.test(file.type)) return res.status(415).end();
      res.setHeader('Content-Type', file.type);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(file.body);
    } catch {
      res.status(404).end();
    }
  });

  return router;
}

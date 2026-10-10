import { Router, Request, Response } from 'express';
import { requireCrmSession, requireOwnerRole, requireEditorRole } from '../middleware/auth';
import { webOverview, connectWeb, disconnectWeb, setWebEnabled, pushToWeb, setProductWeb, resolveWebPrice, webPendingInfo } from './webCatalog';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, error: any, status = 400) {
  res.status(status).json({ error: String(error?.message || error) });
}

/** Catálogo de la página web: conexión, precios por revisar y la versión para la web de cada producto. */
export function webCatalogRouter(): Router {
  const router = Router();

  router.get('/api/web-catalog', requireCrmSession, async (_req: Request, res: Response) => {
    try {
      res.json(await webOverview());
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  // Si hay cambios sin llegar a la web: el CRM abierto en el navegador despierta el panel y pide el envío.
  router.get('/api/web-catalog/pending', requireCrmSession, async (_req: Request, res: Response) => {
    try {
      res.json(await webPendingInfo());
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  router.post('/api/web-catalog/connect', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      res.json({ ...(await connectWeb(req.body || {})), overview: await webOverview() });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/web-catalog/disconnect', requireCrmSession, requireOwnerRole, async (_req: Request, res: Response) => {
    try {
      await disconnectWeb();
      res.json(await webOverview());
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/web-catalog/enabled', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      await setWebEnabled(req.body?.enabled === true);
      res.json(await webOverview());
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/web-catalog/sync', requireCrmSession, requireEditorRole, async (_req: Request, res: Response) => {
    try {
      res.json({ ...(await pushToWeb()), overview: await webOverview() });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.put('/api/products/:id/web', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      res.json(await setProductWeb(req.params.id, req.body || {}));
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/products/:id/web-price', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
      const use = req.body?.use === 'web' ? 'web' : req.body?.use === 'crm' ? 'crm' : null;
      if (!use) return res.status(400).json({ error: 'Elige qué precio queda' });
      await resolveWebPrice(req.params.id, use);
      res.json(await webOverview());
    } catch (error: any) {
      fail(res, error);
    }
  });

  return router;
}

import express, { Router, Request, Response, NextFunction } from 'express';
import { requireCrmSession, requireOwnerRole, requireEditorRole } from '../middleware/auth';
import { runWithTenant, VELAMIA_ID, TenantContext } from './tenant';
import { loadTenant, getAllProducts } from './supabase';
import {
  publicAdsSettings, saveAdsSettings, createReportKey, reportKeyValid, syncAds, setAdProducts, listAds, adResults, registerWebRef,
  BadWebRef, AdRow
} from './ads';

const PERIODS = [7, 30, 90];
const daysOf = (value: unknown) => (PERIODS.includes(Number(value)) ? Number(value) : 30);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Las rutas públicas (las llama la web de la empresa o su app de métricas) tienen tope por dirección.
const hits = new Map<string, { at: number; n: number }>();
export function tooMany(key: string, max: number, now = Date.now()): boolean {
  const h = hits.get(key);
  if (!h || now - h.at > 60 * 60_000) {
    hits.set(key, { at: now, n: 1 });
    if (hits.size > 20_000) hits.clear();
    return false;
  }
  h.n++;
  return h.n > max;
}

/** La empresa de una ruta pública: "velamia" o el id de la empresa. undefined = no existe. */
async function tenantOf(business: string): Promise<{ tenant: TenantContext | undefined } | undefined> {
  const id = String(business || '').toLowerCase();
  if (id === VELAMIA_ID) return { tenant: undefined };
  if (!UUID.test(id)) return undefined;
  const tenant = await loadTenant(id).catch(() => null);
  return tenant ? { tenant } : undefined;
}

const publicAd = (a: AdRow) => ({
  adId: a.ad_id, adName: a.ad_name, campaignName: a.campaign_name, adsetName: a.adset_name, destination: a.destination, status: a.status,
  headline: a.headline, imageUrl: a.image_url, products: a.products || [], category: a.category, productSource: a.product_source, updatedAt: a.updated_at
});

function fail(res: Response, error: any, status = 400) {
  res.status(status).json({ error: String(error?.message || error) });
}

const allowAnyOrigin = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  next();
};

/** Anuncios en el CRM (resultados, producto de cada anuncio, cuenta publicitaria) y las dos rutas públicas. */
export function adsRouter(): Router {
  const router = Router();

  router.get('/api/ads', requireCrmSession, async (req: Request, res: Response) => {
    try {
      const days = daysOf(req.query.days);
      const to = new Date();
      const [settings, results, ads, catalog] = await Promise.all([
        publicAdsSettings(), adResults(new Date(to.getTime() - days * 86_400_000), to), listAds(), getAllProducts().catch(() => [])
      ]);
      res.json({
        days, settings, ...results, ads: ads.map(publicAd),
        catalog: catalog.map((p: any) => ({ name: String(p.name || ''), category: String(p.category || '') })).filter((p: any) => p.name)
      });
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  router.put('/api/ads/settings', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      const saved = await saveAdsSettings(req.body || {});
      // Con la cuenta recién conectada se leen los anuncios de una vez (si falla, el botón "Actualizar" lo reintenta).
      if (saved.connected) await syncAds().catch(() => undefined);
      res.json(saved);
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/report-key', requireCrmSession, requireOwnerRole, async (_req: Request, res: Response) => {
    try {
      res.json({ key: await createReportKey(), settings: await publicAdsSettings() });
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  router.post('/api/ads/sync', requireCrmSession, requireEditorRole, async (_req: Request, res: Response) => {
    try {
      res.json(await syncAds());
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.put('/api/ads/:adId/products', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      res.json(publicAd(await setAdProducts(String(req.params.adId), req.body || {})));
    } catch (error: any) {
      fail(res, error);
    }
  });

  // La web de la empresa anota de qué anuncio llegó la visita y qué producto miraba al tocar WhatsApp. Pública: solo
  // guarda una referencia; nada de lo que manda llega a la vendedora salvo un nombre de producto ya revisado.
  router.options('/api/public/web-ref/:business', allowAnyOrigin, (_req: Request, res: Response) => { res.sendStatus(204); });
  router.post('/api/public/web-ref/:business', allowAnyOrigin, express.text({ type: () => true, limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      if (tooMany(`web:${req.ip}`, 120)) return res.sendStatus(429);
      const found = await tenantOf(req.params.business);
      if (!found) return res.sendStatus(404);
      let body: any = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          return res.sendStatus(400);
        }
      }
      await runWithTenant(found.tenant, () => registerWebRef(body || {}));
      res.sendStatus(204);
    } catch (error: any) {
      if (error instanceof BadWebRef) return res.sendStatus(400);
      console.warn('⚠️ Visita de la web:', error.message);
      res.sendStatus(500);
    }
  });

  // Resultados por anuncio para otra app de la empresa (por ejemplo su app de métricas), con la llave que se crea en el CRM.
  router.get('/api/public/ads-report/:business', async (req: Request, res: Response) => {
    try {
      if (tooMany(`report:${req.ip}`, 120)) return res.status(429).json({ error: 'Demasiadas consultas: espera unos minutos' });
      const found = await tenantOf(req.params.business);
      if (!found) return res.status(404).json({ error: 'Empresa no encontrada' });
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      await runWithTenant(found.tenant, async () => {
        if (!(await reportKeyValid(key))) return res.status(401).json({ error: 'Llave inválida' });
        const days = daysOf(req.query.days);
        const to = new Date();
        const results = await adResults(new Date(to.getTime() - days * 86_400_000), to);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ days, generatedAt: to.toISOString(), ...results });
      });
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  return router;
}

import { Router, Request, Response } from 'express';
import { requireCrmSession, requireOwnerRole, requireEditorRole, getCrmSession } from '../middleware/auth';
import { readBuilderSettings, adCatalog } from './adBuilder';
import {
  campaignsOverview, builderOptions, proposeCampaign, normalizePlan, reviewPlan, writeTexts, searchTargeting, createCampaign, setCampaignActive,
  setAdActive, setCampaignBudget, adLibrary, dailyTotal, adCount, readDraft, saveDraft, deleteDraft
} from './adCampaigns';
import { memoryOverview, refreshMemory, analyzeMemory } from './adMemory';

function fail(res: Response, error: any, status = 400) {
  res.status(status).json({ error: String(error?.message || error) });
}

const who = (req: Request) => {
  const s: any = getCrmSession(req);
  return s?.role === 'admin' ? 'administración' : s?.role === 'owner' ? 'la dueña' : s?.role === 'manager' ? 'encargada' : '';
};

const ID = /^\d{5,30}$/;

/** Creador de campañas de Meta (Anuncios → Crear campaña) y memoria de estrategias: API oficial de Meta y todo en pausa. */
export function adCampaignRouter(): Router {
  const router = Router();

  router.get('/api/ads/campaigns', requireCrmSession, async (_req: Request, res: Response) => {
    try {
      const [overview, options] = await Promise.all([campaignsOverview(), builderOptions()]);
      res.json({ ...overview, ...options });
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  router.post('/api/ads/campaigns/propose', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      res.json(await proposeCampaign(req.body || {}));
    } catch (error: any) {
      fail(res, error);
    }
  });

  // Revisa la campaña editada (reglas de Meta, límites y presupuesto) sin crear nada.
  router.post('/api/ads/campaigns/review', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      const [catalog, library, settings] = await Promise.all([adCatalog(), adLibrary(), readBuilderSettings()]);
      const { plan, errors } = normalizePlan(req.body || {}, { catalog, library, settings });
      res.json({ errors, issues: reviewPlan(plan, catalog, String(req.body?.idea || '')), daily: dailyTotal(plan), ads: adCount(plan) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/campaigns/texts', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      res.json(await writeTexts(req.body || {}));
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.get('/api/ads/campaigns/targeting', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      const type = req.query.type === 'ciudad' ? 'ciudad' : 'interes';
      res.json({ results: await searchTargeting(type, String(req.query.q || '')) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  // Borrador guardado de la campaña (uno por empresa).
  router.get('/api/ads/campaigns/draft', requireCrmSession, requireEditorRole, async (_req: Request, res: Response) => {
    try {
      res.json({ draft: await readDraft() });
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  router.put('/api/ads/campaigns/draft', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      res.json(await saveDraft(req.body || {}, who(req)));
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.delete('/api/ads/campaigns/draft', requireCrmSession, requireEditorRole, async (_req: Request, res: Response) => {
    try {
      await deleteDraft();
      res.json({ ok: true });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/campaigns/create', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      res.json({ created: await createCampaign(req.body || {}, who(req)) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/campaigns/:campaignId/status', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      if (!ID.test(req.params.campaignId)) return fail(res, 'Campaña inválida');
      res.json({ item: await setCampaignActive(req.params.campaignId, req.body?.active === true, who(req)) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/campaigns/:campaignId/ads/:adId/status', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      if (!ID.test(req.params.campaignId) || !ID.test(req.params.adId)) return fail(res, 'Anuncio inválido');
      res.json({ item: await setAdActive(req.params.campaignId, req.params.adId, req.body?.active === true, who(req)) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.put('/api/ads/campaigns/:campaignId/budget', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      if (!ID.test(req.params.campaignId)) return fail(res, 'Campaña inválida');
      res.json({ item: await setCampaignBudget(req.params.campaignId, String(req.body?.adsetId || ''), req.body?.daily, who(req)) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.get('/api/ads/memory', requireCrmSession, async (_req: Request, res: Response) => {
    try {
      res.json(await memoryOverview());
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  router.post('/api/ads/memory/refresh', requireCrmSession, requireEditorRole, async (_req: Request, res: Response) => {
    try {
      await refreshMemory();
      res.json(await memoryOverview());
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/memory/analyze', requireCrmSession, requireEditorRole, async (_req: Request, res: Response) => {
    try {
      await analyzeMemory();
      res.json(await memoryOverview());
    } catch (error: any) {
      fail(res, error);
    }
  });

  return router;
}

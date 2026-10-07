import { Router, Request, Response } from 'express';
import { requireCrmSession, requireOwnerRole, requireEditorRole, getCrmSession } from '../middleware/auth';
import {
  builderOverview, saveBuilderSettings, detectSetup, adCatalog, proposeAd, reviewDraft, normalizeDraft, readBuilderSettings, createAd, setActive,
  setBudget, adviceForAds
} from './adBuilder';

function fail(res: Response, error: any, status = 400) {
  res.status(status).json({ error: String(error?.message || error) });
}

const who = (req: Request) => {
  const s: any = getCrmSession(req);
  return s?.role === 'admin' ? 'administración' : s?.role === 'owner' ? 'la dueña' : s?.role === 'manager' ? 'encargada' : '';
};

const CAMPAIGN = /^\d{5,30}$/;

/** Crear anuncios con IA desde el CRM (Anuncios → Crear anuncio): todo por la API oficial de Meta y en pausa. */
export function adBuilderRouter(): Router {
  const router = Router();

  router.get('/api/ads/builder', requireCrmSession, async (_req: Request, res: Response) => {
    try {
      const [overview, catalog] = await Promise.all([builderOverview(), adCatalog()]);
      res.json({ ...overview, catalog: catalog.filter(p => p.images.length) });
    } catch (error: any) {
      fail(res, error, 500);
    }
  });

  router.put('/api/ads/builder/settings', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      res.json({ settings: await saveBuilderSettings(req.body || {}) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/builder/detect', requireCrmSession, requireOwnerRole, async (_req: Request, res: Response) => {
    try {
      res.json(await detectSetup());
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/builder/propose', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      res.json(await proposeAd(req.body || {}));
    } catch (error: any) {
      fail(res, error);
    }
  });

  // Revisa un borrador editado (reglas de Meta y límites) sin crear nada.
  router.post('/api/ads/builder/review', requireCrmSession, requireEditorRole, async (req: Request, res: Response) => {
    try {
      const [catalog, settings] = await Promise.all([adCatalog(), readBuilderSettings()]);
      const { draft, errors } = normalizeDraft(req.body || {}, catalog, settings);
      res.json({ errors, issues: reviewDraft(draft, catalog, String(req.body?.idea || '')) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/builder/create', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      res.json({ created: await createAd(req.body || {}, who(req)) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/builder/:campaignId/status', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      if (!CAMPAIGN.test(req.params.campaignId)) return fail(res, 'Campaña inválida');
      res.json({ item: await setActive(req.params.campaignId, req.body?.active === true, who(req)) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.put('/api/ads/builder/:campaignId/budget', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      if (!CAMPAIGN.test(req.params.campaignId)) return fail(res, 'Campaña inválida');
      res.json({ item: await setBudget(req.params.campaignId, req.body?.daily, who(req)) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/ads/builder/advice', requireCrmSession, requireEditorRole, async (_req: Request, res: Response) => {
    try {
      res.json(await adviceForAds());
    } catch (error: any) {
      fail(res, error);
    }
  });

  return router;
}

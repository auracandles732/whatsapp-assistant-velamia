import { Router, Request, Response } from 'express';
import { requireCrmSession, requireOwnerRole } from '../middleware/auth';
import { profile } from '../config/businessProfile';
import {
  listLessons, decideLesson, deleteLesson, createLesson, LessonNotFound, reviewHandoffs, buildDayReport, getReport, listReportDays,
  supervisorSpentToday, localDayOf, SUPERVISOR_DAILY_BUDGET, HANDOFF_LABELS
} from './supervisor';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, error: any) {
  if (error instanceof LessonNotFound) return res.status(404).json({ error: error.message });
  return res.status(400).json({ error: String(error?.message || error) });
}

/** Supervisor de los chats en el CRM: aprendizajes por aprobar, los ya aprobados y el reporte de cada día. */
export function supervisorRouter(): Router {
  const router = Router();

  router.get('/api/supervisor', requireCrmSession, async (_req: Request, res: Response) => {
    try {
      const [lessons, days, spent] = await Promise.all([listLessons(), listReportDays(), supervisorSpentToday().catch(() => 0)]);
      const latest = days[0] ? await getReport(days[0]) : null;
      res.json({
        pending: lessons.filter(l => l.status === 'pending').reverse(),
        approved: lessons.filter(l => l.status === 'approved').reverse(),
        days,
        report: latest,
        today: localDayOf(new Date(), profile().business.timezone),
        spentToday: spent,
        dailyBudget: SUPERVISOR_DAILY_BUDGET,
        handoffLabels: HANDOFF_LABELS
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/supervisor/reports/:day', requireCrmSession, async (req: Request, res: Response) => {
    if (!DAY.test(req.params.day)) return res.status(400).json({ error: 'Fecha no válida' });
    try {
      const report = await getReport(req.params.day);
      if (!report) return res.status(404).json({ error: 'No hay reporte de ese día' });
      res.json({ report });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** Arma ahora el reporte de hoy (hasta este momento) o de ayer. */
  router.post('/api/supervisor/reports', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      const tz = profile().business.timezone;
      const now = new Date();
      const day = req.body?.day === 'ayer' ? localDayOf(new Date(now.getTime() - 86_400_000), tz) : localDayOf(now, tz);
      res.json({ report: await buildDayReport(day, now) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  /** Revisa ya los chats donde escribió el equipo (sin esperar la revisión de cada hora). */
  router.post('/api/supervisor/review', requireCrmSession, requireOwnerRole, async (_req: Request, res: Response) => {
    try {
      res.json(await reviewHandoffs());
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.post('/api/supervisor/lessons', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    try {
      res.status(201).json({ lesson: await createLesson(req.body || {}) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  /** Aprobar, descartar o corregir un aprendizaje (status: approved | discarded | pending). */
  router.put('/api/supervisor/lessons/:id', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Aprendizaje no válido' });
    try {
      const status = ['approved', 'discarded', 'pending'].includes(req.body?.status) ? req.body.status : undefined;
      const { situation, answer, always } = req.body || {};
      res.json({ lesson: await decideLesson(req.params.id, { status, situation, answer, always }) });
    } catch (error: any) {
      fail(res, error);
    }
  });

  router.delete('/api/supervisor/lessons/:id', requireCrmSession, requireOwnerRole, async (req: Request, res: Response) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Aprendizaje no válido' });
    try {
      await deleteLesson(req.params.id);
      res.json({ deleted: true });
    } catch (error: any) {
      fail(res, error);
    }
  });

  return router;
}

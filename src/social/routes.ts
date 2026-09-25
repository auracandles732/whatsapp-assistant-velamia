import express, { Request, Response, NextFunction, Router } from 'express';
import path from 'path';
import { requireCrmSession, requireEditorRole, requireOwnerRole } from '../middleware/auth';
import { hasAddon } from '../services/tenant';
import { getAllProducts, updateProduct } from '../services/supabase';
import { publishingStatus } from '../services/metaChannels';
import { profile } from '../config/businessProfile';
import {
  listPosts, getPost, insertPosts, updatePost, deletePost, getSavedSettings, saveSettings,
  DEFAULT_SETTINGS, EDITABLE_STATUSES, POST_CHANNELS, MAX_CAROUSEL, toPostProduct, fallbackCaption, PostStatus, PostChannel, PostMedia
} from './posts';
import { planUpcomingPosts, draftUpcomingPosts, schedulePlan, lastPlanSummary, rewriteCaption } from './planner';
import { claimAndPublish } from './publisher';
import { listAssets, createUpload, registerAsset, updateAsset, deleteAsset, getAssets, markAssetsUsed } from './library';
import {
  getSupplierSettings, saveSupplierSettings, importSupplierCatalog, listSupplierCatalogs, updateSupplierProduct,
  addSupplierProductsToCatalog, deleteSupplierCatalog, mostUsedPackaging, moveSupplierCatalog
} from './suppliers';
import { listResults } from './insights';
import { startPosters, posterStates, postersRunning, applyPoster, keepModel, clearPosterStates, resumeStuck, POSTER_COST } from './posters';
import { publicSocialAi, saveSocialAi, testSocialAi, socialAi } from './ai';

/** ¿El agente tiene su propia clave de OpenAI? (sin ella, los modelos de un PDF entran al Catálogo sin revisar). */
const hasSocialAi = () => socialAi().then(() => true, () => false);

/**
 * Rutas del agente de redes (servicio adicional "publicaciones"): calendario de publicaciones, biblioteca de fotos y
 * videos, catálogos de proveedores y resultados. Todo va aparte del asistente que responde los mensajes.
 */

const CAPTION_LIMIT = 2200; // Instagram no acepta textos más largos.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requirePublishing(_req: Request, res: Response, next: NextFunction) {
  if (hasAddon('publicaciones')) return next();
  res.status(403).json({ error: 'Publicaciones en redes es un servicio adicional: pide que lo activen para tu empresa.', code: 'ADDON_REQUIRED' });
}

const requireUuid = (param: string, label: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!UUID_PATTERN.test(req.params[param] || '')) return res.status(400).json({ error: `${label} inválido` });
  next();
};
const requirePostId = requireUuid('postId', 'Id de publicación');

/** Sin la migración 025 las tablas nuevas no existen: se explica en lugar de mostrar el error técnico. */
function explain(error: any): string {
  const message = String(error?.message || error);
  if (/social_assets|supplier_catalogs|supplier_products|social_metrics|media/.test(message) && /does not exist|schema cache|could not find/i.test(message)) {
    return 'Falta aplicar migrations/025_agente_de_redes.sql en Supabase (SQL Editor) para usar esta función.';
  }
  return message;
}

/** Productos del catálogo por nombre exacto: una publicación nunca muestra algo que no está en el catálogo. */
async function catalogProducts(names: unknown) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const catalog = await getAllProducts();
  const found = names.slice(0, MAX_CAROUSEL).map(n => catalog.find((c: any) => c.name === String(n) && c.image_url));
  if (found.some(f => !f)) throw new Error('Algún producto no está en el catálogo o no tiene foto');
  return found.map(toPostProduct);
}

/** Fotos y videos de la biblioteca, en el orden elegido. */
async function libraryMedia(ids: unknown): Promise<PostMedia[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const wanted = ids.slice(0, MAX_CAROUSEL).map(String).filter(id => UUID_PATTERN.test(id));
  const assets = await getAssets(wanted);
  const media = wanted.map(id => assets.find(a => a.id === id)).filter(Boolean).map(a => ({ type: a!.kind, url: a!.url, asset_id: a!.id }));
  if (media.length !== wanted.length) throw new Error('Algún archivo ya no está en la biblioteca');
  return media;
}

/**
 * Carrusel mezclado, en el orden elegido: fotos del Catálogo ({ product: nombre }) y fotos o videos de la biblioteca
 * ({ asset: id }). Hasta 10 elementos, el máximo que Instagram acepta en un carrusel.
 */
async function mixedItems(items: unknown[]): Promise<{ products: ReturnType<typeof toPostProduct>[]; media: PostMedia[] }> {
  const list = items.slice(0, MAX_CAROUSEL).map((item: any) => ({ product: item?.product ? String(item.product) : '', asset: item?.asset ? String(item.asset) : '' }));
  if (items.length > MAX_CAROUSEL) throw new Error(`Un carrusel lleva máximo ${MAX_CAROUSEL} fotos o videos`);
  const products = await catalogProducts(list.filter(i => i.product).map(i => i.product));
  const assets = await libraryMedia(list.filter(i => !i.product && i.asset).map(i => i.asset));
  let p = 0, a = 0;
  const media = list.filter(i => i.product || i.asset).map(i => (i.product
    ? { type: 'image' as const, url: products[p++].image_url }
    : assets[a++]));
  // Solo fotos del Catálogo: se guarda como siempre (sin "media"), igual que las que prepara la IA.
  return { products, media: assets.length ? media : [] };
}

function cleanChannels(value: unknown) {
  const channels = Array.isArray(value) ? POST_CHANNELS.filter(c => value.includes(c)) : [];
  if (channels.length === 0) throw new Error('Elige al menos una red donde publicar');
  return channels;
}

export function socialRouter(): Router {
  const router = express.Router();

  // ---------- Lector de PDF (se usa en el navegador para leer los catálogos de proveedores) ----------
  const PDFJS_DIR = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build');
  router.get('/crm/pdfjs/:file', (req: Request, res: Response) => {
    const file = req.params.file;
    if (!['pdf.min.mjs', 'pdf.worker.min.mjs'].includes(file)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('text/javascript').sendFile(path.join(PDFJS_DIR, file));
  });

  // ---------- Calendario de publicaciones ----------

  router.get('/api/posts', requireCrmSession, async (req: Request, res: Response) => {
    // Sin el servicio se responde igual: el CRM muestra qué ofrece y cómo pedirlo.
    if (!hasAddon('publicaciones')) return res.json({ enabled: false });
    try {
      const now = Date.now();
      const from = new Date(Number.isFinite(Date.parse(String(req.query.from))) ? String(req.query.from) : now - 30 * 86_400_000).toISOString();
      const to = new Date(Number.isFinite(Date.parse(String(req.query.to))) ? String(req.query.to) : now + 60 * 86_400_000).toISOString();
      const [posts, saved, status, plan] = await Promise.all([
        listPosts(from, to),
        getSavedSettings(),
        publishingStatus().catch(error => ({ connected: false, error: error.message })),
        lastPlanSummary()
      ]);
      res.json({ enabled: true, posts, settings: saved || DEFAULT_SETTINGS, settingsSaved: !!saved, status, timezone: profile().business.timezone, plan });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/posts/settings', requireCrmSession, requireOwnerRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      const settings = await saveSettings(req.body);
      // Al encender el modo automático la IA programa de una vez los próximos 7 días (no espera a la revisión de cada hora).
      const created = settings.autoPlan ? await planUpcomingPosts(new Date(), 7, settings) : [];
      res.json({ settings, created: created.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** Prepara los próximos 7 días con la configuración guardada (o la de siempre si aún no se guardó). */
  router.post('/api/posts/plan', requireCrmSession, requireEditorRole, requirePublishing, async (_req: Request, res: Response) => {
    try {
      const created = await planUpcomingPosts(new Date(), 7, (await getSavedSettings()) || DEFAULT_SETTINGS);
      res.json({ created });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** La planificación que propone el agente para los próximos 7 días, sin guardar nada (se revisa en el CRM). */
  router.post('/api/posts/plan/preview', requireCrmSession, requireEditorRole, requirePublishing, async (_req: Request, res: Response) => {
    try {
      res.json(await draftUpcomingPosts(new Date(), 7, (await getSavedSettings()) || DEFAULT_SETTINGS));
    } catch (error: any) {
      res.status(500).json({ error: explain(error) });
    }
  });

  /** Programa la planificación revisada (tal como se vio, sin las que se quitaron). Precios y fotos se leen de nuevo del Catálogo. */
  router.post('/api/posts/plan/confirm', requireCrmSession, requireEditorRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      const list = Array.isArray(req.body?.drafts) ? req.body.drafts.slice(0, 40) : [];
      if (list.length === 0) return res.status(400).json({ error: 'No hay publicaciones para programar' });
      const drafts = [];
      for (const d of list) {
        const when = new Date(String(d?.scheduled_at || ''));
        if (!Number.isFinite(when.getTime()) || when.getTime() < Date.now() + 2 * 60 * 1000) throw new Error('Alguna publicación ya pasó su hora: vuelve a pedir la propuesta');
        if (when.getTime() > Date.now() + 15 * 86_400_000) throw new Error('Fecha fuera de rango');
        const channels = cleanChannels(d?.channels);
        const caption = String(d?.caption || '').trim();
        if (caption.length > CAPTION_LIMIT) throw new Error(`Un texto pasa de ${CAPTION_LIMIT} caracteres`);
        if (!caption && channels.some(c => c !== 'instagram_story')) throw new Error('A una publicación le falta el texto');
        const { products, media } = await mixedItems(Array.isArray(d?.items) ? d.items : []);
        if (products.length === 0 && media.length === 0) throw new Error('A una publicación le faltan las fotos');
        drafts.push({ scheduled_at: when.toISOString(), channels, caption, products, media, theme: String(d?.theme || '').trim().slice(0, 80) || 'Nuestros productos' });
      }
      const created = await schedulePlan(drafts, String(req.body?.summary || '').slice(0, 600));
      res.status(201).json({ created: created.length });
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.post('/api/posts', requireCrmSession, requireEditorRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      const when = new Date(String(req.body?.scheduled_at || ''));
      if (!Number.isFinite(when.getTime())) return res.status(400).json({ error: 'Elige el día y la hora' });
      if (when.getTime() < Date.now() - 2 * 60 * 1000) return res.status(400).json({ error: 'Esa hora ya pasó: elige otra (o créala y usa "Publicar ahora")' });
      let caption = String(req.body?.caption || '').trim();
      if (caption.length > CAPTION_LIMIT) return res.status(400).json({ error: `El texto pasa de ${CAPTION_LIMIT} caracteres` });
      const { products, media } = Array.isArray(req.body?.items)
        ? await mixedItems(req.body.items)
        : { products: await catalogProducts(req.body?.products), media: await libraryMedia(req.body?.media) };
      if (products.length === 0 && media.length === 0) return res.status(400).json({ error: 'Elige al menos una foto o video' });
      const channels = cleanChannels(req.body?.channels);
      const theme = String(req.body?.theme || '').trim().slice(0, 80) || 'Nuestros productos';
      // Sin texto, lo escribe la IA; si no responde, va el texto de respaldo (siempre se puede cambiar antes de que salga).
      if (!caption) {
        const draft = { theme, products } as any;
        caption = await rewriteCaption(draft).catch(() => fallbackCaption(draft));
      }
      const [post] = await insertPosts([{
        // Queda programada: se publica sola a esa hora, sin pedir aprobación.
        // "media" solo si lleva archivos de la biblioteca: así crear publicaciones funciona aunque falte la migración 025.
        scheduled_at: when.toISOString(), status: 'approved', channels, caption, products, ...(media.length ? { media } : {}), theme, results: {}, error: null
      }]);
      const used = media.filter(m => m.asset_id).map(m => m.asset_id!);
      if (used.length) await markAssetsUsed(used).catch(() => {});
      // La publicación trae su propio campo "error" (motivo de un fallo): va envuelta para que el CRM no lo tome como error de la petición.
      res.status(201).json({ post });
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.patch('/api/posts/:postId', requireCrmSession, requireEditorRole, requirePublishing, requirePostId, async (req: Request, res: Response) => {
    try {
      const post = await getPost(req.params.postId);
      if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
      if (!EDITABLE_STATUSES.includes(post.status)) return res.status(400).json({ error: 'Esta publicación ya no se puede cambiar' });

      const changes: Record<string, any> = {};
      if (req.body?.caption !== undefined) {
        changes.caption = String(req.body.caption).trim();
        if (changes.caption.length > CAPTION_LIMIT) return res.status(400).json({ error: `El texto pasa de ${CAPTION_LIMIT} caracteres` });
      }
      if (req.body?.scheduled_at !== undefined) {
        const when = new Date(String(req.body.scheduled_at));
        if (!Number.isFinite(when.getTime())) return res.status(400).json({ error: 'Fecha inválida' });
        changes.scheduled_at = when.toISOString();
      }
      if (req.body?.channels !== undefined) changes.channels = cleanChannels(req.body.channels);
      if (req.body?.products !== undefined) changes.products = await catalogProducts(req.body.products);
      if (req.body?.status !== undefined) {
        const status = String(req.body.status) as PostStatus;
        if (!['draft', 'approved', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
        changes.status = status;
      }

      // Cambiar una publicación la deja programada otra vez (también a una que falló) si su hora es futura.
      if (changes.status === undefined && post.status !== 'approved' && new Date(changes.scheduled_at || post.scheduled_at).getTime() > Date.now()) {
        changes.status = 'approved';
      }
      const final = { ...post, ...changes };
      if (final.status === 'approved') {
        if (!final.caption && final.channels.some((c: PostChannel) => c !== 'instagram_story')) return res.status(400).json({ error: 'Escribe el texto de la publicación' });
        // Programar algo con hora pasada lo publicaría de golpe: para eso está "Publicar ahora".
        if (new Date(final.scheduled_at).getTime() < Date.now()) return res.status(400).json({ error: 'La hora ya pasó: elige otra o usa "Publicar ahora"' });
        changes.error = null;
      }
      const updated = await updatePost(post.id, changes, EDITABLE_STATUSES);
      if (!updated) return res.status(409).json({ error: 'La publicación cambió mientras la editabas; recarga' });
      res.json({ post: updated });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/api/posts/:postId/publish', requireCrmSession, requireEditorRole, requirePublishing, requirePostId, async (req: Request, res: Response) => {
    try {
      const post = await getPost(req.params.postId);
      if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
      if (!post.caption.trim() && post.channels.some(c => c !== 'instagram_story')) return res.status(400).json({ error: 'Escribe el texto antes de publicar' });
      const done = await claimAndPublish(post, EDITABLE_STATUSES);
      if (!done) return res.status(409).json({ error: 'Esta publicación ya se está publicando o ya salió' });
      res.json({ post: done });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** Elimina una publicación que todavía no salió: desaparece del calendario y su día queda libre. */
  router.delete('/api/posts/:postId', requireCrmSession, requireEditorRole, requirePublishing, requirePostId, async (req: Request, res: Response) => {
    try {
      if (!(await deletePost(req.params.postId))) return res.status(409).json({ error: 'Esta publicación ya salió o se está publicando: no se puede eliminar' });
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** Otro texto hecho por la IA; no se guarda hasta que la empresa lo acepte. */
  router.post('/api/posts/:postId/rewrite', requireCrmSession, requireEditorRole, requirePublishing, requirePostId, async (req: Request, res: Response) => {
    try {
      const post = await getPost(req.params.postId);
      if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
      res.json({ caption: await rewriteCaption(post) });
    } catch (error: any) {
      const noCredits = /credit|quota/i.test(error.message);
      res.status(500).json({ error: noCredits ? 'La IA no tiene créditos en OpenAI: escribe el texto a mano o recarga créditos.' : `No se pudo escribir otro texto: ${error.message}` });
    }
  });

  // ---------- Biblioteca de fotos y videos ----------

  const requireAssetId = requireUuid('assetId', 'Archivo');

  router.get('/api/social/assets', requireCrmSession, requirePublishing, async (_req: Request, res: Response) => {
    try {
      res.json({ assets: await listAssets() });
    } catch (error: any) {
      res.status(500).json({ error: explain(error) });
    }
  });

  /** Permiso para subir un archivo directo al almacenamiento desde el navegador. */
  router.post('/api/social/assets/upload', requireCrmSession, requireEditorRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      res.json(await createUpload(String(req.body?.contentType || ''), Number(req.body?.size)));
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.post('/api/social/assets', requireCrmSession, requireEditorRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      res.status(201).json({ asset: await registerAsset(req.body || {}) });
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.patch('/api/social/assets/:assetId', requireCrmSession, requireEditorRole, requirePublishing, requireAssetId, async (req: Request, res: Response) => {
    try {
      const asset = await updateAsset(req.params.assetId, req.body || {});
      if (!asset) return res.status(404).json({ error: 'Archivo no encontrado' });
      res.json({ asset });
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.delete('/api/social/assets/:assetId', requireCrmSession, requireEditorRole, requirePublishing, requireAssetId, async (req: Request, res: Response) => {
    try {
      if (!(await deleteAsset(req.params.assetId))) return res.status(404).json({ error: 'Archivo no encontrado' });
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: explain(error) });
    }
  });

  // ---------- Catálogos de proveedores ----------

  router.get('/api/social/suppliers', requireCrmSession, requirePublishing, async (_req: Request, res: Response) => {
    try {
      const [settings, data, catalog] = await Promise.all([getSupplierSettings(), listSupplierCatalogs(), getAllProducts()]);
      // Avance de las fotos con el diseño de la empresa; si el servidor se reinició a medio camino, se retoman.
      const posters: Record<string, unknown> = {};
      const working: Record<string, boolean> = {};
      for (const c of data.catalogs as any[]) {
        posters[c.id] = await posterStates(c.id);
        void resumeStuck(c.id);
        working[c.id] = postersRunning(c.id);
      }
      // Con qué empaque entran si la regla no elige uno (el más usado en su Catálogo).
      const categories = [...new Set((catalog as any[]).map(p => String(p.category || '').trim()).filter(Boolean))].sort();
      res.json({ settings, ...data, autoPackaging: mostUsedPackaging(catalog), posters, postersRunning: working, posterCost: POSTER_COST, categories });
    } catch (error: any) {
      res.status(500).json({ error: explain(error) });
    }
  });

  router.put('/api/social/suppliers/settings', requireCrmSession, requireOwnerRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      res.json(await saveSupplierSettings(req.body));
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  /** Catálogo ya leído en el navegador: se guarda y (en automático) sus modelos pasan al Catálogo. */
  router.post('/api/social/suppliers', requireCrmSession, requireEditorRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      // Con la IA del agente, los modelos no entran directo: primero se revisa cuáles ya tiene la empresa (en segundo
      // plano, en el servidor: no depende de que la pantalla siga abierta) y, si la regla lo pide, se hacen sus fotos.
      const review = await hasSocialAi();
      const result = await importSupplierCatalog(req.body || {}, review);
      if (review && result.ids.length) {
        const settings = await getSupplierSettings();
        await startPosters(result.catalog.id, { ids: result.ids, posters: settings.autoPosters });
      }
      res.status(201).json(result);
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.patch('/api/social/suppliers/products/:productId', requireCrmSession, requireEditorRole, requirePublishing, requireUuid('productId', 'Modelo'), async (req: Request, res: Response) => {
    try {
      const product = await updateSupplierProduct(req.params.productId, req.body || {});
      if (!product) return res.status(404).json({ error: 'Modelo no encontrado' });
      // Otro tamaño = otro precio (u otro nombre): la foto con el diseño tenía el anterior. Mientras se hace la nueva, el
      // Catálogo muestra la foto original del PDF (nunca un precio equivocado).
      if ((req.body?.size !== undefined || req.body?.name !== undefined) && (await posterStates(product.catalog_id))[product.id]) {
        if (product.catalog_product_id && product.image_url) await updateProduct(product.catalog_product_id, { image_url: product.image_url });
        await startPosters(product.catalog_id, { ids: [product.id], posters: true }).catch(error => console.warn('⚠️ No se pudo rehacer la foto con el diseño:', error.message));
      }
      res.json({ product });
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.post('/api/social/suppliers/to-catalog', requireCrmSession, requireEditorRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter((id: string) => UUID_PATTERN.test(id)) : [];
      res.json(await addSupplierProductsToCatalog(ids));
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.delete('/api/social/suppliers/:catalogId', requireCrmSession, requireEditorRole, requirePublishing, requireUuid('catalogId', 'Catálogo'), async (req: Request, res: Response) => {
    try {
      // Se borra de todos lados: la lista y los productos que entraron al Catálogo desde este PDF.
      const result = await deleteSupplierCatalog(req.params.catalogId);
      if (!result.deleted) return res.status(404).json({ error: 'Catálogo no encontrado' });
      await clearPosterStates(req.params.catalogId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: explain(error) });
    }
  });

  /** Fotos con el diseño de la empresa: todas las que faltan o, con ids, las que se piden rehacer. Sigue en segundo plano. */
  router.post('/api/social/suppliers/:catalogId/posters', requireCrmSession, requireEditorRole, requirePublishing, requireUuid('catalogId', 'Catálogo'), async (req: Request, res: Response) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter((id: string) => UUID_PATTERN.test(id)) : undefined;
      // posters: false = solo revisar cuáles ya tiene la empresa (sin hacer fotos).
      res.json(await startPosters(req.params.catalogId, { ids, posters: req.body?.posters !== false }));
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  /** "No es el mismo": la IA creyó que la empresa ya lo tenía; entra al Catálogo (y a la fila de fotos si la regla lo pide). */
  router.post('/api/social/suppliers/:catalogId/models/:productId/keep', requireCrmSession, requireEditorRole, requirePublishing, requireUuid('catalogId', 'Catálogo'), requireUuid('productId', 'Modelo'), async (req: Request, res: Response) => {
    try {
      const { products } = await listSupplierCatalogs();
      const model = products.find(p => p.id === req.params.productId && p.catalog_id === req.params.catalogId);
      if (!model) return res.status(404).json({ error: 'Modelo no encontrado' });
      res.json({ poster: await keepModel(req.params.catalogId, model) });
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  /** Lleva el catálogo (y sus productos) a otra categoría del Catálogo, nueva o de las que ya existen. */
  router.patch('/api/social/suppliers/:catalogId', requireCrmSession, requireEditorRole, requirePublishing, requireUuid('catalogId', 'Catálogo'), async (req: Request, res: Response) => {
    try {
      res.json(await moveSupplierCatalog(req.params.catalogId, req.body?.name));
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  /** Usa un afiche que quedó "para revisar". */
  router.post('/api/social/suppliers/:catalogId/posters/:productId/apply', requireCrmSession, requireEditorRole, requirePublishing, requireUuid('catalogId', 'Catálogo'), requireUuid('productId', 'Modelo'), async (req: Request, res: Response) => {
    try {
      const { products } = await listSupplierCatalogs();
      const model = products.find(p => p.id === req.params.productId && p.catalog_id === req.params.catalogId);
      if (!model) return res.status(404).json({ error: 'Modelo no encontrado' });
      res.json({ poster: await applyPoster(req.params.catalogId, model) });
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  // ---------- Cerebro del agente: su propia clave de OpenAI y sus modelos ----------

  router.get('/api/social/ai', requireCrmSession, requirePublishing, async (_req: Request, res: Response) => {
    try {
      res.json(await publicSocialAi());
    } catch (error: any) {
      res.status(500).json({ error: explain(error) });
    }
  });

  router.put('/api/social/ai', requireCrmSession, requireOwnerRole, requirePublishing, async (req: Request, res: Response) => {
    try {
      res.json(await saveSocialAi(req.body || {}));
    } catch (error: any) {
      res.status(400).json({ error: explain(error) });
    }
  });

  router.post('/api/social/ai/test', requireCrmSession, requireOwnerRole, requirePublishing, async (_req: Request, res: Response) => {
    res.json(await testSocialAi());
  });

  // ---------- Resultados ----------

  router.get('/api/social/results', requireCrmSession, requirePublishing, async (req: Request, res: Response) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
      res.json(await listResults(days));
    } catch (error: any) {
      res.status(500).json({ error: explain(error) });
    }
  });

  return router;
}

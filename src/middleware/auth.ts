import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { runWithTenant } from '../services/tenant';

const CRM_PASSWORD = process.env.CRM_PASSWORD || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CrmRole = 'admin' | 'owner' | 'manager' | 'staff';

/** Quién hizo la petición al CRM. */
export interface CrmSession {
  role: CrmRole;
  /** Negocio en que se trabaja; sin él (solo admin) se trabaja en VELAMIA. */
  businessId?: string;
  tokenId?: string;
  userId?: string | null;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isPasswordValid(password: string): boolean {
  if (!CRM_PASSWORD) return false;
  return safeCompare(password, CRM_PASSWORD);
}

/**
 * Sesión firmada. Sin "tid" es la del administrador (contraseña maestra); con "tid" es la de un negocio,
 * atada al token con que entró: si ese token se revoca o vence, la sesión deja de valer.
 */
export function issueSessionToken(access?: { tokenId: string; businessId: string }): string {
  const data: Record<string, any> = { exp: Date.now() + SESSION_DURATION_MS };
  if (access) {
    data.tid = access.tokenId;
    data.bid = access.businessId;
  }
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', CRM_PASSWORD).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSessionToken(token: string): { exp: number; tid?: string; bid?: string } | null {
  if (!CRM_PASSWORD) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = createHmac('sha256', CRM_PASSWORD).update(payload).digest('base64url');
  if (!safeCompare(signature, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof data.exp === 'number' && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export function getCrmSession(req: Request): CrmSession {
  return (req as any).crmSession;
}

/**
 * Acceso al CRM. El administrador trabaja en VELAMIA o, con la cabecera X-Business-Id, en el negocio elegido.
 * El dueño de un negocio trabaja siempre y solo en el suyo. Todo lo que sigue (consultas, envíos por
 * WhatsApp, IA) corre dentro de ese negocio.
 */
export async function requireCrmSession(req: Request, res: Response, next: NextFunction) {
  if (!CRM_PASSWORD) {
    return res.status(503).json({ error: 'CRM sin configurar: falta la variable CRM_PASSWORD en el servidor' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const data = token ? readSessionToken(token) : null;
  if (!data) {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }

  try {
    const { loadTenant, getActiveAccessById } = await import('../services/supabase');
    let session: CrmSession;
    let businessId: string | undefined;

    if (data.tid) {
      const access = await getActiveAccessById(data.tid);
      if (!access || access.businessId !== data.bid) {
        return res.status(401).json({ error: 'Tu acceso fue revocado o venció. Pide un nuevo token.' });
      }
      businessId = access.businessId;
      session = { role: access.role, businessId, tokenId: access.tokenId, userId: access.userId };
    } else {
      const requested = String(req.headers['x-business-id'] || '').trim();
      if (requested && !UUID_PATTERN.test(requested)) {
        return res.status(400).json({ error: 'Negocio inválido' });
      }
      businessId = requested || undefined;
      session = { role: 'admin', businessId };
    }

    const tenant = businessId ? await loadTenant(businessId) : undefined;
    if (businessId && !tenant) {
      return res.status(404).json({ error: 'Negocio no encontrado o desactivado' });
    }

    // El personal (staff) solo consulta: no cambia datos ni escribe a clientes.
    if (session.role === 'staff' && req.method !== 'GET') {
      return res.status(403).json({ error: 'Tu usuario solo tiene permiso de consulta' });
    }

    (req as any).crmSession = session;
    runWithTenant(tenant || undefined, () => next());
  } catch (error: any) {
    console.error('Error validando sesión:', error.message);
    res.status(500).json({ error: 'No se pudo validar la sesión' });
  }
}

/** Configuración del negocio (perfil, instrucciones, datos bancarios, claves): solo el dueño o el admin. */
export function requireOwnerRole(req: Request, res: Response, next: NextFunction) {
  const role = getCrmSession(req)?.role;
  if (role === 'admin' || role === 'owner') return next();
  res.status(403).json({ error: 'Solo el dueño del negocio puede cambiar esta configuración' });
}

/** Administración global del sistema (crear negocios, usuarios, tokens): solo la contraseña maestra. */
export function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  if (!CRM_PASSWORD) {
    return res.status(503).json({ error: 'CRM sin configurar: falta la variable CRM_PASSWORD en el servidor' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const data = token ? readSessionToken(token) : null;
  if (!data || data.tid) {
    return res.status(401).json({ error: 'Se requiere sesión de administrador' });
  }

  (req as any).crmSession = { role: 'admin' } as CrmSession;
  // La administración nunca corre dentro de un negocio, aunque el CRM tenga uno elegido.
  runWithTenant(undefined, () => next());
}

/**
 * Meta firma cada webhook con el App Secret. Sin esta verificación cualquiera
 * podría inyectar mensajes falsos y disparar respuestas (y costos) de OpenAI.
 */
export function verifyWebhookSignature(req: Request, res: Response, next: NextFunction) {
  if (!APP_SECRET) {
    console.warn('⚠️  META_APP_SECRET no configurado: el webhook acepta peticiones sin verificar firma');
    return next();
  }

  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!signature || !rawBody) {
    return res.status(401).send('Firma ausente');
  }

  const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  if (!safeCompare(signature, expected)) {
    console.warn('🚫 Webhook rechazado: firma inválida');
    return res.status(401).send('Firma inválida');
  }

  next();
}

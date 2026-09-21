import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { runWithTenant, VELAMIA_ID } from '../services/tenant';

const CRM_PASSWORD = process.env.CRM_PASSWORD || '';
// Cada app de Meta firma sus webhooks con su propio secreto. Si alguna empresa usa otra app,
// su secreto se agrega en META_APP_SECRETS (separados por coma) junto al principal.
const APP_SECRETS = [process.env.META_APP_SECRET || '', ...(process.env.META_APP_SECRETS || '').split(',')]
  .map(secret => secret.trim())
  .filter(Boolean);
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Llave con que se firman las sesiones. Antes era la contraseña maestra: cualquiera con una sesión (incluso el usuario
 * de una empresa cliente) podía adivinarla probando contraseñas en su computador. Ahora sale de la llave de cifrado
 * del servidor (256 bits) junto con la contraseña: sin esa llave no se puede falsificar ni adivinar nada, y cambiar
 * la contraseña maestra sigue cerrando todas las sesiones. Sin la llave el servidor no arranca: volver a firmar con la
 * contraseña dejaría las sesiones adivinables.
 */
const SECRETS_KEY = process.env.BUSINESS_SECRETS_KEY || '';
if (SECRETS_KEY.length < 16) {
  throw new Error('Falta la variable BUSINESS_SECRETS_KEY (mínimo 16 caracteres): sin ella no se pueden firmar sesiones seguras');
}
const SESSION_KEY = createHmac('sha256', SECRETS_KEY).update(`sesiones-crm:${CRM_PASSWORD}`).digest();

/** Contraseña maestra débil: el servidor lo avisa al arrancar. */
export function weakMasterPassword(): boolean {
  const p = CRM_PASSWORD;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(p)).length;
  return p.length < 14 || kinds < 3;
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CrmRole = 'admin' | 'owner' | 'manager' | 'staff';

/** Quién hizo la petición al CRM. */
export interface CrmSession {
  role: CrmRole;
  /** Negocio en que se trabaja; sin él (solo admin) se trabaja en VELAMIA. */
  businessId?: string;
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
 * Sesión firmada. Sin "uid" es la de la administradora (contraseña maestra); con "uid" es la de un usuario
 * de una empresa. Si el usuario o su empresa se desactivan, la sesión deja de valer.
 */
export function issueSessionToken(access?: { userId: string; businessId: string | null }): string {
  const data: Record<string, any> = { exp: Date.now() + SESSION_DURATION_MS };
  if (access) {
    data.uid = access.userId;
    data.bid = access.businessId;
  }
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSessionToken(token: string): { exp: number; uid?: string; bid?: string | null } | null {
  if (!CRM_PASSWORD) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
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

// Definido junto al contexto de empresa para que también lo pueda usar la capa de datos.
export { VELAMIA_ID };

/**
 * Acceso al CRM. El administrador primero elige empresa (cabecera X-Business-Id: un id de negocio o "velamia");
 * sin elegir solo puede ver la plataforma general. Un usuario de una empresa trabaja siempre y solo
 * en la suya. Todo lo que sigue (consultas, envíos por WhatsApp, IA) corre dentro de esa empresa.
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
    const { loadTenant, getActiveUserAccess } = await import('../services/supabase');
    let session: CrmSession;
    // undefined = sin empresa elegida; VELAMIA_ID = VELAMIA; otro = id del negocio.
    let businessId: string | undefined;

    if (data.uid) {
      const access = await getActiveUserAccess(data.uid);
      if (!access || (access.businessId ?? null) !== (data.bid ?? null)) {
        return res.status(401).json({ error: 'Tu usuario fue desactivado. Vuelve a entrar o habla con la administradora.' });
      }
      businessId = access.businessId ?? VELAMIA_ID;
      session = { role: access.role, businessId, userId: access.userId };
    } else {
      const requested = String(req.headers['x-business-id'] || '').trim().toLowerCase();
      if (requested && requested !== VELAMIA_ID && !UUID_PATTERN.test(requested)) {
        return res.status(400).json({ error: 'Empresa inválida' });
      }
      businessId = requested || undefined;
      session = { role: 'admin', businessId };
    }

    // Sin empresa elegida no hay datos que mostrar: solo la pantalla general de la plataforma.
    if (!businessId && req.path !== '/api/session') {
      return res.status(400).json({ error: 'Elige una empresa para trabajar', code: 'NO_BUSINESS' });
    }

    const isTenant = !!businessId && businessId !== VELAMIA_ID;
    const tenant = isTenant ? await loadTenant(businessId!) : undefined;
    if (isTenant && !tenant) {
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
  res.status(403).json({ error: 'Solo el dueño del negocio puede hacer este cambio' });
}

/** Atender y editar (enviar mensajes, catálogo, pedidos): dueño y encargado. "Solo consulta" solo mira. */
export function requireEditorRole(req: Request, res: Response, next: NextFunction) {
  const role = getCrmSession(req)?.role;
  if (role === 'admin' || role === 'owner' || role === 'manager') return next();
  res.status(403).json({ error: 'Tu usuario es solo de consulta: no puede hacer cambios' });
}

/** Administración global del sistema (crear negocios, usuarios, tokens): solo la contraseña maestra. */
export function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  if (!CRM_PASSWORD) {
    return res.status(503).json({ error: 'CRM sin configurar: falta la variable CRM_PASSWORD en el servidor' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const data = token ? readSessionToken(token) : null;
  if (!data || data.uid) {
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
  if (APP_SECRETS.length === 0) {
    // Solo en la computadora de desarrollo se aceptan mensajes sin firma; en el servidor se rechazan.
    if (process.env.NODE_ENV === 'development') {
      console.warn('⚠️  META_APP_SECRET no configurado: el webhook acepta peticiones sin verificar firma (solo desarrollo)');
      return next();
    }
    console.error('🚫 Webhook rechazado: falta META_APP_SECRET en el servidor');
    return res.status(503).send('Webhook sin configurar');
  }

  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!signature || !rawBody) {
    return res.status(401).send('Firma ausente');
  }

  const valid = APP_SECRETS.some(secret => safeCompare(signature, 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')));
  if (!valid) {
    console.warn('🚫 Webhook rechazado: firma inválida');
    return res.status(401).send('Firma inválida');
  }

  next();
}

import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

const CRM_PASSWORD = process.env.CRM_PASSWORD || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

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

export function issueSessionToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DURATION_MS })).toString('base64url');
  const signature = createHmac('sha256', CRM_PASSWORD).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function isSessionTokenValid(token: string): boolean {
  if (!CRM_PASSWORD) return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = createHmac('sha256', CRM_PASSWORD).update(payload).digest('base64url');
  if (!safeCompare(signature, expected)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

export function requireCrmSession(req: Request, res: Response, next: NextFunction) {
  if (!CRM_PASSWORD) {
    return res.status(503).json({ error: 'CRM sin configurar: falta la variable CRM_PASSWORD en el servidor' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !isSessionTokenValid(token)) {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }

  next();
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

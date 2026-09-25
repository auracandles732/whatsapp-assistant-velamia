import { currentTenant } from './tenant';

/**
 * Si la IA está fallando (por ejemplo, OpenAI sin créditos) el bot deja de responder: se anota por empresa para que el
 * CRM lo muestre bien visible y el aviso a la dueña diga el motivo. Se borra con la primera respuesta que funcione.
 */

export type AiProblem = { reason: 'credits' | 'error'; at: string };

const problems = new Map<string, { reason: AiProblem['reason']; at: number }>();
// Un fallo viejo sin mensajes nuevos no se sigue mostrando.
const SHOW_FOR_MS = 12 * 60 * 60 * 1000;

const key = () => currentTenant()?.businessId || 'velamia';

/** OpenAI sin saldo: "insufficient_quota" o "credit_balance_exhausted" (429). */
export function isNoCredits(error: any): boolean {
  const text = [error?.code, error?.error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  return /insufficient_quota|credit_balance|no credits|exceeded your current quota|billing/i.test(text);
}

export function reportAiFailure(error: any) {
  problems.set(key(), { reason: isNoCredits(error) ? 'credits' : 'error', at: Date.now() });
}

export function reportAiSuccess() {
  problems.delete(key());
}

export function currentAiProblem(now = Date.now()): AiProblem | null {
  const problem = problems.get(key());
  if (!problem || now - problem.at > SHOW_FOR_MS) return null;
  return { reason: problem.reason, at: new Date(problem.at).toISOString() };
}

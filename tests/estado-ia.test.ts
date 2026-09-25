/**
 * Si la IA falla (sobre todo OpenAI sin créditos) el bot deja de responder: el CRM lo muestra y el aviso dice el motivo.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { isNoCredits, reportAiFailure, reportAiSuccess, currentAiProblem } from '../src/services/aiStatus';

test('reconoce cuando OpenAI se quedó sin créditos', () => {
  assert.equal(isNoCredits({ message: '429 You have no credits remaining. Add credits to continue using the API' }), true);
  assert.equal(isNoCredits({ code: 'insufficient_quota', message: 'You exceeded your current quota' }), true);
  assert.equal(isNoCredits({ error: { code: 'credit_balance_exhausted' } }), true);
  assert.equal(isNoCredits({ message: 'Request timed out' }), false);
});

test('el problema se muestra hasta que la IA vuelve a responder, y uno viejo deja de mostrarse', () => {
  reportAiSuccess();
  assert.equal(currentAiProblem(), null);
  reportAiFailure({ message: '429 You have no credits remaining' });
  assert.equal(currentAiProblem()?.reason, 'credits');
  assert.equal(currentAiProblem(Date.now() + 13 * 60 * 60 * 1000), null, 'pasadas 12 horas sin mensajes ya no se muestra');
  reportAiFailure(new Error('Connection error'));
  assert.equal(currentAiProblem()?.reason, 'error');
  reportAiSuccess();
  assert.equal(currentAiProblem(), null);
});

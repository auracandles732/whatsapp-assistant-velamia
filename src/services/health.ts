import { supabase, getBusinessReadiness, getOwnerPhone, BusinessRow } from './supabase';
import { decryptSecret } from './tenant';
import { sendTextMessage } from './whatsapp';
import { hourLocal } from '../config/businessProfile';

/** Consulta a Meta y a OpenAI con las claves del negocio; devuelve qué funciona y qué no, en español. */
export async function testBusinessCredentials(row: BusinessRow) {
  const result: { whatsapp: { ok: boolean; detail: string }; openai: { ok: boolean; detail: string } } = {
    whatsapp: { ok: false, detail: '' },
    openai: { ok: false, detail: '' }
  };

  const token = decryptSecret(row.meta_access_token);
  if (!token || !row.meta_phone_number_id) {
    result.whatsapp.detail = 'Falta el token de Meta o el Phone Number ID';
  } else {
    try {
      const response = await fetch(`https://graph.facebook.com/v25.0/${row.meta_phone_number_id}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data: any = await response.json();
      // Si Meta rechaza el token, ayuda saber cómo llegó: los suyos empiezan con "EAA" y son largos.
      const shape = `token guardado: empieza con "${token.slice(0, 3)}", ${token.length} caracteres`;
      result.whatsapp = response.ok
        ? { ok: true, detail: `Conectado: ${data.verified_name || ''} ${data.display_phone_number || ''}`.trim() }
        : { ok: false, detail: `${data?.error?.message || `Meta respondió ${response.status}`} (${shape})` };
    } catch (error: any) {
      result.whatsapp.detail = `No se pudo consultar a Meta: ${error.message}`;
    }
  }

  const openaiKey = decryptSecret(row.openai_api_key);
  if (!openaiKey) {
    result.openai.detail = 'Falta la clave de OpenAI';
  } else {
    try {
      const response = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${openaiKey}` } });
      result.openai = response.ok
        ? { ok: true, detail: 'Clave válida' }
        : { ok: false, detail: response.status === 401 ? 'Clave inválida o revocada' : `OpenAI respondió ${response.status}` };
    } catch (error: any) {
      result.openai.detail = `No se pudo consultar a OpenAI: ${error.message}`;
    }
  }

  return result;
}

// ---------- REVISIÓN DIARIA ----------

/** Estado de la última revisión, guardado fuera de cualquier empresa (es de la plataforma). */
const STATE_KEY = 'platform_health';
const ALERT_HOUR = 9;
const CHECK_EVERY_MS = 30 * 60 * 1000;

interface HealthState {
  lastRun: string;
  failing: Record<string, string>;
}

async function readState(): Promise<HealthState> {
  const { data } = await supabase.from('business_config').select('value').eq('key', STATE_KEY).maybeSingle();
  try {
    const parsed = data?.value ? JSON.parse(data.value) : null;
    return { lastRun: parsed?.lastRun || '', failing: parsed?.failing || {} };
  } catch {
    return { lastRun: '', failing: {} };
  }
}

async function writeState(state: HealthState) {
  await supabase.from('business_config')
    .upsert({ key: STATE_KEY, value: JSON.stringify(state), updated_at: new Date().toISOString() });
}

/** A quién avisar cuando una empresa deja de atender: la administradora de la plataforma. */
async function alertPhone(): Promise<string> {
  const fromEnv = (process.env.PLATFORM_ALERT_PHONE || '').replace(/\D/g, '');
  return fromEnv || (await getOwnerPhone()) || '';
}

/** Revisa cada empresa activa y devuelve qué le impide atender ahora mismo ('' si está bien). */
async function problemsOf(row: BusinessRow): Promise<string> {
  const readiness = await getBusinessReadiness(row);
  const missing = readiness.items.filter(item => item.required && !item.ok).map(item => item.label);
  if (missing.length > 0) return missing.join(', ');

  // Las claves están cargadas: falta saber si Meta y OpenAI siguen aceptándolas.
  const test = await testBusinessCredentials(row);
  const broken = [
    !test.whatsapp.ok && `WhatsApp (${test.whatsapp.detail})`,
    !test.openai.ok && `OpenAI (${test.openai.detail})`
  ].filter((v): v is string => typeof v === 'string');
  return broken.join(' · ');
}

/**
 * Revisa todas las empresas activas y avisa por WhatsApp solo cuando algo cambia:
 * cuando una empresa deja de poder atender y cuando vuelve a estar bien.
 */
export async function runHealthCheck(force = false) {
  const state = await readState();
  const today = new Date().toISOString().slice(0, 10);
  if (!force && state.lastRun === today) return { skipped: true, checked: 0, alerts: [] as string[] };

  const { data, error } = await supabase.from('businesses').select('*').eq('active', true);
  if (error) throw new Error(`Error revisando empresas: ${error.message}`);

  const rows = (data || []) as BusinessRow[];
  const failing: Record<string, string> = {};
  const alerts: string[] = [];

  for (const row of rows) {
    let problem = '';
    try {
      problem = await problemsOf(row);
    } catch (err: any) {
      problem = `no se pudo revisar: ${err.message}`;
    }
    const before = state.failing[row.id];
    if (problem) {
      failing[row.id] = problem;
      // Solo se avisa cuando aparece el problema o cuando cambia, no todos los días por lo mismo.
      if (before !== problem) alerts.push(`⚠️ *${row.name}*: ${problem}`);
    } else if (before) {
      alerts.push(`✅ *${row.name}*: ya quedó funcionando`);
    }
  }

  if (alerts.length > 0) {
    const phone = await alertPhone();
    const crm = process.env.RENDER_EXTERNAL_URL ? `\n\nCRM: ${process.env.RENDER_EXTERNAL_URL}/crm` : '';
    const text = `🩺 *Revisión diaria de la plataforma*\n\n${alerts.join('\n\n')}${crm}`;
    if (!phone) {
      console.warn('⚠️ Hay avisos de la revisión diaria pero falta PLATFORM_ALERT_PHONE:', alerts.join(' | '));
    } else {
      try {
        await sendTextMessage(phone, text);
      } catch (err: any) {
        // Fuera de 24 h WhatsApp no deja escribir texto libre: queda en el log del servidor.
        console.warn('⚠️ No se pudo enviar el aviso de la revisión diaria:', err.message, '·', alerts.join(' | '));
      }
    }
  }

  await writeState({ lastRun: today, failing });
  console.log(`🩺 Revisión diaria: ${rows.length} empresas · ${Object.keys(failing).length} con problemas · ${alerts.length} avisos`);
  return { skipped: false, checked: rows.length, failing, alerts };
}

/** Corre una vez al día, a la hora de la mañana definida, con la zona horaria de la plataforma. */
export function startHealthCheck() {
  const tick = () => {
    if (hourLocal(new Date()) < ALERT_HOUR) return;
    runHealthCheck().catch(error => console.error('❌ Error en la revisión diaria:', error.message));
  };
  setTimeout(tick, 2 * 60 * 1000);
  setInterval(tick, CHECK_EVERY_MS);
  console.log(`🩺 Revisión diaria de empresas activa (a partir de las ${ALERT_HOUR}:00)`);
}

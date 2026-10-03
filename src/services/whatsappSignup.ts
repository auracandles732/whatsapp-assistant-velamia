import axios from 'axios';
import { metaAppId } from './metaChannels';

/**
 * "Conectar WhatsApp" para las empresas: la ventana oficial de Meta (registro integrado). La empresa inicia sesión, elige
 * o crea su cuenta de WhatsApp y su número, y la plataforma recibe la clave para atenderlo, sin copiar ningún dato.
 * Necesita la configuración de "Inicio de sesión con Facebook para empresas" de WhatsApp creada en la App de Meta.
 */

const GRAPH = 'https://graph.facebook.com/v25.0';
const graph = axios.create({ timeout: 30_000 });

export const whatsappSignupConfigId = () => (process.env.META_WA_CONFIG_ID || '').trim();

/**
 * Dirección de la ventana de Meta. Con coexistencia la empresa sigue usando la app WhatsApp Business del celular con el
 * mismo número, y el asistente atiende desde la plataforma.
 */
export async function whatsappSignupUrl(redirectUri: string, state: string, coexistence: boolean): Promise<string> {
  const configId = whatsappSignupConfigId();
  if (!configId) throw new Error('El botón de WhatsApp todavía no está activado en la plataforma');
  const params = new URLSearchParams({
    client_id: await metaAppId(),
    redirect_uri: redirectUri,
    state,
    config_id: configId,
    response_type: 'code',
    override_default_response_type: 'true',
    extras: JSON.stringify({ setup: {}, featureType: coexistence ? 'whatsapp_business_app_onboarding' : '', sessionInfoVersion: '3' })
  });
  return `https://www.facebook.com/v25.0/dialog/oauth?${params}`;
}

export interface SignedUpNumber {
  token: string;
  wabaId: string;
  phoneNumberId: string;
  /** Solo dígitos, con código de país: 593991234567. */
  displayPhoneNumber: string;
  verifiedName: string;
  /** CLOUD_API si ya puede usarse con la API; otro valor si falta registrarlo. */
  platformType: string;
}

/** Cuentas de WhatsApp que la empresa compartió en la ventana de Meta (vienen en los permisos de la clave). */
export function sharedWabaIds(granularScopes: { scope: string; target_ids?: string[] }[]): string[] {
  const of = (scope: string) => granularScopes.find(g => g.scope === scope)?.target_ids || [];
  return [...new Set([...of('whatsapp_business_management'), ...of('whatsapp_business_messaging')])];
}

/** Cambia el código de la ventana por la clave de la empresa y busca la cuenta y el número que eligió. */
export async function completeWhatsAppSignup(code: string, redirectUri: string): Promise<SignedUpNumber> {
  const appId = await metaAppId();
  const secret = process.env.META_APP_SECRET || '';
  if (!secret) throw new Error('Falta META_APP_SECRET en el servidor');
  const { data } = await graph.get(`${GRAPH}/oauth/access_token`, { params: { client_id: appId, client_secret: secret, redirect_uri: redirectUri, code } });
  const token = String(data?.access_token || '');
  if (!token) throw new Error('Meta no entregó la clave de la cuenta de WhatsApp');

  const debug = await graph.get(`${GRAPH}/debug_token`, { params: { input_token: token, access_token: `${appId}|${secret}` } });
  const wabaIds = sharedWabaIds(debug.data?.data?.granular_scopes || []);
  if (wabaIds.length === 0) throw new Error('En la ventana de Meta no se eligió ninguna cuenta de WhatsApp. Vuelve a intentarlo y elige o crea la cuenta de tu negocio.');

  for (const wabaId of wabaIds) {
    const phones = await graph.get(`${GRAPH}/${wabaId}/phone_numbers`, {
      params: { fields: 'id,display_phone_number,verified_name,platform_type', access_token: token }
    });
    const phone = (phones.data?.data || [])[0];
    if (phone) {
      return {
        token,
        wabaId,
        phoneNumberId: String(phone.id),
        displayPhoneNumber: String(phone.display_phone_number || '').replace(/\D/g, ''),
        verifiedName: String(phone.verified_name || ''),
        platformType: String(phone.platform_type || '')
      };
    }
  }
  throw new Error('La cuenta de WhatsApp que elegiste todavía no tiene ningún número. Agrégalo en la ventana de Meta y vuelve a intentarlo.');
}

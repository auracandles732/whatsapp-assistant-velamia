import axios from 'axios';
import { mp3ToWhatsAppVoice } from './audio';
import { speakableText } from './voiceNotes';
import { getConfig, setConfig } from './supabase';

/**
 * Voz de VELAMIA con ElevenLabs: texto → MP3 → OGG Opus (el único formato que WhatsApp muestra como nota de voz).
 * Requiere ELEVENLABS_API_KEY y ELEVENLABS_VOICE_ID en Render; ELEVENLABS_MODEL es opcional.
 * Se enciende o apaga desde el CRM (Configuración → Notas de voz) sin tocar Render.
 */

const API = 'https://api.elevenlabs.io/v1';
const ENABLED_KEY = 'voice_notes_enabled';

const credentials = () => ({ apiKey: process.env.ELEVENLABS_API_KEY || '', voiceId: process.env.ELEVENLABS_VOICE_ID || '' });

/** La voz en MP3 (lo que se escucha en el CRM). */
export async function textToMp3(text: string): Promise<Buffer> {
  const { apiKey, voiceId } = credentials();
  if (!apiKey || !voiceId) throw new Error('Faltan ELEVENLABS_API_KEY o ELEVENLABS_VOICE_ID en Render');

  const response = await axios.post(
    `${API}/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      text: speakableText(text),
      // Multilingüe: los modelos "monolingual" ya no existen y leían el español con acento inglés.
      model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    },
    {
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      params: { output_format: 'mp3_44100_64' },
      responseType: 'arraybuffer',
      timeout: 30_000
    }
  );
  return Buffer.from(response.data);
}

/** La voz como nota de voz de WhatsApp (OGG Opus). */
export async function textToVoice(text: string): Promise<Buffer> {
  return mp3ToWhatsAppVoice(await textToMp3(text));
}

/** El interruptor del CRM (encendido salvo que la dueña lo apague). */
export async function voiceNotesEnabled(): Promise<boolean> {
  return (await getConfig(ENABLED_KEY)) !== 'false';
}

export async function setVoiceNotesEnabled(enabled: boolean) {
  await setConfig(ENABLED_KEY, enabled ? 'true' : 'false');
}

/** Explica en español por qué ElevenLabs rechazó algo. */
export function describeVoiceError(error: any): string {
  const status = error?.response?.status;
  if (status === 401) return 'ElevenLabs rechazó la clave: revisa ELEVENLABS_API_KEY en Render';
  if (status === 402) return 'La cuenta de ElevenLabs no tiene saldo o su plan no permite esta voz';
  if (status === 404) return 'ElevenLabs no encuentra esa voz: revisa ELEVENLABS_VOICE_ID en Render';
  if (status === 429) return 'ElevenLabs está ocupado o se acabaron los caracteres del mes';
  return String(error?.message || error);
}

/** Qué ve el CRM: si Render tiene las claves, qué voz usa y si está encendida (sin gastar caracteres). "problem" y no "error": el CRM toma cualquier campo error como una falla de la petición. */
export async function voiceStatus() {
  const { apiKey, voiceId } = credentials();
  const enabled = await voiceNotesEnabled();
  if (!apiKey || !voiceId) {
    return { configured: false, enabled, voiceName: '', problem: 'Faltan ELEVENLABS_API_KEY o ELEVENLABS_VOICE_ID en Render → Environment' };
  }
  try {
    const { data } = await axios.get(`${API}/voices/${encodeURIComponent(voiceId)}`, { headers: { 'xi-api-key': apiKey }, timeout: 15_000 });
    return { configured: true, enabled, voiceName: String(data?.name || 'Voz sin nombre'), problem: '' };
  } catch (error: any) {
    return { configured: true, enabled, voiceName: '', problem: describeVoiceError(error) };
  }
}

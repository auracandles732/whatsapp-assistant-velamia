import axios from 'axios';
import { mp3ToWhatsAppVoice } from './audio';
import { speakableText } from './voiceNotes';

/**
 * Voz de VELAMIA con ElevenLabs: texto → MP3 → OGG Opus (el único formato que WhatsApp muestra como nota de voz).
 * Requiere ELEVENLABS_API_KEY y ELEVENLABS_VOICE_ID; ELEVENLABS_MODEL es opcional.
 */
export async function textToVoice(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY || '';
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '';
  if (!apiKey || !voiceId) throw new Error('Faltan ELEVENLABS_API_KEY o ELEVENLABS_VOICE_ID');

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
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
  return mp3ToWhatsAppVoice(Buffer.from(response.data));
}

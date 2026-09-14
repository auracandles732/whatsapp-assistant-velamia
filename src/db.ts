import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export async function initDatabase() {
  const { error } = await supabase.from('business_config').select('key').limit(1);

  if (error) {
    console.error('❌ Error conectando a Supabase:', error.message);
    throw error;
  }

  console.log('✅ Conectado a Supabase');
}

// Re-export todas las funciones del servicio de Supabase
export * from './services/supabase';

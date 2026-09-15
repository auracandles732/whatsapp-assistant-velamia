import { supabase } from './services/supabase';

export async function initDatabase() {
  const { error } = await supabase.from('business_config').select('key').limit(1);
  if (error) throw new Error(`No se pudo conectar a Supabase: ${error.message}`);
  console.log('✅ Conectado a Supabase');
}

export * from './services/supabase';

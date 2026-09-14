import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export async function initDatabase() {
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;

    console.log('✅ Conectado a Supabase');
    console.log('📊 Base de datos lista');
  } catch (error) {
    console.error('❌ Error conectando a Supabase:', error);
    throw error;
  }
}

// Re-export todas las funciones del servicio de Supabase
export * from './services/supabase';

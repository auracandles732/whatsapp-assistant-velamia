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

// INSERT/UPDATE
export async function runQuery(table: string, data: any, action: 'insert' | 'update' = 'insert', match?: any): Promise<any> {
  try {
    if (action === 'insert') {
      const { data: result, error } = await supabase.from(table).insert([data]).select();
      if (error) throw error;
      return result?.[0];
    }

    if (action === 'update' && match) {
      let query = supabase.from(table).update(data);
      Object.entries(match).forEach(([key, value]) => {
        query = (query as any).eq(key, value);
      });
      const { data: result, error } = await query.select();
      if (error) throw error;
      return result?.[0];
    }
  } catch (error: any) {
    console.error(`Error en ${action} ${table}:`, error.message);
    throw error;
  }
}

// SELECT single
export async function getQuery(table: string, match: any): Promise<any> {
  try {
    let query = supabase.from(table).select('*');

    Object.entries(match).forEach(([key, value]) => {
      query = (query as any).eq(key, value);
    });

    const { data, error } = await (query as any).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  } catch (error: any) {
    return null;
  }
}

// SELECT multiple
export async function allQuery(table: string, match?: any, limit?: number): Promise<any[]> {
  try {
    let query = supabase.from(table).select('*');

    if (match) {
      Object.entries(match).forEach(([key, value]) => {
        query = (query as any).eq(key, value);
      });
    }

    if (limit) {
      query = (query as any).limit(limit);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (error: any) {
    console.error(`Error en allQuery ${table}:`, error.message);
    return [];
  }
}

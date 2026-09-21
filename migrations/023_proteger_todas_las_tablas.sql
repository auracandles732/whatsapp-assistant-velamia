-- Seguridad: activa la protección por filas (RLS) en TODAS las tablas.
-- El servidor usa la service key, que no se ve afectada: el CRM y el asistente siguen funcionando igual.
-- Sin políticas, nadie más (por ejemplo con la llave pública "anon" de Supabase) puede leer ni cambiar datos.
-- Se puede ejecutar varias veces sin problema.

ALTER TABLE IF EXISTS conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS products ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS business_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS business_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS business_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS conversation_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS conversation_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS subscription_payments ENABLE ROW LEVEL SECURITY;

-- Revisión: esta consulta debe mostrar rowsecurity = true en todas las filas.
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;

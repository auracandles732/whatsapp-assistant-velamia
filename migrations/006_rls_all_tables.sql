-- Protección de todas las tablas frente a la clave pública (anon/publishable) de Supabase.
-- El servidor usa la service key, que ignora RLS, así que el bot y el CRM siguen funcionando.
-- Sin políticas definidas, nadie más puede leer ni escribir. Se puede ejecutar varias veces.
ALTER TABLE conversations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE followups       ENABLE ROW LEVEL SECURITY;
ALTER TABLE products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications   ENABLE ROW LEVEL SECURITY;

-- Multi-negocio: claves propias por negocio, conversaciones separadas y cierre de políticas abiertas.
-- Se puede ejecutar varias veces. No modifica datos de VELAMIA (filas sin business_id).

-- 1) Claves de cada negocio. meta_phone_number_id es el "Phone Number ID" de Meta: con él se sabe a qué
--    negocio le escribieron. Token de Meta y clave de OpenAI se guardan cifrados por el servidor.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS meta_phone_number_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS openai_api_key TEXT;
ALTER TABLE businesses ALTER COLUMN meta_phone_number DROP NOT NULL;
ALTER TABLE businesses ALTER COLUMN meta_access_token DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS businesses_meta_phone_number_id_unique ON businesses (meta_phone_number_id);

-- 2) Un mismo cliente puede escribirle a VELAMIA y a otro negocio: el teléfono deja de ser único global
--    y pasa a ser único por negocio (VELAMIA = business_id vacío).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'conversations'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (phone_number)'
  LOOP
    EXECUTE format('ALTER TABLE conversations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_business_phone_unique
  ON conversations (COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), phone_number);

-- 3) Tokens de acceso con vencimiento.
ALTER TABLE business_access_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

-- 4) Las políticas "USING (true)" sin rol dejaban leer estas tablas (incluidos tokens) con la clave pública
--    de Supabase. El servidor usa la service key, que ignora RLS: sin políticas nadie más entra.
DROP POLICY IF EXISTS "businesses_service_key" ON businesses;
DROP POLICY IF EXISTS "business_access_tokens_service_key" ON business_access_tokens;
DROP POLICY IF EXISTS "business_users_service_key" ON business_users;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_users ENABLE ROW LEVEL SECURITY;

-- 5) Índices para los listados del CRM de cada negocio.
CREATE INDEX IF NOT EXISTS idx_quotations_business_id ON quotations (business_id);
CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders (business_id);

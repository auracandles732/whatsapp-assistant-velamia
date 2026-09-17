-- UP: Crear tabla businesses para multi-tenant
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  meta_phone_number TEXT NOT NULL UNIQUE,
  meta_access_token TEXT NOT NULL,
  meta_business_account_id TEXT,
  business_profile JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  owner_phone TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_businesses_meta_phone ON businesses(meta_phone_number);
CREATE INDEX IF NOT EXISTS idx_businesses_active ON businesses(active);

-- RLS: Solo la app puede leer/escribir (service key)
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "businesses_service_key" ON businesses
  USING (true)
  WITH CHECK (true);

-- DOWN: Eliminar tabla businesses
-- DROP TABLE IF EXISTS businesses CASCADE;

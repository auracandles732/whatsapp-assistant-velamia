-- MIGRACIÓN 1: Crear tabla businesses
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

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "businesses_service_key" ON businesses
  USING (true)
  WITH CHECK (true);

-- MIGRACIÓN 2: Agregar business_id a conversations
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_conversations_business_id ON conversations(business_id);

-- MIGRACIÓN 3: Agregar business_id a products
ALTER TABLE products
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);

-- MIGRACIÓN 4: Agregar business_id a quotations
ALTER TABLE quotations
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_quotations_business_id ON quotations(business_id);

-- MIGRACIÓN 5: Agregar business_id a orders
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders(business_id);

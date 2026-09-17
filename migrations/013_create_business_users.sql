-- Usuarios Business Owner por negocio
CREATE TABLE IF NOT EXISTS business_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT DEFAULT 'owner', -- 'owner' | 'manager' | 'staff'
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(business_id, email) -- Un email por negocio
);

CREATE INDEX IF NOT EXISTS idx_business_users_business_id ON business_users(business_id);
CREATE INDEX IF NOT EXISTS idx_business_users_email ON business_users(email);
CREATE INDEX IF NOT EXISTS idx_business_users_active ON business_users(active);

ALTER TABLE business_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_users_service_key" ON business_users
  USING (true)
  WITH CHECK (true);

-- Tabla de tokens de acceso para Business Owners
CREATE TABLE IF NOT EXISTS business_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Token hasheado (bcrypt o similar) — nunca guardar el plaintext
  token_hash TEXT NOT NULL UNIQUE,
  -- El token plaintext solo se devuelve UNA VEZ al crear; aquí se guarda el hash
  created_at TIMESTAMP DEFAULT now(),
  last_used TIMESTAMP,
  active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_business_access_tokens_business_id ON business_access_tokens(business_id);
CREATE INDEX IF NOT EXISTS idx_business_access_tokens_token_hash ON business_access_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_business_access_tokens_active ON business_access_tokens(active);

-- RLS: Solo la app (service key) puede escribir; Business Owner lee via API
ALTER TABLE business_access_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_access_tokens_service_key" ON business_access_tokens
  USING (true)
  WITH CHECK (true);

-- Asociar tokens a usuarios específicos (no solo al negocio)
ALTER TABLE business_access_tokens
ADD COLUMN IF NOT EXISTS business_user_id UUID REFERENCES business_users(id) ON DELETE CASCADE;

-- Índice para búsquedas rápidas por usuario
CREATE INDEX IF NOT EXISTS idx_business_access_tokens_user_id ON business_access_tokens(business_user_id);

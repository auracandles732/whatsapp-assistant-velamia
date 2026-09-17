-- UP: Agregar business_id a conversations (NULLABLE para no afectar VELAMIA)
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_conversations_business_id ON conversations(business_id);

-- DOWN: Remover columna business_id
-- ALTER TABLE conversations DROP COLUMN IF EXISTS business_id CASCADE;

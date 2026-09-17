-- UP: Agregar business_id a quotations (NULLABLE para no afectar VELAMIA)
ALTER TABLE quotations
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_quotations_business_id ON quotations(business_id);

-- DOWN: Remover columna business_id
-- ALTER TABLE quotations DROP COLUMN IF EXISTS business_id CASCADE;

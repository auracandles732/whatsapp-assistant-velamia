-- UP: Agregar business_id a products (NULLABLE para no afectar VELAMIA)
ALTER TABLE products
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);

-- DOWN: Remover columna business_id
-- ALTER TABLE products DROP COLUMN IF EXISTS business_id CASCADE;

-- UP: Agregar business_id a orders (NULLABLE para no afectar VELAMIA)
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders(business_id);

-- DOWN: Remover columna business_id
-- ALTER TABLE orders DROP COLUMN IF EXISTS business_id CASCADE;

-- Cada producto puede venderse en su propia unidad (caja, tubo, plancha, metro) y tener su medida.
-- Vacío = se usa la unidad del negocio, como hasta ahora. No cambia nada de VELAMIA.

ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_unit TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS measure TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS pieces_per_unit INTEGER;

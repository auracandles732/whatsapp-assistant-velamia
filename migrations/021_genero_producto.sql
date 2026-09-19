-- Cada producto puede marcarse "niño", "niña" o quedar vacío (neutro, sirve para ambos).
-- Solo lo usan los negocios con el ajuste activado (VELAMIA, en baby shower). No cambia nada de los demás.

ALTER TABLE products ADD COLUMN IF NOT EXISTS gender TEXT;

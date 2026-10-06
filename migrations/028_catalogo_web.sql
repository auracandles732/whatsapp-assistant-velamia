-- Catálogo de la página web: cada producto del CRM puede tener su versión para la web (mostrar o no, nombre, descripción,
-- categoría y fotos de la web, y el id que tiene allá). El CRM manda y la web se actualiza sola.
-- Se puede ejecutar varias veces sin problema. No borra ni cambia datos existentes.
ALTER TABLE products ADD COLUMN IF NOT EXISTS web JSONB;

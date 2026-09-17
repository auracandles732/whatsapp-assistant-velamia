-- Ingreso al CRM con usuario (correo) y contraseña para cada empresa, incluida VELAMIA.
-- No toca datos de VELAMIA.
ALTER TABLE business_users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Usuarios de VELAMIA: business_id vacío (sus datos no llevan business_id).
ALTER TABLE business_users ALTER COLUMN business_id DROP NOT NULL;

-- El correo es el usuario: único en toda la plataforma.
CREATE UNIQUE INDEX IF NOT EXISTS business_users_email_unique ON business_users (lower(email));

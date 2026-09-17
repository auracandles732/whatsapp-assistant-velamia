-- VELAMIA es una empresa más en la plataforma, pero sus datos siguen sin business_id.
-- Sus tokens de acceso se guardan con business_id vacío. No toca ningún dato de VELAMIA.
ALTER TABLE business_access_tokens ALTER COLUMN business_id DROP NOT NULL;

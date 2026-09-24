-- Publicaciones en redes (servicio adicional): el asistente prepara publicaciones con las fotos del catálogo,
-- la empresa las revisa en el CRM y se publican solas en Instagram y Facebook a la hora elegida.
-- Se puede ejecutar varias veces sin problema.

-- Servicios adicionales que la plataforma activa por empresa ({"publicaciones": true}). VELAMIA los tiene todos.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Vacío = VELAMIA, como en el resto de tablas.
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'publishing', 'published', 'partial', 'failed', 'cancelled')),
  -- instagram_feed, instagram_story, facebook
  channels TEXT[] NOT NULL DEFAULT '{instagram_feed}',
  caption TEXT NOT NULL DEFAULT '',
  -- Productos del catálogo que muestra: [{"name": "...", "image_url": "...", "price": 30}]
  products JSONB NOT NULL DEFAULT '[]',
  -- Idea de la publicación ("Baby shower", "Navidad"): ayuda a variar y a escribir el texto.
  theme TEXT NOT NULL DEFAULT '',
  -- Resultado por red: {"instagram_feed": {"id": "...", "permalink": "..."}, "facebook": {"error": "..."}}
  results JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_social_posts_business_time ON social_posts (business_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_social_posts_status_time ON social_posts (status, scheduled_at);

-- Solo el servidor (service key) la lee y la cambia.
ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;

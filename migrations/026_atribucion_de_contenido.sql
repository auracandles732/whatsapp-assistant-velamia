-- Atribución comercial del agente de redes: cada publicación lleva un código (BAUTIZO07) y se sabe qué chats,
-- cotizaciones, pedidos y ventas vinieron de ella. Los totales no se guardan: se calculan, así siempre cuadran.
-- Se puede ejecutar varias veces sin problema. No borra ni cambia datos existentes.

-- Un código por publicación: qué se publicó, con qué objetivo y llamado a la acción.
CREATE TABLE IF NOT EXISTS content_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Vacío = VELAMIA, como en el resto de tablas.
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT '',
  -- Producto principal (nombre del Catálogo) o vacío si es contenido de la marca.
  product_name TEXT NOT NULL DEFAULT '',
  -- historia, carrusel, foto o reel.
  content_type TEXT NOT NULL DEFAULT '',
  -- alcance, interaccion, confianza, consulta o venta.
  content_goal TEXT NOT NULL DEFAULT '',
  cta TEXT NOT NULL DEFAULT '',
  -- catalogo, biblioteca o mixto.
  source TEXT NOT NULL DEFAULT '',
  platforms TEXT[] NOT NULL DEFAULT '{}',
  publish_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Un código no se repite dentro de la misma empresa.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_tracking_code
  ON content_tracking (COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_tracking_post ON content_tracking (post_id);

-- Qué chat vino de qué publicación: exacta (escribió el código), historia (respondió a la historia) o estimada.
CREATE TABLE IF NOT EXISTS content_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tracking_id UUID NOT NULL REFERENCES content_tracking(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('exacta', 'historia', 'estimada')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_attributions_chat ON content_attributions (conversation_id, tracking_id);
CREATE INDEX IF NOT EXISTS idx_content_attributions_tracking ON content_attributions (tracking_id);

-- Como todas las tablas: solo el servidor (clave de servicio) las lee y escribe.
ALTER TABLE content_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_attributions ENABLE ROW LEVEL SECURITY;

-- Atribución de anuncios de Meta: de qué anuncio (o de la web) llegó cada chat, qué producto mostraba ese anuncio y
-- qué cotizaciones, pedidos y ventas salieron de ahí. Los totales no se guardan: se calculan, así siempre cuadran.
-- Se puede ejecutar varias veces sin problema. No borra ni cambia datos existentes.

-- Los anuncios de cada empresa y el producto que muestran. Se llenan solos (al llegar el primer chat de un anuncio y al
-- leer la cuenta publicitaria) y la empresa confirma o corrige el producto en el CRM.
CREATE TABLE IF NOT EXISTS ad_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Vacío = VELAMIA, como en el resto de tablas.
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  ad_id TEXT NOT NULL,
  ad_name TEXT NOT NULL DEFAULT '',
  campaign_id TEXT NOT NULL DEFAULT '',
  campaign_name TEXT NOT NULL DEFAULT '',
  adset_id TEXT NOT NULL DEFAULT '',
  adset_name TEXT NOT NULL DEFAULT '',
  -- whatsapp, web, mensajes (Instagram o Messenger) o vacío si no se sabe.
  destination TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  headline TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  -- Nombres del Catálogo que muestra el anuncio (varios = carrusel o colección).
  products TEXT[] NOT NULL DEFAULT '{}',
  category TEXT NOT NULL DEFAULT '',
  -- sugerido (el sistema, por el texto del anuncio) o confirmado (la empresa o quien creó el anuncio).
  product_source TEXT NOT NULL DEFAULT 'sugerido',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_registry_ad
  ON ad_registry (COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), ad_id);

-- Visitas de la web que llegaron con datos de un anuncio: al tocar WhatsApp el mensaje lleva su referencia (Ref: K7M2QX)
-- y así el chat sabe de qué anuncio y qué producto venía.
CREATE TABLE IF NOT EXISTS web_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  ad_id TEXT NOT NULL DEFAULT '',
  campaign_id TEXT NOT NULL DEFAULT '',
  adset_id TEXT NOT NULL DEFAULT '',
  -- utm_source, utm_medium, utm_campaign, utm_content, utm_term.
  utm JSONB NOT NULL DEFAULT '{}',
  from_meta BOOLEAN NOT NULL DEFAULT false,
  landing_page TEXT NOT NULL DEFAULT '',
  -- El último producto que miraba al tocar WhatsApp.
  product TEXT NOT NULL DEFAULT '',
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_refs_code
  ON web_refs (COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

-- De dónde llegó cada chat: un anuncio (Meta lo dice en el primer mensaje) o la web (por su referencia).
CREATE TABLE IF NOT EXISTS lead_origins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- anuncio o web.
  source TEXT NOT NULL CHECK (source IN ('anuncio', 'web')),
  -- Evita anotar dos veces lo mismo: "ad:<id>" o "web:<referencia>".
  origin_key TEXT NOT NULL,
  -- whatsapp, instagram o messenger.
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  ad_id TEXT NOT NULL DEFAULT '',
  campaign_id TEXT NOT NULL DEFAULT '',
  adset_id TEXT NOT NULL DEFAULT '',
  -- ad o post (publicación promocionada con botón de WhatsApp).
  source_type TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  headline TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  media_url TEXT NOT NULL DEFAULT '',
  -- Identificador del clic en el anuncio: más adelante sirve para avisarle a Meta qué chats compraron.
  ctwa_clid TEXT NOT NULL DEFAULT '',
  ref_code TEXT NOT NULL DEFAULT '',
  landing_page TEXT NOT NULL DEFAULT '',
  utm JSONB NOT NULL DEFAULT '{}',
  products TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_origins_chat ON lead_origins (conversation_id, origin_key);
CREATE INDEX IF NOT EXISTS idx_lead_origins_ad ON lead_origins (ad_id);
CREATE INDEX IF NOT EXISTS idx_lead_origins_created ON lead_origins (created_at);

-- Como todas las tablas: solo el servidor (clave de servicio) las lee y escribe.
ALTER TABLE ad_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_origins ENABLE ROW LEVEL SECURITY;

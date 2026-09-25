-- Agente de redes (servicio adicional "publicaciones"): biblioteca de fotos y videos, catálogos de proveedores
-- (PDF → Catálogo con precio por tamaño), publicaciones con videos y resultados de cada publicación.
-- Se puede ejecutar varias veces sin problema. No borra ni cambia datos existentes.

-- Fotos y videos que sube la empresa (o que genere la IA) para publicar.
CREATE TABLE IF NOT EXISTS social_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Vacío = VELAMIA, como en el resto de tablas.
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'generated')),
  url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- Producto del Catálogo que muestra (para el texto y el precio), si corresponde.
  product_name TEXT,
  width INT,
  height INT,
  duration_seconds NUMERIC,
  size_bytes BIGINT,
  used_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_assets_business ON social_assets (business_id, created_at DESC);

-- Catálogos PDF de proveedores.
CREATE TABLE IF NOT EXISTS supplier_catalogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  -- Nombre del catálogo = categoría con la que sus modelos entran al Catálogo (ej. HALLOWEEN).
  name TEXT NOT NULL,
  supplier TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  pages INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_catalogs_business ON supplier_catalogs (business_id, created_at DESC);

-- Cada modelo del PDF: su foto, el precio del proveedor, el tamaño y si ya pasó al Catálogo.
CREATE TABLE IF NOT EXISTS supplier_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  catalog_id UUID NOT NULL REFERENCES supplier_catalogs(id) ON DELETE CASCADE,
  -- Nombre con el que entra al Catálogo y el que trae el PDF.
  name TEXT NOT NULL,
  supplier_name TEXT NOT NULL DEFAULT '',
  page INT,
  supplier_price NUMERIC(10, 2),
  size TEXT NOT NULL DEFAULT 'mediana' CHECK (size IN ('pequena', 'mediana', 'grande')),
  -- true = el PDF no decía el tamaño y se usó el de siempre (conviene revisarlo).
  size_estimated BOOLEAN NOT NULL DEFAULT false,
  size_note TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo', 'en_catalogo', 'descartado')),
  catalog_product_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_products_catalog ON supplier_products (catalog_id);
CREATE INDEX IF NOT EXISTS idx_supplier_products_business ON supplier_products (business_id);

-- Resultados de cada publicación por red (se actualizan cada hora; una fila por publicación y red).
CREATE TABLE IF NOT EXISTS social_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  media_id TEXT NOT NULL,
  likes INT,
  comments INT,
  views INT,
  reach INT,
  saves INT,
  shares INT,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_social_metrics_business ON social_metrics (business_id, collected_at DESC);

-- Publicaciones con fotos o videos de la biblioteca: [{"type": "video", "url": "...", "asset_id": "..."}].
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]';

-- Solo el servidor (service key) las lee y las cambia.
ALTER TABLE social_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_metrics ENABLE ROW LEVEL SECURITY;

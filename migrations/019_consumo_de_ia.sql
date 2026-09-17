-- Cuánto consume de OpenAI cada empresa: una fila por llamada, para saber qué cuesta cada cliente.
-- business_id vacío = VELAMIA, igual que en el resto de tablas.

CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  model TEXT,
  purpose TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_business_fecha ON ai_usage (business_id, created_at);

-- El servidor usa la service key (ignora RLS); sin políticas, nadie más puede leer esta tabla.
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

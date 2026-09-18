-- CRM fase 2: etiquetas, "no leídas", notas internas y próximas acciones por conversación.
-- Las tablas nuevas cuelgan de la conversación, así que quedan separadas por negocio igual que los mensajes.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMP;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- Lo que ya existe hoy se toma como leído: solo los mensajes nuevos cuentan como "no leídos".
UPDATE conversations SET last_read_at = NOW() WHERE last_read_at IS NULL;

CREATE TABLE IF NOT EXISTS conversation_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_conversation ON conversation_notes (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_date DATE,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  done_at TIMESTAMP,
  created_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_tasks_conversation ON conversation_tasks (conversation_id, done, due_date);

-- El servidor usa la service key (ignora RLS); sin políticas, nadie más puede leer estas tablas.
ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_tasks ENABLE ROW LEVEL SECURITY;

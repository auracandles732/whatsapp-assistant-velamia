-- Mejoras de robustez: deduplicación de mensajes de WhatsApp

-- Evita que un mismo mensaje de WhatsApp se procese dos veces.
-- Meta reintenta el webhook si no recibe respuesta a tiempo.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_message_id VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_id
  ON messages(wa_message_id)
  WHERE wa_message_id IS NOT NULL;

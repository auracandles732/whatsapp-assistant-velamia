-- Pausa selectiva del bot por conversación (punto 1)
ALTER TABLE conversations ADD COLUMN bot_paused_until TIMESTAMP;
-- Si es NULL o está en el pasado, el bot responde normalmente.
-- Si es futuro, el bot se calla en ese chat.

-- Número de teléfono del dueño para notificaciones (punto 2)
INSERT INTO business_config (key, value, updated_at)
VALUES ('owner_phone', '0986673197', NOW())
ON CONFLICT (key) DO UPDATE SET value = '0986673197', updated_at = NOW();

-- Tabla de notificaciones enviadas (para evitar spam)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- 'payment_card', 'payment_proof', 'complaint', 'ask_person'
  message TEXT,
  sent_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_conv ON notifications(conversation_id);

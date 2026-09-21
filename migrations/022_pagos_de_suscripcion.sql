-- Pagos de la mensualidad de cada empresa (transferencia, efectivo o, más adelante, tarjeta con Nuvei).
-- La fecha hasta la que está pagada la empresa es el paid_until del último pago.

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'manual',
  months INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  reference TEXT,
  paid_until TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_empresa ON subscription_payments (business_id, created_at);

-- El servidor usa la service key (ignora RLS); sin políticas, nadie más puede leer esta tabla.
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

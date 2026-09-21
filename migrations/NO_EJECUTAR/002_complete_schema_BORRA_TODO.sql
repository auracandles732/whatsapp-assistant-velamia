-- ⚠️  HISTÓRICA — NO VOLVER A EJECUTAR EN PRODUCCIÓN.
-- Esta migración BORRA todas las tablas y sus datos (DROP TABLE). Solo sirve para crear
-- una base nueva desde cero; después se aplican 003, 004, 005 y 006 en orden.
-- Para instalar un negocio nuevo usa setup/base_nueva.sql (no borra nada ni trae datos de VELAMIA).

DROP TABLE IF EXISTS followups CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS quotations CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS business_config CASCADE;

-- Tabla: conversaciones
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  customer_name VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',
  last_message_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla: mensajes
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender VARCHAR(50) NOT NULL,
  type VARCHAR(50) NOT NULL,
  content TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla: cotizaciones
CREATE TABLE quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(20),
  products JSONB NOT NULL,
  total_amount NUMERIC(10, 2),
  discount NUMERIC(10, 2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);

-- Tabla: pedidos
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(20),
  customer_address TEXT,
  products JSONB NOT NULL,
  total_amount NUMERIC(10, 2),
  status VARCHAR(50) DEFAULT 'pending',
  payment_method VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivery_date TIMESTAMP
);

-- Tabla: seguimientos
CREATE TABLE followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  type VARCHAR(50) NOT NULL,
  message TEXT,
  scheduled_time TIMESTAMP,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla: productos
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price NUMERIC(10, 2) NOT NULL,
  stock INTEGER DEFAULT 0,
  image_url VARCHAR(500),
  category VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla: configuración
CREATE TABLE business_config (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Crear índices
CREATE INDEX idx_conversations_phone ON conversations(phone_number);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_quotations_conversation ON quotations(conversation_id);
CREATE INDEX idx_quotations_status ON quotations(status);
CREATE INDEX idx_orders_conversation ON orders(conversation_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_phone ON orders(customer_phone);
CREATE INDEX idx_followups_scheduled ON followups(scheduled_time);
CREATE INDEX idx_followups_status ON followups(status);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_name ON products(name);

-- Insertar configuración inicial
INSERT INTO business_config (key, value) VALUES
  ('business_name', 'VELAMIA'),
  ('owner_phone', '593995448686'),
  ('currency', 'USD'),
  ('timezone', 'America/Guayaquil'),
  ('business_description', 'Velas artesanales premium para tu hogar'),
  ('bot_enabled', 'true'),
  ('bot_auto_respond', 'true')
ON CONFLICT (key) DO NOTHING;

-- Crear función para actualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger para conversations
CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger para business_config
CREATE TRIGGER update_config_updated_at BEFORE UPDATE ON business_config
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

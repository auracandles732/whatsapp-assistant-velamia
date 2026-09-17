# Aplicar Migraciones a Supabase — Multi-Tenant

**Rama:** `test/multi-tenant-verification`
**Seguridad:** ✅ Todas NULLABLE (VELAMIA no es afectado)
**Tiempo:** ~2 minutos

## Pasos

### 1. Accede a Supabase → SQL Editor
- Abre https://supabase.com
- Ve a proyecto **velamia-ai-platform**
- Abre **SQL Editor** (izquierda)

### 2. Aplica las 5 migraciones en orden

**MIGRACIÓN 1:** Crear tabla `businesses`
```sql
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  meta_phone_number TEXT NOT NULL UNIQUE,
  meta_access_token TEXT NOT NULL,
  meta_business_account_id TEXT,
  business_profile JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  owner_phone TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_businesses_meta_phone ON businesses(meta_phone_number);
CREATE INDEX IF NOT EXISTS idx_businesses_active ON businesses(active);

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "businesses_service_key" ON businesses
  USING (true)
  WITH CHECK (true);
```
✅ Ejecutar

---

**MIGRACIÓN 2:** Agregar `business_id` a conversations
```sql
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_conversations_business_id ON conversations(business_id);
```
✅ Ejecutar

---

**MIGRACIÓN 3:** Agregar `business_id` a products
```sql
ALTER TABLE products
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);
```
✅ Ejecutar

---

**MIGRACIÓN 4:** Agregar `business_id` a quotations
```sql
ALTER TABLE quotations
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_quotations_business_id ON quotations(business_id);
```
✅ Ejecutar

---

**MIGRACIÓN 5:** Agregar `business_id` a orders
```sql
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders(business_id);
```
✅ Ejecutar

---

## Verificación

Después de ejecutar todas, verifica en **Tabla Editor**:
- `businesses` debe existir (vacía para ahora)
- `conversations`, `products`, `quotations`, `orders` deben tener columna `business_id` (NULL)
- VELAMIA datos sin cambios ✅

**Listo. Cuando acabes, avísame para testear.**

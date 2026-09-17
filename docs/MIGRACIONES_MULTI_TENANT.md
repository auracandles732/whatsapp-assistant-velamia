# Migraciones Multi-Tenant — Instrucciones

## Seguridad: VELAMIA No Se Toca

Todas las migraciones son **aditivas** (solo agregan columnas/tablas). Los cambios son **NULLABLE** — VELAMIA sigue funcionando sin cambios.

```
VELAMIA en main (producción)
  └─ Sigue igual, business_id = NULL para sus registros
  └─ Sin cambios en código ni queries

Develop/multi-tenant
  └─ Nuevas tablas y columnas creadas
  └─ Queries nuevo filtran por business_id IS NOT NULL
  └─ Usa los nuevos negocio, VELAMIA ignorado
```

## Migraciones

### 007: Crear tabla `businesses`

```sql
CREATE TABLE businesses (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  meta_phone_number TEXT UNIQUE,
  meta_access_token TEXT,
  business_profile JSONB,
  active BOOLEAN,
  owner_phone TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

**Índices:** `meta_phone_number`, `active`  
**RLS:** Service key solo

### 008–011: Agregar `business_id` a tablas existentes

Cada tabla obtiene una columna `business_id UUID NULLABLE`:
- `conversations.business_id` (008)
- `products.business_id` (009)
- `quotations.business_id` (010)
- `orders.business_id` (011)

**Índices:** cada tabla tiene `idx_<table>_business_id`

## Cómo Aplicar

### Opción A: Desde Supabase UI (recomendado)

1. **Ir a SQL Editor** en https://supabase.com → proyecto `yhaiprlfpmugohmzpzcq`
2. **Copiar-pegar cada migración** de `migrations/00X_*.sql` en orden (007, 008, 009, 010, 011)
3. **Ejecutar** (botón azul "Run")
4. ✅ Listo, sin afectar VELAMIA

### Opción B: Desde CLI (si Aura lo prefiere)

```bash
cd C:\Users\aurac\whatsapp-assistant-velamia
supabase db push --schema public
```

Supabase detecta las migraciones en `migrations/` y las aplica en orden.

## Verificación (sin tocar datos)

```sql
-- Confirmar tabla businesses existe
SELECT column_name, data_type FROM information_schema.columns 
WHERE table_name = 'businesses';

-- Confirmar conversaciones tiene business_id
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'conversations' AND column_name = 'business_id';

-- VELAMIA no afectado: 0 registros con business_id
SELECT COUNT(*) FROM conversations WHERE business_id IS NOT NULL;
-- Resultado: 0 ✅
```

## Rollback (Si algo va mal)

Cada migración tiene un comentario `-- DOWN:` al final. Si necesitas revertir:

```sql
-- Revertir 011 (orders)
ALTER TABLE orders DROP COLUMN IF EXISTS business_id CASCADE;

-- Revertir 010 (quotations)
ALTER TABLE quotations DROP COLUMN IF EXISTS business_id CASCADE;

-- ... etc ...

-- Revertir 007 (tabla businesses)
DROP TABLE IF EXISTS businesses CASCADE;
```

**IMPORTANTE:** No hacer esto a menos que algo esté roto. VELAMIA sigue funcionando sin revertir.

## Siguientes Pasos (Código)

Una vez aplicadas las migraciones:

1. **Actualizar `src/services/supabase.ts`:**
   - Función `getBusinessByPhoneNumberId(phoneNumberId)` → busca en `businesses`
   - Función `getOrCreateBusiness(...)` → inserta nuevo negocio
   - Queries del webhook filtran por `business_id`

2. **Actualizar webhook (`messageController.ts`):**
   - Recibe `phone_number_id` de Meta
   - Busca negocio correspondiente
   - Carga su `business_profile`
   - Procesa como Multi-Tenant

3. **Actualizar CRM (`dashboard/index.html`):**
   - Dropdown "Cambiar negocio"
   - Cargar catálogo, chats, pedidos del negocio actual

---

**Fecha creación:** 17-sep-2026  
**Estado:** Migraciones listas, esperando aprobación de Aura para aplicar  
**Rama:** `develop/multi-tenant`

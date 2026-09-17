# Multi-Tenant: Roadmap de Arquitectura

**Estado:** Desarrollo en rama `develop/multi-tenant`  
**VELAMIA congelado:** tag `frozen/velamia` en `main`  
**Fecha inicio:** 17-sep-2026

## Objetivo

Convertir el asistente en un **SaaS multi-negocio** (single deployment, múltiples clientes).
- Una instalación de Render
- Una Supabase
- Un CRM centralizado donde cambias de contexto ("hoy VELAMIA", mañana "Empresa X")
- Cada cliente paga mensualidad y tiene su catálogo, reglas y configuración

## Arquitectura Actual (VELAMIA Frozen)

```
main (protected)
  └─ Tag: frozen/velamia
  └─ Business Profile fijo en BD (businessProfile)
  └─ Todos los chats → mismo negocio (VELAMIA)
```

## Cambios Necesarios

### 1. Base de datos

**Nueva tabla `businesses`:**
```sql
CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  meta_phone_number TEXT NOT NULL UNIQUE,
  meta_access_token TEXT NOT NULL,
  meta_business_account_id TEXT,
  business_profile JSONB NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  owner_id UUID REFERENCES auth.users(id)
);
```

**Actualizar `conversations`:**
- Agregar `business_id UUID REFERENCES businesses(id)` (requerido)
- Las queries actuales filtran por `business_id`

**Actualizar `products`, `quotations`, `orders`:**
- Agregar `business_id` para desambiguar catálogos

### 2. Lógica de Webhook

El endpoint `POST /webhook` recibirá el `phone_number_id` de Meta:
- **Buscar en `businesses`** cuál coincide con ese teléfono
- **Cargar ese `business_profile`**
- Procesar el mensaje con las reglas de ese negocio

```ts
// messageController.ts
const business = await getBusinessByPhoneNumberId(phoneNumberId);
if (!business) return 401; // No configurado

const profile = normalizeProfile(business.business_profile);
// resto del flujo...
```

### 3. CRM Actualizado

**Nueva sección en el CRM:**
- **Pestaña "Negocios"** (o dropdown fijo):
  - Lista de negocio (nombre, teléfono, estado)
  - Botón "+ Nuevo negocio" (agregar cliente)
  - Click en uno → **carga su contexto**
    - Su catálogo, pedidos, chats, configuración

**Impacto en otras pestañas:**
- Chats, Catálogo, Cotizaciones, Pedidos → **filtran por negocio actual**
- Configuración → **muestra datos del negocio actual** (empaques, prompt, etc.)

### 4. Protecciones

**`main` rama protegida:**
- Solo merges desde PRs aprobadas
- Solo hotfixes críticos (bugs graves, seguridad)
- **No cambios de features**

**`develop/multi-tenant`:**
- Rama abierta para desarrollo
- PRs internas antes de mergear a main (opcional)
- Cuando esté listo → decisión de cómo desplegar (rama separada en Render, o test en staging)

## Fase 1: Arquitectura (Esta rama)

- [ ] Crear tabla `businesses` + migración
- [ ] Agregar `business_id` a `conversations`, `products`, `orders`, `quotations`
- [ ] Refactor webhook para buscar negocio por teléfono
- [ ] Actualizar `src/services/supabase.ts` → queries filtradas por business
- [ ] Tests locales (sin tocar VELAMIA)

## Fase 2: CRM Multi-negocio

- [ ] Pestaña/dropdown "Negocios"
- [ ] Cambiar contexto → recargar catálogo, chats, config
- [ ] Formulario "+ Nuevo negocio" (nombre, teléfono Meta, tokens)

## Fase 3: Testing y Go-Live

- [ ] Testing con 2–3 negocios ficticiios
- [ ] Decisión de deployment (rama en Render, o reemplazar main)
- [ ] Si todo OK → mergear a main o crear rama `production/multi-tenant`

## Rollback Plan

Si algo falla:
- Render → volver a deploying desde `main` (VELAMIA frozen)
- BD → snapshot en Supabase (pedir a Aura que lo haga antes de cambios)
- Git → `git checkout frozen/velamia` restaura código exacto

## Notas

- **VELAMIA en `main`**: completamente funcional, cambios mínimos
- **Desarrollo en `develop/multi-tenant`**: seguro, aislado
- **Una vez listo**: decisión de Aura sobre cuándo/cómo integrar a producción

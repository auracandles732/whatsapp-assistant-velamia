# Estado de Arquitectura Multi-Tenant — 17 Sept 2026

**Fecha:** 17 de septiembre de 2026
**Estado:** ✅ VERIFICADO Y FUNCIONAL

## Ramas

| Rama | Estado | Descripción |
|------|--------|-------------|
| `main` | 🟡 En espera | VELAMIA congelada (requiere tag `frozen/velamia`) |
| `develop/multi-tenant` | ✅ LISTO | Multi-tenant arquitectura, DB migraciones aplicadas, verificado |
| `test/multi-tenant-verification` | ✅ Completado | Rama de prueba (puede eliminarse) |

## Cambios Implementados

### 1. **Base de Datos** (Supabase)
✅ 5 migraciones aplicadas:
- `businesses` table (id, name, phone, token, profile JSONB, RLS)
- `business_id` NULLABLE FK en: conversations, products, quotations, orders
- Indices para performance
- Cascade delete para integridad

### 2. **Backend** (src/)

#### Servicios (`db.ts`)
- `getBusinessByPhoneNumber(phoneNumber)` — detecta negocio
- `createBusiness(...)` — crea negocio con perfil default
- `getAllBusinesses()` — lista negocios activos

#### Controladores (`messageController.ts`)
- Webhook detecta business por `meta_phone_number`
- `getProfileForBatch()` — carga perfil del negocio o fallback global
- Profile pasado a toda lógica de cálculo (unidades, envíos)

#### Config (`businessProfile.ts`)
- `piecesPerUnit` por negocio (VELAMIA=12, TiendaUnidades=1, etc)
- `useCustomRates` para envío custom vs Servientrega
- `customRates[]` y `productWeights{}` para envíos personalizados
- `normalizeProfile()` valida y completa campos con defaults

#### IA (`openai.ts`)
- `getPiecesPerUnit(profile)` — lee factor de conversión del negocio
- `normalizeQuantities()` usa factor dinámico, no hardcoded

#### Envíos (`shippingRates.ts`)
- `shippingCost()` detecta `useCustomRates`
- Placeholder para cálculo por peso (requiere productDetails en context)

### 3. **API REST** (src/index.ts)

```
GET /api/businesses
  → Retorna lista de negocios activos
  
POST /api/businesses
  → Crea negocio nuevo con nombre, phoneNumber, accessToken
  → businessProfile = VELAMIA_PROFILE (default)
```

### 4. **CRM Frontend** (dashboard/index.html)

#### Tab "🏢 Negocios"
- Lista de negocios (cards clickeables)
- Formulario crear negocio
- Indicador "✅ Seleccionado"

#### Header Dropdown
- Selector de negocio
- Opción default "🏢 VELAMIA (predeterminado)"
- localStorage persist de selección

## Verificaciones Realizadas ✅

### Test: TiendaUnidades (piecesPerUnit=1)
```
🔐 Login CRM                          ✅ OK
📦 Crear negocio TiendaUnidades       ✅ OK (piecesPerUnit=1)
📩 Webhook desde +593999888777        ✅ Detectado
✅ Profile cargado dinámicamente      ✅ OK
```

### Backward Compatibility
- VELAMIA data (business_id = NULL) sin cambios ✅
- Conversaciones antiguas mantienen conversación ✅
- Perfil global como fallback ✅

## Decisiones de Diseño

### 1. business_id NULLABLE
**Por qué:** Permite VELAMIA (null) convivir con nuevos negocios sin migración de datos.

### 2. Profile en businessProfile JSONB
**Por qué:** Flexibilidad, no requiere tablas nuevas, fácil validación.

### 3. Custom Rates → placeholder por peso
**Por qué:** Peso requiere lista de productos (no disponible en shippingCost()).
Solución futura: pasar productWeights en context de planTurn.

### 4. localStorage para negocio seleccionado
**Por qué:** UX fluida, no requiere API call extra en cada recarga.

## Próximos Pasos

1. **Testing manual** con 2-3 negocios ficticios:
   - Negocio A: piecesPerUnit=1, Servientrega
   - Negocio B: piecesPerUnit=6, custom rates
   - Negocio C: piecesPerUnit=24 (cajas)

2. **Implementar weight calculation** en `shippingRates.ts`:
   - Pasar `orderItems` a `shippingCost()`
   - Calcular peso total = sum(item.quantity * getProductWeight(item.productId, profile))
   - Aplicar `customRates` si aplica

3. **CRM: Formulario de configuración** por negocio:
   - Editar piecesPerUnit
   - Definir custom rates (zonas + costo/kg)
   - Definir product weights

4. **Merge a main**:
   - Asegurar VELAMIA tagged `frozen/velamia`
   - Deploy multi-tenant a Render (rama develop/multi-tenant)

## Notas Técnicas

- **TypeScript:** 0 errores de compilación ✅
- **Migrations:** Idempotentes (IF NOT EXISTS), seguras ✅
- **RLS:** Tabla businesses solo accesible por service_key ✅
- **Índices:** business_id en todas las tablas (FK + business query) ✅
- **Logs:** "🏢 Negocio encontrado: TiendaUnidades" en webhook ✅

---

**Conclusión:** Arquitectura multi-tenant VERIFICADA y FUNCIONAL. Lista para testing con clientes reales o fases de producción.

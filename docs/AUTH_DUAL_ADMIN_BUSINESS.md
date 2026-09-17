# Autenticación Dual: Admin + Business Owner

**Implementación:** 17 de septiembre de 2026  
**Estado:** ✅ FUNCIONAL  
**Rama:** `develop/multi-tenant`

---

## 🎯 Concepto

El sistema SaaS tiene **dos roles con acceso diferenciado:**

| Rol | Acceso | Usos |
|-----|--------|------|
| **Admin** (Llave Maestra) | Ver/crear/gestionar TODOS los negocios | Aura: administración global del SaaS |
| **Business Owner** (Llave de Cliente) | Ver/editar SOLO su negocio | Cliente: agregar catálogo, manejar stock |

---

## 🔐 Autenticación

### 1. **Admin Login** (Llave Maestra)

```bash
POST /api/login
Content-Type: application/json

{
  "password": "tu_CRM_PASSWORD"
}

# Respuesta:
{
  "token": "eyJhbGc...(session token)"
}
```

**Uso:** Guardar token en localStorage, incluir en cada request:
```javascript
Authorization: Bearer eyJhbGc...
```

---

### 2. **Business Owner Login** (Llave de Cliente)

Primero, admin genera token UNA VEZ por negocio:

```bash
# ADMIN ejecuta esto
POST /api/businesses/{businessId}/generate-access-token
Authorization: Bearer {admin_token}

# Respuesta (única vez):
{
  "accessToken": "a1b2c3d4e5f6...(32 bytes hex)",
  "message": "Guarda este token de forma segura. Solo se muestra una vez."
}
```

El Business Owner recibe este token y lo usa:

```bash
POST /api/auth/login/business
Content-Type: application/json

{
  "accessToken": "a1b2c3d4e5f6..."
}

# Respuesta:
{
  "accessToken": "a1b2c3d4e5f6...",
  "businessId": "uuid-del-negocio",
  "message": "✅ Acceso de negocio otorgado."
}
```

---

## 📋 Endpoints por Rol

### Admin-Only

```
GET  /api/businesses
     Ver TODOS los negocios activos
     Requiere: admin session

POST /api/businesses
     Crear nuevo negocio
     Requiere: admin session

POST /api/businesses/:businessId/generate-access-token
     Generar token para un Business Owner
     Requiere: admin session
     ⚠️ Solo se muestra UNA VEZ
```

### Business Owner-Only

```
GET  /api/me/business
     Ver MI negocio (solo el propio)
     Requiere: business session (token)

GET  /api/me/products
     Ver MIS productos (solo del negocio)
     Requiere: business session (token)

POST /api/me/products
     Crear/editar MIS productos
     Requiere: business session (token)

PATCH /api/me/business
     Actualizar MI perfil (catálogo, stock, etc)
     Requiere: business session (token)
```

---

## 💾 Base de Datos

Tabla `business_access_tokens`:

```sql
CREATE TABLE business_access_tokens (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id),
  token_hash TEXT NOT NULL UNIQUE,  -- SHA256 del token plaintext
  created_at TIMESTAMP,
  last_used TIMESTAMP,              -- Registra último uso
  active BOOLEAN DEFAULT true
);
```

**Seguridad:**
- Token nunca se guarda plaintext en BD
- Se guarda el HASH SHA256
- Solo se devuelve UNA VEZ al crear
- `last_used` permite auditoría de acceso

---

## 🔄 Flujo Completo

### Paso 1: Admin Crea Negocio

```bash
curl -X POST http://localhost:3000/api/businesses \
  -H "Authorization: Bearer {admin_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "TiendaUnidades",
    "phoneNumber": "+593999888777",
    "accessToken": "sk-proj-xxx..." 
  }'

# Respuesta:
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "TiendaUnidades",
  "meta_phone_number": "+593999888777",
  "business_profile": { ... },
  "active": true,
  "created_at": "2026-09-17T..."
}
```

### Paso 2: Admin Genera Token para Cliente

```bash
curl -X POST http://localhost:3000/api/businesses/550e8400-e29b-41d4-a716-446655440000/generate-access-token \
  -H "Authorization: Bearer {admin_token}"

# Respuesta (⚠️ Única vez):
{
  "accessToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
  "message": "Guarda este token de forma segura. Solo se muestra una vez."
}
```

**Cliente recibe:** `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6`

### Paso 3: Business Owner Entra a su Plataforma

```bash
# Business Owner: entrada a portal
curl -X POST http://localhost:3000/api/auth/login/business \
  -H "Content-Type: application/json" \
  -d '{
    "accessToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"
  }'

# Respuesta:
{
  "accessToken": "a1b2c3d4e5f6...",
  "businessId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Paso 4: Business Owner Accede a su Negocio

```bash
# Ver su perfil
curl -X GET http://localhost:3000/api/me/business \
  -H "Authorization: Bearer a1b2c3d4e5f6..."

# Respuesta (solo su negocio):
{
  "id": "550e8400...",
  "name": "TiendaUnidades",
  "business_profile": { ... },
  "active": true
}
```

---

## 🛡️ Seguridad

### Token Plaintext (Solo para Crear)
- **Generado:** `crypto.randomBytes(32).toString('hex')` → 64 caracteres hex
- **Mostrado:** Una sola vez al admin
- **Guardado en BD:** SHA256 hash
- **Validación:** Business Owner envía plaintoken → servidor hashea y compara con BD

### Session Token Admin
- Firmado con HMAC-SHA256
- Expira en 7 días (configurable)
- Verificación timing-safe (contra timing attacks)

### Rate Limiting
- Actualmente: 10 intentos de login fallidos → 15 minutos bloqueado por IP
- Futura: rate limiting por Business Owner (tokens no consumidos rápido)

---

## 📝 Próximos Pasos

1. **CRM Frontend:** 
   - Página de login dual (Admin vs Business Owner)
   - Dashboard admin: lista de negocios + generar tokens
   - Dashboard Business Owner: solo su negocio + catálogo

2. **Endpoints Faltantes:**
   - `GET  /api/me/products` — lista de productos del negocio
   - `POST /api/me/products` — crear producto
   - `PATCH /api/me/products/:id` — editar producto
   - `PATCH /api/me/business` — actualizar config del negocio

3. **Auditoría:**
   - Logs de generación/uso de tokens
   - Dashboard de acceso por Business Owner

---

## ⚙️ Variables de Entorno

```env
CRM_PASSWORD=tu_contraseña_maestra_aqui

# Otros (ya existentes):
OPENAI_API_KEY=...
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
```

---

**Listo:** Autenticación dual funcional. Cada Business Owner tiene su llave segura.

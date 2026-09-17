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

GET  /api/businesses/:businessId/users
     Listar usuarios (owners, managers, staff) de un negocio
     Requiere: admin session

POST /api/businesses/:businessId/users
     Crear nuevo usuario en un negocio
     Body: { email, fullName, role: "owner"|"manager"|"staff" }
     Requiere: admin session

PATCH /api/businesses/:businessId/users/:userId
     Actualizar usuario (nombre, rol, estado)
     Requiere: admin session

DELETE /api/businesses/:businessId/users/:userId
     Desactivar usuario (soft delete)
     Requiere: admin session

POST /api/businesses/:businessId/users/:userId/generate-token
     Generar token de acceso para UN usuario específico
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

### Tabla `business_users` (Nuevo)

```sql
CREATE TABLE business_users (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id),
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT DEFAULT 'owner',  -- 'owner' | 'manager' | 'staff'
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  UNIQUE(business_id, email)  -- Un email por negocio
);
```

**Roles:**
- `owner` — Acceso total (agregar catálogo, stock, configuración)
- `manager` — Acceso moderado (ver catálogo, agregar stock)
- `staff` — Acceso limitado (solo consultar)

### Tabla `business_access_tokens` (Actualizada)

```sql
CREATE TABLE business_access_tokens (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id),
  business_user_id UUID REFERENCES business_users(id),  -- NUEVO: asociar a usuario
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
- `last_used` permite auditoría de acceso por usuario
- Cada usuario puede tener múltiples tokens (activos o revocados)

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
  ...
}
```

### Paso 2: Admin Crea Usuario(s) para ese Negocio

```bash
curl -X POST http://localhost:3000/api/businesses/550e8400-e29b-41d4-a716-446655440000/users \
  -H "Authorization: Bearer {admin_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "juan@tiendaunidades.com",
    "fullName": "Juan García",
    "role": "owner"  # owner | manager | staff
  }'

# Respuesta:
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "business_id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "juan@tiendaunidades.com",
  "full_name": "Juan García",
  "role": "owner",
  "active": true,
  "created_at": "2026-09-17T..."
}
```

**Opcional:** Crear más usuarios (managers, staff) con diferentes roles.

### Paso 3: Admin Genera Token para ese Usuario

```bash
curl -X POST http://localhost:3000/api/businesses/550e8400-e29b-41d4-a716-446655440000/users/f47ac10b-58cc-4372-a567-0e02b2c3d479/generate-token \
  -H "Authorization: Bearer {admin_token}"

# Respuesta (⚠️ Única vez, solo para Juan):
{
  "accessToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
  "user": {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "email": "juan@tiendaunidades.com",
    "fullName": "Juan García"
  },
  "message": "✅ Token para juan@tiendaunidades.com. Guárdalo de forma segura, solo se muestra una vez."
}
```

**Juan recibe:** `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6`

### Paso 4: Business Owner (Juan) Entra a su Plataforma

```bash
# Juan: entrada a portal
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

### Paso 5: Business Owner (Juan) Accede a su Negocio

```bash
# Ver su perfil (solo TiendaUnidades, no otros negocios)
curl -X GET http://localhost:3000/api/me/business \
  -H "Authorization: Bearer a1b2c3d4e5f6..."

# Respuesta (solo su negocio):
{
  "id": "550e8400...",
  "name": "TiendaUnidades",
  "business_profile": { ... },
  "active": true
}

# Ver/agregar productos de su catálogo
curl -X GET http://localhost:3000/api/me/products \
  -H "Authorization: Bearer a1b2c3d4e5f6..."
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

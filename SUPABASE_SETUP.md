# 🚀 Configuración Supabase — Base de Datos PostgreSQL en la Nube

Tu asistente ahora usa **Supabase** (PostgreSQL gratis en la nube) en lugar de SQLite local. ¡Mejor escalabilidad, backups automáticos y acceso desde cualquier lado!

## 📋 Paso 1: Crear Proyecto en Supabase (5 min)

### 1.1 Registrarse
1. Ve a https://supabase.com
2. Click "Start your project"
3. Signup con GitHub o email
4. Verifica tu email

### 1.2 Crear Proyecto
1. Dashboard → "New Project"
2. Nombre: `velamia-whatsapp`
3. Contraseña: crea una fuerte (guárdala)
4. Región: `us-east-1` (recomendado)
5. Click "Create new project"

**Espera 2-3 minutos mientras Supabase provisiona tu BD...**

## 📋 Paso 2: Obtener Credenciales (2 min)

Una vez creado tu proyecto:

### 2.1 Copiar URL de Supabase
En tu proyecto → Settings → API
- Copia **Project URL** (ej: `https://abc123xyz.supabase.co`)
- Pega en `.env.local`: `SUPABASE_URL=https://abc123xyz.supabase.co`

### 2.2 Copiar Service Key
En Settings → API → Service Role Secret
- Copia la key (larga, empieza con `eyJhbGc...`)
- Pega en `.env.local`: `SUPABASE_SERVICE_KEY=eyJhbGc...`

**⚠️ IMPORTANTE:** Esta key es como tu contraseña de DB. **NUNCA** la publiques en GitHub.

## 📋 Paso 3: Ejecutar Migraciones SQL (2 min)

### 3.1 Abrir SQL Editor
En tu proyecto → SQL Editor

### 3.2 Crear todas las tablas
Copia todo el contenido de `migrations/001_init_schema.sql` y:
1. Click "+" → "New Query"
2. Pega el SQL
3. Click "Run" (botón de play)

Deberías ver: ✅ Success

Las tablas están creadas automáticamente:
- `conversations`
- `messages`
- `quotations`
- `orders`
- `followups`
- `products`
- `business_config`

## 📋 Paso 4: Configurar `.env.local` (2 min)

Copia `.env.example` a `.env.local`:

```bash
cp .env.example .env.local
```

Edita con tus valores:

```
PORT=3000
NODE_ENV=development

WHATSAPP_TOKEN=EAA...tu_token
WHATSAPP_PHONE_ID=1317197854807120
WHATSAPP_BUSINESS_ACCOUNT_ID=114...
OPENAI_API_KEY=sk-proj-...
WEBHOOK_VERIFY_TOKEN=tu_token_seguro

SUPABASE_URL=https://abc123xyz.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGc...
```

## 📋 Paso 5: Instalar Dependencias (5 min)

```bash
npm install
```

Esto instalará la librería `@supabase/supabase-js` que ya está en `package.json`.

## ✅ Paso 6: Probar Conexión (2 min)

```bash
npm run dev
```

Deberías ver en terminal:
```
✅ Conectado a Supabase
📊 Base de datos lista
🚀 Servidor ejecutándose en puerto 3000
```

Si ves error de conexión, revisa:
- URLs y keys correctas en `.env.local`
- Que Supabase haya terminado de provisionar (2-3 minutos)

## 📊 Ver Datos en Supabase

### En el Dashboard
1. Tu proyecto → Table Editor
2. Haz clic en cada tabla para ver datos
3. Ejemplo: `conversations` mostrará clientes que escriben

### Ejecutar queries SQL
Tu proyecto → SQL Editor → puedes escribir SQL directo:

```sql
SELECT COUNT(*) as total_clientes FROM conversations;
SELECT SUM(total_amount) as ingresos FROM orders WHERE status = 'delivered';
```

## 🔄 Backup Automático

Supabase hace **backup automático diariamente**. Para descargar:

1. Tu proyecto → Backups
2. Click en cualquier backup
3. "Restore" o "Download"

## 🚀 Deploy a Railway con Supabase

Cuando despliegues a Railway:

1. Railway Dashboard → Tu proyecto → Variables
2. Agrega:
   ```
   SUPABASE_URL=https://abc123xyz.supabase.co
   SUPABASE_SERVICE_KEY=eyJhbGc...
   ```
3. El bot conecta automáticamente a tu BD en Supabase

**Ventaja:** La BD es idéntica en desarrollo y producción.

## 🔐 Seguridad

### ✅ Buenas prácticas
- Nunca compartas `SUPABASE_SERVICE_KEY`
- Guárdala en `.env.local` (en `.gitignore`)
- En producción, usa Railway's secret variables
- Supabase encripta todo automáticamente

### Cambiar contraseña de BD
Si crees que la contraseña se expuso:
1. Tu proyecto → Settings → Database
2. "Reset database password"
3. Confirma (toma ~5 min)

## 📈 Monitorear Uso

Supabase tiene plan gratuito:
- 500 MB storage
- Queries ilimitadas
- Backups diarios

Para ver uso:
1. Tu proyecto → Billing
2. "Project size"

Si necesitas más: Upgrade a plan pagado ($25/mes).

## 🐛 Troubleshooting

**"Error: connect ECONNREFUSED"**
→ Espera a que Supabase termine de provisionar (2-3 min)

**"Service role key is invalid"**
→ Copia exactamente la key, sin espacios al inicio/final

**"Table does not exist"**
→ Ejecutaste las migraciones SQL? (Paso 3)

**"Connection timeout"**
→ Supabase puede tener issues. Espera 5 min y reinicia.

## ✨ Ventajas de Supabase vs SQLite

| Aspecto | SQLite | Supabase |
|--------|--------|----------|
| Hosting | Local | Cloud |
| Escalabilidad | Limitada | Infinita |
| Backup | Manual | Automático |
| Costo | Gratis | Gratis (+pay-as-you-go) |
| Usuarios simultáneos | ~10 | 1000+ |
| Disponibilidad | Si se cae el servidor | 99.9% SLA |

---

**¡Tu base de datos está en Supabase!** 🎉

Próximo paso: Configura WhatsApp en SETUP.md

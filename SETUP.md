# 🚀 Guía de Setup Paso a Paso

## Fase 1: Preparación (5 min)

### 1.1 Clonar/Descargar proyecto
```bash
cd C:\Users\aurac
git clone <url-del-repo> whatsapp-assistant-velamia
cd whatsapp-assistant-velamia
```

### 1.2 Instalar Node.js (si no tienes)
Descarga desde: https://nodejs.org/ (versión LTS 18+)

Verifica instalación:
```bash
node --version
npm --version
```

### 1.3 Instalar dependencias
```bash
npm install
```

---

## Fase 2: Configurar OpenAI (5 min)

### 2.1 Crear API key
1. Ve a https://platform.openai.com/account/api-keys
2. Click en "+ Create new secret key"
3. Copia la key (aparece solo una vez)

### 2.2 Guardar en .env.local
```bash
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxx
```

---

## Fase 3: Configurar WhatsApp Business API (15 min)

### 3.1 Ir a Meta Business
1. https://business.facebook.com
2. Login con tu cuenta de Meta/Facebook

### 3.2 Crear Business Account (si no tienes)
1. Esquina inferior izquierda → "Business settings"
2. "Cuentas" → "+ Agregar cuenta"
3. Elige "Crear nueva cuenta comercial"

### 3.3 Crear/Acceder a Aplicación
1. En Business settings, ve a "Apps"
2. Click "+ Create App"
3. Elige: "Business" → "Messaging"
4. Nombre: "VELAMIA WhatsApp Assistant"

### 3.4 Agregar WhatsApp
1. En tu App, ve a "Add products"
2. Busca "WhatsApp Business"
3. Click "Set Up"
4. Elige país y acepta términos

### 3.5 Obtener credenciales
En **Settings → Basic Information**:
- App ID (copiar)

En **WhatsApp → Getting Started**:
- Haz click en "Manage phone numbers"
- Agregar número: usa tu teléfono personal
- Verifica con código SMS
- **Copia el Phone Number ID** (el que empieza con números)

Luego, en **Configuración → Tokens de acceso**:
1. Haz click en tu nombre en esquina superior
2. "Generate access token"
3. Selecciona: "whatsapp_business_messaging"
4. **Copia el token** (largo con letras/números)

Guarda en `.env.local`:
```bash
WHATSAPP_TOKEN=EAAxxxxxxxxxxxxxx
WHATSAPP_PHONE_ID=1317197854807120
WHATSAPP_BUSINESS_ACCOUNT_ID=114xxxxxxxxxxxxx
```

---

## Fase 4: Configurar Webhook (10 min)

### 4.1 Generar Webhook Verify Token
Elige una contraseña fuerte:
```bash
WEBHOOK_VERIFY_TOKEN=mi_token_super_seguro_2024_abc123
```

### 4.2 Tunelear tu servidor local (desarrollo)
Usa Ngrok para exponer tu servidor local a internet:

1. Descarga: https://ngrok.com/download
2. En terminal:
```bash
ngrok http 3000
```
3. Verás URL como: `https://abc123def.ngrok.io`
4. Copia la URL HTTPS

### 4.3 Registrar Webhook en Meta
En Meta Business → **WhatsApp → Configuración → Webhooks**:

1. Click "Edit"
2. **URL de devolución:** `https://abc123def.ngrok.io/webhook`
3. **Token de verificación:** `mi_token_super_seguro_2024_abc123`
4. **Eventos:** marca ✓ `messages`
5. Click "Verificar y guardar"

Meta enviará un test → si ves ✓ verde, ¡está configurado!

---

## Fase 5: Probar Localmente (5 min)

### 5.1 Completar .env.local
```bash
PORT=3000
WHATSAPP_TOKEN=EAAxxxxxxxxxxxxxx
WHATSAPP_PHONE_ID=1317197854807120
WHATSAPP_BUSINESS_ACCOUNT_ID=114xxxxxxxxxxxxx
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxx
WEBHOOK_VERIFY_TOKEN=mi_token_super_seguro_2024_abc123
DATABASE_PATH=./data/velamia.db
NODE_ENV=development
```

### 5.2 Inicializar base de datos
```bash
npm run db:init
```

### 5.3 Iniciar servidor
En terminal 1:
```bash
npm run dev
```

Deberías ver:
```
✅ Base de datos inicializada
🚀 Servidor ejecutándose en puerto 3000
📱 Webhook URL: http://localhost:3000/webhook
```

### 5.4 Probar endpoint
En terminal 2:
```bash
curl http://localhost:3000/health
```

Respuesta esperada:
```json
{"status":"ok","timestamp":"2026-09-14T..."}
```

### 5.5 Enviar mensaje de prueba
1. En WhatsApp, envía un mensaje a tu número de negocio
2. El bot debería responder automáticamente
3. Revisa logs en terminal para ver flujo

---

## Fase 6: Deploy a Railway (10 min)

### 6.1 Crear cuenta Railway
1. https://railway.app
2. Signup con GitHub

### 6.2 Conectar GitHub
1. En Railway: "New Project" → "Deploy from GitHub"
2. Selecciona tu repositorio
3. Deploy automático ✓

### 6.3 Agregar variables de entorno
En Railway Project Settings:
```
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_ID=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
OPENAI_API_KEY=...
WEBHOOK_VERIFY_TOKEN=...
NODE_ENV=production
```

### 6.4 Obtener URL pública
Railway te asigna URL como: `https://whatsapp-velamia-prod.up.railway.app`

### 6.5 Actualizar Webhook en Meta
En Meta Business → **Webhooks**:
- **URL de devolución:** `https://whatsapp-velamia-prod.up.railway.app/webhook`
- Guardar

¡Listo! Tu bot está en producción 🎉

---

## ⚠️ Checklist Final

- ✓ Node.js instalado
- ✓ Dependencias instaladas (`npm install`)
- ✓ OpenAI API key válida
- ✓ WhatsApp token válida
- ✓ Phone ID correcto
- ✓ Webhook registrado en Meta
- ✓ Base de datos inicializada
- ✓ Servidor ejecutándose
- ✓ Primer mensaje respondido

---

## 🆘 Problemas comunes

### "No se puede conectar a la BD"
```bash
npm run db:init
```

### "Webhook verification failed"
- Verifica `WEBHOOK_VERIFY_TOKEN` exacto
- Reinicia ngrok
- Vuelve a verificar en Meta

### "OpenAI error: invalid API key"
- Regenera key en platform.openai.com
- Asegúrate que esté en `.env.local`

### "WhatsApp token inválido"
- El token expira cada ~24h
- Regenera en Meta Business
- Usa "Long-lived access token"

---

**¿Preguntas?** Contacta: auracandles732@gmail.com

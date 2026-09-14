# 🚀 ASISTENTE IA OPERATIVO — GUÍA FINAL

Tu asistente WhatsApp está **100% configurado y listo**. Solo necesitas seguir estos 3 pasos.

---

## ✅ PASO 1: Crear las Tablas en Supabase (5 min)

1. Ve a tu dashboard Supabase: https://supabase.com/dashboard/project/yhaiprlfpmugohmzpzcq
2. Click en **"SQL Editor"**
3. Click en **"+ New Query"**
4. Copia TODO el contenido de: `migrations/002_complete_schema.sql`
5. Pégalo en el editor
6. Click en **"RUN"** (botón de play)

**Deberías ver ✅ Success**

Si todo está bien:
- ✅ 7 tablas creadas
- ✅ Índices optimizados
- ✅ Triggers automáticos
- ✅ Configuración inicial insertada

---

## ✅ PASO 2: Abrir el CRM/Dashboard (2 min)

Abre el archivo (doble-click):
```
C:\Users\aurac\whatsapp-assistant-velamia\dashboard\index.html
```

Deberías ver:
- Dashboard profesional
- 0 conversaciones (porque aún no hay mensajes)
- Estadísticas en vivo
- Control del bot

---

## ✅ PASO 3: Configurar el Webhook en Meta Business (5 min)

1. Ve a https://business.facebook.com
2. Tu app → WhatsApp → Webhooks
3. Click **"Edit"**
4. **URL de devolución:**
   ```
   https://tu-url-de-railway.railway.app/webhook
   ```
   (Cambiar `tu-url-de-railway` por tu URL real de Railway)

5. **Token de verificación:**
   ```
   velamia_webhook_2024_secure_token
   ```
   (Es el mismo que en `.env.local`)

6. **Eventos:** ✓ messages
7. Click **"Verificar y guardar"**

Meta enviará un test. Si ves ✓ verde, **¡LISTO!**

---

## 🎯 Cómo probar que TODO funciona

### Test 1: Enviar un mensaje desde WhatsApp
1. Abre WhatsApp
2. Envía un mensaje a tu número de negocio
3. El bot responde automáticamente

### Test 2: Ver el CRM en acción
1. Abre `dashboard/index.html` en tu navegador
2. Deberías ver tu conversación en tiempo real
3. Estadísticas actualizadas cada 5 segundos

### Test 3: Responder manualmente
1. En el CRM, selecciona una conversación
2. Escribe un mensaje
3. Click en "Enviar"
4. El cliente recibe el mensaje manualmente

---

## 📱 ¿Cómo funciona el flujo?

```
Cliente escribe en WhatsApp
        ↓
Webhook recibe mensaje
        ↓
IA analiza intención
        ↓
Bot responde automáticamente
        ↓
Mensaje guardado en Supabase
        ↓
Aparece en CRM en tiempo real
        ↓
(Tú puedes responder manualmente si quieres)
```

---

## 🎛️ Controles del CRM

### Estado del Bot
- **🤖 Bot Activo** (verde) = Responde automáticamente
- **🚫 Bot Inactivo** (rojo) = Tú respondes manualmente

Click para toggle.

### Estadísticas (en vivo)
- **Total Clientes**: Conversaciones creadas
- **Conversaciones Activas**: Status = 'active'
- **Pedidos**: Órdenes registradas
- **Ingresos**: Total $

Se actualiza cada 5 segundos.

### Envío de Mensajes
1. Selecciona una conversación
2. Escribe tu mensaje
3. Click "Enviar" o Enter
4. Mensaje se envía al cliente

### Envío de Fotos (próximamente)
1. Click en "📷 Foto"
2. Selecciona la imagen
3. Se envía al cliente

---

## 🚀 Deploy a Producción

Una vez todo funcione localmente:

1. **Sube a GitHub**
   ```bash
   git push origin main
   ```

2. **Deploy en Railway**
   - Ve a https://railway.app
   - "New Project" → "Deploy from GitHub"
   - Selecciona tu repo
   - Railway auto-deploya

3. **Agrega variables en Railway**
   - Todos los valores de `.env.local`
   - Railway encripta automáticamente

4. **Obtén la URL pública**
   - Railway te asigna algo como: `https://whatsapp-velamia-prod.railway.app`
   - Usa esa en el webhook de Meta

---

## 📊 Datos de tu Negocio (próximo paso)

Una vez que TODO esté funcionando, pasamos a:

1. **Agregar productos** (tus velas con fotos)
2. **Configurar prompt de IA** (cómo habla el bot)
3. **Personalizar respuestas** (tono, políticas, etc)
4. **Agregar fotos de productos** (para que el bot las envíe)

---

## ⚠️ Si algo falla

### "Error: conectando a Supabase"
- Verifica URL y Service Key en `.env.local`
- ¿Están correctos?

### "Webhook verification failed"
- Copia exacto: `velamia_webhook_2024_secure_token`
- ¿Sin espacios al inicio/final?

### "No aparecen conversaciones en CRM"
- ¿Ejecutaste las migraciones SQL? (Paso 1)
- ¿Enviaste un mensaje desde WhatsApp?
- El CRM auto-refresca cada 5 segundos

### "Bot no responde"
- ¿El webhook está verificado en Meta?
- ¿La URL de Railway es correcta?
- ¿Bot está en estado "Activo"?

---

## 📞 Resumen

✅ Credenciales: Configuradas
✅ Base de datos: Lista
✅ CRM: Funcional
✅ Bot: Conectado
✅ Todo: Operativo

**Ahora:**
1. Ejecuta migraciones SQL
2. Abre dashboard/index.html
3. Configura webhook en Meta
4. ¡Prueba enviando un mensaje!

---

**¿Preguntas? Todo está en los archivos documentados.**

Última actualización: 14-sep-2026

# 🚀 Deployment a Railway

Railway es la forma más fácil de desplegar tu asistente en producción. ¡Gratis para empezar!

## 📋 Prerequisitos

- ✅ Cuenta en Railway.app
- ✅ Repositorio en GitHub
- ✅ Variables de entorno configuradas

## 1️⃣ Conectar GitHub a Railway

1. Ve a https://railway.app
2. Login/Signup
3. "New Project" → "Deploy from GitHub"
4. Autoriza Railway en tu cuenta GitHub
5. Selecciona tu repositorio `whatsapp-assistant-velamia`
6. Click "Deploy"

Railway automáticamente:
- Detecta Node.js
- Instala dependencias
- Compila TypeScript
- Inicia el servidor

## 2️⃣ Configurar Variables de Entorno

En Railway Dashboard → Tu proyecto → Variables:

Copia-pega cada una:

```
WHATSAPP_TOKEN=EAA...xxxxx
WHATSAPP_PHONE_ID=1317197854807120
WHATSAPP_BUSINESS_ACCOUNT_ID=114xxxxx
OPENAI_API_KEY=sk-proj-xxxxx
WEBHOOK_VERIFY_TOKEN=tu_token_seguro_aqui
DATABASE_PATH=/var/data/velamia.db
NODE_ENV=production
PORT=3000
```

## 3️⃣ Obtener URL Pública

Railway asigna automáticamente una URL:
```
https://whatsapp-velamia-prod.railway.app
```

(Railway genera nombres aleatorios, puedes cambiar el nombre del proyecto)

## 4️⃣ Actualizar Webhook en Meta Business

En **Meta Business → WhatsApp → Webhooks**:

1. URL de devolución: `https://whatsapp-velamia-prod.railway.app/webhook`
2. Token de verificación: (el mismo de `.env.local`)
3. Click "Guardar"

Meta hará un test automático. Si ves ✓ verde, ¡está correcto!

## 5️⃣ Monitorear Deploy

En Railway Dashboard:
- **Deployments** → ves historial de deploys
- **Logs** → ves output del servidor
- **Variables** → edita variables en vivo

```
✓ Build successful
✓ Server started on port 3000
📱 Webhook URL: https://...railway.app/webhook
```

Si ves errores:
1. Click en el deploy rojo
2. Abre "Logs"
3. Busca el error
4. Arregla el código localmente
5. Haz `git push` → Railway auto-redeploy

## 6️⃣ Auto-Deploy en Cada Push

Railway configura automáticamente que:
- Cada `git push` a `main` → se rebuilda y redeploy
- Cero downtime (Blue-Green deployment)

```bash
git add .
git commit -m "Agregar nueva funcionalidad"
git push origin main
# Railway automáticamente redeploy en ~2 minutos
```

## 7️⃣ Problemas Comunes

### "Build failed"
→ Revisa Logs en Railway Dashboard
→ Asegúrate que `npm run build` funciona localmente

### "Connection refused"
→ El servidor no está escuchando en puerto `PORT`
→ Revisa `process.env.PORT` en `index.ts`

### "Webhook verification failed"
→ La URL de Railway no es accesible
→ Espera 2-3 minutos después de deploy
→ Reinicia el webhook en Meta

### "Database locked"
→ SQLite no es ideal para concurrencia
→ Para producción, considera migrar a PostgreSQL (Railway lo ofrece gratis)

## 📊 Monitorear en Producción

Railway ofrece:
- **Metrics:** CPU, memoria, requests
- **Logs:** Todos los console.log() en vivo
- **Deployment history:** Versiones anteriores

## 🔄 Actualizar a PostgreSQL (Opcional)

Si necesitas escalabilidad:

1. En Railway Dashboard → "+ Create"
2. Selecciona "PostgreSQL"
3. Conecta al proyecto
4. Modifica `src/db.ts` para usar `pg` en lugar de `sqlite3`
5. Redeploy

## 🎯 Resumen

| Acción | Resultado |
|--------|-----------|
| `git push` | Auto-deploy a Railway |
| Cambiar variables | Restart automático |
| Ver logs | Tiempo real en Dashboard |
| Rollback | 1-click a versión anterior |

---

**Tu bot está en producción 24/7 🚀**

Para soporte: https://railway.app/support

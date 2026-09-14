# Asistente WhatsApp VELAMIA 🕯️

Asistente inteligente de ventas para VELAMIA, automatiza conversaciones en WhatsApp y gestiona cotizaciones, pedidos y seguimientos.

## 🚀 Características

✅ Recibe y responde mensajes automáticamente con IA (OpenAI GPT-4o)
✅ Crea cotizaciones personalizadas
✅ Gestiona pedidos y seguimientos
✅ Envía fotos y mensajes interactivos
✅ Cierra ventas completamente automatizado
✅ Base de datos PostgreSQL en Supabase (backups automáticos)

## 📋 Requisitos previos

- Node.js 18+
- npm o yarn
- Cuenta de WhatsApp Business (Meta Business Account)
- API key de OpenAI

## 🔧 Instalación

### 1. Clonar/Descargar el proyecto
```bash
cd whatsapp-assistant-velamia
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables de entorno
Copia `.env.example` a `.env.local` y completa:

```bash
cp .env.example .env.local
```

Edita `.env.local`:
```
PORT=3000
WHATSAPP_TOKEN=tu_token_de_meta_aqui
WHATSAPP_PHONE_ID=123456789
WHATSAPP_BUSINESS_ACCOUNT_ID=tu_id_aqui
OPENAI_API_KEY=sk-...
WEBHOOK_VERIFY_TOKEN=mi_token_seguro_123
DATABASE_PATH=./data/velamia.db
NODE_ENV=development
```

### 4. Inicializar base de datos
```bash
npm run db:init
```

## ⚙️ Configuración de WhatsApp

### 1. Obtener credenciales en Meta Business

1. Ve a [Meta Business Platform](https://business.facebook.com)
2. Crea o selecciona tu Business Account
3. Ve a **Herramientas → WhatsApp Manager**
4. Crea una aplicación o usa una existente
5. En **Configuración → Números de teléfono**, obtén:
   - `WHATSAPP_PHONE_ID`: ID del número
   - `WHATSAPP_BUSINESS_ACCOUNT_ID`: ID de la cuenta

### 2. Generar token
1. En **Configuración → Tokens de acceso**
2. Crea un token con permisos: `whatsapp_business_messaging`
3. Copia en `WHATSAPP_TOKEN`

### 3. Configurar Webhook
Tu servidor necesita estar en internet (usa Ngrok para desarrollo):

```bash
ngrok http 3000
```

Copia la URL (ej: `https://abc123.ngrok.io`)

En Meta Business:
1. **Configuración → Webhooks**
2. URL de devolución: `https://abc123.ngrok.io/webhook`
3. Token de verificación: el valor de `WEBHOOK_VERIFY_TOKEN`
4. Eventos a suscribirse: `messages`

## 🏃 Uso

### Desarrollo
```bash
npm run dev
```

El servidor estará en `http://localhost:3000`

### Producción
```bash
npm run build
npm start
```

## 📚 Estructura de Base de Datos

### Tablas principales:

**conversations** — Conversaciones activas
```
- id (PK)
- phone_number
- customer_name
- status (active, closed, paused)
- last_message_time
- created_at, updated_at
```

**messages** — Historial de mensajes
```
- id (PK)
- conversation_id (FK)
- sender (customer, bot)
- type (text, image, document)
- content
- timestamp
```

**quotations** — Cotizaciones generadas
```
- id (PK)
- conversation_id (FK)
- customer_name, customer_phone
- products (JSON)
- total_amount
- status (pending, accepted, expired)
- created_at, expires_at (3 días)
```

**orders** — Pedidos completados
```
- id (PK)
- conversation_id (FK)
- customer_name, customer_phone, customer_address
- products (JSON)
- total_amount
- status (pending, confirmed, shipped, delivered)
- payment_method
- created_at, delivery_date
```

**followups** — Seguimientos programados
```
- id (PK)
- conversation_id, order_id (FK)
- type (reminder, update, feedback)
- message, scheduled_time
- status (pending, sent)
```

**products** — Catálogo
```
- id (PK)
- name, description
- price, stock
- image_url, category
```

**business_config** — Configuración
```
- key (PK): business_name, owner_phone, currency, timezone
- value
```

## 🔄 Flujo de un mensaje

```
1. Cliente envía mensaje → Webhook recibe
2. Se guarda en DB (conversations, messages)
3. Se analiza intención con OpenAI
4. Se genera respuesta inteligente
5. Si es cotización/pedido → se crea registro
6. Se envía respuesta al cliente
7. Se actualiza historial
```

## 📞 Funcionalidades por tipo de mensaje

### Saludo/Información
- IA responde naturalmente
- Sugiere productos

### Solicitud de Cotización
- Extrae productos del mensaje
- Genera cotización con ID único
- Válida 3 días
- Envía resumen al cliente

### Solicitud de Pedido
- Confirma productos y cantidad
- Solicita dirección de entrega
- Crea registro de orden
- Notifica disponibilidad

### Consulta de Estado
- Busca pedidos del cliente
- Informa estado actual
- Próxima fecha de entrega

### Solicitud de Pago
- Muestra opciones disponibles
- Direcciona según método
- Registra transacción

## 🔐 Seguridad

- Variables de entorno: `.env.local` (nunca en git)
- Tokens seguros en proceso
- SQLite local (sin cloud)
- Validación de webhooks

## 🚨 Troubleshooting

**Error: "Webhook verification failed"**
- Verifica `WEBHOOK_VERIFY_TOKEN` en Meta Business
- Comprueba que matches en `.env.local`

**Error: "Invalid WhatsApp token"**
- Token puede haber expirado
- Regenera en Meta Business Platform

**Mensajes no se envían**
- Verifica `WHATSAPP_PHONE_ID` correcto
- El número debe estar verificado en Meta

**OpenAI error "rate limit"**
- Espera unos minutos
- O upgradea tu plan en OpenAI

## 📈 Próximas mejoras

- [ ] Dashboard de ventas
- [ ] Integración con pasarelas de pago
- [ ] Envío automático de imágenes del catálogo
- [ ] AI Training con tus productos específicos
- [ ] Webhook de entrega confirmada

## 📧 Soporte

Para dudas o errores, contacta a: auracandles732@gmail.com

---

**Versión:** 1.0.0  
**Última actualización:** Sep 2026  
**Estado:** Producción

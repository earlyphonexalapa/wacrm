# Conectar WhatsApp Business por coexistencia

Con coexistencia, el mismo número funciona a la vez en la **app WhatsApp Business del celular** y en el **CRM**. Lo que escribes desde el celular aparece en el CRM, y el historial de los últimos 180 días se importa.

La conexión se hace con un botón del CRM (Ajustes → WhatsApp → **Conectar mi número**) que abre el "Embedded Signup" de Meta. Para que el botón funcione hay que crear una app en Meta **una sola vez**. Esta guía parte de cero.

## Lo que necesitas antes de empezar

- Una cuenta de Facebook (la que administra tu portafolio comercial de Meta).
- Un **portafolio comercial** de Meta (Meta Business). Si ya tienes tu cuenta publicitaria, ya tienes uno; usa el mismo.
- El **dominio del CRM con HTTPS** (por ejemplo `https://crm.tudominio.com`).
- Acceso a las variables de entorno de tu hosting y al SQL Editor de Supabase.
- El celular con la app **WhatsApp Business versión 2.24.17 o superior** y el número que quieres conectar.

> **Una advertencia honesta.** Meta documenta el Embedded Signup con coexistencia para Tech Providers y Solution Partners, y no aclara si un negocio puede conectar solo su propio número. Sí dice que quien usa la API para sí mismo ("Direct Developer") **no necesita acceso avanzado ni App Review**, y que los administradores de la app pueden probar el flujo con su propia cuenta. Lo más probable es que te funcione con tu cuenta como administrador. Si Meta lo rechaza, el CRM muestra el mensaje exacto que devuelve Meta; en ese caso la salida es registrar la app como Tech Provider (verificación del negocio y App Review de los permisos de WhatsApp).

---

## Parte A. Crear la app de Meta desde cero

### A1. Cuenta de desarrollador

1. Entra a <https://developers.facebook.com/> con tu cuenta de Facebook.
2. Si te lo pide, completa el registro como desarrollador (**Get Started**). Es gratis.

### A2. Crear la app

1. Ve a <https://developers.facebook.com/apps> y pulsa **Create App** (Crear app).
2. Escribe el **nombre de la app** (por ejemplo, `EarlyAcademy CRM`) y tu **correo**.
3. En el caso de uso, elige **Connect with customers through WhatsApp** (Conectar con clientes a través de WhatsApp) y pulsa **Next**.
4. Elige tu **portafolio comercial** (o crea uno) y pulsa **Next**.
5. Lee los requisitos de publicación, pulsa **Next** y luego **Create app**.

La app debe quedar de tipo **Business**; el tipo se ve arriba en el panel de la app.

Al terminar entras a **Customize use case → Connect on WhatsApp → Quickstart**.

### A3. Cuenta de WhatsApp Business

En **Quickstart → Start using the API** (se abre **API Setup**), Meta pide asociar una cuenta de WhatsApp Business: elige una de la lista o pulsa **Create a WhatsApp Business account**. Si Meta te deja seguir sin ella, no hace falta: el asistente de coexistencia de la Parte F conecta la cuenta de tu número.

### A4. App ID y App Secret

1. El **App ID** aparece arriba en el panel de la app.
2. El **App Secret** está en **App settings → Basic** (pulsa **Show** y confirma tu contraseña).

Guárdalos: son `META_APP_ID` y `META_APP_SECRET` (Parte D). **El App Secret nunca se comparte ni se pone en el navegador.**

### A5. Quién puede probar

En **App roles → Roles**, la persona que vaya a conectar el número debe ser **Administrator** o **Developer** de la app. Tú, como creador, ya lo eres. Mientras la app esté en modo desarrollo, solo ellos pueden completar el flujo.

---

## Parte B. Configurar el inicio de sesión de WhatsApp (Embedded Signup)

1. En el menú de la app, agrega el producto **Facebook Login for Business** (si no aparece, búscalo en **Add product** o **Use cases**).
2. Entra a **Facebook Login for Business → Configurations**.
3. Pulsa **Create from template** y elige **WhatsApp Embedded Signup Configuration With 60 Expiration Token**.
   (Alternativa: **Create configuration**, ponle un nombre y elige la variación **WhatsApp Embedded Signup**.)
4. Elige los productos y permisos. Deja solo lo necesario: `whatsapp_business_management` y `whatsapp_business_messaging`. Los permisos de más hacen que la gente abandone el proceso.
5. Guarda y **copia el Configuration ID**. Será `META_ES_CONFIG_ID`.
6. Ve a **Facebook Login for Business → Settings → Client OAuth settings** y pon en **Yes**:
   - Client OAuth login
   - Web OAuth login
   - Enforce HTTPS
   - Embedded Browser OAuth Login
   - Use Strict Mode for redirect URIs
   - Login with the JavaScript SDK
7. En **Allowed domains for the JavaScript SDK** y en **Valid OAuth redirect URIs**, agrega el dominio de tu CRM, por ejemplo `https://crm.tudominio.com/`. Si el dominio no está en ambos campos, Meta no devuelve la respuesta al CRM. Solo se aceptan dominios con HTTPS.
8. Guarda los cambios.

---

## Parte C. Webhook

El webhook es la dirección a la que Meta manda los mensajes. Meta la comprueba cuando la guardas, así que el CRM necesita conocer una clave de verificación **antes** de que exista ningún número conectado.

1. Inventa una clave larga y aleatoria (por ejemplo, 32 caracteres). Será `META_WEBHOOK_VERIFY_TOKEN`. Agrégala en tu hosting (Parte D) y **vuelve a desplegar** antes de continuar.
2. En la app, ve a **WhatsApp → Configuration → Webhooks** y pulsa **Edit**.
3. **Callback URL:** `https://crm.tudominio.com/api/whatsapp/webhook`
4. **Verify token:** la clave del paso 1.
5. Pulsa **Verify and Save**.
6. En la lista de campos (**Webhook fields**), pulsa **Subscribe** en estos:
   - `messages`
   - `account_update` (obligatorio: Meta avisa por aquí cuando termina la conexión)
   - `history`
   - `smb_app_state_sync`
   - `smb_message_echoes`
   - `message_template_status_update` (si usas plantillas)

---

## Parte D. Variables de entorno en tu hosting

Agrega estas variables y **vuelve a desplegar**:

| Variable | Qué es |
| --- | --- |
| `META_APP_ID` | App ID (A4) |
| `META_APP_SECRET` | App Secret (A4). También verifica las firmas del webhook |
| `META_ES_CONFIG_ID` | Configuration ID (B5) |
| `META_WEBHOOK_VERIFY_TOKEN` | La clave del webhook (C1) |
| `META_COEXISTENCE_API_VERSION` | Opcional. Versión de la Graph API para estas llamadas; por defecto `v27.0` |

Si ya tenías `META_APP_ID` y `META_APP_SECRET` de otra app, **reemplázalos por los de la app nueva**.

## Parte E. Base de datos

Ejecuta `supabase/migrations/060_whatsapp_coexistence.sql` en el SQL Editor de Supabase. Es segura de repetir.

---

## Parte F. Conectar el número

1. En el celular, abre la app **WhatsApp Business** con el número que quieres conectar.
2. En el CRM, ve a **Ajustes → WhatsApp → Conectar mi número**.
3. Sigue el asistente de Meta: inicia sesión, elige tu portafolio, escanea el **código QR** con la app del celular, toca **Conectar a la Plataforma de WhatsApp Business** y confirma.
4. Cuando Meta pregunte si compartir el historial de chats, acepta para importarlo.
5. **Deja abierta la app WhatsApp Business** hasta que el historial termine (la tarjeta del CRM muestra el avance).

Esto **reemplaza** la conexión actual de WhatsApp de la cuenta: el CRM guarda un solo número por cuenta. Los datos de atribución a Meta Ads (dataset y token) se conservan.

Las **plantillas** de mensaje pertenecen a la cuenta de WhatsApp Business. Si conectas una cuenta distinta a la anterior, tendrás que volver a crearlas o sincronizarlas.

---

## Qué hace el CRM con lo que llega

| Evento | Qué pasa |
| --- | --- |
| Mensaje que escribes en el celular (`smb_message_echoes`) | Se guarda en el chat como mensaje enviado por un agente. Se pausa la IA y cualquier flujo activo de ese contacto: una persona está contestando. |
| Historial (`history`) | Se importan los chats con sus fechas reales. No cuenta como contactos nuevos del día, no se asigna a closers y no dispara automatizaciones ni notificaciones. |
| Contactos del celular (`smb_app_state_sync`) | Solo se completa el **nombre** de contactos que el CRM ya tiene y que solo mostraban el número. No se importa tu agenda completa. |
| Desconexión (`account_update`) | Si desconectas la cuenta desde la app o Meta lo hace por inactividad, el CRM la marca como desconectada. |

Meta permite pedir cada sincronización (contactos e historial) **una sola vez y dentro de las primeras 24 horas** tras conectar. El CRM las pide automáticamente al terminar. Si hay que repetirlas, hay que desconectar y volver a conectar el número.

## Límites de Meta con coexistencia

- Velocidad de envío fija de 20 mensajes por segundo.
- En chats 1 a 1 de la app del celular dejan de funcionar: mensajes temporales, ver una vez, ubicación en vivo y listas de difusión.
- WhatsApp para Windows no es compatible; los otros dispositivos vinculados se desvinculan al conectar.
- Los grupos no se sincronizan y las llamadas no cambian.
- Los mensajes que envías desde la app siguen siendo gratis; los que se envían por la API siguen el precio de Cloud API.
- Si el celular pasa unos 14 días sin abrir la app WhatsApp Business, Meta desconecta la API.

## Si algo falla

| Síntoma | Causa probable |
| --- | --- |
| El botón dice "Falta configurar Meta en el servidor" | Falta una variable de la Parte D, o no se desplegó después de agregarla |
| **Verify and Save** del webhook falla | `META_WEBHOOK_VERIFY_TOKEN` no está desplegada, o la clave del paso C4 no coincide |
| El popup de Meta se abre y no devuelve nada | El dominio no está en **Allowed domains** y **Valid OAuth redirect URIs** (B7), o falta alguna opción de B6 |
| "Meta rechazó el código" | El código caduca a los 30 segundos: vuelve a pulsar el botón |
| Meta no deja continuar con tu cuenta | La app sigue en modo desarrollo y tu usuario no es administrador ni desarrollador (A5), o Meta exige ser Tech Provider |
| La conexión termina pero no llegan mensajes | Falta suscribir `messages` o `account_update` (C6), o `META_APP_SECRET` no es el de esta app |
| "Falta la última actualización de la base de datos" | Falta correr la migración 060 (Parte E) |

Referencias oficiales:
- <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users>
- <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation>
- <https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started>

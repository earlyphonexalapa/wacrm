# Conectar WhatsApp Business por coexistencia

Con coexistencia, el mismo número funciona a la vez en la **app WhatsApp Business del celular** y en el **CRM**. Lo que escribes desde el celular aparece en el CRM, y el historial de los últimos 180 días se importa.

La conexión se hace con un botón del CRM (Ajustes → WhatsApp → **Conectar mi número**) que abre el "Embedded Signup" de Meta. Antes de que el botón funcione hay que preparar tu app de Meta **una sola vez**.

> Meta indica que el Embedded Signup con coexistencia está pensado para Tech Providers y Solution Partners, y no aclara si un negocio puede conectar solo su propio número. Sí indica que los administradores de la app pueden probarlo con su propia cuenta. Si Meta rechaza la conexión en producción, el CRM muestra el error exacto que devuelve Meta; en ese caso hay que registrar la app como Tech Provider (verificación del negocio y App Review de los permisos de WhatsApp).

## 1. En Meta (developers.facebook.com → tu app)

1. **Agrega el producto "Facebook Login for Business"** a la misma app que ya usas para WhatsApp.
2. Dentro de ese producto, **Configurations → Create configuration**. Usa la plantilla **"WhatsApp Embedded Signup Configuration With 60 Expiration Token"** (o crea una con la variación "WhatsApp Embedded Signup") y deja solo los permisos que necesitas (`whatsapp_business_management`, `whatsapp_business_messaging`). Guarda y **copia el Configuration ID**.
3. En **Facebook Login for Business → Settings → Client OAuth settings**, pon en **Sí**:
   - Client OAuth login
   - Web OAuth login
   - Enforce HTTPS
   - Embedded Browser OAuth Login
   - Use Strict Mode for redirect URIs
   - Login with the JavaScript SDK
4. En **Allowed domains for the JavaScript SDK** y **Valid OAuth redirect URIs** agrega tu dominio, por ejemplo `https://crm.tudominio.com/`. Si el dominio no está, Meta no devuelve la respuesta al CRM.
5. En **WhatsApp → Configuration → Webhook**, con la URL de siempre (`https://tu-dominio/api/whatsapp/webhook`), **suscribe estos campos** además de los que ya tenías:
   - `account_update`
   - `history`
   - `smb_app_state_sync`
   - `smb_message_echoes`
6. En **App settings → Basic** confirma el **App ID** y el **App Secret** (el secreto ya debe estar configurado: el webhook lo usa para verificar las firmas de Meta).

## 2. En tu hosting

Agrega estas variables de entorno y **vuelve a desplegar**:

| Variable | De dónde sale |
| --- | --- |
| `META_APP_ID` | App settings → Basic → App ID (ya existe si usas plantillas con imagen) |
| `META_APP_SECRET` | App settings → Basic → App Secret (ya existe) |
| `META_ES_CONFIG_ID` | El Configuration ID del paso 1.2 (**nueva**) |
| `META_COEXISTENCE_API_VERSION` | Opcional. Versión de la Graph API para estas llamadas; por defecto `v27.0` |

## 3. En Supabase

Ejecuta la migración `supabase/migrations/060_whatsapp_coexistence.sql` en el SQL Editor. Es segura de repetir.

## 4. En el celular

- App **WhatsApp Business** versión **2.24.17 o superior**, con el número activo.
- Ten el celular a la mano: Meta mostrará un **código QR** para escanear con la app; el asistente te guía en pantalla.
- Cuando Meta pregunte si compartir el historial de chats, acepta para importarlo.

## 5. Conectar

1. CRM → **Ajustes → WhatsApp → Conectar mi número**.
2. Sigue el asistente de Meta (elegir el portafolio, escanear el QR, aceptar permisos).
3. Deja abierta la app WhatsApp Business hasta que el historial termine (la tarjeta muestra el avance).

Esto **reemplaza** la conexión actual de WhatsApp de la cuenta (el CRM guarda un solo número por cuenta).

## Qué hace el CRM con lo que llega

| Evento | Qué pasa |
| --- | --- |
| Mensaje que escribes en el celular (`smb_message_echoes`) | Se guarda en el chat como mensaje enviado por un agente. Se pausa la IA y cualquier flujo activo de ese contacto: una persona está contestando. |
| Historial (`history`) | Se importan los chats con sus fechas reales. No cuenta como contactos nuevos del día, no se asigna a closers y no dispara automatizaciones ni notificaciones. |
| Contactos del celular (`smb_app_state_sync`) | Solo se completa el **nombre** de contactos que el CRM ya tiene y que solo mostraban el número. No se importa tu agenda completa. |
| Desconexión (`account_update`) | Si desconectas la cuenta desde la app o Meta lo hace por inactividad, el CRM lo marca como desconectado. |

Meta permite pedir cada sincronización (contactos e historial) **una sola vez y dentro de las primeras 24 horas** tras conectar. El CRM las pide automáticamente al terminar. Si hay que repetirlas, hay que desconectar y volver a conectar el número.

## Límites de Meta con coexistencia

- Velocidad de envío fija de 20 mensajes por segundo.
- En chats 1 a 1 de la app del celular dejan de funcionar: mensajes temporales, ver una vez, ubicación en vivo y listas de difusión.
- WhatsApp para Windows no es compatible; los otros dispositivos vinculados se desvinculan al conectar.
- Los grupos no se sincronizan.
- Los mensajes que envías desde la app siguen siendo gratis; los que se envían por la API siguen el precio de Cloud API.
- Si el celular pasa unos 14 días sin abrir la app WhatsApp Business, Meta desconecta la API.

Referencia oficial: <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users>

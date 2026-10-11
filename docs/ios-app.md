# App para iPhone (sin App Store)

wacrm se instala en el iPhone como una app, igual que WhatsApp Business: icono
en la pantalla de inicio, pantalla completa, lista de **Chats** con pestañas
abajo, el chat abierto a pantalla completa y notificaciones push cuando escribe
un cliente, incluso con la app cerrada.

No se publica en el App Store ni requiere cuenta de Apple Developer ni Mac. Es
una *Progressive Web App* (PWA): la misma web de siempre, que Safari sabe
instalar. Cada actualización que despliegues llega sola a los teléfonos, sin
reinstalar.

La versión web de escritorio no cambia.

## Requisitos

- iPhone con **iOS 16.4 o superior** (las notificaciones push en la app
  instalada empiezan en 16.4).
- wacrm servido por **HTTPS** con un dominio propio (Easypanel lo hace con su
  certificado automático).
- Supabase con la migración `059_push_subscriptions.sql` aplicada.

## Puesta en marcha (una sola vez)

### 1. Base de datos (Supabase)

Abre **Supabase → SQL Editor**, pega el contenido de
`supabase/migrations/059_push_subscriptions.sql` y ejecútalo. Crea la tabla
donde se guardan los teléfonos que activan notificaciones. Se puede ejecutar
más de una vez sin problema.

### 2. Claves de notificaciones (VAPID)

En tu computadora, dentro del proyecto:

```bash
npx web-push generate-vapid-keys
```

Te da una *Public Key* y una *Private Key*. Guárdalas: si las cambias más
adelante, cada teléfono tiene que volver a activar las notificaciones.

### 3. Variables de entorno (Easypanel)

En **Easypanel → tu servicio de wacrm → Environment**, agrega:

```
VAPID_PUBLIC_KEY=<la Public Key>
VAPID_PRIVATE_KEY=<la Private Key>
VAPID_SUBJECT=mailto:tu-correo@tudominio.com
```

Se leen al arrancar, así que basta con **Deploy / Restart**; no hace falta
reconstruir la imagen. La clave privada nunca sale del servidor.

Asegúrate también de que el dominio del servicio tenga **HTTPS** activado en
Easypanel (Domains → tu dominio con el certificado de Let's Encrypt).

### 4. Despliega

Despliega esta versión como de costumbre. Para comprobarlo, abre
`https://tu-dominio/manifest.webmanifest` (debe mostrar el JSON de la app) y
`https://tu-dominio/api/push` (debe mostrar `publicKey` con tu clave, no
`null`).

## Instalar en el iPhone (cada usuario)

1. Abre `https://tu-dominio` en **Safari** e inicia sesión.
2. Toca el botón **Compartir** (cuadro con flecha hacia arriba).
3. Elige **Agregar a pantalla de inicio** → **Agregar**.
4. Abre **wacrm** desde el nuevo icono (no desde Safari).
5. Toca **Activar** en el aviso «Activa las notificaciones» y acepta el permiso
   de iOS. También puedes hacerlo en la pestaña **Notificaciones** → tarjeta
   «App del teléfono», donde además hay un botón **Enviar prueba**.

En Android (Chrome) es igual: menú ⋮ → **Instalar app**.

## Qué hace la app

- **Chats**: la bandeja de entrada con el título grande, búsqueda, filtros,
  hora estilo WhatsApp (14:05 / Ayer / fecha) y contador de no leídos.
- **Chat a pantalla completa**: flecha atrás, foto y nombre del contacto (al
  tocarlo se abre su ficha con etiquetas, negocios y notas), estado, asignación
  y closer.
- **Escribir**: campo redondeado; con el campo vacío aparece el **micrófono**
  para notas de voz y al escribir cambia a **enviar**. Intro hace salto de
  línea, como en WhatsApp. El botón **+** incluye mensajes interactivos,
  respuestas rápidas, plantillas y redactar con IA; 📎 adjunta foto, video,
  documento o audio.
- **Mensajes**: **desliza a la derecha** una burbuja para responderla y
  **mantén pulsado** para reaccionar, responder o copiar.
- **Pestañas abajo**: Chats, Contactos, Notificaciones, Panel y **Más** (abre el
  menú con el resto de secciones). Cada rol ve solo lo que puede abrir.
- **Notificaciones push**: título = nombre del contacto, texto = mensaje (o
  «📷 Foto», «🎤 Audio», etc.). Tocarla abre ese chat. El icono muestra el
  número de chats sin leer.

### ¿A quién le llega cada notificación?

- Si el chat tiene closer o agente asignado: solo a esas personas.
- Si nadie lo tiene: a todo el equipo (menos observadores) o, si está activado
  «cada closer solo ve sus chats», solo a administradores y propietario.

Cerrar sesión en un teléfono deja de enviarle notificaciones a ese teléfono.

## Problemas comunes

| Síntoma | Solución |
| --- | --- |
| No aparece «Agregar a pantalla de inicio» | Debe ser Safari (en iOS < 16.4 los otros navegadores no instalan). |
| La tarjeta dice que las notificaciones solo funcionan desde la app instalada | Estás en Safari: abre wacrm desde el icono de la pantalla de inicio. |
| «Las notificaciones no están configuradas en el servidor» | Faltan `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` en Easypanel, o no reiniciaste. |
| «Las notificaciones están bloqueadas» | iPhone → Ajustes → Notificaciones → wacrm → Permitir. |
| No llegan notificaciones | Revisa el modo Concentración; usa **Enviar prueba**; revisa los logs de Easypanel buscando `[push]`. |
| Cambié de dominio | El dominio forma parte de la app: hay que volver a instalarla desde el nuevo dominio. |

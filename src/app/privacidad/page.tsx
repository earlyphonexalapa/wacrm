import type { Metadata } from 'next'

// Public page: Meta asks for a privacy-policy URL (and instructions for
// deleting data) before an app that uses WhatsApp can be published.
// It sits outside (auth) and (dashboard) so anyone can read it signed out.
//
// This is a plain-language DRAFT. Whoever runs this CRM is the data
// controller: review it and adjust it to your business before relying on it.

export const metadata: Metadata = {
  title: 'Política de privacidad',
  robots: { index: true, follow: true },
}

const UPDATED = '8 de noviembre de 2026'

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-12 text-foreground">
      <h1 className="text-2xl font-semibold">Política de privacidad</h1>
      <p className="mt-1 text-sm text-muted-foreground">Última actualización: {UPDATED}</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed">
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Quiénes somos</h2>
          <p>
            Este sitio es el sistema interno de atención a clientes de EarlyAcademy. Lo usamos
            para responder los mensajes de WhatsApp de personas interesadas en nuestros cursos y
            para dar seguimiento a sus solicitudes.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">Qué datos tratamos</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Tu nombre y tu número de teléfono de WhatsApp.</li>
            <li>El contenido de los mensajes, fotos, audios y archivos que nos envías, y nuestras respuestas.</li>
            <li>
              Si llegas desde un anuncio de Facebook o Instagram, un identificador del anuncio que
              nos permite saber qué campaña te trajo.
            </li>
            <li>Notas internas y etiquetas que nuestro equipo agrega para atenderte mejor.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">Para qué los usamos</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Responder tus mensajes y darte información sobre nuestros cursos.</li>
            <li>Dar seguimiento a tu solicitud y a tu compra.</li>
            <li>
              Medir qué anuncios funcionan. Cuando concretas una compra, podemos informar a Meta
              de ese resultado, sin enviar el monto, para evaluar nuestras campañas.
            </li>
          </ul>
          <p>No vendemos tus datos.</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">Con quién los compartimos</h2>
          <p>
            Solo con los proveedores necesarios para operar: Meta (WhatsApp Business y publicidad),
            y los servicios de alojamiento y base de datos donde se guarda la información. Cada
            uno los trata según sus propias políticas.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">Cuánto tiempo los guardamos</h2>
          <p>
            Mientras sea necesario para atenderte o mientras mantengamos una relación comercial
            contigo, y después el tiempo que exija la ley.
          </p>
        </section>

        <section id="eliminacion" className="space-y-2">
          <h2 className="text-base font-semibold">Cómo pedir que eliminemos tus datos</h2>
          <p>
            Puedes pedir en cualquier momento que consultemos, corrijamos o eliminemos tus datos.
            Escríbenos por WhatsApp al mismo número desde el que recibes nuestros mensajes, con el
            texto &laquo;Quiero que eliminen mis datos&raquo;. Eliminaremos tu conversación y tu
            información de contacto de nuestro sistema y te confirmaremos por el mismo medio.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">Cambios a esta política</h2>
          <p>
            Si la actualizamos, publicaremos la nueva versión en esta misma página con su fecha.
          </p>
        </section>
      </div>
    </main>
  )
}

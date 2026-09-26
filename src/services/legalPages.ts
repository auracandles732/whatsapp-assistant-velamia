import { BusinessProfile } from '../config/businessProfile';

/**
 * Páginas públicas que pide la ley de Ecuador a quien atiende y vende por internet: la política de privacidad (Ley
 * Orgánica de Protección de Datos Personales, su Reglamento y las normas de la Superintendencia) y las condiciones de
 * venta (Ley Orgánica de Defensa del Consumidor y Ley de Comercio Electrónico). Se arman con el perfil del negocio.
 * También sirven como enlace de "Política de privacidad" que Meta pide para la App.
 */

/** Fecha de la última revisión del texto (cambiarla al modificarlo). */
export const LEGAL_UPDATED = '26 de septiembre de 2026';

const esc = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(title: string, business: string, body: string, color: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(business)}</title><meta name="robots" content="index,follow">
<style>
:root{--ink:#1B2140;--muted:#5B6385;--bg:#F6F4F1;--card:#fff;--line:#E6E2DC;--accent:${esc(color)}}
@media (prefers-color-scheme:dark){:root{--ink:#ECEAF3;--muted:#A9ADC2;--bg:#15161C;--card:#1E2029;--line:#2E3140}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:820px;margin:0 auto;padding:28px 16px 64px}
header{margin-bottom:18px}header small{color:var(--muted)}
h1{font-size:30px;line-height:1.2;margin:6px 0 8px}h2{font-size:19px;margin:28px 0 8px;color:var(--accent)}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:6px 22px 18px;margin:14px 0}
ul{padding-left:20px}li{margin:4px 0}a{color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:14.5px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
.note{color:var(--muted);font-size:14px}
</style></head><body><main>${body}</main></body></html>`;
}

function controllerLines(p: BusinessProfile): string {
  const v = p.privacy;
  return [
    `<b>${esc(v.legalName || p.business.name)}</b>${v.legalName && v.legalName !== p.business.name ? ` (${esc(p.business.name)})` : ''}`,
    v.ruc ? `RUC ${esc(v.ruc)}` : '',
    esc(v.address || [p.business.city, p.business.country].filter(Boolean).join(', ')),
    v.email ? `Correo: <a href="mailto:${esc(v.email)}">${esc(v.email)}</a>` : ''
  ].filter(Boolean).join('<br>');
}

/** Cómo pedir algo sobre sus datos: por el mismo chat y, si hay, por correo. */
function howToAsk(p: BusinessProfile): string {
  const mail = p.privacy.email ? ` o al correo <a href="mailto:${esc(p.privacy.email)}">${esc(p.privacy.email)}</a>` : '';
  return `escríbenos por el mismo chat de WhatsApp, Instagram o Messenger (por ejemplo: "quiero ver mis datos" o "quiero que borren mis datos")${mail}`;
}

export function privacyPolicyHtml(p: BusinessProfile, options: { voiceNotes?: boolean } = {}): string {
  const name = esc(p.business.name);
  const retention = p.privacy.retentionMonths > 0
    ? `Los chats que no terminaron en un pedido se borran automáticamente después de ${p.privacy.retentionMonths} meses sin mensajes.`
    : 'Los chats se conservan mientras dure la relación comercial o hasta que pidas borrarlos.';
  const followUps = p.followUps.enabled
    ? '<li><b>Seguimientos comerciales</b>: si nos escribiste, podemos enviarte por WhatsApp hasta unos pocos recordatorios sobre tu cotización o nuestros productos. Base: nuestro interés legítimo y tu consentimiento, que puedes retirar en cualquier momento respondiendo <b>NO</b>.</li>'
    : '';
  const body = `
<header><small>Última actualización: ${LEGAL_UPDATED}</small><h1>Política de privacidad</h1>
<p>En ${name} cuidamos los datos personales de quienes nos escriben y nos compran. Esta política explica qué datos tratamos, para qué, con quién los compartimos y cómo puedes ejercer tus derechos, conforme a la <b>Ley Orgánica de Protección de Datos Personales</b> (LOPDP), su Reglamento y las normas de la Superintendencia de Protección de Datos Personales del Ecuador.</p></header>

<section><h2>1. Responsable del tratamiento</h2><p>${controllerLines(p)}</p></section>

<section><h2>2. Qué datos tratamos</h2><ul>
<li><b>Contacto</b>: tu nombre de perfil y número de WhatsApp o tu usuario de Instagram/Messenger.</li>
<li><b>Conversación</b>: los mensajes, audios, fotos y documentos que nos envías por esos chats.</li>
<li><b>Pedido</b>: productos, cantidades, personalización, fecha del evento, ciudad y dirección de entrega.</li>
<li><b>Pago</b>: el comprobante de transferencia que nos envías. No guardamos números de tarjetas: los pagos con tarjeta se hacen en la pasarela de pago.</li>
</ul><p>No pedimos datos sensibles (salud, religión, etnia, etc.). Si al personalizar un producto nos das el nombre de otra persona (por ejemplo, de un bebé), lo usamos solo para elaborar tu pedido.</p></section>

<section><h2>3. Para qué los usamos y con qué base legal</h2><ul>
<li><b>Atenderte, cotizar y vender</b>: responder tus preguntas, enviarte fotos y precios, preparar tu cotización, registrar y entregar tu pedido. Base: medidas precontractuales y la ejecución del contrato que nos pides (art. 7 LOPDP).</li>
${followUps}
<li><b>Mejorar la atención</b>: revisar las conversaciones para corregir errores y responder mejor. Base: nuestro interés legítimo.</li>
<li><b>Cumplir la ley</b>: facturación y obligaciones tributarias. Base: obligación legal.</li>
</ul><p>No vendemos tus datos ni los usamos para fines distintos a los indicados.</p></section>

<section><h2>4. Atención automatizada</h2><p>Para responder rápido, parte de la atención de los chats se prepara con herramientas automatizadas y de inteligencia artificial, bajo la supervisión de nuestro equipo. No tomamos decisiones con efectos jurídicos basadas únicamente en tratamiento automatizado, y puedes pedir en cualquier momento que te atienda una persona.</p></section>

<section><h2>5. Con quién los compartimos (encargados) y transferencias internacionales</h2>
<p>Para operar usamos proveedores que tratan los datos por encargo nuestro, con contratos y medidas de seguridad. Algunos están fuera del Ecuador (principalmente en Estados Unidos), por lo que hay transferencia internacional de datos con garantías contractuales adecuadas:</p>
<table><tr><th>Proveedor</th><th>Para qué</th><th>País</th></tr>
<tr><td>Meta Platforms (WhatsApp, Instagram, Messenger)</td><td>Recibir y enviar los mensajes</td><td>EE. UU. / Irlanda</td></tr>
<tr><td>OpenAI</td><td>Entender y preparar respuestas, leer fotos y transcribir audios</td><td>EE. UU.</td></tr>
<tr><td>Supabase</td><td>Base de datos y archivos del sistema</td><td>EE. UU.</td></tr>
<tr><td>Render</td><td>Servidor donde funciona el sistema</td><td>EE. UU.</td></tr>
${options.voiceNotes ? '<tr><td>ElevenLabs</td><td>Notas de voz</td><td>EE. UU.</td></tr>' : ''}
<tr><td>Empresa de envíos${p.shipping.carrier ? ` (${esc(p.shipping.carrier)})` : ''}</td><td>Entregar tu pedido (nombre, teléfono y dirección)</td><td>Ecuador</td></tr>
</table><p class="note">Solo compartimos datos con autoridades cuando la ley lo exige.</p></section>

<section><h2>6. Cuánto tiempo los guardamos</h2><p>${retention} Los datos de pedidos y facturación se conservan el tiempo que exigen las normas tributarias (hasta 7 años). Después se eliminan o se anonimizan.</p></section>

<section><h2>7. Tus derechos</h2><p>Puedes ejercer en cualquier momento, de forma gratuita, tus derechos de <b>información, acceso, rectificación y actualización, eliminación, oposición, portabilidad, suspensión del tratamiento</b> y a <b>no ser objeto de decisiones basadas únicamente en valoraciones automatizadas</b>. Para hacerlo, ${howToAsk(p)}. Te responderemos en un plazo máximo de <b>15 días</b>.</p>
<p>Si consideras que no atendimos bien tu pedido, puedes presentar un reclamo ante la <a href="https://spdp.gob.ec" rel="noopener">Superintendencia de Protección de Datos Personales</a>.</p></section>

<section><h2>8. Seguridad</h2><ul>
<li>Toda la información viaja cifrada (HTTPS) y las claves de acceso se guardan cifradas.</li>
<li>Solo el personal autorizado entra al sistema, con usuario, contraseña y permisos por rol, y queda registro de las acciones sensibles.</li>
<li>Usamos proveedores con altos estándares de seguridad y copias de respaldo.</li>
<li>Si ocurriera una vulneración de seguridad que afecte tus datos, la notificaremos a la Superintendencia en un máximo de 5 días y a ti, si hay riesgo para tus derechos, en un máximo de 3 días.</li>
</ul></section>

<section><h2>9. Menores de edad</h2><p>Nuestros servicios están dirigidos a personas mayores de edad. No recopilamos a sabiendas datos de menores, salvo los que un adulto nos da para personalizar un producto.</p></section>

<section><h2>10. Cambios a esta política</h2><p>Si cambiamos esta política, publicaremos aquí la nueva versión con su fecha. Si el cambio es importante, te lo avisaremos por el chat.</p></section>
<p class="note">Condiciones de venta: <a href="condiciones">ver aquí</a>.</p>`;
  return page('Política de privacidad', p.business.name, body, p.branding.primaryColor);
}

export function salesTermsHtml(p: BusinessProfile): string {
  const pay = p.payments;
  const payments = [
    pay.transferEnabled ? `Transferencia o depósito bancario${pay.depositPercent < 100 ? `: se paga un anticipo del ${pay.depositPercent}% para confirmar el pedido y el saldo antes de la entrega` : ' del valor total'}.` : '',
    pay.cardEnabled ? `Tarjeta${pay.cardBrands ? ` (${esc(pay.cardBrands)})` : ''}, mediante enlace de pago seguro: se paga el 100% del total.` : ''
  ].filter(Boolean).map(t => `<li>${t}</li>`).join('');
  const shipping = p.shipping.mode === 'none'
    ? '<li>Entrega en el lugar acordado por el chat.</li>'
    : `<li>Envíos a ${esc(p.shipping.coverage || 'todo el Ecuador')}${p.shipping.carrier ? ` por ${esc(p.shipping.carrier)}` : ''}. El costo del envío se informa en la cotización antes de pagar.</li>${p.shipping.pickupAvailable && p.shipping.pickupAddress ? `<li>Retiro en: ${esc(p.shipping.pickupAddress)}.</li>` : ''}`;
  const dates = p.dates.enabled
    ? `<li>Para tu ${esc(p.dates.eventLabel)}, el pedido se entrega ${p.dates.deliveryDaysBeforeEvent} día(s) antes. La fecha queda reservada al recibir el ${pay.depositPercent < 100 ? 'anticipo' : 'pago'}, porque las fechas se ocupan por orden de pago.</li>`
    : '';
  const body = `
<header><small>Última actualización: ${LEGAL_UPDATED}</small><h1>Condiciones de venta</h1>
<p>Estas condiciones aplican a las compras que haces con ${esc(p.business.name)} por WhatsApp, Instagram o Messenger, conforme a la <b>Ley Orgánica de Defensa del Consumidor</b> y la <b>Ley de Comercio Electrónico, Firmas Electrónicas y Mensajes de Datos</b> del Ecuador.</p></header>
<section><h2>1. Quién vende</h2><p>${controllerLines(p)}</p></section>
<section><h2>2. Productos y precios</h2><ul>
<li>Te enviamos fotos, características y precio de cada producto antes de que compres. El precio es por ${esc(p.sales.unitSingular)}${p.sales.unitDetail ? ` (${esc(p.sales.unitDetail)})` : ''}.</li>
<li>La cotización que recibes por el chat detalla productos, cantidades, personalización, envío y total. Ese es el valor que pagas${p.sales.minimumOrder ? `; pedido mínimo: ${esc(p.sales.minimumOrder)}` : ''}.</li>
${p.sales.personalization ? '<li>Los productos personalizados se elaboran a pedido según lo que confirmas por escrito en el chat (nombres, colores, fechas): revísalo antes de pagar.</li>' : ''}
</ul></section>
<section><h2>3. Pago</h2><ul>${payments || '<li>Se acuerda por el chat antes de confirmar el pedido.</li>'}<li>Tu pedido queda confirmado cuando verificamos el pago y te lo confirmamos por el chat.</li></ul></section>
<section><h2>4. Entrega</h2><ul>${dates}${shipping}</ul></section>
<section><h2>5. Cambios, devoluciones y garantía</h2><ul>
<li>En compras a distancia tienes derecho a devolver el producto dentro de los <b>3 días</b> posteriores a recibirlo (art. 45 de la Ley Orgánica de Defensa del Consumidor), en el mismo estado en que lo recibiste. Escríbenos por el chat para coordinarlo.</li>
<li>Si el producto llega dañado o distinto a lo confirmado, escríbenos con una foto apenas lo recibas y te damos una solución conforme a la ley.</li>
</ul></section>
<section><h2>6. Tus datos</h2><p>Tratamos tus datos según nuestra <a href="privacidad">Política de privacidad</a>.</p></section>
<section><h2>7. Consultas y reclamos</h2><p>Escríbenos por el mismo chat${p.privacy.email ? ` o a <a href="mailto:${esc(p.privacy.email)}">${esc(p.privacy.email)}</a>` : ''}. Si no quedas conforme, puedes acudir a la Defensoría del Pueblo del Ecuador.</p></section>`;
  return page('Condiciones de venta', p.business.name, body, p.branding.primaryColor);
}

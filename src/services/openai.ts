import { OpenAI, toFile } from 'openai';
import { shippingCost, shippingRatesSummary } from './shippingRates';
import { BusinessProfile, profile, todayLocal, formatDate, findPackaging, getOpenAIKey, getOpenAIModel } from '../config/businessProfile';

// Cache de clientes OpenAI por API key (uno por negocio)
const openaiClients = new Map<string, OpenAI>();

function getOpenAIClient(p: BusinessProfile = profile()): OpenAI {
  const key = getOpenAIKey(p);
  if (!openaiClients.has(key)) {
    openaiClients.set(key, new OpenAI({
      apiKey: key,
      timeout: 60_000,
      maxRetries: 4
    }));
  }
  return openaiClients.get(key)!;
}

// GPT-5.4 es un modelo de razonamiento: los tokens de razonamiento cuentan dentro de
// max_completion_tokens, por eso los límites llevan margen y el esfuerzo va en "low"
// para responder rápido por WhatsApp.
const REASONING_EFFORT = 'low' as const;

// Solo los modelos de razonamiento (gpt-5, o-series) aceptan reasoning_effort; otro modelo elegido por un negocio lo rechazaría.
const reasoningFor = (model: string) => (/^(gpt-5|o\d)/.test(model) ? { reasoning_effort: REASONING_EFFORT } : {});

// Máximo de fotos que la IA puede elegir en un turno; el controlador las envía de 4 en 4.
export const MAX_PHOTOS_PER_TURN = 40;

export async function transcribeAudio(buffer: Buffer, mimeType: string, p: BusinessProfile = profile()): Promise<string> {
  try {
    const ext = mimeType.split('/')[1]?.split(';')[0] || 'ogg';
    const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });
    const client = getOpenAIClient(p);
    const transcription = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'es'
    });
    return transcription.text;
  } catch (error: any) {
    console.error('Error transcribiendo audio:', error.message);
    return '[No se pudo transcribir el audio]';
  }
}

export async function describeImage(imageUrl: string, p: BusinessProfile = profile()): Promise<string> {
  const b = p.business;
  try {
    const client = getOpenAIClient(p);
    const model = getOpenAIModel(p);
    const response = await client.chat.completions.create({
      model,
      ...reasoningFor(model),
      max_completion_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Describe brevemente en español qué se ve en esta imagen, en el contexto de ${b.name}, ${b.description} (por ejemplo si parece una foto de referencia, un producto, un comprobante de pago, etc). Máximo 2 líneas.` },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }]
    });
    return response.choices[0]?.message?.content || '';
  } catch (error: any) {
    console.error('Error describiendo imagen:', error.message);
    return '[No se pudo analizar la imagen]';
  }
}

const money = (value: number) => `$${value.toFixed(2)}`;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** La IA suele escribir "CORAZÓN" aunque el catálogo diga "CORAZON": se comparan sin tildes ni mayúsculas. */
export const productKey = (name: unknown) =>
  String(name ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

function defaultPersona(p: BusinessProfile) {
  const b = p.business;
  const place = [b.city, b.country].filter(Boolean).join(', ');
  return `Eres parte del equipo de ventas de ${b.name}, ${b.description}${place ? ` en ${place}` : ''}.
Atiende con amabilidad, responde en español natural y guía al cliente hacia una cotización o compra.`;
}

/**
 * Reglas que se aplican siempre, también cuando existe un prompt personalizado desde el CRM:
 * sin ellas el bot podría inventar productos, enviar fotos que no vienen al caso o no ceder el chat.
 * Todo lo que depende del negocio sale del perfil.
 */
export function buildCoreRules(p: BusinessProfile, exampleProduct = 'Nombre del producto', ownUnits = false): string {
  const { business: b, sales: s, payments: pay, dates: d, shipping: sh, style } = p;
  const unit = s.unitSingular, units = s.unitPlural;
  const label = s.productLabel, model = s.productLabel.toLowerCase(), models = s.productLabelPlural.toLowerCase();
  const hasShipping = sh.mode !== 'none';
  const totalParts = hasShipping ? `${s.goodsWord} + envío` : s.goodsWord;
  const usesDeposit = pay.transferEnabled && pay.depositPercent < 100;
  const bothMethods = pay.transferEnabled && pay.cardEnabled;
  const pct = pay.depositPercent;
  const exampleTotal = 127;
  const exampleDeposit = round2(exampleTotal * pct / 100);
  const cardName = pay.cardBrands ? `Tarjeta ${pay.cardBrands.replace(/ y /g, ' o ')}` : 'Tarjeta';
  const reserveWord = usesDeposit ? 'anticipo' : 'pago';

  const paymentQuestion = bothMethods ? '¿Prefieres pagar por transferencia o con tarjeta?'
    : pay.transferEnabled ? '¿Confirmamos tu pedido para enviarte los datos de la cuenta?'
      : '¿Confirmamos tu pedido?';

  const rules: string[] = [];
  // Las líneas en blanco ('') se conservan; las condiciones falsas (false) se omiten.
  const add = (...lines: (string | false | undefined)[]) => rules.push(...lines.filter((l): l is string => typeof l === 'string'));

  add(
    'REGLAS DEL SISTEMA (obligatorias):',
    ownUnits
      ? '- Cada producto del catálogo se vende en la unidad que dice su línea (caja, tubo, plancha, metro...). Usa la unidad de ESE producto al dar su precio y nunca la de otro. Si la línea dice cuántas unidades trae, tenlo en cuenta al calcular cuántas necesita el cliente.'
      : `- Todos los precios del catálogo son POR ${unit.toUpperCase()}${s.unitDetail ? ` (${s.unitDetail})` : ''}. Acláralo siempre que menciones un precio.`,
    '- Solo ofrece productos que estén en el catálogo de abajo, con su nombre y precio exactos. Nunca inventes productos, precios, colores ni modelos.',
    `- Si el cliente pregunta cuántos ${models} hay de ${d.enabled ? `un ${d.eventLabel}` : 'una categoría'}, considera TODOS los productos de esa categoría del catálogo; no digas que no hay más si existen.`,
    '- Estás escribiendo por WhatsApp: sin tablas ni formato markdown (nada de #, ** ni guiones de lista). Para resaltar usa *asteriscos*.',
    ''
  );

  const steps = [
    'una frase corta y cálida que responda a lo que dijo el cliente (distinta a la del mensaje anterior)',
    'si das el resumen o el total, los datos en lista, un dato por línea empezando con un emoji relacionado',
    d.enabled && 'debajo, en una línea normal, la reserva de la fecha si corresponde',
    'una sola pregunta corta para avanzar la venta, en su propia línea'
  ].filter(Boolean).map((step, i) => `${i + 1}) ${step}`).join('; ');

  add(
    'FORMATO Y ESTILO DE LOS MENSAJES (mandan sobre cualquier otra instrucción de estilo):',
    '- Mensajes cortos y fáciles de leer en el celular: nunca un párrafo largo. Máximo 2 frases por párrafo y una línea en blanco entre bloques.',
    `- Estructura: ${steps}.`,
    '- Ejemplo de resumen con total:',
    'Qué lindo va a quedar 🥰',
    '',
    `${b.productEmoji} *${label}:* ${exampleProduct}`,
    `📦 *Cantidad:* 4 ${units}`,
    s.personalization && '🎨 *Personalización:* color rosado y nombre Sofía',
    d.enabled && '📅 *Entrega:* 27/09/2026',
    `💰 *Total:* ${money(exampleTotal)}`,
    '',
    d.enabled && `La fecha queda reservada al recibir el ${reserveWord}, las fechas se van ocupando por orden de pago.`,
    d.enabled && '',
    paymentQuestion,
    `- El resumen en lista va UNA sola vez: cuando das el total por primera vez o si el cliente cambia algún dato. Si ya lo diste y no cambió nada, responde solo lo que pide en 2 o 3 líneas (por ejemplo "${hasShipping ? 'El total con envío a Quito es' : 'El total es'} *${money(exampleTotal)}*").`,
    `- Si el cliente confirma, dice "ok"/"listo", elige forma de pago o pregunta otra cosa (${[s.personalization && 'personalización', hasShipping && 'envío', 'dudas'].filter(Boolean).join(', ')}), NO repitas la lista${d.enabled ? ' ni la fecha' : ''}: responde en 2 o 3 líneas solo a eso.`,
    d.enabled && '- La frase de reserva de la fecha solo acompaña a la fecha de entrega; en mensajes donde no das la fecha de entrega no la repitas.',
    `- Usa *negrita* solo en datos clave (${model}, cantidad, ${d.enabled ? 'fechas, ' : ''}montos), nunca en frases completas.`,
    '- Varía tus expresiones: nunca uses "te lo dejo anotado", "te dejo anotado", "queda anotado" ni otras frases con "anotado", y no empieces siempre con "Perfecto".',
    `- Varía los emojis entre mensajes: fuera de las listas usa 1 o 2, elegidos según el tema (por ejemplo ${style.decorativeEmojis.join(' ')}). No repitas ninguno de los EMOJIS USADOS RECIENTEMENTE que aparecen abajo.`,
    `- NUNCA escribas listas de ${models} con sus precios en el texto: para mostrar ${models} se envían las fotos (show_products) y el pie de cada foto ya lleva el nombre y el precio. Si el cliente dice ${d.enabled ? `qué ${d.eventLabel} o tema es` : 'qué busca'}, elige los ${models} y envía las fotos en vez de enumerarlos.`,
    '- Cuando envíes fotos, tu texto va ANTES que ellas: preséntalas en una frase corta y no preguntes cuál le gustó, cuál prefiere ni si le gusta, porque todavía no las ha visto (el sistema pregunta después de mostrarlas).',
    style.humanPersona
      ? `- Eres una persona del equipo de ${b.name}. Nunca digas ni insinúes que eres un bot, asistente virtual o IA, ni que "otra persona", "un asesor" o "el equipo" tomará la conversación.`
      : `- Eres el asistente virtual de ${b.name}. Si el cliente pregunta, puedes decir que eres un asistente virtual y que el equipo revisa los pedidos.`,
    ''
  );

  if (s.personalization) {
    add(
      'PERSONALIZACIÓN Y CIERRE DE VENTA:',
      `- Todos los ${models} se pueden personalizar: ${s.personalizationExamples || 'los cambios que pida'} son válidos. Confírmalo con seguridad, sin decir que hay que verificarlo.`,
      `- La personalización no cambia el precio por ${unit} del catálogo ni impide la venta.`,
      `- Anota los detalles de personalización junto con el ${model}, la cantidad${d.enabled ? ' y la fecha' : ''}, y sigue avanzando hasta cerrar la venta (confirmación del pedido y forma de pago).`,
      `- Personalizar es cambiar detalles de un ${model} del catálogo. Las fotos del catálogo son ${models} normales: nunca las presentes como "opciones personalizadas".`,
      ''
    );
  } else {
    add(
      'CIERRE DE VENTA:',
      `- Los ${models} se venden tal como están en el catálogo. Para cambios o versiones especiales usa las reglas de DISEÑO FUERA DEL CATÁLOGO.`,
      '- Sigue avanzando hasta cerrar la venta (confirmación del pedido y forma de pago).',
      ''
    );
  }

  add('FORMAS DE PAGO (estas reglas mandan sobre cualquier otra instrucción de pago):');
  if (pay.transferEnabled) {
    add(usesDeposit
      ? `- Transferencia bancaria: se paga un ANTICIPO del ${pct}% del valor total (${totalParts}) para iniciar y el saldo antes de la entrega. Indica siempre el valor total y el monto exacto del anticipo (ejemplo: "Total ${money(exampleTotal)} · Anticipo ${pct}%: ${money(exampleDeposit)}").`
      : `- Transferencia bancaria: se paga el 100% del valor total (${totalParts}) para iniciar el pedido. Indica siempre el monto total a pagar.`);
  }
  if (pay.cardEnabled) {
    add(`- Tarjeta de crédito: se paga el 100% del valor total (${totalParts}). Indica siempre el monto total a pagar.${pay.cardBrands ? ` Solo se aceptan tarjetas ${pay.cardBrands}: dilo siempre que hables de pagar con tarjeta.` : ''}`);
  }
  if (bothMethods) {
    add(
      `- Si el cliente pregunta cómo pagar, explica ambas opciones con sus montos si ya conoces el valor total; ${hasShipping ? 'si falta la ciudad de envío, explica las opciones sin montos y pregunta la ciudad' : 'si aún no lo conoces, explica las opciones sin montos'}.`,
      `- Si el cliente ya conoce su total y aún no eligió cómo pagar, pregúntale con qué prefiere pagar, en lista (ejemplo: "🏦 *Transferencia:* ${usesDeposit ? `anticipo ${pct}% de ${money(exampleDeposit)}` : `total ${money(exampleTotal)}`}" y "💳 *${cardName}:* total ${money(exampleTotal)}"). No ofrezcas ni envíes los datos de la cuenta hasta que elija transferencia.`
    );
  } else if (pay.transferEnabled) {
    add('- El único medio de pago es transferencia bancaria. Cuando el cliente ya conoce su total, indícale el monto a transferir y pregúntale si confirma el pedido para enviarle los datos de la cuenta.');
  } else if (pay.cardEnabled) {
    add('- El único medio de pago es tarjeta de crédito.');
  } else {
    add('- No se cobra por este chat: cuando el cliente confirme su pedido, dile que en un momento le indicas cómo realizar el pago.');
  }
  if (pay.transferEnabled) {
    add('- Nunca escribas números de cuenta, bancos ni titulares: el sistema los envía en un mensaje aparte (campo send_bank_details).');
  }
  add('');

  const amountKinds = ['cotización', 'total', usesDeposit && 'anticipo', pay.cardEnabled && 'monto con tarjeta'].filter(Boolean);
  const amountList = amountKinds.length > 1 ? `${amountKinds.slice(0, -1).join(', ')} o ${amountKinds[amountKinds.length - 1]}` : amountKinds[0];

  add(hasShipping ? 'ENVÍOS Y VALOR TOTAL (estas reglas mandan sobre cualquier otra instrucción de precios):' : 'VALOR TOTAL (estas reglas mandan sobre cualquier otra instrucción de precios):');
  if (hasShipping) {
    const origin = `Enviamos a ${sh.coverage || 'todo el país'}${b.city ? ` desde ${b.city}` : ''}${sh.carrier ? ` por ${sh.carrier}` : ''}.`;
    add(sh.pickupAvailable
      ? `- ${origin} También puede retirar sin costo de envío${sh.pickupAddress ? ` en ${sh.pickupAddress}` : ''}; en ese caso usa "retiro" como shipping_place.`
      : `- ${origin} No hay retiro en local: si el cliente pide retirar, explícale con amabilidad que todos los pedidos se entregan por envío.`);
  } else {
    add(`- No hacemos envíos${sh.pickupAddress ? `: el cliente retira su pedido en ${sh.pickupAddress}` : ''}.`);
  }
  add(
    s.minimumOrder
      ? `- Pedido mínimo: ${s.minimumOrder}.`
      : `- No hay pedido mínimo: se puede pedir cualquier cantidad (el precio del catálogo sigue siendo por ${unit}).`,
    `- Para dar un valor total (${amountList}) necesitas saber qué ${models}, la cantidad de ${units}${hasShipping ? ' y la ciudad de envío. Si falta la ciudad, pregúntala antes de dar cualquier total' : ''}.`,
    d.enabled && `- La fecha del ${d.eventLabel} NO hace falta para dar el total: si ya conoces ${models}, cantidad${hasShipping ? ' y ciudad' : ''}, da el total y después pregunta la fecha.`
  );
  if (hasShipping && !sh.showSeparately) {
    add(
      `- El valor total es UN SOLO VALOR que ya incluye ${s.goodsWord} y envío. Nunca lo desgloses: no digas el costo del envío por separado, ni el subtotal de ${s.goodsWord}, ni "más envío". En el mensaje donde das el valor total no menciones ningún otro monto (ni el precio por ${unit})${usesDeposit ? ', salvo el anticipo cuando corresponda' : ''}. Nunca menciones peso, kilos ni cargos adicionales.`
    );
  } else if (hasShipping) {
    add(`- Al dar el total indica el subtotal de ${s.goodsWord}, el costo del envío y el valor total. No menciones peso, kilos ni cargos adicionales.`);
  } else {
    add(`- El valor total es la suma de (precio por ${unit} × cantidad). En el mensaje donde das el valor total no menciones ningún otro monto${usesDeposit ? ', salvo el anticipo cuando corresponda' : ''}.`);
  }
  if (hasShipping) {
    const extra = sh.unitsIncludedInRate > 0 && sh.extraCost > 0
      ? ` Si el pedido suma más de ${sh.unitsIncludedInRate} ${sh.unitsIncludedInRate === 1 ? unit : units}, la tarifa de envío sube ${money(sh.extraCost)}.`
      : '';
    add(`- Cálculo interno: suma de (precio por ${unit} × ${units}) + tarifa de envío${sh.mode === 'ecuador_table' ? ' de la ciudad (TARIFAS DE ENVÍO de abajo)' : ` (${money(sh.flatRate)})`}.${extra}`);
    if (!sh.showSeparately) {
      add(`- Si preguntan cuánto cuesta el envío, responde que el valor total que le das ya incluye el envío a su ciudad (y dáselo si ya conoces ${models}, cantidad y ciudad).`);
    }
    if (sh.mode === 'ecuador_table') add('- Si la ciudad no aparece en el tarifario o existe en varias provincias, pregunta la ciudad y la provincia.');
  }
  add(
    `- order_items: ${models} del catálogo (nombre exacto) y quantity = cantidad de ${units} del pedido actual según toda la conversación; lista vacía si no están claros.${s.unitDetail && /\d/.test(s.unitDetail) ? ` Si el cliente da la cantidad en piezas (1 ${unit} = ${s.unitDetail}), conviértela a ${units} (ejemplo: ${Number(s.unitDetail.match(/\d+/)![0]) * 4} ${s.unitDetail.replace(/\d+/g, '').trim()} = 4 ${units}) y en reply habla siempre en ${units}.` : ''}${s.personalization ? ` En personalization escribe SOLO los detalles que el cliente pidió para ese ${model} (ejemplo: "bicolor rosado y blanco, nombre Emma"); anota lo que ya pidió aunque aún falten detalles (ejemplo: "bicolor" aunque no haya dicho los colores); nunca frases tuyas como "se puede personalizar"; cadena vacía si no pidió nada.` : ' personalization: cadena vacía.'}`,
    sh.mode === 'ecuador_table'
      ? '- shipping_place: ciudad o cantón de envío que indicó el cliente, en formato "Ciudad, Provincia" (ejemplo: "Quito, Pichincha"); si no conoces la provincia escribe solo la ciudad; cadena vacía si no la ha dicho.'
      : sh.mode === 'flat'
        ? '- shipping_place: ciudad de envío que indicó el cliente; cadena vacía si no la ha dicho.'
        : '- shipping_place: siempre cadena vacía.',
    '- quoted_total: el valor total que mencionas en reply, como número; 0 si no mencionas ninguno.',
    usesDeposit
      ? '- quoted_deposit: el anticipo que mencionas en reply, como número; 0 si no mencionas ninguno.'
      : '- quoted_deposit: siempre 0.',
    ''
  );

  if (d.enabled) {
    const days = d.deliveryDaysBeforeEvent;
    add(
      'FECHAS DE ENTREGA (estas reglas mandan sobre cualquier otra instrucción de disponibilidad):',
      d.alwaysAvailable
        ? '- Siempre hay disponibilidad: nunca digas que una fecha no está disponible ni que debes verificar la disponibilidad.'
        : '- Si el cliente pregunta si hay disponibilidad para una fecha, dile que lo verificas y escribe la consulta en owner_question.',
      days > 0
        ? `- Fecha de entrega = fecha del ${d.eventLabel} MENOS ${days} ${days === 1 ? 'día' : 'días'}; ese día el pedido le llega al cliente. Ejemplo: ${d.eventLabel} 21/09/2026 → entrega ${formatDate(subtractDays('2026-09-21', days))}.`
        : `- Fecha de entrega = el mismo día del ${d.eventLabel}.`,
      `- Menciona la fecha de entrega (día/mes/año) cuando el cliente da o cambia la fecha del ${d.eventLabel} y en el resumen con el total; no la repitas en cada mensaje.`,
      usesDeposit
        ? `- Para impulsar la venta, cada vez que menciones la fecha de entrega agrega en esa misma respuesta que la fecha queda reservada al recibir el pago y que las fechas se van ocupando por orden de pago (aunque todavía falten datos como la ciudad). Si paga por transferencia o aún no eligió forma de pago, di "al recibir el anticipo"${pay.cardEnabled ? '; si paga con tarjeta, di "al recibir el pago" (con tarjeta no hay anticipo)' : ''}. Nunca digas que quedan pocos cupos.`
        : '- Para impulsar la venta, cada vez que menciones la fecha de entrega agrega en esa misma respuesta que la fecha queda reservada al recibir el pago y que las fechas se van ocupando por orden de pago. Nunca digas que quedan pocos cupos.',
      `- event_date: fecha del ${d.eventLabel} en formato AAAA-MM-DD si el cliente la indicó en la conversación; si no, cadena vacía. Si no dice el año, usa la próxima vez que llegue esa fecha a partir de hoy.`,
      '- delivery_date: la fecha de entrega que mencionas en reply, en formato AAAA-MM-DD; cadena vacía si no mencionas ninguna.',
      ''
    );
  } else {
    add('FECHAS:', `- Este negocio no trabaja con fechas de ${d.eventLabel}: event_date y delivery_date siempre son cadena vacía.`, '');
  }

  const packagingOn = p.packaging.enabled && p.packaging.types.length > 0;
  if (packagingOn) {
    const cost = (c: number | null) => c === null ? 'costo por confirmar' : c === 0 ? 'sin costo' : `+${money(c)} por ${unit}`;
    add(
      'EMPAQUE (campo packaging de order_items):',
      `- Cada ${model} viene con su empaque, indicado en el catálogo como "empaque: …", y ese empaque ya está incluido en el precio.`,
      '- Tipos de empaque:',
      ...p.packaging.types.map(t => `  - ${t.name}: ${t.description}.`),
      `- Si preguntan por la presentación o el empaque, dile el empaque del ${model} que le interesa y descríbelo en una frase. Si ese ${model} no tiene empaque en el catálogo, dile que lo verificas y escríbelo en owner_question.`,
      `- El cliente puede cambiar a otro empaque. Costo del cambio por ${unit}: ${p.packaging.types.map(t => `${t.name} (${cost(t.changeCost)})`).join(', ')}. No menciones estos costos si no pregunta por cambiar el empaque.`,
      `- Personalizar la vela (colores, nombres, frases) no es lo mismo que personalizar el empaque. Un empaque solo se personaliza si su descripción lo dice; si preguntan por personalizar otro empaque, aclara que ese empaque no se personaliza (la vela sí) y menciona el que sí se puede.`,
      '- Si el cliente elige o pregunta por un empaque personalizable, pregúntale qué color le gustaría para cada parte que se personaliza. No ofrezcas una lista de colores: hay mucha variedad, así que deja que el cliente lo diga. Guarda los colores del empaque en personalization (ejemplo: "tul rosado con lazo blanco").',
      '- Si pide un cambio con "costo por confirmar", dile que lo verificas y le confirmas el valor (escríbelo en owner_question) y no des un total con ese cambio.',
      `- packaging: el empaque al que el cliente pidió cambiar ese ${model}, según toda la conversación (mantenlo en los mensajes siguientes); cadena vacía si se queda con el empaque del catálogo.`,
      ''
    );
  }

  const packagingList = packagingOn ? p.packaging.types.map(t => t.name).join(', ') : '';
  add(
    'DISEÑO FUERA DEL CATÁLOGO (campos custom_design_requested y custom_design_summary):',
    `- Si el cliente pide CUALQUIER ${model} que NO esté en el catálogo (una temática, un animal, un motivo, una figura, un estilo, cualquier cosa) o si dice que ninguno de los ${models} que le mostraste le gusta y quiere algo distinto, es un diseño fuera del catálogo. Da igual qué sea: cualquier cosa que no aparezca en el catálogo entra aquí.`,
    '- NUNCA aceptes ni rechaces el pedido, ni digas que "lo verificas", "lo consultas", "lo confirmas con el equipo" ni nada parecido: el cliente no debe darse cuenta de esta gestión.',
    '- Tampoco des un valor total ni menciones montos: el precio se lo daremos después.',
    '- Pregunta con naturalidad, de a una cosa por mensaje, para entender cómo la quiere:',
    '  1) descripción del diseño (qué quiere que sea) Y si tiene alguna foto de referencia, pídele que te la envíe por este mismo chat: es la forma más clara de entender la idea',
    s.personalization && '  2) colores que le gustaría',
    packagingOn && `  3) empaque que prefiere (${packagingList})`,
    '  4) si quiere algún nombre o frase en la vela',
    `  5) cantidad de ${units}${hasShipping ? ' y ciudad de envío' : ''}`,
    d.enabled && `  6) fecha del ${d.eventLabel}`,
    '- No repitas todas las preguntas juntas: una por respuesta, avanzando la conversación.',
    '- Marca custom_design_requested = true en cuanto entiendas que quiere algo fuera del catálogo.',
    '- Si el cliente envió una foto de referencia en la conversación, agrega "con foto de referencia" al resumen para que la dueña sepa que debe abrir el chat y verla.',
    '- Deja order_items VACÍO mientras sea un diseño fuera del catálogo (no está en el catálogo, no lo pongas).',
    `- Cuando ya tengas al menos la descripción del diseño${s.personalization ? ', los colores' : ''}${packagingOn ? ', el empaque' : ''} y la cantidad, llena custom_design_summary con una sola línea que junte TODO lo que dijo (ejemplo: "${label} temático${s.personalization ? ' · colores' : ''}${packagingOn && p.packaging.types[0] ? ` · empaque ${p.packaging.types[0].name}` : ''} · nombre · 2 ${units}${hasShipping ? ' · ciudad' : ''}${d.enabled ? ` · ${d.eventLabel} DD/MM/YYYY` : ''}"). Antes de tener esos datos, custom_design_summary va vacío.`,
    '- Después de llenar custom_design_summary responde algo cálido y natural (por ejemplo: "Qué idea tan linda 🥰 En un momento te preparo la propuesta"), sin decir que consultas ni prometer una hora.',
    '- Si el diseño ya está en DISEÑOS FUERA DEL CATÁLOGO YA ENVIADOS A LA DUEÑA, no vuelvas a preguntar sus datos: atiende lo que el cliente dice ahora. Si en la conversación ya se le dio un precio para ese diseño, puedes usar ese mismo precio y seguir con la forma de pago con normalidad.',
    '- En el resto de casos custom_design_requested = false y custom_design_summary = "".',
    ''
  );

  add(
    'PREGUNTAS SIN RESPUESTA (campo owner_question):',
    `- Si el cliente pregunta algo que no está en tus instrucciones, en el catálogo${hasShipping ? ' ni en el tarifario de envíos' : ''} (por ejemplo ${packagingOn ? '' : 'presentación o empaque, '}materiales, tamaño), dile que lo verificas y le confirmas pronto, y escribe en owner_question la pregunta resumida en una línea. Sigue atendiendo lo demás con normalidad.`,
    '- NUNCA inventes ni supongas la respuesta a esas preguntas, tampoco después de haber dicho que lo verificas.',
    '- Si la pregunta ya está en PREGUNTAS YA ENVIADAS A LA DUEÑA, deja owner_question vacío y no repitas "lo reviso" en cada mensaje: menciónalo solo si el cliente vuelve a preguntar ("ya lo estoy confirmando").',
    '- Si pudiste responder con tus instrucciones, el catálogo o los datos de empaque, owner_question va vacío: el aviso es solo para lo que no sabes.',
    '- En cualquier otro caso owner_question es una cadena vacía.',
    ''
  );

  add('DATOS BANCARIOS (campo send_bank_details):');
  if (pay.transferEnabled) {
    add(
      '- true SOLO cuando el cliente elige pagar por transferencia o pide los datos de la cuenta. En cualquier otro caso false.',
      bothMethods
        ? '- Aceptar el total, confirmar el pedido o responder "ok", "sí" o "perfecto" NO es elegir transferencia: deja false y pregúntale si prefiere transferencia o tarjeta.'
        : '- Como la transferencia es el único medio de pago, también es true cuando el cliente confirma el pedido y ya conoce el total.',
      usesDeposit
        ? `- Si es true, en reply confirma el total y el anticipo del ${pct}% y dile que a continuación le compartes los datos de la cuenta.`
        : '- Si es true, en reply confirma el total y dile que a continuación le compartes los datos de la cuenta.',
      ''
    );
  } else {
    add('- Siempre false: este negocio no recibe transferencias por este chat.', '');
  }

  add(
    'FOTOS (campo show_products):',
    `- Incluye productos SOLO cuando el cliente pide ver ${models}, fotos u opciones, o pide "más ${models}".`,
    `- Incluye TODOS los productos del catálogo que correspondan a lo que pidió (por ejemplo, todos los de la categoría o todos los que coinciden con el ${model}), usando los nombres exactos.`,
    `- No repitas fotos ya enviadas en esta conversación, salvo que el cliente pida volver a ver un ${model} concreto.`,
    `- Déjalo vacío cuando el cliente está dando detalles de su pedido (cantidad${d.enabled ? ', fecha' : ''}${s.personalization ? ', colores, nombres, personalización' : ''}), confirmando, preguntando precios o formas de pago, o conversando. En esos casos una foto no aporta y confunde.`,
    '- Si envías fotos, en reply preséntalas en una frase corta; no repitas la lista completa de nombres y precios porque cada foto ya lleva su nombre y precio.',
    `- El sistema envía las fotos de 4 en 4 y, si quedan más, pregunta solo si desea ver más ${models}. No hagas tú esa pregunta ni digas cuántas fotos vas a enviar.`,
    '- Si el cliente acepta ver más ("sí", "dale", "muéstrame más"…) y hay FOTOS PENDIENTES POR MOSTRAR, pon TODAS esas en show_products (el sistema las reparte).',
    `- Cuando el mensaje indica que el cliente responde a una foto concreta, ese es el ${model} del que habla.`,
    ''
  );

  add(
    `CASOS QUE REQUIEREN REVISIÓN MANUAL (campo handoff${style.humanPersona ? '; el cliente nunca debe notar ningún cambio de persona' : ''}):`,
    pay.cardEnabled
      ? `- card_payment: el cliente ELIGE explícitamente pagar con tarjeta ("pago con tarjeta", "prefiero tarjeta"). Preguntar cómo pagar o qué formas de pago hay NO es card_payment. Reply: recuérdale el monto total a pagar (100% del valor total${hasShipping ? ' con envío' : ''}),${pay.cardBrands ? ` indícale que solo aceptamos tarjetas ${pay.cardBrands} y` : ''} dile que en un momento le envías el link de pago. Usa emojis en esta respuesta (💳 y otro según el contexto). No hagas preguntas.`
      : '- card_payment: no se usa, este negocio no acepta tarjeta por este chat.',
    '- payment_proof: el cliente envía o dice que envió un comprobante, transferencia o depósito. Reply: agradece, dile que lo verificas y, si falta algún detalle del pedido, sigue atendiéndolo con normalidad.',
    '- complaint: queja o problema con un pedido ya entregado o en curso (llegó roto, atraso, error). Reply: lamenta lo ocurrido y dile que lo revisas y le escribes en unos minutos. No hagas preguntas.',
    `- none: cualquier otro caso${s.personalization ? ', incluidas todas las personalizaciones' : ''}.`,
    '- Reply siempre en primera persona.',
    ''
  );

  add(
    'INTENCIÓN (campo intent):',
    '- quotation: SOLO cuando el cliente pide explícitamente una cotización o el valor total de su pedido ("me cotizas", "cuánto sería en total", "cuánto me sale todo", "pásame la cotización"). Dar cantidad, fecha o colores, o preguntar el precio de un modelo, NO es quotation aunque tú menciones un total.',
    `- order: el cliente CONFIRMA explícitamente la compra con ${model} y cantidad ya definidos ("confirmo", "sí, hagamos el pedido", "lo quiero reservar"). Decir que un ${model} le gusta, dar ${model}, cantidad${s.personalization ? ', colores' : ''}${d.enabled ? ', fecha' : ''}${hasShipping ? ' o ciudad' : ''} (aunque diga "quiero 4 ${units}") o preguntar precios NO es order: usa product_inquiry u other. Elegir la forma de pago después de conocer el total sí confirma la compra.`,
    '- delivery_status: pregunta por el estado de un pedido ya hecho. Responde con ÚLTIMO PEDIDO DE ESTE CLIENTE (estado y fecha de entrega) sin inventar nada más. Si no tiene pedidos registrados o el estado es "pendiente de pago", dile que lo revisas y le confirmas pronto, y escribe en owner_question "Estado del pedido".',
    '- product_inquiry, greeting u other en los demás casos.'
  );

  return rules.join('\n');
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface CatalogProduct {
  name: string;
  price: number;
  category: string;
  /** Empaque incluido en el precio (se guarda en la columna description). */
  description?: string | null;
  /** Unidad propia del producto ("caja de 10", "tubo", "metro"); vacía = la del negocio. */
  sale_unit?: string | null;
  /** Medida del producto ("2,95 m x 0,17 m"); vacía = no se menciona. */
  measure?: string | null;
  /** Piezas que trae esa unidad (10 = caja de 10); vacío = la del negocio. */
  pieces_per_unit?: number | null;
}

/** Unidad en la que se vende y se cotiza un producto: la suya si la tiene, si no la del negocio. */
export function unitOf(product: { sale_unit?: string | null } | undefined, p: BusinessProfile): string {
  return product?.sale_unit?.trim() || p.sales.unitSingular;
}

export type HandoffReason = 'none' | 'card_payment' | 'payment_proof' | 'complaint';

export interface TurnPlan {
  reply: string;
  intent: 'greeting' | 'product_inquiry' | 'quotation' | 'order' | 'delivery_status' | 'other';
  show_products: string[];
  handoff: HandoffReason;
  send_bank_details: boolean;
  owner_question: string;
  custom_design_requested: boolean;
  custom_design_summary: string;
  /** Fecha del evento (AAAA-MM-DD) o cadena vacía. */
  event_date: string;
  /** Fecha de entrega calculada por el sistema o cadena vacía. */
  delivery_date: string;
  /** Productos reales del catálogo con su cantidad (en la unidad de venta del negocio). */
  order_items: { name: string; price: number; quantity: number; personalization: string; packaging: string; packagingChanged: boolean }[];
  shipping_place: string;
  /** Valor total calculado por el sistema (productos + envío) o 0 si falta información. */
  order_total: number;
  /** Monto a transferir para iniciar (anticipo o total) o 0. */
  deposit: number;
}

const TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'intent', 'show_products', 'handoff', 'send_bank_details', 'owner_question', 'custom_design_requested', 'custom_design_summary', 'event_date', 'delivery_date', 'order_items', 'shipping_place', 'quoted_total', 'quoted_deposit'],
  properties: {
    reply: { type: 'string' },
    intent: { type: 'string', enum: ['greeting', 'product_inquiry', 'quotation', 'order', 'delivery_status', 'other'] },
    show_products: { type: 'array', items: { type: 'string' } },
    handoff: { type: 'string', enum: ['none', 'card_payment', 'payment_proof', 'complaint'] },
    send_bank_details: { type: 'boolean' },
    owner_question: { type: 'string' },
    custom_design_requested: { type: 'boolean' },
    custom_design_summary: { type: 'string' },
    event_date: { type: 'string' },
    delivery_date: { type: 'string' },
    order_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'quantity', 'personalization', 'packaging'],
        properties: { name: { type: 'string' }, quantity: { type: 'number' }, personalization: { type: 'string' }, packaging: { type: 'string' } }
      }
    },
    shipping_place: { type: 'string' },
    quoted_total: { type: 'number' },
    quoted_deposit: { type: 'number' }
  }
};

// La clienta elige transferencia o pide la cuenta con alguna de estas palabras.
const BANK_CHOICE_PATTERN = /(?<!\p{L})(transfer\p{L}*|dep[oó]sit\p{L}*|cuentas?|banc\p{L}*)(?!\p{L})/iu;
// Con la transferencia como único medio de pago, confirmar el pedido ya es pedir la cuenta.
const CONFIRM_PATTERN = /(?<!\p{L})(confirm\p{L}*|s[ií]|ok|okey|listo|dale|de acuerdo|hag[aá]mos\p{L}*|lo quiero|la quiero|los quiero|las quiero)(?!\p{L})/iu;

// Frases que la dueña pidió no usar porque se repetían en cada respuesta.
const BANNED_PHRASES = /anotad[oa]s?/i;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// El resumen del pedido en lista y los casos en que sí corresponde volver a darlo.
// Solo cuenta como "ya dado" el resumen completo (con el total): antes de eso todavía se está armando el pedido.
function summaryPatterns(p: BusinessProfile) {
  const label = escapeRegex(p.sales.productLabel);
  const unitStem = escapeRegex(p.sales.unitSingular.slice(0, Math.max(3, p.sales.unitSingular.length - 1)));
  return {
    summary: new RegExp(`\\*${label}:\\*`, 'i'),
    fullSummary: new RegExp(`\\*${label}:\\*[\\s\\S]*\\*Total:\\*`, 'i'),
    totalOrChange: new RegExp(
      `(total|cotiz\\p{L}*|precio|valor|cu[aá]nt\\p{L}*|cantidad|${unitStem}\\p{L}*|fecha|${escapeRegex(p.dates.eventLabel)}|ciudad|env[ií]\\p{L}*|cambi\\p{L}*|mejor|prefiero|agreg\\p{L}*|a[ñn]ad\\p{L}*|quit\\p{L}*|resum\\p{L}*)`,
      'iu'
    )
  };
}

/** Quita las líneas del resumen ("🕯️ *Modelo:* …") y la frase de reserva de la fecha, dejando el resto del mensaje. */
function stripSummary(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*\p{Extended_Pictographic}️?\s*\*[^*\n]+:\*/u.test(line) && !/reservad|se reserva/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Si la IA repite un emoji de adorno de los últimos mensajes, se cambia por otro de la lista que no se haya usado. */
export function varyEmojis(reply: string, recentEmojis: string[], decorative: string[] = profile().style.decorativeEmojis): string {
  const clean = (e: string) => e.replace(/️/g, '');
  const pool = decorative.map(clean);
  const used = new Set(recentEmojis.map(clean));
  return reply.replace(/\p{Extended_Pictographic}️?/gu, match => {
    const base = clean(match);
    if (!pool.includes(base) || !used.has(base)) {
      used.add(base);
      return match;
    }
    const options = pool.filter(e => !used.has(e));
    if (options.length === 0) return match;
    const replacement = options[Math.floor(Math.random() * options.length)];
    used.add(replacement);
    return replacement;
  });
}

// Frases del bot ("se puede adaptar a tus colores") que la IA a veces copia como si fueran el pedido de la clienta.
const GENERIC_PERSONALIZATION = /(se pued|puede[ns]? (adaptar|personalizar|cambiar)|personalizable|admite|a tu gusto|tus colores|lo que (prefieras|quieras)|personalizad[oa]s?$)/i;
// Notas de relleno ("bicolor a definir", "aroma no confirmado"): se borran esas palabras y se conserva el dato.
const FILLER = /\b(personalizaci[oó]n|pendientes?|(a|por|sin) (confirmar|definir|elegir)|no (confirmad|definid|elegid)[oa]s?)\b/gi;
const GENERIC_WORD = /^(los |las |sus |tus |el |la )?(detalles|colores?|nombres?|frases?|personalizaci[oó]n|dise[ñn]os?|aroma|empaque)$/i;

// Palabras que no identifican un detalle concreto: no sirven para saber si la clienta lo pidió.
const DETAIL_FILLER = new Set(['color', 'colores', 'nombre', 'nombres', 'frase', 'frases', 'aroma', 'empaque', 'detalle', 'detalles', 'personalizacion', 'tono', 'tonos', 'para', 'como', 'vela', 'velas']);
const normalizeWords = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * La IA a veces supone detalles que la clienta nunca dijo ("aroma Dulce"). Cada parte de la personalización se conserva
 * solo si alguna de sus palabras (de 4 letras o más) aparece en lo que escribió o dijo la clienta.
 */
export function keepCustomerDetails(personalization: string, customerText: string): string {
  const said = normalizeWords(customerText);
  return personalization
    .split(/,\s*/)
    .filter(part => {
      const words = normalizeWords(part).split(/[^a-zñ]+/).filter(w => w.length >= 4 && !DETAIL_FILLER.has(w));
      return words.length === 0 || words.some(w => said.includes(w.slice(0, 5)));
    })
    .join(', ');
}

/** La personalización solo guarda lo que pidió la clienta: se quitan las partes genéricas que escribe el bot. */
export function cleanPersonalization(value: unknown): string {
  return String(value ?? '')
    .split(/,|;|\s+y\s+/)
    .map(part => part.replace(FILLER, '').replace(/\s+/g, ' ').replace(/^[\s:-]+|[\s:-]+$/g, '').trim())
    .filter(part => part && !GENERIC_PERSONALIZATION.test(part) && !GENERIC_WORD.test(part))
    .join(', ');
}

/** Piezas por unidad de venta según el perfil ("12 unidades" → 12); 1 si no aplica. */
function piecesPerUnit(p: BusinessProfile): number {
  // Si el perfil tiene piecesPerUnit definido, usarlo
  if (p.sales.piecesPerUnit !== undefined && p.sales.piecesPerUnit > 0) {
    return p.sales.piecesPerUnit;
  }
  // Fallback: extraer del unitDetail (ej: "12 unidades" → 12)
  const match = p.sales.unitDetail.match(/\d+/);
  const pieces = match ? Number(match[0]) : 1;
  return pieces > 1 ? pieces : 1;
}

/**
 * La clienta suele pedir en piezas ("48 unidades", "36 velas") y la IA a veces copia ese número como
 * cantidad de docenas: 48 docenas multiplicaría el total por 12. Si la clienta dijo ese número en piezas
 * (y nunca en docenas), se convierte a la unidad de venta redondeando hacia arriba (50 velas → 5 docenas).
 */
export function normalizeQuantities(rawItems: any, customerText: string, p: BusinessProfile = profile(), catalog: CatalogProduct[] = []): any {
  if (!Array.isArray(rawItems)) return rawItems;
  const globalPer = piecesPerUnit(p);
  // Un producto puede traer sus propias piezas por unidad (una caja de 10, un tubo suelto).
  const piecesOf = (name: unknown) => {
    const own = catalog.find(c => c.name === name)?.pieces_per_unit;
    return Number(own) > 1 ? Number(own) : globalPer;
  };
  if (globalPer === 1 && !catalog.some(c => Number(c.pieces_per_unit) > 1)) return rawItems;
  const text = normalizeWords(customerText);
  const clean = (w: string) => escapeRegex(normalizeWords(w.trim()));
  const pieceWords = ['unidad', 'unidades', 'pieza', 'piezas', 'vela', 'velas', 'velita', 'velitas',
    ...p.sales.unitDetail.replace(/\d+/g, ' ').split(/\s+/), p.sales.goodsWord]
    .filter(w => w && w.length >= 3).map(clean);
  return rawItems.map((item: any) => {
    const quantity = Number(item?.quantity);
    const per = piecesOf(item?.name);
    if (per === 1 || !Number.isFinite(quantity) || quantity <= 1) return item;
    const own = catalog.find(c => c.name === item?.name)?.sale_unit || '';
    const unitWords = [p.sales.unitSingular, p.sales.unitPlural, ...own.split(/\s+/)]
      .filter(w => w && w.length >= 3).map(clean);
    const saidPieces = new RegExp(`(^|\\D)${quantity}\\s*(${[...new Set(pieceWords)].join('|')})\\b`, 'i').test(text);
    const saidUnits = new RegExp(`(^|\\D)${quantity}\\s*(${unitWords.join('|')})\\b`, 'i').test(text);
    if (!saidPieces || saidUnits) return item;
    const converted = Math.ceil(quantity / per);
    console.warn(`📦 Cantidad corregida: la clienta pidió ${quantity} piezas = ${converted} ${p.sales.unitPlural}`);
    return { ...item, quantity: converted };
  });
}

/**
 * Calcula el valor total a partir de lo que la IA entendió de la conversación.
 * Los precios salen del catálogo y el envío del perfil del negocio: la IA no hace las cuentas.
 */
export function computeOrderTotal(rawItems: any, rawPlace: any, catalog: CatalogProduct[], p: BusinessProfile = profile()) {
  const byName = new Map(catalog.map(c => [productKey(c.name), c]));
  const packagingOn = p.packaging.enabled && p.packaging.types.length > 0;
  // Empaque pedido cuyo costo de cambio aún no está definido: sin ese valor no hay total.
  let packagingUndefined = '';
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map((i: any) => ({
      product: byName.get(productKey(i?.name)),
      quantity: Number(i?.quantity),
      personalization: cleanPersonalization(i?.personalization),
      packaging: i?.packaging
    }))
    .filter((i: any) => i.product && Number.isFinite(i.quantity) && i.quantity > 0)
    .map((i: any) => {
      // El empaque del catálogo va incluido en el precio; cambiarlo suma el costo del empaque elegido por unidad de venta.
      const included = packagingOn ? String(i.product.description || '').trim() : '';
      const wanted = packagingOn ? findPackaging(i.packaging, p) : undefined;
      const changed = !!wanted && productKey(wanted.name) !== productKey(included);
      if (changed && wanted!.changeCost === null) packagingUndefined = wanted!.name;
      const extra = changed ? wanted!.changeCost || 0 : 0;
      return {
        name: i.product.name,
        price: round2(Number(i.product.price) + extra),
        quantity: i.quantity,
        personalization: i.personalization,
        packaging: changed ? wanted!.name : included,
        packagingChanged: changed
      };
    });

  const needsPlace = p.shipping.mode !== 'none';
  const place = needsPlace ? String(rawPlace || '').trim() : '';
  const units = items.reduce((sum: number, i: any) => sum + i.quantity, 0);
  const shipping = place ? shippingCost(place, units, p) : null;

  let missing: '' | 'items' | 'place' | 'unknown_place' | 'packaging_cost' = '';
  if (items.length === 0) missing = 'items';
  else if (needsPlace && !place) missing = 'place';
  else if (needsPlace && !shipping) missing = 'unknown_place';
  else if (packagingUndefined) missing = 'packaging_cost';

  const subtotal = round2(items.reduce((sum: number, i: any) => sum + i.price * i.quantity, 0));
  const total = missing ? 0 : round2(subtotal + (shipping?.cost || 0));
  const depositPercent = p.payments.transferEnabled ? p.payments.depositPercent : 100;
  return { items, place, shipping, missing, packagingUndefined, subtotal, total, deposit: round2(total * depositPercent / 100) };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Resta días a una fecha AAAA-MM-DD sin depender de la zona horaria del servidor. */
export function subtractDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d - days));
  return date.toISOString().slice(0, 10);
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function buildSystemPrompt(
  catalog: CatalogProduct[],
  customPrompt: string | undefined,
  sentProducts: string[],
  bankDetailsSent: boolean,
  pendingProducts: string[] = [],
  recentEmojis: string[] = [],
  p: BusinessProfile = profile()
) {
  const persona = customPrompt && customPrompt.trim() ? customPrompt.trim() : defaultPersona(p);
  const { unitSingular: unit } = p.sales;
  const models = p.sales.productLabelPlural.toLowerCase();

  let catalogText = 'CATÁLOGO: todavía no hay productos cargados. Si el cliente pregunta por productos, indícale que en breve le compartes las opciones.';
  if (catalog.length > 0) {
    const byCategory: { [key: string]: CatalogProduct[] } = {};
    for (const c of catalog) {
      if (!byCategory[c.category]) byCategory[c.category] = [];
      byCategory[c.category].push(c);
    }
    catalogText = `CATÁLOGO ACTUAL DE ${p.business.name.toUpperCase()} (cada precio es por la unidad indicada):\n\n` + Object.entries(byCategory)
      .map(([cat, items]) => `${cat} (${items.length} ${models}):\n` + items.map(i => {
        const pieces = Number(i.pieces_per_unit) > 1 ? ` = ${i.pieces_per_unit} unidades` : '';
        const measure = i.measure ? ` · mide ${i.measure}` : '';
        return `  - ${i.name}: $${Number(i.price).toFixed(2)} por ${unitOf(i, p)}${pieces}${measure}${p.packaging.enabled && i.description ? ` · empaque: ${i.description}` : ''}`;
      }).join('\n'))
      .join('\n\n');
  }

  const sentText = sentProducts.length > 0
    ? `FOTOS YA ENVIADAS EN ESTA CONVERSACIÓN: ${sentProducts.join(', ')}`
    : 'FOTOS YA ENVIADAS EN ESTA CONVERSACIÓN: ninguna';
  const pendingText = pendingProducts.length > 0
    ? `\nFOTOS PENDIENTES POR MOSTRAR (ya se le preguntó si desea ver más ${models}): ${pendingProducts.join(', ')}`
    : '';

  // Sin la fecha la IA no puede saber si "el 18" ya pasó ni qué año corresponde.
  const today = new Date().toLocaleDateString('es-EC', {
    timeZone: p.business.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const bankText = !p.payments.transferEnabled ? ''
    : bankDetailsSent
      ? '\nDATOS BANCARIOS: ya se enviaron en esta conversación; vuelve a marcar send_bank_details solo si el cliente los pide de nuevo.'
      : '\nDATOS BANCARIOS: aún no se han enviado en esta conversación.';

  const summary = shippingRatesSummary(p);
  const shippingText = p.shipping.mode === 'ecuador_table'
    ? `TARIFAS DE ENVÍO DESDE ${p.business.city.toUpperCase()} (uso interno, todos los cantones de la provincia cuestan igual):\n${summary}\n\n`
    : p.shipping.mode === 'flat' ? `TARIFA DE ENVÍO (uso interno):\n${summary}\n\n` : '';

  const rules = buildCoreRules(p, catalog[0]?.name, catalog.some(c => c.sale_unit));
  return `${persona}\n\n${rules}\n\nFECHA DE HOY (${p.business.city || p.business.timezone}): ${today}\n\n${shippingText}${catalogText}\n\n${sentText}${pendingText}${bankText}\nEMOJIS USADOS RECIENTEMENTE: ${recentEmojis.length ? recentEmojis.join(' ') : 'ninguno'}`;
}

/**
 * Decide en una sola llamada qué responder, qué fotos enviar y si el chat pasa a una persona.
 * Hacerlo junto evita que la respuesta diga una cosa y las fotos muestren otra.
 */
export async function planTurn(params: {
  history: Message[];
  userMessage: string;
  catalog: CatalogProduct[];
  customPrompt?: string;
  sentProducts: string[];
  bankDetailsSent?: boolean;
  pendingProducts?: string[];
  recentEmojis?: string[];
  /** Preguntas que ya se le enviaron a la dueña en este chat y siguen sin respuesta. */
  pendingOwnerQuestions?: string[];
  /** La clienta ya eligió pagar con tarjeta: se paga el total, no hay anticipo. */
  cardChosen?: boolean;
  /** Diseños fuera del catálogo que ya se le enviaron a la dueña en este chat. */
  pendingCustomDesigns?: string[];
  /** Resumen del último pedido del chat con su estado, para responder "¿cómo va mi pedido?". */
  lastOrder?: string;
  /** Perfil del negocio; si no viene, usa el global. */
  profile?: BusinessProfile;
}): Promise<TurnPlan> {
  const {
    history, userMessage, catalog, customPrompt, sentProducts, bankDetailsSent = false, pendingProducts = [], recentEmojis = [],
    pendingOwnerQuestions = [], cardChosen: cardChosenBefore = false, pendingCustomDesigns = [], lastOrder = '', profile: profileParam
  } = params;
  const p = profileParam || profile();
  const pay = p.payments;
  const usesDeposit = pay.transferEnabled && pay.depositPercent < 100;
  const hasShipping = p.shipping.mode !== 'none';
  const goods = hasShipping ? `${p.sales.goodsWord} + envío` : p.sales.goodsWord;

  // Lo que escribió la clienta, sin el texto citado de otro mensaje (que puede decir "transferencia").
  const customerWords = userMessage.replace(/\[El cliente responde a [^\]]*\]/g, '');
  const onlyTransfer = pay.transferEnabled && !pay.cardEnabled;
  const choseTransfer = pay.transferEnabled
    && (BANK_CHOICE_PATTERN.test(customerWords) || (onlyTransfer && CONFIRM_PATTERN.test(customerWords)));
  // Si antes eligió tarjeta pero ahora elige transferencia, vuelve a haber anticipo.
  const cardChosen = cardChosenBefore && !choseTransfer;
  const patterns = summaryPatterns(p);

  const baseMessages = [
    {
      role: 'system' as const,
      content: buildSystemPrompt(catalog, customPrompt, sentProducts, bankDetailsSent, pendingProducts, recentEmojis, p)
        + `\nPREGUNTAS YA ENVIADAS A LA DUEÑA: ${pendingOwnerQuestions.length ? pendingOwnerQuestions.join(' | ') : 'ninguna'}`
        + (cardChosen && usesDeposit ? '\nFORMA DE PAGO ELEGIDA: tarjeta. Se paga el 100% del total: no menciones anticipo; la fecha se reserva "al recibir el pago".' : '')
        + `\nDISEÑOS FUERA DEL CATÁLOGO YA ENVIADOS A LA DUEÑA: ${pendingCustomDesigns.length ? pendingCustomDesigns.join(' | ') : 'ninguno'}`
        + `\nÚLTIMO PEDIDO DE ESTE CLIENTE: ${lastOrder || 'no tiene pedidos registrados'}`
    },
    ...history,
    { role: 'user' as const, content: userMessage }
  ];

  const ask = async (extraSystem?: string) => {
    const client = getOpenAIClient(p);
    const model = getOpenAIModel(p);
    const response = await client.chat.completions.create({
      model,
      ...reasoningFor(model),
      max_completion_tokens: 3000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'turno_whatsapp', strict: true, schema: TURN_SCHEMA }
      },
      messages: extraSystem ? [...baseMessages, { role: 'system' as const, content: extraSystem }] : baseMessages
    });
    return JSON.parse(response.choices[0]?.message?.content || '{}');
  };

  let parsed = await ask();

  // Fechas y montos los calcula el sistema. Si la IA escribió otros, se rehace la respuesta
  // una sola vez con todas las correcciones juntas.
  const corrections: string[] = [];
  const reply = () => String(parsed.reply || '');

  const days = p.dates.deliveryDaysBeforeEvent;
  const eventDate = p.dates.enabled && isValidIsoDate(String(parsed.event_date || '')) ? parsed.event_date : '';
  const expectedDelivery = eventDate ? subtractDays(eventDate, days) : '';
  const mentioned = String(parsed.delivery_date || '');
  const ev = p.dates.eventLabel;
  const DATE_TALK = new RegExp(`(fecha|entrega|d[ií]a|cu[aá]ndo|llega|${escapeRegex(ev)}|\\d{1,2}\\s+de\\s+\\p{L}+|\\d{1,2}/\\d{1,2})`, 'iu');
  const dateAlreadyGiven = !!expectedDelivery
    && history.some(m => m.role === 'assistant' && String(m.content || '').includes(formatDate(expectedDelivery)))
    && !DATE_TALK.test(customerWords);
  if (expectedDelivery && mentioned && expectedDelivery <= todayLocal(p)) {
    // Evento muy cercano: siempre se atiende, pero decirle una fecha de entrega ya pasada no tiene sentido.
    console.warn(`📅 Entrega calculada ${expectedDelivery} es hoy o ya pasó: se pide no mencionarla`);
    corrections.push(
      `El ${ev} es el ${formatDate(eventDate)} y la entrega calculada (${days} días antes) ya pasó o es hoy. ` +
      `No menciones ninguna fecha de entrega. Confirma con seguridad que sí atendemos su pedido para su ${ev} y dile que en un momento le confirmas el día exacto de entrega.`
    );
  } else if (expectedDelivery && mentioned && mentioned !== expectedDelivery) {
    console.warn(`📅 Fecha de entrega corregida: la IA dijo ${mentioned}, corresponde ${expectedDelivery}`);
    corrections.push(
      `El ${ev} es el ${formatDate(eventDate)} y la fecha de entrega correcta es el ${formatDate(expectedDelivery)} ` +
      `(${days} días antes). Usa exactamente esa fecha de entrega y di que la fecha se reserva al recibir el ${usesDeposit ? 'anticipo' : 'pago'}.`
    );
  } else if (expectedDelivery && mentioned && dateAlreadyGiven) {
    // Ya se le dio esa fecha y no preguntó por ella: repetirla con la frase de la reserva en cada mensaje cansa.
    console.warn('📅 La IA repitió la fecha de entrega sin que la clienta la pidiera');
    corrections.push('Ya le diste la fecha de entrega antes y no la está preguntando: no repitas la fecha de entrega ni la frase de la reserva. Responde solo a lo que pregunta.');
  } else if (expectedDelivery && mentioned) {
    // La fecha es correcta, pero sin la reserva por pago se pierde la urgencia.
    const payByCard = parsed.handoff === 'card_payment' || cardChosen || !usesDeposit;
    if (!(payByCard ? /recibir el pago|confirmar el pago/i : /anticipo/i).test(reply())) {
      corrections.push(payByCard
        ? `Mantén la misma fecha de entrega y agrega que la fecha queda reservada al recibir el pago, ya que las fechas se van ocupando por orden de pago.${usesDeposit ? ' No menciones anticipo: con tarjeta se paga el total.' : ''}`
        : 'Mantén la misma fecha de entrega y agrega que la fecha queda reservada al recibir el anticipo, ya que las fechas se van ocupando por orden de pago.');
    }
  }

  // Con tarjeta se paga el 100%: hablar de anticipo confunde a la clienta.
  if (usesDeposit && (parsed.handoff === 'card_payment' || cardChosen) && /anticipo/i.test(reply())) {
    corrections.push('La clienta paga con tarjeta: se cancela el 100% del valor total. No menciones la palabra anticipo; si hablas de la reserva de la fecha di "al recibir el pago".');
  }

  // Los datos bancarios solo salen cuando la clienta eligió transferencia o pidió la cuenta.
  if (parsed.send_bank_details === true && !choseTransfer) {
    console.warn('🏦 La IA quiso enviar datos bancarios sin que la clienta eligiera transferencia');
    const options = pay.cardEnabled
      ? ` Pregúntale con qué prefiere pagar, en lista: transferencia (${usesDeposit ? `anticipo ${pay.depositPercent}%` : '100% del total'}) o tarjeta${pay.cardBrands ? ` ${pay.cardBrands.replace(/ y /g, ' o ')}` : ''} (100% del total).`
      : ' Pregúntale si confirma el pedido.';
    corrections.push(
      'La clienta todavía NO eligió pagar por transferencia ni pidió los datos de la cuenta: send_bank_details debe ser false. ' +
      `No digas que le envías ni que le compartes los datos de la cuenta.${options}`
    );
  }

  // El resumen en lista solo se repite si vuelve a pedir el total o cambia algo del pedido.
  const summaryAlreadySent = history.some(m => m.role === 'assistant' && patterns.fullSummary.test(String(m.content || '')));
  const repeatsSummary = () => summaryAlreadySent && patterns.summary.test(reply()) && !patterns.totalOrChange.test(customerWords);
  if (repeatsSummary()) {
    console.warn('📋 La IA repitió el resumen sin que la clienta cambiara nada');
    corrections.push(
      'Ya le diste el resumen en lista antes y no cambió ningún dato: no lo repitas. ' +
      'Responde solo a lo que pregunta, en 2 o 3 líneas, sin la lista, sin repetir la fecha de entrega y sin la frase de la reserva.'
    );
  }

  if (BANNED_PHRASES.test(reply())) {
    corrections.push('No uses "te lo dejo anotado" ni ninguna frase con "anotado"; exprésalo de otra forma.');
  }

  const quotedTotal = Number(parsed.quoted_total) || 0;
  const quotedDeposit = usesDeposit ? Number(parsed.quoted_deposit) || 0 : 0;
  const customerText = [...history.filter(m => m.role === 'user').map(m => m.content), userMessage].join('\n');
  const firstOrder = computeOrderTotal(normalizeQuantities(parsed.order_items, customerText, p, catalog), parsed.shipping_place, catalog, p);
  // Montos que aparecen escritos en la respuesta ("$30", "$127.00", "$63,50").
  const amountsInReply = (reply().match(/\$\s?\d+(?:[.,]\d{1,2})?/g) || [])
    .map(a => Number(a.replace(/[$\s]/g, '').replace(',', '.')));
  // Sin montos todavía, pero la reserva de la fecha sí se puede mencionar para crear urgencia.
  const noAmountsYet = `No escribas ningún monto (ni valor total${usesDeposit ? ' ni valor del anticipo' : ''}) todavía${p.dates.enabled ? `; sí puedes decir que la fecha se reserva con el ${usesDeposit ? 'anticipo' : 'pago'}` : ''}.`;

  // Un monto que el negocio ya le dio en este chat (por ejemplo el precio de un diseño personalizado que escribió
  // la dueña) se puede repetir, igual que su anticipo, aunque ese producto no esté en el catálogo.
  const amountsSaidBefore = history
    .filter(m => m.role === 'assistant')
    .flatMap(m => (String(m.content || '').match(/\$\s?\d+(?:[.,]\d{1,2})?/g) || []).map(a => Number(a.replace(/[$\s]/g, '').replace(',', '.'))));
  const saidBefore = (value: number) => amountsSaidBefore.some(v =>
    Math.abs(v - value) < 0.009 || (usesDeposit && Math.abs(round2(v * pay.depositPercent / 100) - value) < 0.009));
  const repeatsKnownPrice = firstOrder.missing === 'items' && amountsInReply.length > 0 && amountsInReply.every(saidBefore);

  if ((quotedTotal > 0 || quotedDeposit > 0) && !repeatsKnownPrice) {
    if (firstOrder.missing === 'items') {
      corrections.push(`${noAmountsYet} Aún no está claro qué ${p.sales.productLabelPlural.toLowerCase()} y cuántas ${p.sales.unitPlural} quiere; pregúntale.`);
    } else if (firstOrder.missing === 'place') {
      corrections.push(`${noAmountsYet} Pregunta primero a qué ciudad se envía el pedido.`);
    } else if (firstOrder.missing === 'unknown_place') {
      corrections.push(`${noAmountsYet} "${firstOrder.place}" no aparece en el tarifario o existe en varias provincias; pregunta la ciudad y la provincia exactas.`);
    } else if (firstOrder.missing === 'packaging_cost') {
      corrections.push(`${noAmountsYet} El costo de cambiar al empaque ${firstOrder.packagingUndefined} todavía no está definido: dile que lo verificas y le confirmas el valor, y escribe la consulta en owner_question.`);
    }
  }

  // Si ya se conoce todo lo necesario, cualquier monto escrito debe cuadrar con el cálculo del sistema,
  // aunque la IA no lo haya declarado en quoted_total (por ejemplo "$123.00" en lugar de "$124.00").
  if (!firstOrder.missing && amountsInReply.length > 0) {
    const showSeparately = hasShipping && p.shipping.showSeparately;
    const allowed = [firstOrder.total, firstOrder.deposit, ...(showSeparately ? [firstOrder.subtotal, firstOrder.shipping?.cost || 0] : [])];
    // El costo de cambiar de empaque se puede mencionar cuando la clienta lo pregunta.
    const catalogPrices = [
      ...catalog.map(c => Number(c.price)),
      ...(p.packaging.enabled ? p.packaging.types.map(t => t.changeCost).filter((c): c is number => typeof c === 'number' && c > 0) : [])
    ];
    const givesTotal = quotedTotal > 0 || quotedDeposit > 0 || amountsInReply.some(a => [firstOrder.total, firstOrder.deposit].some(v => Math.abs(a - v) < 0.009));
    const wrongTotal = (quotedTotal > 0 && Math.abs(quotedTotal - firstOrder.total) > 0.009)
      || (quotedDeposit > 0 && Math.abs(quotedDeposit - firstOrder.deposit) > 0.009);
    // Al dar el total solo valen los montos del cálculo; en otros mensajes también se permite el precio de catálogo.
    const accepted = givesTotal ? allowed : [...allowed, ...catalogPrices];
    const extraAmounts = amountsInReply.some(a => !accepted.some(v => Math.abs(a - v) < 0.009));
    if (wrongTotal || extraAmounts) {
      console.warn(`💲 Montos corregidos: la IA dijo ${quotedTotal}/${quotedDeposit} (${amountsInReply.join(', ')}), corresponde ${firstOrder.total}/${firstOrder.deposit}`);
      const where = firstOrder.shipping ? `${p.sales.goodsWord} + envío a ${firstOrder.shipping.place}` : goods;
      const depositText = usesDeposit ? ` y el anticipo del ${pay.depositPercent}% es ${money(firstOrder.deposit)}` : '';
      corrections.push(showSeparately
        ? `El subtotal de ${p.sales.goodsWord} es ${money(firstOrder.subtotal)}, el envío a ${firstOrder.shipping!.place} cuesta ${money(firstOrder.shipping!.cost)} y el valor total es ${money(firstOrder.total)}${depositText}. Usa exactamente esos montos.`
        : `El valor total correcto del pedido (${where}) es ${money(firstOrder.total)}${depositText}. Escribe solo ${usesDeposit ? 'esos montos' : 'ese monto'}, como un solo valor: ` +
          `sin precio por ${p.sales.unitSingular}${hasShipping ? `, sin subtotal de ${p.sales.goodsWord} y sin mencionar el envío por separado` : ''}.`
      );
    }
  }

  if (corrections.length > 0) {
    parsed = await ask(`CORRECCIÓN (obligatoria):\n- ${corrections.join('\n- ')}\nRehaz la respuesta aplicando estas correcciones.`);
    if (repeatsSummary()) {
      console.warn('📋 La IA insistió en repetir el resumen: se quitan esas líneas');
      parsed.reply = stripSummary(reply());
    }
    if (dateAlreadyGiven && reply().includes(formatDate(expectedDelivery))) {
      console.warn('📅 La IA insistió en repetir la fecha de entrega: se quitan esas líneas');
      parsed.reply = reply().split('\n')
        .filter(line => !line.includes(formatDate(expectedDelivery)) && !/reservad|se reserva|orden de pago/i.test(line))
        .join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  const order = computeOrderTotal(normalizeQuantities(parsed.order_items, customerText, p, catalog), parsed.shipping_place, catalog, p);

  // Solo nombres que existen de verdad en el catálogo, sin duplicados.
  const byName = new Map(catalog.map(c => [productKey(c.name), c.name]));
  const showProducts = [...new Set(
    (Array.isArray(parsed.show_products) ? parsed.show_products : [])
      .map((n: any) => byName.get(productKey(n)))
      .filter(Boolean) as string[]
  )].slice(0, MAX_PHOTOS_PER_TURN);

  return {
    reply: varyEmojis(String(parsed.reply || '').trim(), recentEmojis, p.style.decorativeEmojis),
    intent: parsed.intent || 'other',
    show_products: showProducts,
    // Sin tarjeta habilitada no hay pago con tarjeta que derivar.
    handoff: parsed.handoff === 'card_payment' && !pay.cardEnabled ? 'none' : parsed.handoff || 'none',
    // Aunque la corrección falle, sin elección de transferencia nunca se envían las cuentas.
    send_bank_details: parsed.send_bank_details === true && choseTransfer,
    owner_question: String(parsed.owner_question || '').trim(),
    custom_design_requested: parsed.custom_design_requested === true,
    custom_design_summary: String(parsed.custom_design_summary || '').trim(),
    event_date: eventDate,
    delivery_date: expectedDelivery,
    order_items: order.items.map(i => ({
      ...i,
      personalization: keepCustomerDetails(i.personalization, customerText)
    })),
    shipping_place: order.place,
    order_total: order.total,
    deposit: order.total ? order.deposit : 0
  };
}

export interface OrderItem {
  name: string;
  price: number;
  quantity: number;
  personalization: string;
  packaging?: string;
  packagingChanged?: boolean;
}

/**
 * Extrae qué productos del catálogo quiere el cliente y en qué cantidad, leyendo la conversación
 * reciente (el cliente suele decir "de ese modelo" sin repetir el nombre).
 * Devuelve solo coincidencias reales del catálogo: nunca inventa productos ni precios.
 */
export async function extractOrderItems(
  conversationText: string,
  catalog: { name: string; price: number; category: string }[],
  p: BusinessProfile = profile()
): Promise<OrderItem[]> {
  if (!catalog || catalog.length === 0) return [];
  const s = p.sales;

  try {
    const catalogNames = catalog.map(c => c.name).join('\n');
    const prompt = `Catálogo disponible (un producto por línea):
${catalogNames}

Conversación reciente con el cliente:
${conversationText}

Identifica qué productos del catálogo quiere el cliente en este momento y cuántas ${s.unitPlural.toUpperCase()} de cada uno.
Reglas:
- Usa EXACTAMENTE los nombres del catálogo.
- Si no queda claro ningún producto del catálogo, devuelve una lista vacía.
${s.unitDetail ? `- Si da la cantidad en otra medida, conviértela a ${s.unitPlural} (1 ${s.unitSingular} = ${s.unitDetail}), redondeando hacia arriba.\n` : ''}- Si no especifica cantidad, asume 1 ${s.unitSingular}.
- En personalization resume los detalles especiales que pidió para ese producto (colores, nombres, frases, fecha); cadena vacía si no hay.

Responde solo JSON: {"items":[{"name":"...","quantity":1,"personalization":"..."}]}`;

    const client = getOpenAIClient(p);
    const model = getOpenAIModel(p);
    const response = await client.chat.completions.create({
      model,
      ...reasoningFor(model),
      max_completion_tokens: 1000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    return items
      .map((item: any) => {
        const match = catalog.find(c => productKey(c.name) === productKey(item.name));
        if (!match) return null;
        const quantity = Number(item.quantity);
        return {
          name: match.name,
          price: match.price,
          quantity: Number.isFinite(quantity) && quantity > 0 ? Math.ceil(quantity) : 1,
          personalization: cleanPersonalization(item.personalization)
        };
      })
      .filter(Boolean) as OrderItem[];
  } catch (error: any) {
    console.error('Error extrayendo productos del pedido:', error.message);
    return [];
  }
}

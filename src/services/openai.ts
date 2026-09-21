import { OpenAI, toFile } from 'openai';
import { shippingCost, shippingRatesSummary } from './shippingRates';
import { recordAiUsage } from './supabase';
import { ticsIn, stripFillerOpening, withoutBrokenChars } from './muletillas';
import { BusinessProfile, profile, todayLocal, formatDate, findPackaging, getOpenAIKey, getOpenAIModel, getOpenAIVisionModel, usesProductUnits, usesGenderTagging, packagingChange, PackagingChange } from '../config/businessProfile';

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

/** Anota lo que consumió la llamada para poder ver después cuánto gasta cada empresa. */
function track(purpose: string, model: string, response: any) {
  const u = response?.usage;
  if (!u) return;
  void recordAiUsage({
    model,
    purpose,
    input: u.prompt_tokens || 0,
    cached: u.prompt_tokens_details?.cached_tokens || 0,
    output: u.completion_tokens || 0
  });
}

/** Marca con la que la IA lee los mensajes que escribió una persona del equipo (el cliente nunca la ve). */
export const TEAM_MARK = '[Mensaje del equipo] ';

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
      language: 'es',
      response_format: 'verbose_json'
    });
    // Se anota como segundos de audio (cobra por minuto) para que el gasto coincida con la factura.
    void recordAiUsage({ model: 'whisper-1', purpose: 'audio', input: Math.ceil((transcription as any).duration || 0), cached: 0, output: 0 });
    return transcription.text;
  } catch (error: any) {
    console.error('Error transcribiendo audio:', error.message);
    return '[No se pudo transcribir el audio]';
  }
}

/**
 * Lo que la IA debe fijarse al mirar una foto del cliente. Una descripción genérica ("foto de referencia de un producto")
 * no sirve: hace falta la figura exacta, los colores de cada parte, el empaque y los textos, porque con eso se cotiza.
 */
export function buildImagePrompt(p: BusinessProfile): string {
  const lines = [
    `Un cliente de un negocio de ${p.business.description} te envió esta foto por WhatsApp. Descríbela en español con TODO el detalle útil para atenderlo, en líneas cortas con estas etiquetas (omite las que no apliquen):`,
    'Tipo: foto de referencia de un producto o diseño / comprobante de pago o transferencia / imagen del catálogo del propio negocio / documento / otra cosa.',
    'Figura: qué es exactamente y cómo es, con el nombre concreto ("conejita sentada de orejas largas caídas", "peonía abierta", "oso abrazando un corazón"), su postura y su acabado.',
    'Colores: el color de cada parte visible (cuerpo, moño o lazo, detalles, base), con nombres precisos (blanco hueso, rosado pastel, dorado…).',
    'Presentación: cómo viene empacado (bolsita con ventana, caja, tul, frasco, vasito, acetato, cinta) y los colores del empaque.',
    'Detalles: textos o nombres escritos (cópialos tal cual), adornos (perlas, flores, tarjeta, estrellas), tamaño aproximado si se nota y cuántas piezas se ven.'
  ];
  lines.push(
    'Si es un comprobante de pago: Tipo: comprobante de pago, y además el banco, el monto, la fecha y el número de referencia si se leen.',
    'Privacidad: en documentos, guías o capturas NO copies datos personales (cédula, teléfonos, correos, direcciones, nombres de personas): solo di de qué documento se trata. En un comprobante de pago sí anota banco, monto, fecha y referencia.',
    'Reglas: sé específico, nunca genérico; no inventes lo que no se ve (usa "posiblemente" o "no se distingue"); no opines sobre el negocio. Máximo 7 líneas.'
  );
  return lines.join('\n');
}

export async function describeImage(imageUrl: string, p: BusinessProfile = profile()): Promise<string> {
  const client = getOpenAIClient(p);
  const ask = async (model: string) => {
    const response = await client.chat.completions.create({
      model,
      ...reasoningFor(model),
      // Con modelos que razonan, parte del límite se gasta pensando: se deja margen para que la descripción salga completa.
      max_completion_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildImagePrompt(p) },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
        ]
      }]
    } as any);
    track('foto', model, response);
    return (response.choices[0]?.message?.content || '').trim();
  };

  const visionModel = getOpenAIVisionModel(p);
  try {
    const description = await ask(visionModel);
    if (description) return description;
  } catch (error: any) {
    // La clave de un negocio puede no tener acceso al modelo de imágenes: se intenta con su modelo de siempre.
    console.error(`Error describiendo imagen con ${visionModel}:`, error.message);
  }
  try {
    const fallback = getOpenAIModel(p);
    if (fallback !== visionModel) return await ask(fallback);
  } catch (error: any) {
    console.error('Error describiendo imagen:', error.message);
  }
  return '[No se pudo analizar la imagen]';
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
export function buildCoreRules(p: BusinessProfile, exampleProduct = 'Nombre del producto', ownUnits = false, hasGenderedProducts = false): string {
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
      ? '- Cada producto del catálogo se vende en la unidad que dice su línea (caja, tubo, plancha, metro...). Usa la unidad de ESE producto al dar su precio y nunca la de otro. Si el cliente necesita una cantidad de piezas sueltas, conviértela a esa unidad redondeando hacia arriba y habla siempre en la unidad de venta (ejemplo: necesita 18 piezas de un producto que va en caja de 10 → son 2 cajas; dile "2 cajas (20 piezas)").'
      : `- Todos los precios del catálogo son POR ${unit.toUpperCase()}${s.unitDetail ? ` (${s.unitDetail})` : ''}. Acláralo siempre que menciones un precio.`,
    '- Solo ofrece productos que estén en el catálogo de abajo, con su nombre y precio exactos. Nunca inventes productos, precios, colores ni modelos.',
    `- Si el cliente pregunta cuántos ${models} hay de ${d.enabled ? `un ${d.eventLabel}` : 'una categoría'}, considera TODOS los productos de esa categoría del catálogo; no digas que no hay más si existen.`,
    '- Estás escribiendo por WhatsApp: sin tablas ni formato markdown (nada de #, ** ni guiones de lista). Para resaltar usa *asteriscos*.',
    '- Haz UNA sola pregunta por mensaje (un solo signo de interrogación) y solo la que más ayude a avanzar; nunca juntes evento, cantidad y fecha en la misma pregunta. Si el cliente solo saluda, pregunta únicamente qué producto busca o para qué evento es.',
    '- Si ya le hiciste una pregunta y el cliente responde otra cosa sin contestarla (por ejemplo vuelve a pedir lo mismo), NO repitas la pregunta: elige tú la opción que mejor encaje con lo que pide, dile cuál elegiste y avanza (cotiza), dejando claro que puede cambiarla. No pidas permiso para cotizar.',
    '- Todo dato que el cliente ya dio (evento, cantidad, fecha, ciudad, colores, sexo del bebé) se confirma TODO junto en una frase de tu respuesta, sin olvidar la cantidad (por ejemplo "perfecto, 3 docenas de baby shower de niño para noviembre") y NUNCA se le vuelve a preguntar; pregunta solo lo que todavía falta. Si dio solo el mes de la fecha, pídele únicamente el día.',
    '- NATURALIDAD: escribe como una persona, no como un robot. Empieza directo con la respuesta; una exclamación de relleno ("Qué lindo", "Claro", "Perfecto", "Listo", "Con gusto") como máximo cada cuatro mensajes, nunca dos seguidas ni la misma dos veces. No repitas en el chat fórmulas como "te comparto", "te muestro", "cuéntame", "qué gusto", "me encanta", "va a quedar hermoso" (revisa "TUS ÚLTIMAS APERTURAS"). No elogies cada elección: reconócela con un hecho concreto o avanza. Nunca uses frases con "anotado".',
    '- Saluda ("Hola", "qué gusto", etc.) SOLO en tu primer mensaje de la conversación. En los siguientes mensajes ve directo al punto, sin volver a saludar aunque el cliente diga "hola" de nuevo.',
    '- Si el cliente escribe una palabra con una errata obvia pero reconocible (letras de más, de menos o cambiadas: "veliy" por "velas", "qeu" por "que"), entiende a qué se refiere y responde con normalidad; no le preguntes si quiso decir esa palabra ni se lo hagas notar.',
    ''
  );

  const steps = [
    'una frase corta y cálida que responda a lo que dijo el cliente (distinta a la del mensaje anterior)',
    'si das el resumen o el total, los datos en lista, un dato por línea empezando con un emoji relacionado',
    d.enabled && 'debajo, en una línea normal, la reserva de la fecha, solo cuando el cliente ya dio la fecha exacta (día y mes); si falta el día, no pongas esa línea y pregunta solo el día',
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
      '- Si el cliente dice que es para un bebé o niño/niña de un sexo (por ejemplo "es niño", "es nena", "para mi bebé varón") y todavía no dio colores, ofrécele el color típico (celeste o azul para niño, rosado para niña) como sugerencia y pregunta si lo prefiere así o con otro color; no lo anotes en personalization hasta que confirme. Si el cliente ya dio otro color, respeta ese y no menciones el típico.',
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
    add(sh.packingNote && `- Cómo viajan los pedidos: ${sh.packingNote} Si el cliente pregunta si llegan bien cuidados, si se pueden dañar o cómo los envían, respóndelo con esto, sin inventar más detalles y sin mencionar costos.`);
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
    `- order_items: ${models} del catálogo (nombre exacto) y quantity = cantidad del pedido actual según toda la conversación, ${ownUnits ? 'en la unidad de venta de ESE producto (cajas, tubos, metros)' : `cantidad de ${units}`}; lista vacía si no están claros. ${ownUnits ? 'quantity_in_pieces: true SOLO si esa cantidad son piezas sueltas y no unidades de venta (ejemplo: 18 paneles de un producto que va en caja de 10 → quantity 18 con quantity_in_pieces true); false en cualquier otro caso.' : 'quantity_in_pieces: siempre false.'}${!ownUnits && s.unitDetail && /\d/.test(s.unitDetail) ? ` Si el cliente da la cantidad en piezas (1 ${unit} = ${s.unitDetail}), conviértela a ${units} (ejemplo: ${Number(s.unitDetail.match(/\d+/)![0]) * 4} ${s.unitDetail.replace(/\d+/g, '').trim()} = 4 ${units}) y en reply habla siempre en ${units}.` : ''}${s.personalization ? ` En personalization escribe SOLO los detalles que el cliente pidió para ese ${model} (ejemplo: "bicolor rosado y blanco, nombre Emma"); anota lo que ya pidió aunque aún falten detalles (ejemplo: "bicolor" aunque no haya dicho los colores); nunca frases tuyas como "se puede personalizar"; cadena vacía si no pidió nada.` : ' personalization: cadena vacía.'}`,
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
    const cost = (c: number | null) => c === null ? 'costo por confirmar' : c === 0 ? 'sin costo' : c < 0 ? `descuento de ${money(-c)} por ${unit}` : `+${money(c)} por ${unit}`;
    const rules: PackagingChange[] = p.packaging.changes || [];
    const defaults = p.packaging.types.map(t => `${t.name} (${cost(t.changeCost)})`).join(', ');
    const changeRules = rules.length
      ? [
        `- Cambios de empaque, del empaque que trae el ${model} al que pide el cliente:`,
        ...rules.map(c => `  - ${c.from} → ${c.to}: ${!c.allowed ? 'NO se puede' : cost(c.cost)}${c.note ? `. ${c.note}` : ''}`),
        `- Un cambio que NO esté en esa lista cuesta según el empaque nuevo, por ${unit}: ${defaults}. Si el cambio pedido está en la lista, manda la lista.`,
        `- Si el cambio dice "NO se puede": explícale con amabilidad el motivo indicado, ofrécele los empaques a los que sí puede pasar desde el que trae ese ${model} (si no puede pasar a ninguno, dile que ese ${model} va tal cual, sin otro empaque, y no ofrezcas alternativas) y NO lo pongas en packaging (deja el del catálogo). No es una duda para la dueña: no escribas owner_question.`,
        `- Si el cambio trae una recomendación (por ejemplo que no conviene), díselo con esas palabras antes de confirmar; si aun así lo quiere, se puede y va en packaging.`,
        '- No menciones costos ni reglas de cambio si el cliente no pregunta por cambiar el empaque.'
      ]
      : [`- El cliente puede cambiar a otro empaque. Costo del cambio por ${unit}: ${defaults}. No menciones estos costos si no pregunta por cambiar el empaque.`];
    const bareType = p.packaging.types.find(t => t.bare);
    const bareRule = bareType
      ? [
        `- VENTA DE "${bareType.name.toUpperCase()}": si el cliente quiere el ${model} solo, sin empaque, sin nada, sin caja, sin tul o sin frasco, es una VENTA, no un problema: eso es un CAMBIO DE EMPAQUE a "${bareType.name}" y hay que cerrarla.`,
        `  1) Primero confirma con amabilidad que sí se puede y hazle UNA pregunta de sí o no para confirmar la presentación, con el ${model} que ya eligió. Ejemplos: "Claro que sí 🤍 ¿Entonces deseas la velita sin el frasco de vidrio?" o "Claro que sí 🤍 ¿Entonces la deseas solo la vela, sin el empaque? Así te queda en $28.00 la docena". Si la línea del catálogo de ese modelo trae su precio de "${bareType.name.toLowerCase()}", dilo en esa misma frase con esa cifra exacta; si dice "precio por confirmar", NO menciones ningún monto ni descuento. En este mensaje NO des el total todavía.`,
        `  2) Si responde que sí (o "ok", "dale", "perfecto"), pon "${bareType.name}" en packaging y sigue vendiendo hasta el total: cantidad, ${hasShipping ? 'ciudad, ' : ''}${d.enabled ? 'fecha y ' : ''}forma de pago. Sin volver a preguntar lo mismo. Si dice que no, deja el empaque original y sigue.`,
        `  3) Si el cambio tiene "costo por confirmar", después del sí sigue pidiendo esos datos y dile UNA sola vez, con estas palabras u otras parecidas: "el valor de esa presentación te lo confirma nuestro equipo enseguida" (escríbelo también en owner_question); no repitas esa frase en cada mensaje y nunca inventes el precio.`,
        `  4) No escribas "${bareType.name}" en personalization: ese campo es solo para colores, nombres y frases.`,
        `- Si hay dos ${models} posibles y no sabes cuál quiere, hazle UNA sola pregunta para saberlo y en esa misma pregunta dile que en cualquiera de los dos puede ir "${bareType.name}". Si ya respondió, nunca vuelvas a preguntar cuál ${model}: usa el que dijo o el que más encaje y avanza.`
      ]
      : [];
    add(
      'EMPAQUE (campo packaging de order_items):',
      `- Cada ${model} viene con su empaque, indicado en el catálogo como "empaque: …", y ese empaque ya está incluido en el precio.`,
      '- Tipos de empaque:',
      ...p.packaging.types.map(t => `  - ${t.name}: ${t.description}.`),
      `- Si preguntan por los empaques en general, describe TODOS los tipos, uno por línea, y pregunta qué ${model} le interesa. Si preguntan por el empaque de un ${model}, dile el de ESE ${model} según el catálogo en una frase; si no tiene empaque en el catálogo, no inventes: dile que confirmas cuál lleva, menciona los tipos (${p.packaging.types.map(t => t.name).join(', ')}), pregunta su preferencia y escribe la consulta en owner_question.`,
      ...changeRules,
      ...bareRule,

      `- Personalizar el ${model} (${s.personalizationExamples || 'colores, nombres, frases'}) no es lo mismo que personalizar el empaque. Un empaque solo se personaliza si su descripción lo dice; si preguntan por personalizar otro empaque, aclara que ese empaque no se personaliza (el ${model} sí) y menciona el que sí se puede.`,
      '- Si el cliente elige o pregunta por un empaque personalizable, pregúntale qué color le gustaría para cada parte que se personaliza. No ofrezcas una lista de colores: hay mucha variedad, así que deja que el cliente lo diga. Guarda los colores del empaque en personalization (ejemplo: "tul rosado con lazo blanco").',
      '- Si pide un cambio con "costo por confirmar", dile que lo verificas y le confirmas el valor (escríbelo en owner_question) y no des un total con ese cambio.',
      `- packaging: el empaque al que el cliente pidió cambiar ese ${model}, según toda la conversación (mantenlo en los mensajes siguientes); cadena vacía si se queda con el empaque del catálogo.`,
      ''
    );
  }

  const packagingList = packagingOn ? p.packaging.types.map(t => t.name).join(', ') : '';
  add(
    'FOTOS QUE ENVÍA EL CLIENTE (mensajes que empiezan con "[El cliente envió una foto]"):',
    '- La descripción trae lo que se ve: figura, colores, empaque, textos y piezas. Úsala con precisión y NUNCA inventes lo que no diga.',
    `- Si es una foto de referencia, confírmale en UNA frase lo que entendiste con esos detalles (por ejemplo "una conejita blanca de orejas largas con moño rosado, en bolsita rosa"). No la describas dos veces ni pidas lo que ya se ve: pregunta solo lo que falte.`,
    `- Si dice "Tipo: imagen del catálogo del propio negocio" o coincide CLARAMENTE (misma figura y textos) con un ${model} del catálogo, es ese ${model}: dile cuál es y avanza. Si solo se parece, NO lo trates como del catálogo: sigue el proceso de diseño fuera del catálogo.`,
    '- Los nombres, fechas y textos impresos en la foto son de EJEMPLO, no del cliente: no los repitas ni los anotes en personalization; si aplica, pregunta qué nombre o frase quiere.',
    '- Si dice "Tipo: comprobante de pago", sigue las reglas de pagos.',
    ''
  );

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
    '- Marca custom_design_requested = true en cuanto entiendas que quiere algo fuera del catálogo; en el resto de casos false y custom_design_summary = "".',
    '- Si el cliente envió una foto de referencia en la conversación, agrega "con foto de referencia" al resumen y anota en él lo que se ve en la foto (figura, colores, empaque, textos), para que la dueña entienda la idea sin abrir el chat.',
    '- Deja order_items VACÍO mientras sea un diseño fuera del catálogo (no está en el catálogo, no lo pongas).',
    `- Llena custom_design_summary desde el primer momento en que sepas de qué trata el diseño, con una sola línea que junte TODO lo que sepas hasta ahora (ejemplo: "${label} temático${s.personalization ? ' · colores' : ''}${packagingOn && p.packaging.types[0] ? ` · empaque ${p.packaging.types[0].name}` : ''} · nombre · 2 ${units}${hasShipping ? ' · ciudad' : ''}${d.enabled ? ` · ${d.eventLabel} DD/MM/YYYY` : ''}"), y actualízala en cada mensaje con lo nuevo que diga el cliente. Solo pon la cantidad cuando el cliente la haya dicho: la dueña usa ese dato para saber que ya se puede cotizar.`,
    '- El asistente sigue atendiendo con normalidad. Tras llenar custom_design_summary responde algo cálido y natural (por ejemplo: "Qué idea tan linda 🥰 En un momento te preparo la propuesta"), sin decir que consultas, que esperas a nadie ni prometer una hora.',
    '- Si el diseño ya está en DISEÑOS FUERA DEL CATÁLOGO YA ENVIADOS A LA DUEÑA, no vuelvas a preguntar sus datos: atiende lo que el cliente dice ahora. Si en la conversación ya se le dio un precio para ese diseño, puedes usar ese mismo precio y seguir con la forma de pago con normalidad.',
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
    hasGenderedProducts && `- Algunos ${models} del catálogo indican "niño" o "niña"; los que no lo indican sirven para ambos. Si el cliente pide ver ${models} de esa categoría y todavía no dijo si el bebé es niño o niña, PREGÚNTASELO PRIMERO y deja show_products vacío en ese mensaje; no envíes fotos todavía.`,
    hasGenderedProducts && `- Ya que sepas el sexo, en show_products incluye solo los ${models} marcados para ese sexo y los que sirven para ambos (no indican género); no incluyas los del sexo contrario salvo que el cliente pida verlos igual o pida un ${model} puntual por su nombre.`,
    hasGenderedProducts && `- Justo después de enviar esas fotos, en el mismo mensaje, menciona en una frase que también hay modelos del otro sexo y que se pueden personalizar para que queden perfectos para el suyo (por ejemplo, "también tengo modelos de niña, y se pueden personalizar en celeste para que quede ideal"). Dilo solo la primera vez que muestras esa categoría en la conversación, no lo repitas en los envíos siguientes.`,
    hasGenderedProducts && `- El género del catálogo es solo una guía de diseño, no una restricción: el cliente puede pedir cualquier ${model} aunque sea del sexo contrario y personalizarlo a su gusto (por ejemplo, un ${model} "de niño" en colores de niña). Nunca le digas que un ${model} "no se puede" por su género.`,
    `- No repitas fotos ya enviadas en esta conversación, salvo que el cliente pida volver a ver un ${model} concreto.`,
    `- Déjalo vacío cuando el cliente está dando detalles de su pedido (cantidad${d.enabled ? ', fecha' : ''}${s.personalization ? ', colores, nombres, personalización' : ''}), confirmando, preguntando precios o formas de pago, o conversando. En esos casos una foto no aporta y confunde.`,
    `- El sistema envía las fotos de 4 en 4 y pregunta solo si desea ver más ${models}: no hagas tú esa pregunta ni digas cuántas fotos envías.`,
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
  /** "niño", "niña" o vacío (neutro, sirve para ambos). Solo se usa si el negocio marca género (baby shower). */
  gender?: string | null;
}

/**
 * La unidad, medida y piezas propias de cada producto solo cuentan en los negocios que las usan (MegaMundo);
 * en los demás (VELAMIA vende todo por docena) se ignoran aunque el producto tenga esos datos guardados.
 */
export function scopeCatalog<T extends CatalogProduct>(catalog: T[], p: BusinessProfile): T[] {
  const stripUnits = !usesProductUnits(p);
  const stripGender = !usesGenderTagging(p);
  if (!stripUnits && !stripGender) return catalog;
  return catalog.map(c => ({
    ...c,
    ...(stripUnits ? { sale_unit: null, measure: null, pieces_per_unit: null } : {}),
    ...(stripGender ? { gender: null } : {})
  }));
}

/**
 * Lo que dice el catálogo de cada modelo sobre "solo la vela": su precio con ese cambio (calculado con la lista de
 * cambios, no deducido por la IA) o "precio por confirmar". Vacío si el negocio no tiene ese empaque o el cambio no se puede.
 */
export function bareOffer(product: { price: number; description?: string | null }, p: BusinessProfile): string {
  const bare = p.packaging.enabled ? p.packaging.types.find(t => t.bare) : undefined;
  const current = String(product.description || '').trim();
  if (!bare || !current || productKey(current) === productKey(bare.name)) return '';
  const rule = packagingChange(current, bare.name, p);
  if (!rule || !rule.allowed) return '';
  return rule.cost === null
    ? ` · ${bare.name.toLowerCase()}: precio por confirmar`
    : ` · ${bare.name.toLowerCase()}: $${Math.max(0, Number(product.price) + rule.cost).toFixed(2)}`;
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
        required: ['name', 'quantity', 'quantity_in_pieces', 'personalization', 'packaging'],
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number' },
          quantity_in_pieces: { type: 'boolean' },
          personalization: { type: 'string' },
          packaging: { type: 'string' }
        }
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

/**
 * ¿El cliente nombró ese producto? No hace falta el nombre completo: alcanza con las palabras que lo
 * distinguen ("el osito grande" para OSITO GRANDE CORAZON). Así, si pide una foto puntual, se le envía
 * aunque ya se la hayan mandado antes.
 */
export function namedByCustomer(productName: string, customerText: string): boolean {
  const words = normalizeWords(productName).split(/[^a-zñ0-9]+/).filter(w => w.length >= 4 && !NAME_FILLER.has(w));
  if (words.length === 0) return false;
  const said = words.filter(w => customerText.includes(w)).length;
  return said >= Math.min(2, words.length);
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

/**
 * Red de seguridad de dinero: si el sistema no pudo calcular el total (falta la ciudad, el costo de un cambio de empaque…),
 * la respuesta no puede traer un "Total" ni un "Anticipo" inventado por la IA. Se quitan esas líneas y la pregunta de pago.
 */
export function removeUnverifiedTotals(text: string): { text: string; removed: boolean } {
  const lines = text.split('\n');
  const kept = lines.filter(line => {
    const hasMoney = /\$\s?\d/.test(line);
    // "Total", "Anticipo"… con un monto. El precio por docena ("te queda en $28.00 la docena") no es un total.
    const totalLine = hasMoney && /\b(total|anticipo|abono|saldo)\b/i.test(line);
    const payQuestion = /\?/.test(line) && /transferencia|tarjeta|forma de pago/i.test(line);
    return !totalLine && !payQuestion;
  });
  const removed = kept.length !== lines.length;
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/**
 * "Solo la vela" es un empaque, no una personalización: si la IA lo escribe en la línea "Personalización:" del resumen,
 * esa línea sobra (el empaque ya tiene su propia línea o va en el texto).
 */
export function removeBareFromPersonalization(text: string, p: BusinessProfile): string {
  const bare = p.packaging.types.find(t => t.bare);
  if (!bare) return text;
  const bareWords = new Set([normalizeWords(bare.name), 'solo la vela', 'sin empaque', 'sin nada', 'sin caja', 'sin frasco']);
  return text
    .split('\n')
    .filter(line => {
      const match = line.match(/^\s*\P{L}*\*?Personalizaci[oó]n:?\*?:?\s*(.+)$/iu);
      if (!match) return true;
      const value = normalizeWords(match[1].replace(/[*_]/g, '')).replace(/[.\s]+$/, '').trim();
      return !bareWords.has(value);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Si el cliente cambió el empaque de su pedido y el resumen en lista no lo dice, se agrega su línea
 * ("📦 Empaque: Solo la vela"): el cliente debe ver exactamente qué se está cotizando.
 */
export function ensurePackagingLine(text: string, items: { packaging?: string; packagingChanged?: boolean }[]): string {
  const changed = items.filter(i => i.packagingChanged && i.packaging);
  if (changed.length !== 1) return text;
  const lines = text.split('\n');
  const quantityAt = lines.findIndex(l => /\*Cantidad:?\*/i.test(l));
  if (quantityAt < 0 || lines.some(l => /\*(Empaque|Presentaci[oó]n):?\*/i.test(l))) return text;
  lines.splice(quantityAt + 1, 0, `📦 *Empaque:* ${changed[0].packaging}`);
  return lines.join('\n');
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
/** La última pregunta de un mensaje (lo que va entre ¿ y ?), sin tildes ni mayúsculas. */
function lastQuestion(text: string): string {
  const found = text.match(/[^.!?¿\n]*\?/g);
  return found ? normalizeWords(found[found.length - 1]).replace(/[¿?]/g, '').trim() : '';
}

/** ¿Es la misma pregunta que la del mensaje anterior? Compara por palabras (4 primeras letras), sin importar el orden. */
export function sameQuestion(current: string, previous: string, productNames: string[] = []): boolean {
  const a = lastQuestion(current), b = lastQuestion(previous);
  if (!a || !b) return false;

  // Cualquier pregunta que pida elegir entre modelos ("¿Te cotizo el A o el B?", "¿Con cuál de las dos?", "¿Qué modelo prefieres?")
  // cuenta como la misma: si el cliente no eligió, preguntarlo otra vez con otras palabras es dar vueltas.
  const mentioned = (q: string) => productNames.map(normalizeWords).filter(n => q.includes(n)).length;
  const asksWhichModel = (q: string) => mentioned(q) >= 2
    || /\b(cual|cuales|que)\b[^?]*\b(modelo|modelos|velita|velitas|vela|velas|opcion|opciones|dos)\b/.test(q)
    || /\bprefieres (la|el|los|las|cual)\b/.test(q);
  if (asksWhichModel(a) && asksWhichModel(b)) return true;
  const stems = (q: string) => new Set(q.split(/[^a-zñ0-9]+/).filter(w => w.length >= 4).map(w => w.slice(0, 4)));
  const A = stems(a), B = stems(b);
  if (A.size === 0 || B.size === 0) return false;
  const shared = [...A].filter(x => B.has(x)).length;
  return shared / Math.min(A.size, B.size) >= 0.75 && shared >= 2;
}

// Palabras que aparecen en casi todos los nombres del catálogo: no sirven para reconocer un modelo.
const NAME_FILLER = new Set(['vela', 'velas', 'velita', 'velitas', 'para', 'con', 'del', 'los', 'las', 'base', 'medio']);

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
  catalog = scopeCatalog(catalog, p);
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

    // La IA avisa cuando contó piezas sueltas (18 paneles) en vez de unidades de venta (2 cajas).
    // Solo se aplica a productos con su propia unidad; los demás siguen con la corrección por texto.
    const ownPieces = Number(catalog.find(c => c.name === item?.name)?.pieces_per_unit) > 1;
    if (ownPieces && item?.quantity_in_pieces === true) {
      const units = Math.ceil(quantity / per);
      console.warn(`📦 Cantidad convertida: ${quantity} piezas = ${units} x ${catalog.find(c => c.name === item.name)?.sale_unit || 'unidad'}`);
      return { ...item, quantity: units, quantity_in_pieces: false };
    }

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
/** Quita de la personalización el empaque "solo el producto" ("solo la vela"), que va en el campo de empaque. */
function withoutBareWords(personalization: string, p: BusinessProfile): string {
  const bare = p.packaging.types.find(t => t.bare);
  if (!bare || !personalization) return personalization;
  const cleaned = personalization
    .split(/[,;·]| y /)
    .map(part => part.trim())
    .filter(part => part && !/^(solo|sólo)( la| el| las| los)? \p{L}+$|^sin (empaque|nada|caja|frasco)/iu.test(part) && normalizeWords(part) !== normalizeWords(bare.name))
    .join(', ');
  return cleaned;
}

export function computeOrderTotal(rawItems: any, rawPlace: any, catalog: CatalogProduct[], p: BusinessProfile = profile()) {
  const byName = new Map(catalog.map(c => [productKey(c.name), c]));
  const packagingOn = p.packaging.enabled && p.packaging.types.length > 0;
  // Empaque pedido cuyo costo de cambio aún no está definido: sin ese valor no hay total.
  let packagingUndefined = '';
  let packagingBlocked = '';
  let packagingBlockedNote = '';
  let packagingAdvice = null as { packaging: string; note: string } | null;
  let packagingAlternatives: string[] = [];
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map((i: any) => ({
      product: byName.get(productKey(i?.name)),
      quantity: Number(i?.quantity),
      personalization: withoutBareWords(cleanPersonalization(i?.personalization), p),
      packaging: i?.packaging
    }))
    .filter((i: any) => i.product && Number.isFinite(i.quantity) && i.quantity > 0)
    .map((i: any) => {
      // El empaque del catálogo va incluido en el precio; cambiarlo suma el costo del empaque elegido por unidad de venta.
      const included = packagingOn ? String(i.product.description || '').trim() : '';
      const wanted = packagingOn ? findPackaging(i.packaging, p) : undefined;
      const differs = !!wanted && productKey(wanted.name) !== productKey(included);
      const rule = differs ? packagingChange(included, wanted!.name, p) : undefined;
      // Un cambio que no se puede hacer (por peso, altura...) se ignora: se deja el empaque del catálogo.
      const blocked = !!rule && !rule.allowed;
      if (blocked) {
        packagingBlocked = wanted!.name;
        packagingBlockedNote = rule!.note;
        packagingAlternatives = p.packaging.types
          .filter(t => productKey(t.name) !== productKey(included) && packagingChange(included, t.name, p)?.allowed !== false)
          .map(t => t.name);
      }
      const changed = differs && !blocked;
      if (changed && rule!.note && !packagingAdvice) packagingAdvice = { packaging: wanted!.name, note: rule!.note };
      if (changed && rule!.cost === null) packagingUndefined = wanted!.name;
      const extra = changed ? rule!.cost || 0 : 0;
      return {
        name: i.product.name,
        price: Math.max(0, round2(Number(i.product.price) + extra)),
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
  return { items, place, shipping, missing, packagingUndefined, packagingBlocked, packagingBlockedNote, packagingAlternatives, packagingAdvice, subtotal, total, deposit: round2(total * depositPercent / 100) };
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

/**
 * Parte fija del prompt: persona, reglas, envíos y catálogo. Solo cambia si cambia la configuración
 * o el catálogo, así OpenAI la cobra como entrada en caché en vez de como entrada nueva.
 */
export function buildSystemPrompt(
  catalog: CatalogProduct[],
  customPrompt: string | undefined,
  p: BusinessProfile = profile()
) {
  catalog = scopeCatalog(catalog, p);
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
        // "caja de 10" ya dice cuántas trae: no repetirlo.
        const own = unitOf(i, p);
        const pieces = Number(i.pieces_per_unit) > 1 && !own.includes(String(i.pieces_per_unit))
          ? ` = ${i.pieces_per_unit} unidades` : '';
        const measure = i.measure ? ` · mide ${i.measure}` : '';
        const gender = i.gender === 'niño' || i.gender === 'niña' ? ` · ${i.gender}` : '';
        return `  - ${i.name}: $${Number(i.price).toFixed(2)} por ${own}${pieces}${measure}${gender}${p.packaging.enabled && i.description ? ` · empaque: ${i.description}` : ''}${bareOffer(i, p)}`;
      }).join('\n'))
      .join('\n\n');
  }

  // Sin la fecha la IA no puede saber si "el 18" ya pasó ni qué año corresponde.
  const today = new Date().toLocaleDateString('es-EC', {
    timeZone: p.business.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const summary = shippingRatesSummary(p);
  const shippingText = p.shipping.mode === 'ecuador_table'
    ? `TARIFAS DE ENVÍO DESDE ${p.business.city.toUpperCase()} (uso interno, todos los cantones de la provincia cuestan igual):\n${summary}\n\n`
    : p.shipping.mode === 'flat' ? `TARIFA DE ENVÍO (uso interno):\n${summary}\n\n` : '';

  const rules = buildCoreRules(p, catalog[0]?.name, catalog.some(c => c.sale_unit), catalog.some(c => c.gender === 'niño' || c.gender === 'niña'));
  return `${persona}\n\n${rules}\n\nFECHA DE HOY (${p.business.city || p.business.timezone}): ${today}\n\n${shippingText}${catalogText}`;
}

/**
 * Lo que cambia en cada mensaje. Va después del historial: si fuera antes, OpenAI dejaría de
 * reconocer como repetido todo lo que viene detrás y se cobraría el historial completo cada vez.
 */
/** Cómo empezaron tus últimos mensajes en este chat: para que la IA no repita las mismas aperturas ni fórmulas. */
export function recentOpeningsText(previousReplies: string[]): string {
  const last = previousReplies.filter(r => r && r.trim()).slice(-5);
  if (last.length === 0) return '';
  // Se recorta por caracteres completos: cortar un emoji por la mitad deja un carácter roto y OpenAI rechaza todo el mensaje.
  const openings = last.map(r => `"${[...r.replace(/\s+/g, ' ').replace(/[*_]/g, '').trim().split(/(?<=[.!?])\s|\n/)[0]].slice(0, 60).join('')}"`);
  return `\nTUS ÚLTIMAS APERTURAS EN ESTE CHAT (no las repitas ni abras con una exclamación de relleno parecida): ${openings.join(' | ')}`;
}

export function buildTurnContext(
  sentProducts: string[],
  bankDetailsSent: boolean,
  pendingProducts: string[],
  recentEmojis: string[],
  p: BusinessProfile = profile(),
  previousReplies: string[] = []
) {
  const models = p.sales.productLabelPlural.toLowerCase();
  const pendingText = pendingProducts.length > 0
    ? `\nFOTOS PENDIENTES POR MOSTRAR (ya se le preguntó si desea ver más ${models}): ${pendingProducts.join(', ')}`
    : '';
  const bankText = !p.payments.transferEnabled ? ''
    : bankDetailsSent
      ? '\nDATOS BANCARIOS: ya se enviaron en esta conversación; vuelve a marcar send_bank_details solo si el cliente los pide de nuevo.'
      : '\nDATOS BANCARIOS: aún no se han enviado en esta conversación.';
  return `FOTOS YA ENVIADAS EN ESTA CONVERSACIÓN: ${sentProducts.length ? sentProducts.join(', ') : 'ninguna'}`
    + pendingText + bankText
    + `\nEMOJIS USADOS RECIENTEMENTE: ${recentEmojis.length ? recentEmojis.join(' ') : 'ninguno'}`
    + recentOpeningsText(previousReplies);
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

  const previousReplies = history
    .filter(m => m.role === 'assistant' && !m.content.startsWith('[Foto') && !m.content.startsWith('🏦') && !m.content.startsWith(TEAM_MARK))
    .map(m => m.content);

  const baseMessages = [
    { role: 'system' as const, content: buildSystemPrompt(catalog, customPrompt, p) },
    ...history,
    {
      role: 'system' as const,
      content: buildTurnContext(sentProducts, bankDetailsSent, pendingProducts, recentEmojis, p, previousReplies)
        + `\nPREGUNTAS YA ENVIADAS A LA DUEÑA: ${pendingOwnerQuestions.length ? pendingOwnerQuestions.join(' | ') : 'ninguna'}`
        + (cardChosen && usesDeposit ? '\nFORMA DE PAGO ELEGIDA: tarjeta. Se paga el 100% del total: no menciones anticipo; la fecha se reserva "al recibir el pago".' : '')
        + `\nDISEÑOS FUERA DEL CATÁLOGO YA ENVIADOS A LA DUEÑA: ${pendingCustomDesigns.length ? pendingCustomDesigns.join(' | ') : 'ninguno'}`
        + `\nÚLTIMO PEDIDO DE ESTE CLIENTE: ${lastOrder || 'no tiene pedidos registrados'}`
        + (history.some(m => m.role === 'assistant' && m.content.startsWith(TEAM_MARK))
          ? `\nATENCIÓN DEL EQUIPO: los mensajes marcados "${TEAM_MARK.trim()}" los escribió una persona del equipo y el cliente los recibió como tuyos. Retoma la conversación desde ahí: usa lo que dijeron o prometieron, no repitas preguntas ni datos que ya se dieron y no los contradigas. Nunca escribas esa marca.`
          : '')
    },
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
      // Ningún texto con un carácter roto (un emoji partido al recortar) puede tumbar la respuesta entera.
      messages: (extraSystem ? [...baseMessages, { role: 'system' as const, content: extraSystem }] : baseMessages)
        .map(m => (typeof m.content === 'string' ? { ...m, content: withoutBrokenChars(m.content) } : m))
    });
    track('respuesta', model, response);
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
  // Si el cliente pidió un empaque que ese modelo no puede llevar y la respuesta no lo aclara, se rehace una vez.
  if (firstOrder.packagingBlocked) {
    const said = normalizeWords(reply());
    const explains = said.includes(normalizeWords(firstOrder.packagingBlocked)) && /no (se )?(puede|podemos|es posible|esta disponible|aplica|lleva|maneja)|solo (viene|va|lleva)/.test(said);
    if (!explains) {
      const others = firstOrder.packagingAlternatives.join(', ');
      corrections.push(`El cliente pidió cambiar al empaque ${firstOrder.packagingBlocked}, pero ese cambio no se puede hacer${firstOrder.packagingBlockedNote ? ` (${firstOrder.packagingBlockedNote})` : ''}: explícaselo con amabilidad${others ? `, ofrécele ${others}` : ', dile que ese modelo va tal cual, sin otro empaque, y no ofrezcas alternativas'} y no lo pongas como empaque del pedido. No escribas owner_question.`);
    }
  }
  // Un cambio con nota (por ejemplo "no se recomienda") se le explica a la clienta una vez, antes de confirmarlo.
  const advice = firstOrder.packagingAdvice;
  const adviceTold = (text: string) => {
    if (!advice) return true;
    const said = normalizeWords(text);
    const nameWords = new Set(normalizeWords(advice.packaging).split(/[^a-zñ]+/));
    const noteWords = normalizeWords(advice.note).split(/[^a-zñ]+/).filter(w => w.length >= 6 && !nameWords.has(w));
    const cue = /recomend|convien|luc(e|ir|ira)\b|aprecia|se ve\b|se ven\b|resalta|se nota|visible/.test(said);
    return cue || new Set(noteWords.filter(w => said.includes(w))).size >= 2;
  };
  if (advice && !adviceTold(reply()) && !adviceTold(history.filter(m => m.role === 'assistant').map(m => m.content).join(' '))) {
    corrections.push(`El cliente pidió cambiar al empaque ${advice.packaging}. Antes de seguir, díselo con amabilidad y tus palabras, dirigiéndote a él: "${advice.note}". Si aun así lo quiere, sigue con el pedido normalmente con ese empaque.`);
  }
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
      ...(p.packaging.enabled ? [...p.packaging.types.map(t => t.changeCost), ...(p.packaging.changes || []).map(c => c.cost)].filter((c): c is number => typeof c === 'number' && c !== 0).map(Math.abs) : [])
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

  // Nunca la misma pregunta dos veces seguidas: si el cliente no la respondió como se esperaba, se cambia de enfoque.
  const lastBotText = [...history].reverse().find(m => m.role === 'assistant' && !m.content.startsWith('[Foto'))?.content || '';
  const repeatsQuestion = () => sameQuestion(reply(), lastBotText, catalog.map(c => c.name));
  if (repeatsQuestion()) {
    corrections.push('Esa pregunta ya se la hiciste al cliente en tu mensaje anterior y no la respondió como esperabas: NO la repitas ni la reformules con otras palabras. Elige tú la opción que mejor encaje con lo que pidió, dile cuál elegiste y avanza con eso (cotiza), aclarando que puede cambiarla. Solo si es imposible avanzar, dile que lo consultas con el equipo y escríbelo en owner_question.');
  }

  // Muletillas: nunca la misma exclamación de relleno ni las mismas fórmulas que ya usó en este chat.
  let firstTics = ticsIn(reply(), previousReplies);
  // Una exclamación de relleno aislada ("Perfecto 🤍 …") se quita directamente, sin gastar otra llamada a la IA.
  if (firstTics.why) {
    const stripped = stripFillerOpening(reply());
    if (stripped !== reply()) {
      parsed.reply = stripped;
      firstTics = ticsIn(reply(), previousReplies);
    }
  }
  if (firstTics.violates) {
    console.warn(`🗣️ Muletilla detectada, se corrige: ${firstTics.why || firstTics.formulas.join(', ')}`);
    const partes: string[] = [];
    if (firstTics.why) partes.push(`Tu mensaje abre con una exclamación de relleno y ${firstTics.why}. Empieza directo con la respuesta o la información, sin "Qué lindo", "Claro", "Perfecto", "Listo" ni parecidos.`);
    if (firstTics.formulas.length > 0) partes.push(`Ya usaste en este chat estas fórmulas: ${firstTics.formulas.join(', ')}. Dilo con otras palabras o no lo digas.`);
    corrections.push(`Estás sonando repetitivo, como un robot. ${partes.join(' ')}`);
  }

  // Una foto ya enviada no se repite, salvo que la clienta la pida otra vez o nombre ese modelo.
  const sentKeys = new Set(sentProducts.map(productKey));
  const spoken = normalizeWords(customerWords);
  const asksAgain = /otra vez|de nuevo|volver a (ver|mandar|enviar)|nuevamente|repite/.test(spoken);
  const isRepeatedPhoto = (name: unknown) => {
    const key = productKey(name);
    const real = catalog.find(c => productKey(c.name) === key);
    return !!real && sentKeys.has(key) && !asksAgain && !namedByCustomer(real.name, spoken);
  };
  const requestedPhotos: unknown[] = Array.isArray(parsed.show_products) ? parsed.show_products : [];
  if (requestedPhotos.length > 0 && requestedPhotos.every(isRepeatedPhoto)) {
    corrections.push('Esas fotos ya se le enviaron a la clienta en esta conversación: no las repitas. Deja show_products vacío y, sin decir que le vas a mostrar modelos, responde a lo que dijo y haz una sola pregunta para avanzar (por ejemplo cuál de los modelos que ya vio le gustó).');
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

  if (advice && !adviceTold(reply()) && !adviceTold(history.filter(m => m.role === 'assistant').map(m => m.content).join(' '))) {
    console.warn('ℹ️ La IA no explicó la nota del cambio de empaque: se agrega tal como la escribió el negocio');
    parsed.reply = `${reply().trim()}\n\n${advice.note}`.trim();
  }

  // Si aun corregida repite la pregunta, el bot está atascado: la dueña recibe el aviso para que intervenga.
  const stuck = repeatsQuestion();
  if (stuck) console.warn('🔁 El asistente insiste en repetir la misma pregunta: se avisa a la dueña');

  // Última defensa: si aun corregida abre con la misma exclamación de relleno, se quita y empieza directo.
  if (ticsIn(reply(), previousReplies).opening) {
    console.warn('🗣️ Muletilla repetida al abrir: se quita de la respuesta');
    parsed.reply = stripFillerOpening(reply());
  }

  parsed.reply = reply().split(TEAM_MARK.trim()).join('').trim();

  const order = computeOrderTotal(normalizeQuantities(parsed.order_items, customerText, p, catalog), parsed.shipping_place, catalog, p);

  // Sin total calculado por el sistema, ningún total escrito por la IA es confiable.
  if (order.missing) {
    const safe = removeUnverifiedTotals(reply());
    if (safe.removed) {
      console.warn('💲 La IA escribió un total que el sistema no pudo calcular: se quita de la respuesta');
      const pendingCost = order.missing === 'packaging_cost';
      const alreadyTold = /confirm|verific|revis/i.test(safe.text);
      // Nunca se deja a la clienta sin respuesta: si al quitar el total no quedó nada, se manda un aviso seguro.
      const fallback = pendingCost
        ? 'Claro 🤍 el valor de esa presentación te lo confirma nuestro equipo enseguida.'
        : 'Enseguida te confirmo el valor 🤍';
      parsed.reply = safe.text
        ? (pendingCost && !alreadyTold ? `${safe.text}\n\nEl valor de esa presentación lo confirma nuestro equipo y te avisamos enseguida.` : safe.text)
        : fallback;
    }
  }

  parsed.reply = ensurePackagingLine(removeBareFromPersonalization(reply(), p), order.items);

  // Solo nombres que existen de verdad en el catálogo, sin duplicados.
  const byName = new Map(catalog.map(c => [productKey(c.name), c.name]));
  const showProducts = [...new Set(
    (Array.isArray(parsed.show_products) ? parsed.show_products : [])
      .filter((n: any) => !isRepeatedPhoto(n))
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
    owner_question: String(parsed.owner_question || '').trim() || (stuck ? 'El cliente parece atascado: el asistente repitió la misma pregunta. Revisa el chat y responde tú.' : ''),
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

    track('pedido', model, response);
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

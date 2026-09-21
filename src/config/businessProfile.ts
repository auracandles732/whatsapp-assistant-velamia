import { currentTenant } from '../services/tenant';
/**
 * Todo lo que cambia de un negocio a otro. Se guarda en business_config (clave business_profile)
 * y se edita desde el CRM; el código del bot, del CRM y de los seguimientos lo lee de aquí.
 */
export type ShippingMode = 'ecuador_table' | 'flat' | 'none';

export interface FollowUpStep {
  template: string;
  days: number;
}

export interface BusinessProfile {
  business: {
    name: string;
    /** Frase que completa "NOMBRE es …": "una marca de velas y recuerdos para eventos". */
    description: string;
    city: string;
    country: string;
    timezone: string;
    /** Emoji del pie de cada foto del catálogo. */
    productEmoji: string;
  };
  sales: {
    unitSingular: string;
    unitPlural: string;
    /** Aclaración de la unidad, por ejemplo "12 unidades". Vacío si no aplica. */
    unitDetail: string;
    /** Cómo se lee el precio en el pie de foto: "la docena", "el par", "c/u". */
    priceSuffix: string;
    productLabel: string;
    productLabelPlural: string;
    /** Qué se vende, para hablar del total: "velas", "zapatos", "productos". */
    goodsWord: string;
    /** Cuántas "piezas" = 1 unidad de venta. VELAMIA=12, individual=1, caja=100. */
    piecesPerUnit: number;
    personalization: boolean;
    personalizationExamples: string;
    /** Vacío = sin pedido mínimo. */
    minimumOrder: string;
    /** true = cada producto puede tener su propia unidad, medida y piezas (cajas, tubos, metros). false = todo se vende en la unidad del negocio. */
    perProductUnits: boolean;
    /** true = los productos pueden marcarse "niño", "niña" o neutro (baby shower); el asistente pregunta el sexo antes de mostrar fotos de esa categoría. */
    genderTagging: boolean;
  };
  payments: {
    transferEnabled: boolean;
    /** Porcentaje que se paga por transferencia para iniciar; 100 = pago completo. */
    depositPercent: number;
    cardEnabled: boolean;
    cardBrands: string;
  };
  dates: {
    /** Si el negocio trabaja con fecha de evento y fecha de entrega calculada. */
    enabled: boolean;
    eventLabel: string;
    deliveryDaysBeforeEvent: number;
    /** Aviso a la dueña cuando la entrega cae dentro de estos días. */
    urgentDays: number;
    alwaysAvailable: boolean;
  };
  shipping: {
    mode: ShippingMode;
    carrier: string;
    coverage: string;
    flatRate: number;
    /** Unidades que cubre la tarifa base; 0 = sin recargo por cantidad. */
    unitsIncludedInRate: number;
    extraCost: number;
    /** false = el total es un solo valor con el envío incluido. */
    showSeparately: boolean;
    pickupAvailable: boolean;
    pickupAddress: string;
    /** true = usar customRates en lugar de tarifa del carrier. */
    useCustomRates: boolean;
    /** Zonas personalizadas con costo por kg: [{zone: "Guayaquil", costPerKg: 0.5}]. */
    customRates: Array<{ zone: string; costPerKg: number }>;
    /** Pesos de productos para cálculo con customRates: {productId: peso_kg}. */
    productWeights: Record<string, number>;
    /** Cómo se empacan los envíos ("en caja de cartón protegida"). El asistente lo dice cuando preguntan si llegan bien cuidados. Vacío = no se menciona. */
    packingNote: string;
  };
  followUps: {
    enabled: boolean;
    steps: FollowUpStep[];
    /**
     * Seguimientos para chats que nunca recibieron una cotización. Las plantillas que hablan de "la cotización"
     * o del pedido no tienen sentido para quien solo saludó. Vacío = todos los chats usan "steps".
     */
    stepsNoQuote: FollowUpStep[];
    /**
     * true = solo se le escribe a quien mostró interés real: recibió una cotización o dijo algo más que el saludo
     * automático del anuncio. Quien solo saludó no recibe seguimientos.
     */
    requireInterest: boolean;
    fromHour: number;
    untilHour: number;
    optOutMessage: string;
  };
  alerts: {
    /** Plantilla de Meta para avisar a la dueña; vacío = solo texto libre. */
    template: string;
    /** Número que recibe los avisos, con código de país y sin "+" (593…). Vacío = el guardado en owner_phone. */
    ownerPhone: string;
  };
  style: {
    /** true = el bot se presenta como una persona del equipo y nunca dice que es un asistente virtual. */
    humanPersona: boolean;
    decorativeEmojis: string[];
  };
  branding: {
    primaryColor: string;
    logoUrl: string;
  };
  packaging: {
    /** Cada producto del catálogo tiene su empaque incluido en el precio; la clienta puede cambiarlo. */
    enabled: boolean;
    types: PackagingType[];
    /** Reglas de cambio entre empaques; lo que no esté aquí usa el costo general del empaque nuevo. */
    changes: PackagingChange[];
  };
  ai: {
    /** OpenAI API key específica del negocio. Si está vacía, usa la global (process.env.OPENAI_API_KEY). */
    openai_api_key?: string;
    /** Modelo OpenAI para este negocio; default = gpt-5.4-mini. */
    model?: string;
    /** Modelo para mirar las fotos del cliente; default = gpt-5.4 (distingue mejor figuras, colores y textos que el mini). */
    visionModel?: string;
  };
}

export interface PackagingType {
  name: string;
  description: string;
  /** Costo adicional por unidad de venta al cambiar a este empaque; null = aún no definido. */
  changeCost: number | null;
  /** true = "solo el producto, sin empaque": lo que el cliente pide con "sin empaque", "sin nada", "solo la vela". */
  bare?: boolean;
}

/** Cambio de un empaque a otro (del que trae el modelo al que pide la clienta): si se puede, cuánto cuesta y qué explicarle. */
export interface PackagingChange {
  from: string;
  to: string;
  /** Extra por unidad de venta; null = costo por confirmar. */
  cost: number | null;
  allowed: boolean;
  /** Motivo o recomendación que el asistente le explica a la clienta (por qué no se puede o por qué no conviene). */
  note: string;
}

export const VELAMIA_PROFILE: BusinessProfile = {
  business: {
    name: 'VELAMIA',
    description: 'una marca de velas y recuerdos para eventos',
    city: 'Guayaquil',
    country: 'Ecuador',
    timezone: 'America/Guayaquil',
    productEmoji: '🕯️'
  },
  sales: {
    unitSingular: 'docena',
    unitPlural: 'docenas',
    unitDetail: '12 unidades',
    priceSuffix: 'la docena',
    productLabel: 'Modelo',
    productLabelPlural: 'Modelos',
    goodsWord: 'velas',
    piecesPerUnit: 12,
    personalization: true,
    personalizationExamples: 'cambios de colores, nombres, frases y detalles',
    minimumOrder: '',
    perProductUnits: false,
    genderTagging: false
  },
  payments: { transferEnabled: true, depositPercent: 50, cardEnabled: true, cardBrands: 'Visa y Mastercard' },
  dates: { enabled: true, eventLabel: 'evento', deliveryDaysBeforeEvent: 3, urgentDays: 3, alwaysAvailable: true },
  shipping: {
    mode: 'ecuador_table',
    carrier: 'Servientrega',
    coverage: 'todo Ecuador',
    flatRate: 0,
    unitsIncludedInRate: 3,
    extraCost: 1,
    showSeparately: false,
    pickupAvailable: false,
    pickupAddress: '',
    useCustomRates: false,
    customRates: [],
    productWeights: {},
    packingNote: ''
  },
  followUps: {
    enabled: true,
    steps: [
      { template: 'velamia_seguimiento_01', days: 1 },
      { template: 'velamia_seguimiento_02', days: 2 },
      { template: 'velamia_seguimiento_03', days: 4 },
      { template: 'velamia_seguimiento_04_v2', days: 7 },
      { template: 'velamia_seguimiento_05_v2', days: 14 }
    ],
    stepsNoQuote: [],
    requireInterest: false,
    fromHour: 9,
    untilHour: 19,
    optOutMessage: 'Listo 🤍 No te enviaré más mensajes de seguimiento. Si más adelante necesitas velitas para tu evento, aquí estaré ✨'
  },
  alerts: { template: 'velamia_aviso_equipo', ownerPhone: '' },
  style: {
    humanPersona: true,
    decorativeEmojis: ['🤍', '✨', '💕', '🌸', '🎀', '🌷', '💫', '🥰', '😊', '🌼', '💖', '🫶', '😍', '🙌', '🌺', '💐']
  },
  branding: { primaryColor: '#B96B4F', logoUrl: '' },
  packaging: {
    enabled: true,
    types: [
      { name: 'Acetato', description: 'transparente, elegante y permite ver la vela', changeCost: null },
      { name: 'Tul', description: 'delicado, ligero y decorativo, va con lazo; se personaliza el color del tul y del lazo', changeCost: null },
      { name: 'Kraft', description: 'natural, minimalista y brinda mayor protección', changeCost: null },
      { name: 'Caja lazo personalizable', description: 'caja con lazo; se personaliza el color del lazo y la portada frontal y trasera', changeCost: null }
    ],
    changes: []
  },
  ai: {
    openai_api_key: process.env.OPENAI_API_KEY || '',
    model: 'gpt-5.4-mini'
  }
};

/** Punto de partida para un negocio nuevo: tienda que vende por unidad, sin fechas de evento. */
export const STORE_PROFILE: BusinessProfile = {
  business: {
    name: 'Mi Negocio',
    description: 'una tienda con envíos a domicilio',
    city: 'Guayaquil',
    country: 'Ecuador',
    timezone: 'America/Guayaquil',
    productEmoji: '🛍️'
  },
  sales: {
    unitSingular: 'unidad',
    unitPlural: 'unidades',
    unitDetail: '',
    priceSuffix: 'c/u',
    productLabel: 'Producto',
    productLabelPlural: 'Productos',
    goodsWord: 'productos',
    piecesPerUnit: 1,
    personalization: false,
    personalizationExamples: '',
    minimumOrder: '',
    perProductUnits: false,
    genderTagging: false
  },
  payments: { transferEnabled: true, depositPercent: 100, cardEnabled: false, cardBrands: '' },
  dates: { enabled: false, eventLabel: 'evento', deliveryDaysBeforeEvent: 0, urgentDays: 2, alwaysAvailable: false },
  shipping: {
    mode: 'ecuador_table',
    carrier: 'Servientrega',
    coverage: 'todo Ecuador',
    flatRate: 0,
    unitsIncludedInRate: 0,
    extraCost: 0,
    showSeparately: false,
    pickupAvailable: false,
    pickupAddress: '',
    useCustomRates: false,
    customRates: [],
    productWeights: {},
    packingNote: ''
  },
  followUps: {
    enabled: false,
    steps: [],
    stepsNoQuote: [],
    requireInterest: false,
    fromHour: 9,
    untilHour: 19,
    optOutMessage: 'Listo 😊 No te enviaré más mensajes de seguimiento. Si más adelante necesitas algo, aquí estaré.'
  },
  alerts: { template: '', ownerPhone: '' },
  style: {
    humanPersona: false,
    decorativeEmojis: ['😊', '✨', '🙌', '👌', '💫', '🎉', '👍', '🛍️', '📦', '🤩']
  },
  branding: { primaryColor: '#B96B4F', logoUrl: '' },
  packaging: { enabled: false, types: [], changes: [] },
  ai: {
    openai_api_key: process.env.OPENAI_API_KEY || '',
    model: 'gpt-5.4-mini'
  }
};

/** Mismo funcionamiento que VELAMIA, sin su nombre, plantillas de Meta ni logo. */
export const EVENTS_PROFILE: BusinessProfile = {
  ...VELAMIA_PROFILE,
  business: { ...VELAMIA_PROFILE.business, name: 'Mi Negocio', description: 'una tienda de detalles y recuerdos para eventos' },
  followUps: { ...VELAMIA_PROFILE.followUps, enabled: false, steps: [], optOutMessage: 'Listo 😊 No te enviaré más mensajes de seguimiento. Si más adelante necesitas algo para tu evento, aquí estaré ✨' },
  alerts: { template: '', ownerPhone: '' },
  branding: { ...VELAMIA_PROFILE.branding, logoUrl: '' }
};

export const PROFILE_PRESETS: Record<string, { label: string; profile: BusinessProfile }> = {
  eventos: { label: 'Detalles para eventos (por docena, con fecha de evento)', profile: EVENTS_PROFILE },
  tienda: { label: 'Tienda de productos (por unidad, sin fecha de evento)', profile: STORE_PROFILE }
};

const PROFILE_KEY = 'business_profile';

// ---------- Validación ----------

const text = (value: unknown, fallback: string, max = 300) =>
  typeof value === 'string' ? value.trim().slice(0, max) : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const num = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return value !== '' && value !== null && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Completa lo que falte con la base y corrige tipos y rangos: un perfil mal escrito nunca rompe el bot. */
export function normalizeProfile(raw: any, base: BusinessProfile = STORE_PROFILE): BusinessProfile {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = r.business || {}, s = r.sales || {}, p = r.payments || {}, d = r.dates || {};
  const sh = r.shipping || {}, f = r.followUps || {}, a = r.alerts || {}, st = r.style || {}, br = r.branding || {};
  const pk = r.packaging || {}, ai = r.ai || {};

  const timezone = text(b.timezone, base.business.timezone, 60);
  const mode = ['ecuador_table', 'flat', 'none'].includes(sh.mode) ? sh.mode : base.shipping.mode;
  const parseSteps = (raw: unknown, fallback: FollowUpStep[]): FollowUpStep[] => Array.isArray(raw)
    ? raw
      .map((x: any) => ({ template: text(x?.template, '', 120), days: num(x?.days, 0, 1, 90) }))
      .filter((x: FollowUpStep) => /^[a-z0-9_]+$/.test(x.template) && x.days > 0)
      .sort((x: FollowUpStep, y: FollowUpStep) => x.days - y.days)
      .slice(0, 10)
    : fallback;
  const steps = parseSteps(f.steps, base.followUps.steps);
  const stepsNoQuote = parseSteps(f.stepsNoQuote, base.followUps.stepsNoQuote || []);
  const emojis = Array.isArray(st.decorativeEmojis)
    ? st.decorativeEmojis.map((e: unknown) => text(e, '', 16)).filter(Boolean).slice(0, 40)
    : base.style.decorativeEmojis;
  const fromHour = num(f.fromHour, base.followUps.fromHour, 0, 23);

  return {
    business: {
      name: text(b.name, base.business.name, 80) || base.business.name,
      description: text(b.description, base.business.description),
      city: text(b.city, base.business.city, 80),
      country: text(b.country, base.business.country, 80),
      timezone: isValidTimezone(timezone) ? timezone : base.business.timezone,
      productEmoji: text(b.productEmoji, base.business.productEmoji, 16) || base.business.productEmoji
    },
    sales: {
      unitSingular: text(s.unitSingular, base.sales.unitSingular, 40) || base.sales.unitSingular,
      unitPlural: text(s.unitPlural, base.sales.unitPlural, 40) || base.sales.unitPlural,
      unitDetail: text(s.unitDetail, base.sales.unitDetail, 80),
      priceSuffix: text(s.priceSuffix, base.sales.priceSuffix, 40) || base.sales.priceSuffix,
      // El rótulo va entre *asteriscos* en los resúmenes: un asterisco dentro rompería esa lectura.
      productLabel: (text(s.productLabel, base.sales.productLabel, 40) || base.sales.productLabel).replace(/\*/g, ''),
      productLabelPlural: text(s.productLabelPlural, base.sales.productLabelPlural, 40) || base.sales.productLabelPlural,
      goodsWord: text(s.goodsWord, base.sales.goodsWord, 40) || base.sales.goodsWord,
      // Perfiles guardados antes de este campo: se deduce de la aclaración ('12 unidades' = 12), como siempre funcionó VELAMIA.
      piecesPerUnit: typeof s.piecesPerUnit === 'number' && s.piecesPerUnit > 0
        ? s.piecesPerUnit
        : Math.max(1, Number(String(s.unitDetail ?? base.sales.unitDetail).match(/\d+/)?.[0]) || 1),
      personalization: bool(s.personalization, base.sales.personalization),
      personalizationExamples: text(s.personalizationExamples, base.sales.personalizationExamples),
      minimumOrder: text(s.minimumOrder, base.sales.minimumOrder, 120),
      perProductUnits: bool(s.perProductUnits, base.sales.perProductUnits === true),
      genderTagging: bool(s.genderTagging, base.sales.genderTagging === true)
    },
    payments: {
      transferEnabled: bool(p.transferEnabled, base.payments.transferEnabled),
      depositPercent: Math.round(num(p.depositPercent, base.payments.depositPercent, 1, 100)),
      cardEnabled: bool(p.cardEnabled, base.payments.cardEnabled),
      cardBrands: text(p.cardBrands, base.payments.cardBrands, 80)
    },
    dates: {
      enabled: bool(d.enabled, base.dates.enabled),
      eventLabel: text(d.eventLabel, base.dates.eventLabel, 40) || base.dates.eventLabel,
      deliveryDaysBeforeEvent: Math.round(num(d.deliveryDaysBeforeEvent, base.dates.deliveryDaysBeforeEvent, 0, 60)),
      urgentDays: Math.round(num(d.urgentDays, base.dates.urgentDays, 0, 30)),
      alwaysAvailable: bool(d.alwaysAvailable, base.dates.alwaysAvailable)
    },
    shipping: {
      mode,
      carrier: text(sh.carrier, base.shipping.carrier, 80),
      coverage: text(sh.coverage, base.shipping.coverage, 120),
      flatRate: num(sh.flatRate, base.shipping.flatRate, 0, 10000),
      unitsIncludedInRate: Math.round(num(sh.unitsIncludedInRate, base.shipping.unitsIncludedInRate, 0, 10000)),
      extraCost: num(sh.extraCost, base.shipping.extraCost, 0, 10000),
      showSeparately: bool(sh.showSeparately, base.shipping.showSeparately),
      pickupAvailable: bool(sh.pickupAvailable, base.shipping.pickupAvailable),
      pickupAddress: text(sh.pickupAddress, base.shipping.pickupAddress),
      useCustomRates: bool(sh.useCustomRates, base.shipping.useCustomRates),
      customRates: Array.isArray(sh.customRates) ? sh.customRates.filter((r: any) => typeof r.zone === 'string' && typeof r.costPerKg === 'number') : base.shipping.customRates,
      productWeights: typeof sh.productWeights === 'object' && sh.productWeights !== null ? sh.productWeights : base.shipping.productWeights,
      packingNote: text(sh.packingNote, base.shipping.packingNote ?? '', 300)
    },
    followUps: {
      enabled: bool(f.enabled, base.followUps.enabled),
      steps,
      stepsNoQuote,
      requireInterest: bool(f.requireInterest, base.followUps.requireInterest === true),
      fromHour,
      untilHour: Math.max(fromHour + 1, num(f.untilHour, base.followUps.untilHour, 1, 24)),
      optOutMessage: text(f.optOutMessage, base.followUps.optOutMessage, 500) || base.followUps.optOutMessage
    },
    alerts: {
      template: /^[a-z0-9_]*$/.test(text(a.template, base.alerts.template, 120)) ? text(a.template, base.alerts.template, 120) : base.alerts.template,
      ownerPhone: (() => {
        const digits = text(a.ownerPhone, base.alerts.ownerPhone, 30).replace(/\D/g, '');
        return digits.length >= 8 && digits.length <= 15 ? digits : '';
      })()
    },
    style: {
      humanPersona: bool(st.humanPersona, base.style.humanPersona),
      decorativeEmojis: emojis.length ? emojis : base.style.decorativeEmojis
    },
    branding: {
      primaryColor: /^#[0-9a-f]{6}$/i.test(text(br.primaryColor, '', 7)) ? text(br.primaryColor, '', 7) : base.branding.primaryColor,
      logoUrl: /^https:\/\//.test(text(br.logoUrl, '', 500)) ? text(br.logoUrl, '', 500) : ''
    },
    packaging: {
      enabled: bool(pk.enabled, base.packaging.enabled),
      types: Array.isArray(pk.types)
        ? pk.types
          .map((t: any) => ({
            name: text(t?.name, '', 40),
            description: text(t?.description, '', 160),
            // Vacío = costo del cambio sin definir: el bot no da un total con ese cambio.
            changeCost: t?.changeCost === null || t?.changeCost === undefined || t?.changeCost === '' ? null : num(t.changeCost, 0, -1000, 10000),
            bare: t?.bare === true
          }))
          .filter((t: PackagingType) => t.name)
          .slice(0, 10)
        : base.packaging.types,
      changes: Array.isArray(pk.changes)
        ? pk.changes
          .map((c: any) => ({
            from: text(c?.from, '', 40),
            to: text(c?.to, '', 40),
            cost: c?.cost === null || c?.cost === undefined || c?.cost === '' ? null : num(c.cost, 0, -1000, 10000),
            allowed: c?.allowed !== false,
            note: text(c?.note, '', 240)
          }))
          .filter((c: PackagingChange) => c.from && c.to && c.from !== c.to)
          .slice(0, 60)
        : (base.packaging.changes || [])
    },
    ai: {
      openai_api_key: typeof ai.openai_api_key === 'string' && ai.openai_api_key.length > 0 ? ai.openai_api_key : (base.ai?.openai_api_key || ''),
      model: typeof ai.model === 'string' && ai.model.length > 0 ? ai.model : (base.ai?.model || 'gpt-5.4-mini'),
      visionModel: typeof ai.visionModel === 'string' && ai.visionModel.length > 0 ? ai.visionModel : base.ai?.visionModel
    }
  };
}

const packagingKey = (v: unknown) => String(v ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

export interface PackagingChangeRule {
  allowed: boolean;
  /** null = costo por confirmar. */
  cost: number | null;
  note: string;
  /** true = existe una regla escrita para este cambio; false = se usa el costo general del empaque nuevo. */
  specific: boolean;
}

/**
 * Qué pasa al pasar del empaque que trae un modelo al que pide la clienta. Si hay una regla para ese cambio manda;
 * si no, vale el costo general del empaque nuevo. Devuelve undefined si el empaque pedido no existe.
 */
export function packagingChange(fromName: unknown, toName: unknown, p: BusinessProfile = profile()): PackagingChangeRule | undefined {
  const to = findPackaging(toName, p);
  if (!to) return undefined;
  const from = findPackaging(fromName, p);
  const rule = from
    ? (p.packaging.changes || []).find(c => packagingKey(c.from) === packagingKey(from.name) && packagingKey(c.to) === packagingKey(to.name))
    : undefined;
  return rule
    ? { allowed: rule.allowed, cost: rule.cost, note: rule.note, specific: true }
    : { allowed: true, cost: to.changeCost, note: '', specific: false };
}

/**
 * Tipo de empaque por nombre, sin importar mayúsculas ni tildes. Si no hay coincidencia exacta acepta
 * variantes claras ("bolsa de tul" → Tul, "caja con lazo" → Caja lazo personalizable), pero solo cuando
 * una única opción encaja: ante la duda no adivina.
 */
export function findPackaging(name: unknown, p: BusinessProfile = profile()): PackagingType | undefined {
  const key = packagingKey;
  const wanted = key(name);
  if (!wanted) return undefined;

  const exact = p.packaging.types.find(t => key(t.name) === wanted);
  if (exact) return exact;

  const contained = p.packaging.types.filter(t => {
    const own = key(t.name);
    return own.length >= 3 && (` ${wanted} `.includes(` ${own} `) || ` ${own} `.includes(` ${wanted} `));
  });
  if (contained.length === 1) return contained[0];
  if (contained.length > 1) return undefined;

  // Comparten al menos dos palabras con el nombre del empaque ("caja con lazo" y "caja lazo personalizable").
  const words = (text: string) => new Set(text.split(' ').filter(w => w.length >= 3));
  const wantedWords = words(wanted);
  const scored = p.packaging.types
    .map(t => ({ type: t, shared: [...words(key(t.name))].filter(w => wantedWords.has(w)).length }))
    .filter(x => x.shared >= 2)
    .sort((a, b) => b.shared - a.shared);
  return scored.length === 1 || (scored.length > 1 && scored[0].shared > scored[1].shared) ? scored[0].type : undefined;
}

// ---------- Perfil en uso ----------

let current: BusinessProfile = STORE_PROFILE;

/**
 * Perfil vigente. Dentro de un negocio (multi-negocio) es el de ese negocio; fuera, el de VELAMIA,
 * que se carga al iniciar el servidor y se refresca al guardarlo desde el CRM.
 */
export function profile(): BusinessProfile {
  return currentTenant()?.profile ?? current;
}

/** El perfil tal como lo ve el CRM: sin la clave de OpenAI. */
export function publicProfile(p: BusinessProfile = profile()): BusinessProfile {
  return { ...p, ai: { model: p.ai?.model } };
}

// La base se importa al usarla: así el tarifario y las pruebas pueden usar el perfil sin conexión.
export async function loadBusinessProfile(): Promise<BusinessProfile> {
  const { getConfig } = await import('../services/supabase');
  const stored = await getConfig(PROFILE_KEY);
  if (!stored) {
    console.warn('⚠️ No hay perfil de negocio guardado: se usa la plantilla de tienda. Complétalo en CRM → Configuración.');
    current = STORE_PROFILE;
    return current;
  }
  try {
    current = normalizeProfile(JSON.parse(stored));
  } catch {
    console.error('❌ El perfil de negocio guardado no es JSON válido: se mantiene el anterior');
  }
  return current;
}

export async function saveBusinessProfile(raw: unknown): Promise<BusinessProfile> {
  const tenant = currentTenant();
  if (tenant) {
    // La clave de OpenAI de un negocio va cifrada en su propia columna, nunca dentro del perfil.
    const normalized = normalizeProfile(raw, tenant.profile);
    normalized.ai = { model: normalized.ai?.model || 'gpt-5.4-mini' };
    const { saveTenantProfile } = await import('../services/supabase');
    await saveTenantProfile(tenant.businessId, normalized);
    tenant.profile = normalized;
    return normalized;
  }

  const { setConfig } = await import('../services/supabase');
  // El CRM no recibe la clave de OpenAI: se conserva la que ya tenía el perfil.
  if (raw && typeof raw === 'object' && !(raw as any).ai?.openai_api_key) {
    raw = { ...(raw as any), ai: { ...(raw as any).ai, openai_api_key: current.ai?.openai_api_key } };
  }
  const normalized = normalizeProfile(raw, current);
  await setConfig(PROFILE_KEY, JSON.stringify(normalized));
  current = normalized;
  return current;
}

/** Solo para pruebas y scripts: usa un perfil sin leer la base. */
export function useProfile(p: BusinessProfile) {
  current = normalizeProfile(p, p);
}

// ---------- Textos derivados ----------

/** ¿Este negocio maneja unidad, medida y piezas propias en cada producto? Si no, esos datos no se usan aunque existan. */
export const usesProductUnits = (p: BusinessProfile = profile()) => p.sales.perProductUnits === true;

/** ¿Este negocio marca "niño"/"niña"/neutro en sus productos? Si no, ese dato no se usa aunque exista. */
export const usesGenderTagging = (p: BusinessProfile = profile()) => p.sales.genderTagging === true;

export const unitWord = (quantity: number, p: BusinessProfile = profile()) =>
  quantity === 1 ? p.sales.unitSingular : p.sales.unitPlural;

export const quantityText = (quantity: number, p: BusinessProfile = profile()) =>
  `${quantity} ${unitWord(quantity, p)}`;

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria del negocio. */
export function todayLocal(p: BusinessProfile = profile()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: p.business.timezone }).format(new Date());
}

export function hourLocal(date: Date, p: BusinessProfile = profile()): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: p.business.timezone, hour: 'numeric', hourCycle: 'h23' }).format(date));
}

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// ---------- Helpers Multi-Tenant ----------

/** Obtiene el factor de conversión de piezas a unidades de venta. VELAMIA=12, individual=1. */
export function getPiecesPerUnit(p: BusinessProfile = profile()): number {
  return p.sales.piecesPerUnit ?? 12;
}

/** Calcula el costo de envío custom (por peso) basado en zona. Usado por negocios con tarifa propia. */
export function calculateCustomShippingCost(
  zone: string,
  totalWeightKg: number,
  p: BusinessProfile = profile()
): number {
  if (!p.shipping.useCustomRates || p.shipping.customRates.length === 0) {
    return 0;
  }
  const rate = p.shipping.customRates.find(r => r.zone.toLowerCase() === zone.toLowerCase());
  return rate ? rate.costPerKg * totalWeightKg : 0;
}

/** Obtiene el peso de un producto para cálculos de envío custom. */
export function getProductWeight(productId: string, p: BusinessProfile = profile()): number {
  return p.shipping.productWeights?.[productId] ?? 0;
}

/**
 * Clave de OpenAI. Un negocio usa siempre la suya (cada uno paga su consumo, sin respaldo en la de VELAMIA);
 * VELAMIA usa la de su perfil o la global (process.env.OPENAI_API_KEY).
 */
export function getOpenAIKey(p: BusinessProfile = profile()): string {
  const tenant = currentTenant();
  if (tenant) {
    // Sin llave propia, la empresa usa la de la plataforma: el gasto de IA va incluido en su mensualidad
    // (cada llamada queda anotada por empresa en ai_usage).
    const key = (tenant.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();
    if (!key) throw new Error(`El negocio ${tenant.name} no tiene clave de OpenAI y la plataforma tampoco`);
    return key;
  }
  return (p.ai?.openai_api_key || process.env.OPENAI_API_KEY || '').trim();
}

/** Modelo para mirar las fotos del cliente. Default = gpt-5.4: el mini confundía una conejita con un pollito. */
export function getOpenAIVisionModel(p: BusinessProfile = profile()): string {
  return (p.ai?.visionModel || 'gpt-5.4').trim();
}

/** Obtiene el modelo OpenAI del negocio. Default = gpt-5.4-mini. */
export function getOpenAIModel(p: BusinessProfile = profile()): string {
  return (p.ai?.model || 'gpt-5.4-mini').trim();
}

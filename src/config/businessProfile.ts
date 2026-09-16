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
    personalization: boolean;
    personalizationExamples: string;
    /** Vacío = sin pedido mínimo. */
    minimumOrder: string;
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
  };
  followUps: {
    enabled: boolean;
    steps: FollowUpStep[];
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
  };
}

export interface PackagingType {
  name: string;
  description: string;
  /** Costo adicional por unidad de venta al cambiar a este empaque; null = aún no definido. */
  changeCost: number | null;
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
    personalization: true,
    personalizationExamples: 'cambios de colores, nombres, frases y detalles',
    minimumOrder: ''
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
    pickupAddress: ''
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
    ]
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
    personalization: false,
    personalizationExamples: '',
    minimumOrder: ''
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
    pickupAddress: ''
  },
  followUps: {
    enabled: false,
    steps: [],
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
  packaging: { enabled: false, types: [] }
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
  const pk = r.packaging || {};

  const timezone = text(b.timezone, base.business.timezone, 60);
  const mode = ['ecuador_table', 'flat', 'none'].includes(sh.mode) ? sh.mode : base.shipping.mode;
  const steps = Array.isArray(f.steps)
    ? f.steps
      .map((x: any) => ({ template: text(x?.template, '', 120), days: num(x?.days, 0, 1, 90) }))
      .filter((x: FollowUpStep) => /^[a-z0-9_]+$/.test(x.template) && x.days > 0)
      .sort((x: FollowUpStep, y: FollowUpStep) => x.days - y.days)
      .slice(0, 10)
    : base.followUps.steps;
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
      personalization: bool(s.personalization, base.sales.personalization),
      personalizationExamples: text(s.personalizationExamples, base.sales.personalizationExamples),
      minimumOrder: text(s.minimumOrder, base.sales.minimumOrder, 120)
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
      pickupAddress: text(sh.pickupAddress, base.shipping.pickupAddress)
    },
    followUps: {
      enabled: bool(f.enabled, base.followUps.enabled),
      steps,
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
            changeCost: t?.changeCost === null || t?.changeCost === undefined || t?.changeCost === '' ? null : num(t.changeCost, 0, 0, 10000)
          }))
          .filter((t: PackagingType) => t.name)
          .slice(0, 10)
        : base.packaging.types
    }
  };
}

/** Tipo de empaque por nombre, sin importar mayúsculas ni tildes. */
export function findPackaging(name: unknown, p: BusinessProfile = current): PackagingType | undefined {
  const key = (v: unknown) => String(v ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
  const wanted = key(name);
  return wanted ? p.packaging.types.find(t => key(t.name) === wanted) : undefined;
}

// ---------- Perfil en uso ----------

let current: BusinessProfile = STORE_PROFILE;

/** Perfil vigente. Se carga al iniciar el servidor y se refresca al guardarlo desde el CRM. */
export function profile(): BusinessProfile {
  return current;
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
  const { setConfig } = await import('../services/supabase');
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

export const unitWord = (quantity: number, p: BusinessProfile = current) =>
  quantity === 1 ? p.sales.unitSingular : p.sales.unitPlural;

export const quantityText = (quantity: number, p: BusinessProfile = current) =>
  `${quantity} ${unitWord(quantity, p)}`;

/** Fecha de hoy (AAAA-MM-DD) en la zona horaria del negocio. */
export function todayLocal(p: BusinessProfile = current): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: p.business.timezone }).format(new Date());
}

export function hourLocal(date: Date, p: BusinessProfile = current): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: p.business.timezone, hour: 'numeric', hourCycle: 'h23' }).format(date));
}

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

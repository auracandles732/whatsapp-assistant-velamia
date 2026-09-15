/**
 * Tarifario referencial interno de envíos (Servientrega), origen Guayaquil, paquetes hasta 2 kg.
 * Fuente: Tarifario_Envios_Ecuador_Hasta_2kg.pdf (24 provincias, 222 cantones).
 * No es una tabla oficial: pesos mayores, recargos o zonas especiales se confirman antes de cobrar.
 */

export const SHIPPING_ORIGIN = 'Guayaquil';
export const SHIPPING_MAX_WEIGHT_KG = 2;

interface ProvinceRates {
  rate: number;
  cantons: string[];
  /** Cantones con tarifa distinta a la de su provincia. */
  exceptions?: Record<string, number>;
}

export const SHIPPING_RATES: Record<string, ProvinceRates> = {
  'Azuay': { rate: 5.75, cantons: ['Camilo Ponce Enríquez', 'Chordeleg', 'Cuenca', 'El Pan', 'Girón', 'Guachapala', 'Gualaceo', 'Nabón', 'Oña', 'Paute', 'Pucará', 'San Fernando', 'Santa Isabel', 'Sevilla de Oro', 'Sígsig'] },
  'Bolívar': { rate: 5.75, cantons: ['Caluma', 'Chillanes', 'Chimbo', 'Echeandía', 'Guaranda', 'Las Naves', 'San Miguel'] },
  'Cañar': { rate: 5.75, cantons: ['Azogues', 'Biblián', 'Cañar', 'Déleg', 'El Tambo', 'La Troncal', 'Suscal'] },
  'Carchi': { rate: 6.30, cantons: ['Bolívar', 'Espejo', 'Mira', 'Montúfar', 'San Pedro de Huaca', 'Tulcán'] },
  'Chimborazo': { rate: 5.75, cantons: ['Alausí', 'Chambo', 'Chunchi', 'Colta', 'Cumandá', 'Guamote', 'Guano', 'Pallatanga', 'Penipe', 'Riobamba'] },
  'Cotopaxi': { rate: 5.75, cantons: ['La Maná', 'Latacunga', 'Pangua', 'Pujilí', 'Salcedo', 'Saquisilí', 'Sigchos'] },
  'El Oro': { rate: 5.25, cantons: ['Arenillas', 'Atahualpa', 'Balsas', 'Chilla', 'El Guabo', 'Huaquillas', 'Las Lajas', 'Machala', 'Marcabelí', 'Pasaje', 'Piñas', 'Portovelo', 'Santa Rosa', 'Zaruma'] },
  'Esmeraldas': { rate: 6.30, cantons: ['Atacames', 'Eloy Alfaro', 'Esmeraldas', 'Muisne', 'Quinindé', 'Rioverde', 'San Lorenzo'] },
  'Galápagos': { rate: 12.00, cantons: ['Isabela', 'San Cristóbal', 'Santa Cruz'] },
  'Guayas': {
    rate: 5.25,
    cantons: ['Alfredo Baquerizo Moreno', 'Balao', 'Balzar', 'Colimes', 'Coronel Marcelino Maridueña', 'Daule', 'Durán', 'El Empalme', 'El Triunfo', 'General Antonio Elizalde', 'Guayaquil', 'Isidro Ayora', 'Lomas de Sargentillo', 'Milagro', 'Naranjal', 'Naranjito', 'Nobol', 'Palestina', 'Pedro Carbo', 'Playas', 'Salitre', 'Samborondón', 'Santa Lucía', 'Simón Bolívar', 'Yaguachi'],
    exceptions: { 'Guayaquil': 3.00, 'Durán': 3.00 }
  },
  'Imbabura': { rate: 6.00, cantons: ['Antonio Ante', 'Cotacachi', 'Ibarra', 'Otavalo', 'Pimampiro', 'San Miguel de Urcuquí'] },
  'Loja': { rate: 6.30, cantons: ['Calvas', 'Catamayo', 'Celica', 'Chaguarpamba', 'Espíndola', 'Gonzanamá', 'Loja', 'Macará', 'Olmedo', 'Paltas', 'Pindal', 'Puyango', 'Quilanga', 'Saraguro', 'Sozoranga', 'Zapotillo'] },
  'Los Ríos': { rate: 5.25, cantons: ['Baba', 'Babahoyo', 'Buena Fe', 'Mocache', 'Montalvo', 'Palenque', 'Pueblo Viejo', 'Quevedo', 'Quinsaloma', 'Urdaneta', 'Valencia', 'Ventanas', 'Vinces'] },
  'Manabí': { rate: 5.50, cantons: ['24 de Mayo', 'Bolívar', 'Chone', 'El Carmen', 'Flavio Alfaro', 'Jama', 'Jaramijó', 'Jipijapa', 'Junín', 'Manta', 'Montecristi', 'Olmedo', 'Paján', 'Pedernales', 'Pichincha', 'Portoviejo', 'Puerto López', 'Rocafuerte', 'San Vicente', 'Santa Ana', 'Sucre', 'Tosagua'] },
  'Morona Santiago': { rate: 6.30, cantons: ['Gualaquiza', 'Huamboya', 'Limón Indanza', 'Logroño', 'Morona', 'Pablo Sexto', 'Palora', 'San Juan Bosco', 'Santiago', 'Sevilla Don Bosco', 'Sucúa', 'Taisha', 'Tiwintza'] },
  'Napo': { rate: 6.30, cantons: ['Archidona', 'Carlos Julio Arosemena Tola', 'El Chaco', 'Quijos', 'Tena'] },
  'Orellana': { rate: 6.30, cantons: ['Aguarico', 'Francisco de Orellana', 'La Joya de los Sachas', 'Loreto'] },
  'Pastaza': { rate: 6.30, cantons: ['Arajuno', 'Mera', 'Pastaza', 'Santa Clara'] },
  'Pichincha': { rate: 6.00, cantons: ['Cayambe', 'Mejía', 'Pedro Moncayo', 'Pedro Vicente Maldonado', 'Puerto Quito', 'Quito', 'Rumiñahui', 'San Miguel de los Bancos'] },
  'Santa Elena': { rate: 5.25, cantons: ['La Libertad', 'Salinas', 'Santa Elena'] },
  'Santo Domingo de los Tsáchilas': { rate: 5.50, cantons: ['La Concordia', 'Santo Domingo'] },
  'Sucumbíos': { rate: 6.30, cantons: ['Cascales', 'Cuyabeno', 'Gonzalo Pizarro', 'Lago Agrio', 'Putumayo', 'Shushufindi', 'Sucumbíos'] },
  'Tungurahua': { rate: 5.75, cantons: ['Ambato', 'Baños de Agua Santa', 'Cevallos', 'Mocha', 'Patate', 'Quero', 'San Pedro de Pelileo', 'Santiago de Píllaro', 'Tisaleo'] },
  'Zamora Chinchipe': { rate: 6.30, cantons: ['Centinela del Cóndor', 'Chinchipe', 'El Pangui', 'Nangaritza', 'Palanda', 'Paquisha', 'Yacuambi', 'Yantzaza', 'Zamora'] }
};

/** Nombres populares de ciudades que no coinciden con el nombre oficial del cantón. */
const ALIASES: Record<string, string> = {
  'jujan': 'Alfredo Baquerizo Moreno',
  'bucay': 'General Antonio Elizalde',
  'general villamil': 'Playas',
  'velasco ibarra': 'El Empalme',
  'puyo': 'Pastaza',
  'macas': 'Morona',
  'nueva loja': 'Lago Agrio',
  'coca': 'Francisco de Orellana',
  'el coca': 'Francisco de Orellana',
  'puerto francisco de orellana': 'Francisco de Orellana',
  'sangolqui': 'Rumiñahui',
  'machachi': 'Mejía',
  'tabacundo': 'Pedro Moncayo',
  'pelileo': 'San Pedro de Pelileo',
  'pillaro': 'Santiago de Píllaro',
  'banos': 'Baños de Agua Santa',
  'urcuqui': 'San Miguel de Urcuquí',
  'atuntaqui': 'Antonio Ante',
  'san gabriel': 'Montúfar',
  'cariamanga': 'Calvas',
  'catacocha': 'Paltas',
  'alamor': 'Puyango',
  'ponce enriquez': 'Camilo Ponce Enríquez',
  'santo domingo de los colorados': 'Santo Domingo',
  'puerto ayora': 'Santa Cruz',
  'puerto baquerizo moreno': 'San Cristóbal',
  'puerto villamil': 'Isabela',
  'montanita': 'Santa Elena',
  'ballenita': 'Santa Elena',
  'tonsupa': 'Atacames',
  'crucita': 'Portoviejo'
};

export function normalizePlace(value: string): string {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(canton|ciudad|provincia|de la provincia|del)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ShippingMatch {
  place: string;
  province: string;
  rate: number;
}

function cantonMatches(name: string): ShippingMatch[] {
  const target = normalizePlace(name);
  const matches: ShippingMatch[] = [];
  for (const [province, data] of Object.entries(SHIPPING_RATES)) {
    for (const canton of data.cantons) {
      if (normalizePlace(canton) === target) {
        matches.push({ place: canton, province, rate: data.exceptions?.[canton] ?? data.rate });
      }
    }
  }
  return matches;
}

function provinceByName(name: string): string | undefined {
  const target = normalizePlace(name);
  return Object.keys(SHIPPING_RATES).find(p => normalizePlace(p) === target);
}

/** Tarifa de un nombre suelto: cantones, nombres populares y provincia con ese mismo nombre. */
function matchesForName(name: string): ShippingMatch[] {
  const normalized = normalizePlace(name);
  const matches = cantonMatches(ALIASES[normalized] || name);

  // "Pichincha" es provincia ($6.00) y cantón de Manabí ($5.50): ambas lecturas cuentan.
  // Guayas no tiene tarifa única (Guayaquil y Durán son más baratos): se necesita la ciudad.
  const province = provinceByName(name);
  if (province && !SHIPPING_RATES[province].exceptions) {
    matches.push({ place: province, province, rate: SHIPPING_RATES[province].rate });
  } else if (province) {
    matches.push({ place: province, province, rate: NaN });
  }
  return matches;
}

/**
 * Busca la tarifa de un destino: cantón, nombre popular, provincia o "ciudad, provincia".
 * Devuelve null si no existe o si es ambiguo con tarifas distintas (por ejemplo "Olmedo"
 * existe en Loja y en Manabí): en ese caso hay que preguntar la provincia.
 */
export function findShippingRate(place: string): ShippingMatch | null {
  const raw = String(place || '').trim();
  if (!normalizePlace(raw)) return null;

  // "Quito, Pichincha", "Cuenca - Azuay" o "Olmedo (Manabí)": la provincia desambigua el cantón.
  const parts = raw.split(/,|\s-\s|\(|\)|\//).map(s => s.trim()).filter(Boolean);
  let cityPart = parts[0];
  let provincePart = parts.length > 1 ? provinceByName(parts[parts.length - 1]) : undefined;

  // "Quito Pichincha" sin separador: se reconoce la provincia al final, pero solo si el nombre
  // completo no es ya un destino ("Nueva Loja" es una ciudad, no "Nueva" en la provincia de Loja).
  if (!provincePart && parts.length === 1 && matchesForName(raw).length === 0) {
    const normalized = normalizePlace(raw);
    for (const p of Object.keys(SHIPPING_RATES)) {
      const suffix = ` ${normalizePlace(p)}`;
      if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
        cityPart = normalized.slice(0, -suffix.length);
        provincePart = p;
        break;
      }
    }
  }

  let matches = matchesForName(cityPart);
  if (provincePart) {
    const inProvince = matches.filter(m => m.province === provincePart);
    if (inProvince.length > 0) matches = inProvince;
  }

  if (matches.length === 0 || matches.some(m => Number.isNaN(m.rate))) return null;
  const rates = new Set(matches.map(m => m.rate));
  if (rates.size > 1) return null;
  // Mismo nombre y misma tarifa (p. ej. "Loja" cantón y provincia): la tarifa es inequívoca.
  return matches.find(m => m.place !== m.province) || matches[0];
}

// Hasta 3 docenas el paquete pesa ~2 kg (tarifa de la tabla); más docenas suman $1.00 al envío.
// Es interno: nunca se le menciona a la clienta.
export const DOZENS_INCLUDED_IN_BASE_RATE = 3;
export const EXTRA_SHIPPING_COST = 1.00;

/** Costo real del envío según destino y cantidad de docenas, o null si el destino no se reconoce. */
export function shippingCost(place: string, dozens: number): (ShippingMatch & { cost: number }) | null {
  const match = findShippingRate(place);
  if (!match) return null;
  const extra = dozens > DOZENS_INCLUDED_IN_BASE_RATE ? EXTRA_SHIPPING_COST : 0;
  return { ...match, cost: Math.round((match.rate + extra) * 100) / 100 };
}

/** Resumen compacto para las instrucciones de la IA. */
export function shippingRatesSummary(): string {
  const lines = Object.entries(SHIPPING_RATES).map(([province, data]) => {
    if (province === 'Guayas') return `- Guayas: Guayaquil y Durán $3.00 · resto de cantones $5.25`;
    return `- ${province}: $${data.rate.toFixed(2)}`;
  });
  return lines.join('\n');
}

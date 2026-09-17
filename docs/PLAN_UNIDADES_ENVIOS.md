# Plan: Unidades y Envíos Multi-Negocio

**Problema:** El sistema asume VELAMIA (docenas, Servientrega). Otro negocio puede vender por unidades individuales, cajas, o mixto, con envío diferente.

**Impacto:**
- `openai.ts`: `piecesPerDocena = 12` está hardcodeado
- `openai.ts`: `normalizeQuantities()` asume conversión 12:1
- `shippingRates.ts`: usa tarifa fija Servientrega + tabla Ecuador
- CRM: no hay forma de definir unidades ni envío custom

**Solución: 4 cambios**

## 1. Extender `businessProfile.ts`

```ts
sales: {
  // ... existente ...
  /** Cuántas "piezas" = 1 unidad de venta. VELAMIA=12, otro=1 (individual) o 100 (caja). */
  piecesPerUnit: number;
  /** "unidad" | "caja" | "docena" | "par" | "metro" */
  unitType: string;
}

shipping: {
  // ... existente ...
  /** true = usar tarifa customRates en lugar de Servientrega. */
  useCustomRates: boolean;
  /** Array de zonas: [{zone: "Guayaquil", costPerKg: 0.5}, ...]. Vacío si no aplica. */
  customRates: { zone: string; costPerKg: number }[];
}

products: {
  /** true = cada producto tiene peso definido en la BD. */
  weightsEnabled: boolean;
}
```

## 2. Nueva tabla o campo en `business_config`

Opción A (JSON en businessProfile): guardar weights dentro del perfil.
Opción B (tabla nueva): `product_weights(product_id, business_id, weight_kg)`.

**Recomendación:** Opción A por simplicidad. Agregar a `businessProfile.productWeights: Record<productId, number>` (peso en kg).

## 3. Refactor `openai.ts`

**Antes:**
```ts
const piecesPerDocena = 12;
```

**Después:**
```ts
function getPiecesPerUnit(profile: BusinessProfile): number {
  return profile.sales.piecesPerUnit || 12; // default VELAMIA
}
```

En `normalizeQuantities()`, usar `getPiecesPerUnit(profile)` en lugar de constante.

## 4. Refactor `shippingRates.ts`

**Antes:**
```ts
export function shippingCost(place: string, docenas: number): { place: string; cost: number } {
  // tarifa Servientrega hardcodeada
}
```

**Después:**
```ts
export function shippingCost(
  place: string,
  units: number,
  profile: BusinessProfile
): { place: string; cost: number } {
  if (profile.shipping.useCustomRates) {
    // calcular con customRates + weights
    const weight = calculateTotalWeight(units, profile);
    return customRatesCalculation(place, weight, profile);
  }
  // fallback: Servientrega (VELAMIA)
  return servientregaCalculation(place, units);
}

function calculateTotalWeight(units: number, profile: BusinessProfile): number {
  // Sumar peso de todos los productos en la orden
  // Requiere que la IA pase lista de productos
}
```

## 5. Integración en `messageController.ts` → `planTurn`

Pasar `profile` a la IA para que use `getPiecesPerUnit(profile)` y `shippingCost(..., profile)`.

Ya está parcialmente hecho (pasa `profile()` en algunas llamadas).

## Checklist de Implementación

- [ ] Extender `businessProfile.ts` (add `piecesPerUnit`, `customRates`, `productWeights`)
- [ ] Agregar campos a formulario CRM (Configuración → Unidades y Envío)
- [ ] Crear `getPiecesPerUnit()` y refactor `normalizeQuantities()`
- [ ] Refactor `shippingRates.ts` (agnóstico de carrier)
- [ ] Pasar `profile` a todos los cálculos
- [ ] Documentar en README cómo un negocio nuevo define sus unidades/envío
- [ ] Testing: simular negocio que vende "por unidad" (piecesPerUnit=1)

## Notas

- **Urgencia:** Media. VELAMIA funciona. Multi-tenant no debe desplogar sin esto.
- **Complejidad:** Media-Alta. Afecta lógica de cálculo en varios archivos.
- **Riesgo:** Bajo si se hace bien (VELAMIA tiene valores por defecto).

## Decisión de Aura

¿Implementar esto ANTES de testear multi-tenant, o crear negocio de prueba con misma estructura que VELAMIA (docenas + Servientrega)?

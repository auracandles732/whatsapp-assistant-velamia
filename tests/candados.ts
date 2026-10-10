/**
 * Candados: cada arreglo del CRM y del asistente queda sellado con una prueba, y la lista de pruebas selladas vive en
 * tests/candados.json. Si una prueba sellada desaparece o cambia de nombre, falla "candados.test.ts" y el arreglo viejo
 * no se pierde sin que nadie lo note. Quitar un candado solo con permiso de Aura (ver CLAUDE.md).
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export const TESTS_DIR = __dirname;
export const SEALS_FILE = join(__dirname, 'candados.json');

interface Seals { nota: string; pruebas: string[] }

/** Nombres de todas las pruebas de tests/*.test.ts: test('nombre', ...). */
export function currentTestNames(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(TESTS_DIR).filter(f => f.endsWith('.test.ts'))) {
    const source = readFileSync(join(TESTS_DIR, file), 'utf8');
    for (const match of source.matchAll(/^\s*test\(\s*'((?:[^'\\]|\\.)*)'/gm)) names.add(match[1].replace(/\\(.)/g, '$1'));
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'es'));
}

export function readSeals(): Seals {
  return JSON.parse(readFileSync(SEALS_FILE, 'utf8'));
}

/** Suma las pruebas nuevas a los candados. Nunca quita ninguno: eso se hace a mano y con permiso. */
export function sealNewTests(): { added: string[]; total: number } {
  const seals = readSeals();
  const sealed = new Set(seals.pruebas);
  const added = currentTestNames().filter(name => !sealed.has(name));
  const pruebas = [...sealed, ...added].sort((a, b) => a.localeCompare(b, 'es'));
  writeFileSync(SEALS_FILE, JSON.stringify({ ...seals, pruebas }, null, 2) + '\n');
  return { added, total: pruebas.length };
}

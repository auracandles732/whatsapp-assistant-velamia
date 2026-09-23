import { createHash } from 'crypto';

export interface BuiltCrm {
  html: string;
  js: string;
  version: string;
  /** No quedó ningún script escrito dentro de la página: se puede prohibir el código en línea y el evaluado. */
  strictScripts: boolean;
}

const BABEL_BLOCK = /<script type="text\/babel">([\s\S]*?)<\/script>/;
const BABEL_LIBRARY = /\s*<script[^>]*@babel\/standalone[^>]*><\/script>/;
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;

/**
 * El CRM se escribe con JSX en un solo archivo. Antes el navegador descargaba Babel (~3 MB) y traducía todo en cada
 * apertura; ahora se traduce una vez al arrancar el servidor: carga más rápido, sobre todo en el celular, y la página ya
 * no necesita permitir código en línea ni evaluado.
 */
export function buildCrm(html: string): BuiltCrm {
  const esbuild = require('esbuild');
  const match = html.match(BABEL_BLOCK);
  if (!match) throw new Error('No se encontró el código del CRM');

  const compiled: string = esbuild.transformSync(match[1], { loader: 'jsx', target: 'es2019', minify: true, legalComments: 'none' }).code;
  const inline = [...html.matchAll(INLINE_SCRIPT)].map(m => m[1]);
  const js = [compiled, ...inline].join('\n;\n');
  const version = createHash('sha256').update(js).digest('hex').slice(0, 12);

  const out = html
    .replace(BABEL_LIBRARY, () => '')
    .replace(BABEL_BLOCK, () => `<script src="app.js?v=${version}"></script>`)
    .replace(INLINE_SCRIPT, () => '');
  const strictScripts = !/<script(?![^>]*\bsrc=)[^>]*>/.test(out);
  return { html: out, js, version, strictScripts };
}

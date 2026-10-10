# Nexly / VELAMIA — asistente de WhatsApp y CRM

## 🔒 REGLA OBLIGATORIA (Aura, 10-oct-2026): todo arreglo queda sellado

> "Cuando se actualice o se corrija algún error de comportamiento o de infraestructura, o algo que tenga que ver con el
> CRM o con el asistente IA, esa mejora debe permanecer siempre y no desaparecer con el pasar del tiempo."

Esto se cumple en cada cambio, sin excepción:

1. **Antes de arreglar**, buscar en [docs/ARREGLOS.md](docs/ARREGLOS.md) si ese error ya se había corregido. Si volvió,
   hay que encontrar por qué se perdió el arreglo y cerrar ese camino, no solo repetirlo.
2. **Cada arreglo o mejora lleva su candado**: una prueba en `tests/*.test.ts` que falle si el error vuelve. Sin
   candado no se publica. Después de escribirla: `npm run sellar` (la suma a `tests/candados.json`).
3. **Anotar el arreglo** en `docs/ARREGLOS.md`: fecha, qué pasaba, qué se hizo y el nombre de su prueba.
4. **Antes de publicar** (`git push origin <rama>:main`): `npx tsc --noEmit` y `npm test` en verde. Nunca publicar con
   pruebas fallando. GitHub Actions ("Pruebas") las vuelve a correr en cada publicación.
5. **Prohibido sin permiso explícito de Aura**: borrar, renombrar, debilitar, saltar (`skip`/`todo`) una prueba sellada o
   quitar un nombre de `tests/candados.json`. Si un cambio nuevo choca con un candado, se corrige el cambio, no el candado.
6. **Comportamiento del asistente IA**: una regla que solo vive en el prompt se puede perder o la IA puede ignorarla.
   Siempre que se pueda, va también una guarda en código (validador, filtro, respuesta fija) con su prueba. Si solo puede
   ir en el prompt, la prueba verifica que la instrucción sigue estando en el prompt.
7. **Arreglos que viven en la configuración** (Supabase `business_config`): el valor correcto también va como valor por
   defecto en el código, con su prueba, para que guardar desde el CRM no lo revierta.
8. **Publicar solo desde una rama al día con `origin/main`** (traer main antes), nunca con `--force`. La rama `agente-ia`
   está atrasada desde el 24-sep-2026: no se publica sin traer antes todo main.

## Datos del proyecto

- Producción: Render (`https://whatsapp-assistant-velamia.onrender.com/crm/`), se publica con `git push origin <rama>:main`.
- CRM: un solo `dashboard/index.html` (JSX) que el servidor traduce al arrancar (`src/services/crmBuild.ts`).
- Siempre en español, respuestas cortas; Aura no es técnica.

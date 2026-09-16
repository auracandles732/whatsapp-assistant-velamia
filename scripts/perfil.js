// Carga un perfil de negocio en la base configurada en .env (o .env.local).
// Uso: npm run build && node scripts/perfil.js <velamia|eventos|tienda|archivo.json> [--ver]
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
for (const file of ['.env.local', '.env']) {
  if (fs.existsSync(path.join(root, file))) require('dotenv').config({ path: path.join(root, file) });
}

const bp = require(path.join(root, 'dist/config/businessProfile.js'));
const arg = process.argv[2];
const onlyShow = process.argv.includes('--ver');

(async () => {
  if (onlyShow || !arg) {
    const current = await bp.loadBusinessProfile();
    console.log(JSON.stringify(current, null, 2));
    if (!arg) console.log('\nUso: node scripts/perfil.js <velamia|eventos|tienda|archivo.json>');
    return;
  }

  const presets = { velamia: bp.VELAMIA_PROFILE, eventos: bp.EVENTS_PROFILE, tienda: bp.STORE_PROFILE };
  const raw = presets[arg] || JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
  const saved = await bp.saveBusinessProfile(raw);
  console.log(`✅ Perfil guardado: ${saved.business.name} (${saved.sales.unitPlural}, envío ${saved.shipping.mode})`);
})().catch(error => {
  console.error('❌', error.message);
  process.exit(1);
});

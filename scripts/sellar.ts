// Sella las pruebas nuevas en tests/candados.json (npm run sellar). Nunca quita candados.
import { sealNewTests } from '../tests/candados';

const { added, total } = sealNewTests();
console.log(added.length ? `🔒 ${added.length} prueba(s) sellada(s):\n- ${added.join('\n- ')}` : '🔒 No había pruebas nuevas para sellar.');
console.log(`Total de candados: ${total}`);

/**
 * Las pruebas no tocan la base ni internet, pero los servicios crean el cliente de Supabase
 * al cargarse. Con estos valores de mentira el import no falla y nada sale de la máquina.
 * Debe importarse antes que cualquier servicio.
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ||= 'clave-de-prueba';
process.env.OPENAI_API_KEY ||= 'sk-de-prueba';
process.env.BUSINESS_SECRETS_KEY ||= 'clave-de-prueba-para-cifrado';

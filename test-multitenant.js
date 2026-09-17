#!/usr/bin/env node
/**
 * Test: Multi-tenant detection, profile loading, units conversion
 * Crea negocio ficticio y simula webhook para verificar arquitectura
 */

const http = require('http');

const BASE_URL = 'http://localhost:3000';
const CRM_PASSWORD = process.env.CRM_PASSWORD || 'test';

// Paso 1: Login y obtener token de sesión
async function login() {
  console.log('🔐 Login al CRM...');
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.token) {
            console.log('✅ Token de sesión obtenido');
            resolve(result.token);
          } else {
            reject(new Error('No token: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ password: CRM_PASSWORD }));
    req.end();
  });
}

// Paso 2: Crear negocio TiendaUnidades
async function createBusiness(token) {
  console.log('\n📦 Creando negocio TiendaUnidades...');
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/businesses',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.id) {
            console.log(`✅ Negocio creado: ${result.name} (ID: ${result.id})`);
            console.log(`   Teléfono: ${result.meta_phone_number}`);
            console.log(`   piecesPerUnit: ${result.business_profile?.sales?.piecesPerUnit || 'default'}`);
            resolve(result);
          } else {
            reject(new Error('Fallo creando negocio: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({
      name: 'TiendaUnidades',
      phoneNumber: '+593999888777',
      accessToken: 'dummy_token_test_123'
    }));
    req.end();
  });
}

// Paso 3: Simular webhook (mensaje llegando)
async function simulateWebhook(phoneNumber) {
  console.log(`\n📩 Simulando webhook desde ${phoneNumber}...`);
  console.log('   Mensaje: "Hola, cuánto cuesta una vela?"');

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/webhook',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ Webhook recibido');
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            messages: [{
              from: phoneNumber.replace('+', ''),
              id: 'wamid.123',
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: 'Hola, cuánto cuesta una vela?' }
            }]
          }
        }]
      }]
    };

    req.write(JSON.stringify(payload));
    req.end();
  });
}

// Main
(async () => {
  try {
    const token = await login();
    const business = await createBusiness(token);
    await new Promise(r => setTimeout(r, 1000)); // Espera a que se procese
    await simulateWebhook(business.meta_phone_number);

    console.log('\n✅ Test completado. Revisar en CRM que TiendaUnidades aparezca con conversación.');
    console.log('   Nota: Si piecesPerUnit=1, la IA debe decir "1 vela" no "1 docena"');
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
})();

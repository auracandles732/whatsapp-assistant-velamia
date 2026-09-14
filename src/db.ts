import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_PATH || './data/velamia.db';

// Crear directorio si no existe
if (!fs.existsSync('./data')) {
  fs.mkdirSync('./data', { recursive: true });
}

const db = new sqlite3.Database(dbPath);

export function initDatabase() {
  db.serialize(() => {
    // Tabla: conversaciones
    db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL UNIQUE,
        customer_name TEXT,
        status TEXT DEFAULT 'active',
        last_message_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabla: mensajes
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);

    // Tabla: cotizaciones
    db.run(`
      CREATE TABLE IF NOT EXISTS quotations (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        customer_name TEXT,
        customer_phone TEXT,
        products TEXT NOT NULL,
        total_amount REAL,
        discount REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);

    // Tabla: pedidos
    db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        customer_name TEXT,
        customer_phone TEXT,
        customer_address TEXT,
        products TEXT NOT NULL,
        total_amount REAL,
        status TEXT DEFAULT 'pending',
        payment_method TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        delivery_date DATETIME,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);

    // Tabla: seguimientos
    db.run(`
      CREATE TABLE IF NOT EXISTS followups (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        order_id TEXT,
        type TEXT NOT NULL,
        message TEXT,
        scheduled_time DATETIME,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        FOREIGN KEY (order_id) REFERENCES orders(id)
      )
    `);

    // Tabla: catálogo de productos
    db.run(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        stock INTEGER DEFAULT 0,
        image_url TEXT,
        category TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabla: configuración
    db.run(`
      CREATE TABLE IF NOT EXISTS business_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, () => {
      db.run(`
        INSERT OR IGNORE INTO business_config (key, value) VALUES
        ('business_name', 'VELAMIA'),
        ('owner_phone', '593995448686'),
        ('currency', 'USD'),
        ('timezone', 'America/Guayaquil'),
        ('business_description', 'Velas artesanales premium para tu hogar')
      `);
      console.log('✅ Base de datos inicializada');
    });
  });
}

export function runQuery(sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function getQuery(sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export function allQuery(sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

export { db };

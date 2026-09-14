import { runQuery, getQuery, allQuery } from '../db';
import { v4 as uuidv4 } from 'uuid';

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  image_url?: string;
  category: string;
}

export async function addProduct(product: Omit<Product, 'id'>) {
  const id = uuidv4();
  await runQuery(
    `INSERT INTO products (id, name, description, price, stock, image_url, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, product.name, product.description, product.price, product.stock, product.image_url, product.category, new Date().toISOString()]
  );
  return id;
}

export async function getProductsByCategory(category: string): Promise<Product[]> {
  return await allQuery(
    'SELECT * FROM products WHERE category = ? ORDER BY name ASC',
    [category]
  );
}

export async function getProductByName(name: string): Promise<Product | undefined> {
  return await getQuery(
    'SELECT * FROM products WHERE name LIKE ?',
    [`%${name}%`]
  );
}

export async function getAllProducts(): Promise<Product[]> {
  return await allQuery('SELECT * FROM products ORDER BY category, name ASC');
}

export async function updateProductStock(productId: string, newStock: number) {
  await runQuery(
    'UPDATE products SET stock = ? WHERE id = ?',
    [newStock, productId]
  );
}

export async function getCatalogSummary(): Promise<{ category: string; count: number; totalValue: number }[]> {
  return await allQuery(`
    SELECT
      category,
      COUNT(*) as count,
      SUM(price * stock) as totalValue
    FROM products
    GROUP BY category
    ORDER BY category
  `);
}

// Productos de prueba
export async function seedSampleProducts() {
  const products = [
    {
      name: 'Vela Aromática Lavanda',
      description: 'Vela artesanal con aroma relajante de lavanda',
      price: 22.50,
      stock: 15,
      category: 'Aromáticas',
      image_url: 'https://via.placeholder.com/300?text=Lavanda'
    },
    {
      name: 'Vela Aromática Rosa',
      description: 'Vela artesanal con aroma floral de rosa',
      price: 22.50,
      stock: 12,
      category: 'Aromáticas',
      image_url: 'https://via.placeholder.com/300?text=Rosa'
    },
    {
      name: 'Vela Vainilla Premium',
      description: 'Vela de lujo con aroma vainilla pura',
      price: 28.00,
      stock: 8,
      category: 'Premium',
      image_url: 'https://via.placeholder.com/300?text=Vainilla'
    },
    {
      name: 'Vela Decorativa Blanca',
      description: 'Vela decorativa para hogares modernos',
      price: 15.00,
      stock: 25,
      category: 'Decorativas',
      image_url: 'https://via.placeholder.com/300?text=Blanca'
    },
    {
      name: 'Vela Inspiración Cítricos',
      description: 'Aroma fresco de naranja y limón',
      price: 20.00,
      stock: 10,
      category: 'Aromáticas',
      image_url: 'https://via.placeholder.com/300?text=Citricos'
    }
  ];

  for (const product of products) {
    try {
      await addProduct(product as any);
      console.log(`✅ Producto agregado: ${product.name}`);
    } catch (error: any) {
      if (!error.message.includes('UNIQUE constraint failed')) {
        console.error(`Error agregando ${product.name}:`, error.message);
      }
    }
  }
}

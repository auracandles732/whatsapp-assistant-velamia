import { v4 as uuidv4 } from 'uuid';
import { runQuery, getQuery, allQuery } from '../db';
import { sendTextMessage } from '../services/whatsapp';
import { sendButtonMessage } from '../services/whatsapp';
import { getAllProducts } from '../services/products';

interface QuotationItem {
  product_id: string;
  name: string;
  price: number;
  quantity: number;
}

export async function createQuotation(
  conversationId: string,
  phoneNumber: string,
  customerName: string,
  items: QuotationItem[]
) {
  try {
    const quotationId = uuidv4();
    const totalAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 3); // Válida 3 días

    const productsJson = JSON.stringify(items);

    await runQuery(
      `INSERT INTO quotations (id, conversation_id, customer_name, customer_phone, products, total_amount, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quotationId,
        conversationId,
        customerName || 'Cliente',
        phoneNumber,
        productsJson,
        totalAmount,
        'pending',
        new Date().toISOString(),
        expiresAt.toISOString()
      ]
    );

    // Enviar resumen al cliente
    const summary = items.map(item => `• ${item.name} x${item.quantity} = $${(item.price * item.quantity).toFixed(2)}`).join('\n');
    const quotationMessage = `✅ Cotización generada:\n\n${summary}\n\n💰 Total: $${totalAmount.toFixed(2)}\n\nID: ${quotationId.substring(0, 8).toUpperCase()}\nVálida hasta: ${expiresAt.toLocaleDateString('es-EC')}\n\n¿Te gustaría confirmar esta cotización?`;

    await sendTextMessage(phoneNumber, quotationMessage);

    return quotationId;
  } catch (error) {
    console.error('Error creando cotización:', error);
    throw error;
  }
}

export async function getQuotation(quotationId: string) {
  return await getQuery(
    'SELECT * FROM quotations WHERE id = ?',
    [quotationId]
  );
}

export async function getQuotationsByConversation(conversationId: string) {
  return await allQuery(
    'SELECT * FROM quotations WHERE conversation_id = ? ORDER BY created_at DESC',
    [conversationId]
  );
}

export async function acceptQuotation(quotationId: string) {
  await runQuery(
    'UPDATE quotations SET status = ? WHERE id = ?',
    ['accepted', quotationId]
  );
}

export async function expireQuotation(quotationId: string) {
  await runQuery(
    'UPDATE quotations SET status = ? WHERE id = ?',
    ['expired', quotationId]
  );
}

export async function sendQuotationReminder(quotationId: string) {
  try {
    const quotation = await getQuotation(quotationId);
    if (!quotation || quotation.status !== 'pending') return;

    const expiresAt = new Date(quotation.expires_at);
    const now = new Date();
    const hoursLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60));

    const reminderMessage = `⏰ Recordatorio: Tu cotización vence en ${hoursLeft} horas.\nID: ${quotationId.substring(0, 8).toUpperCase()}\nTotal: $${quotation.total_amount.toFixed(2)}\n\n¿Deseas proceder con la compra?`;

    await sendTextMessage(quotation.customer_phone, reminderMessage);
  } catch (error) {
    console.error('Error enviando recordatorio:', error);
  }
}

export async function generateProductMenuMessage(): Promise<string> {
  try {
    const products = await getAllProducts();
    const categories = [...new Set(products.map(p => p.category))];

    let message = `📦 Catálogo VELAMIA:\n\n`;

    for (const category of categories) {
      const categoryProducts = products.filter(p => p.category === category);
      message += `*${category}*\n`;
      for (const product of categoryProducts) {
        message += `• ${product.name} - $${product.price.toFixed(2)} (Stock: ${product.stock})\n`;
      }
      message += '\n';
    }

    message += `¿Cuál te interesa? Dime el nombre o número de producto.`;
    return message;
  } catch (error) {
    console.error('Error generando menú:', error);
    return 'Error al cargar el catálogo. Por favor, intenta de nuevo.';
  }
}

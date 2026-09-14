export interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: number;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'button' | 'location';
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename: string };
  audio?: { id: string; mime_type: string };
  video?: { id: string; mime_type: string; caption?: string };
  button?: { payload: string; text: string };
  location?: { latitude: number; longitude: number };
}

export interface Conversation {
  id: string;
  phone_number: string;
  customer_name?: string;
  status: 'active' | 'closed' | 'paused';
  last_message_time: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender: 'customer' | 'bot';
  type: 'text' | 'image' | 'document' | 'audio';
  content: string;
  timestamp: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  image_url?: string;
  category: string;
  created_at: string;
}

export interface Quotation {
  id: string;
  conversation_id: string;
  customer_name: string;
  customer_phone: string;
  products: string; // JSON stringified
  total_amount: number;
  discount: number;
  status: 'pending' | 'accepted' | 'expired';
  created_at: string;
  expires_at: string;
}

export interface Order {
  id: string;
  conversation_id: string;
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  products: string; // JSON stringified
  total_amount: number;
  status: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';
  payment_method: string;
  created_at: string;
  delivery_date?: string;
}

export interface FollowUp {
  id: string;
  conversation_id: string;
  order_id: string;
  type: 'reminder' | 'update' | 'feedback';
  message: string;
  scheduled_time: string;
  status: 'pending' | 'sent';
  created_at: string;
}

export interface BusinessConfig {
  key: string;
  value: string;
  updated_at: string;
}

export interface UserIntent {
  intent: 'greeting' | 'product_inquiry' | 'quotation' | 'order' | 'payment' | 'delivery_status' | 'complaint' | 'other';
  entities: string[];
  confidence: number;
}

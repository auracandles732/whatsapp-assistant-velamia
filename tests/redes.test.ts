/**
 * Instagram y Messenger: los chats se guardan como "ig:<id>" / "fb:<id>", sus mensajes se traducen a la forma de
 * WhatsApp y los comentarios se contestan en público (corto) y por privado (la venta).
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSocialAddress, contactLabel, splitForChannel, isSocialAddress } from '../src/services/metaChannels';
import { toWhatsAppShape, commentFromChange, commentKind, publicReplyText } from '../src/controllers/socialController';
import { sendTemplateMessage, sendAudioMessage } from '../src/services/whatsapp';

test('los contactos de Instagram y Messenger se reconocen y se muestran por su canal', () => {
  assert.deepEqual(parseSocialAddress('ig:17841400000000001'), { channel: 'instagram', userId: '17841400000000001' });
  assert.deepEqual(parseSocialAddress('fb:24000000000000'), { channel: 'messenger', userId: '24000000000000' });
  assert.equal(parseSocialAddress('593986673197'), null);
  assert.equal(isSocialAddress('593986673197'), false);
  assert.equal(contactLabel('ig:1'), 'Instagram');
  assert.equal(contactLabel('fb:1'), 'Messenger');
  assert.equal(contactLabel('593986673197'), '+593986673197');
});

test('un texto largo se parte entre párrafos sin pasar el límite del canal', () => {
  const texto = ['Primer párrafo con detalles.', 'Segundo párrafo '.repeat(40).trim(), 'Cierre ¿te lo preparo?'].join('\n\n');
  const partes = splitForChannel(texto, 300);
  assert.ok(partes.length >= 2);
  assert.ok(partes.every(p => p.length <= 300));
  assert.equal(partes.join('\n\n').replace(/\s+/g, ' '), texto.replace(/\s+/g, ' '));
  assert.deepEqual(splitForChannel('Hola', 1000), ['Hola']);
});

test('WhatsApp no manda plantillas ni notas de voz a Instagram o Messenger', async () => {
  await assert.rejects(sendTemplateMessage('ig:1', 'velamia_seguimiento_01', 'es'));
  await assert.rejects(sendAudioMessage('fb:1', 'https://x/a.ogg'), /solo se envían por WhatsApp/);
});

test('mensajes de Instagram y Messenger se traducen a la forma de WhatsApp', () => {
  const texto = toWhatsAppShape('instagram', { sender: { id: '111' }, recipient: { id: '999' }, timestamp: 1790000000000, message: { mid: 'm1', text: 'Hola, precio?' } });
  assert.equal(texto.from, 'ig:111');
  assert.equal(texto.id, 'm1');
  assert.equal(texto.type, 'text');
  assert.equal(texto.text.body, 'Hola, precio?');

  const foto = toWhatsAppShape('messenger', { sender: { id: '222' }, timestamp: 1, message: { mid: 'm2', attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }] } });
  assert.equal(foto.from, 'fb:222');
  assert.equal(foto.type, 'image');
  assert.equal(foto.image.link, 'https://cdn/x.jpg');

  const respuesta = toWhatsAppShape('messenger', { sender: { id: '222' }, timestamp: 1, message: { mid: 'm3', text: 'este', reply_to: { mid: 'm-foto' } } });
  assert.equal(respuesta.context.id, 'm-foto');

  const boton = toWhatsAppShape('messenger', { sender: { id: '222' }, timestamp: 1, postback: { title: 'Ver catálogo', payload: 'X', mid: 'p1' } });
  assert.equal(boton.text.body, 'Ver catálogo');

  const historia = toWhatsAppShape('instagram', { sender: { id: '111' }, timestamp: 1, message: { mid: 'm4', text: 'qué lindo', reply_to: { story: { id: 's1', url: 'https://x' } } } });
  assert.equal(historia.text.body, '[Respondió a tu historia] qué lindo');
});

test('ecos, mensajes borrados, reacciones y leídos no se contestan', () => {
  assert.equal(toWhatsAppShape('instagram', { sender: { id: '999' }, message: { mid: 'e1', text: 'hola', is_echo: true } }), null);
  assert.equal(toWhatsAppShape('instagram', { sender: { id: '1' }, message: { mid: 'd1', is_deleted: true } }), null);
  assert.equal(toWhatsAppShape('messenger', { sender: { id: '1' }, reaction: { reaction: 'love' } }), null);
  assert.equal(toWhatsAppShape('messenger', { sender: { id: '1' }, read: { watermark: 1 } }), null);
});

test('solo se atienden comentarios nuevos de otras personas, no respuestas ni los propios', () => {
  const fb = (value: any) => commentFromChange('messenger', { field: 'feed', value: { item: 'comment', verb: 'add', post_id: 'P_1', comment_id: 'C_1', parent_id: 'P_1', from: { id: 'u1', name: 'Ana Pérez' }, message: 'precio?', ...value } }, 'PAGE');
  assert.deepEqual(fb({}), { commentId: 'C_1', postId: 'P_1', text: 'precio?', fromId: 'u1', fromName: 'Ana Pérez' });
  assert.equal(fb({ parent_id: 'C_0' }), null);
  assert.equal(fb({ from: { id: 'PAGE', name: 'VELAMIA' } }), null);
  assert.equal(fb({ verb: 'edited' }), null);
  assert.equal(commentFromChange('messenger', { field: 'feed', value: { item: 'reaction', verb: 'add' } }, 'PAGE'), null);

  const ig = (value: any) => commentFromChange('instagram', { field: 'comments', value: { id: 'IC_1', text: 'info', from: { id: 'u2', username: 'ana.p' }, media: { id: 'M_1' }, ...value } }, 'IGACC');
  assert.deepEqual(ig({}), { commentId: 'IC_1', postId: 'M_1', text: 'info', fromId: 'u2', fromName: 'ana.p' });
  assert.equal(ig({ parent_id: 'IC_0' }), null);
  assert.equal(ig({ from: { id: 'IGACC', username: 'velamia' } }), null);
});

test('quien pregunta o muestra interés recibe mensaje privado; quien elogia, un gracias', () => {
  for (const t of ['Precio?', 'info', 'Cuánto la docena', 'Me interesa para mi boda', 'Hacen envíos a Quito', 'inbox porfa', 'Las quiero 😍']) {
    assert.equal(commentKind(t), 'lead', t);
  }
  for (const t of ['Hermosas 😍', 'Qué lindas', '❤️❤️']) assert.equal(commentKind(t), 'praise', t);
  for (const t of ['Estafa, nunca llegó mi pedido', 'Pésimo servicio']) assert.equal(commentKind(t), 'complaint', t);
  assert.equal(commentKind('@maria.jose @carla'), 'ignore');
  assert.equal(commentKind('   '), 'ignore');
});

test('la respuesta pública es corta, sin precios, y solo dice "te escribimos" si se pudo escribir', () => {
  const escrito = publicReplyText('lead', 'messenger', 'Ana Pérez', true);
  assert.ok(/Ana/.test(escrito));
  assert.ok(/interno|privado|mensajes/.test(escrito));
  assert.ok(!/\$/.test(escrito));
  assert.ok(/mensaje directo/.test(publicReplyText('lead', 'messenger', 'Ana Pérez', false)));
  assert.ok(!/ana\.p/.test(publicReplyText('lead', 'instagram', 'ana.p', true)));
  assert.ok(/[Gg]racias|lindo/.test(publicReplyText('praise', 'instagram', 'ana.p', false)));
});

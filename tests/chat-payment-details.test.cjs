const test = require('node:test');
const assert = require('node:assert/strict');

let helpers;
test.before(async () => {
  helpers = await import('../src/chatPaymentDetails.js');
});

test('extracts and normalizes a Spanish IBAN token', () => {
  const details = helpers.extractChatPaymentDetails(
    'Gracias. [[IBAN: ES30 1465 0100 9117 7435 7440]] [[FIN]]'
  );

  assert.deepEqual(details, {
    paymentMethod: 'iban',
    iban: 'ES3014650100911774357440',
    bizum: null,
  });
});

test('stores BIZUM from the first chat separately from the contact phone', () => {
  const details = helpers.extractChatPaymentDetails('Perfecto [[BIZUM: +34 612-345-678]]');
  const stored = helpers.applyChatPaymentDetails(
    { phone: '+34911222333', iban: 'ES3014650100911774357440' },
    details
  );

  assert.equal(stored.phone, '+34911222333');
  assert.equal(stored.bizum, '612345678');
  assert.equal(stored.paymentMethod, 'bizum');
  assert.equal('iban' in stored, false);
});

test('does not accept PHONE as Bizum in the first chat', () => {
  assert.deepEqual(
    helpers.extractChatPaymentDetails('[[PHONE:612345678]]'),
    { paymentMethod: null, iban: null, bizum: null }
  );
});

test('normalizes local, +34 and 0034 Bizum numbers to nine digits', () => {
  assert.equal(helpers.normalizeBizum('612 345 678'), '612345678');
  assert.equal(helpers.normalizeBizum('+34 612 345 678'), '612345678');
  assert.equal(helpers.normalizeBizum('0034 712-345-678'), '712345678');
  assert.equal(helpers.normalizeBizum('+34 512 345 678'), null);
  assert.equal(helpers.normalizeBizum('349 123 456'), null);
});

test('a new IBAN clears an earlier Bizum and becomes the selected method', () => {
  const details = helpers.extractChatPaymentDetails('[[IBAN:ES3014650100911774357440]]');
  const stored = helpers.applyChatPaymentDetails(
    { bizum: '612345678', paymentMethod: 'bizum', phone: '699888777' },
    details
  );

  assert.equal(stored.iban, 'ES3014650100911774357440');
  assert.equal(stored.paymentMethod, 'iban');
  assert.equal('bizum' in stored, false);
  assert.equal(stored.phone, '699888777');
});

test('rejects invalid payment tokens and uses the last valid method if both appear', () => {
  assert.deepEqual(
    helpers.extractChatPaymentDetails('[[IBAN:FR761234]] [[BIZUM:555123456]]'),
    { paymentMethod: null, iban: null, bizum: null }
  );
  assert.deepEqual(
    helpers.extractChatPaymentDetails('[[IBAN:ES3014650100911774357440]] [[BIZUM:612345678]]'),
    { paymentMethod: 'bizum', iban: null, bizum: '612345678' }
  );
});

test('uses the selected destination in persisted transfer descriptions', () => {
  assert.equal(
    helpers.getClientTransferDescription({ paymentMethod: 'bizum', bizum: '612345678' }),
    'Transferencia mediante Bizum'
  );
  assert.equal(
    helpers.getClientTransferDescription({ iban: 'ES3014650100911774357440' }),
    'Transferencia al IBAN'
  );
});

test('builds an unambiguous API view and keeps legacy IBAN records working', () => {
  assert.deepEqual(
    helpers.getClientPaymentDetails({ iban: 'ES3014650100911774357440' }),
    { paymentMethod: 'iban', iban: 'ES3014650100911774357440', bizum: '' }
  );
  assert.deepEqual(
    helpers.getClientPaymentDetails({ iban: 'old', bizum: '612345678', paymentMethod: 'bizum' }),
    { paymentMethod: 'bizum', iban: '', bizum: '612345678' }
  );
});

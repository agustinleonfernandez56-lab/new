const PAYMENT_TOKEN_RE = /\[\[(IBAN|BIZUM):\s*([^\]\r\n]{1,80})\]\]/gi;

export function normalizeSpanishIban(value) {
  const normalized = String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  return /^ES\d{22}$/.test(normalized) ? normalized : null;
}

export function normalizeBizum(value) {
  let normalized = String(value || '').replace(/[\s.()\-]/g, '');
  if (normalized.startsWith('+34')) normalized = normalized.slice(3);
  else if (normalized.startsWith('0034')) normalized = normalized.slice(4);
  return /^[67]\d{8}$/.test(normalized) ? normalized : null;
}

// In the first chat, [[BIZUM:...]] stores the phone linked to Bizum.
// The second/support chat deliberately keeps its own [[PHONE:...]] handling
// because there it represents the client's ordinary contact phone.
export function extractChatPaymentDetails(rawReply) {
  const source = String(rawReply || '');
  let selected = null;
  let match;

  PAYMENT_TOKEN_RE.lastIndex = 0;
  while ((match = PAYMENT_TOKEN_RE.exec(source)) !== null) {
    if (match[1].toUpperCase() === 'IBAN') {
      const iban = normalizeSpanishIban(match[2]);
      if (iban) selected = { paymentMethod: 'iban', iban, bizum: null };
    } else {
      const bizum = normalizeBizum(match[2]);
      if (bizum) selected = { paymentMethod: 'bizum', iban: null, bizum };
    }
  }

  return selected || { paymentMethod: null, iban: null, bizum: null };
}

export function extractUserPaymentDetails(message) {
  const source = String(message || '');
  const ibanMatch = source.match(/ES(?:[\s.,-]*\d){22}/i);
  const iban = ibanMatch ? normalizeSpanishIban(ibanMatch[0]) : null;
  if (iban) return { paymentMethod: 'iban', iban, bizum: null };

  const bizumMatches = source.match(/(?:\+34|0034)?[\s.()\-]*[67](?:[\s.()\-]*\d){8}/g) || [];
  for (const candidate of bizumMatches) {
    const bizum = normalizeBizum(candidate);
    if (bizum) return { paymentMethod: 'bizum', iban: null, bizum };
  }
  return { paymentMethod: null, iban: null, bizum: null };
}

export function applyChatPaymentDetails(submissionData, details) {
  const next = (submissionData && typeof submissionData === 'object' && !Array.isArray(submissionData))
    ? { ...submissionData }
    : {};

  if (details?.paymentMethod === 'iban' && details.iban) {
    next.iban = details.iban;
    delete next.bizum;
    next.paymentMethod = 'iban';
  } else if (details?.paymentMethod === 'bizum' && details.bizum) {
    next.bizum = details.bizum;
    delete next.iban;
    next.paymentMethod = 'bizum';
  }

  return next;
}

// Legacy records predate paymentMethod. Prefer their IBAN when both old fields
// happen to exist, while explicit new records always follow paymentMethod.
export function getClientPaymentDetails(submissionData) {
  const sub = (submissionData && typeof submissionData === 'object' && !Array.isArray(submissionData))
    ? submissionData
    : {};
  const iban = typeof sub.iban === 'string' ? sub.iban.trim() : '';
  const bizum = typeof sub.bizum === 'string' ? sub.bizum.trim() : '';

  if (sub.paymentMethod === 'bizum' && bizum) {
    return { paymentMethod: 'bizum', iban: '', bizum };
  }
  if (sub.paymentMethod === 'iban' && iban) {
    return { paymentMethod: 'iban', iban, bizum: '' };
  }
  if (iban) return { paymentMethod: 'iban', iban, bizum: '' };
  if (bizum) return { paymentMethod: 'bizum', iban: '', bizum };
  return { paymentMethod: '', iban: '', bizum: '' };
}

export function getClientTransferDescription(submissionData) {
  return getClientPaymentDetails(submissionData).paymentMethod === 'bizum'
    ? 'Transferencia mediante Bizum'
    : 'Transferencia al IBAN';
}

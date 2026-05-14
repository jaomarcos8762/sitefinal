import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const paymentStatusStore = new Map();
const checkoutCache = new Map();
const checkoutCacheTtlMs = Number(process.env.CHECKOUT_CACHE_TTL_MS || 10 * 60 * 1000);
const checkoutRateLimitStore = new Map();
const checkoutRateLimitWindowMs = Number(process.env.CHECKOUT_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const checkoutRateLimitMax = Number(process.env.CHECKOUT_RATE_LIMIT_MAX || 3);
const paymentTestMode = String(process.env.PAYMENT_TEST_MODE || '').toLowerCase();

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname, { index: false }));

function normalizeItemPrice(item) {
  const unitPrice = Number(item?.unitPrice || 0);
  if (unitPrice > 0) return unitPrice;

  const directPrice = Number(item?.price || 0);
  if (directPrice > 0) return directPrice;

  return Number(item?.oldPrice || 0);
}

function requirePaymentConfig() {
  const required = [
    'PAYMENT_API_URL',
    'PAYMENT_API_KEY',
    'IRONPAY_OFFER_HASH',
    'IRONPAY_PRODUCT_HASH',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    const error = new Error(`Configure no .env: ${missing.join(', ')}`);
    error.statusCode = 500;
    throw error;
  }
}

function getCheckoutCacheKey({ idempotencyKey, items, customer, delivery }) {
  if (typeof idempotencyKey === 'string' && idempotencyKey.trim()) {
    return `idempotency:${idempotencyKey.trim()}`;
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ items, customer, delivery }))
    .digest('hex');
}

function pruneCheckoutCache() {
  const now = Date.now();

  for (const [key, entry] of checkoutCache) {
    if (entry.expiresAt <= now) {
      checkoutCache.delete(key);
    }
  }
}

function pruneCheckoutRateLimit() {
  const now = Date.now();

  for (const [key, entry] of checkoutRateLimitStore) {
    if (entry.resetAt <= now) {
      checkoutRateLimitStore.delete(key);
    }
  }
}

function getClientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function assertCheckoutRateLimit(req) {
  pruneCheckoutRateLimit();

  const key = getClientIp(req);
  const now = Date.now();
  const entry = checkoutRateLimitStore.get(key) || {
    count: 0,
    resetAt: now + checkoutRateLimitWindowMs,
  };

  if (entry.count >= checkoutRateLimitMax) {
    const error = new Error('Muitas tentativas de gerar Pix. Aguarde alguns minutos e tente novamente.');
    error.statusCode = 429;
    throw error;
  }

  entry.count += 1;
  checkoutRateLimitStore.set(key, entry);
}

function hasValidCheckoutCustomer(customer = {}) {
  const name = String(customer.name || '').trim();
  const document = String(customer.document || customer.cpf || '').replace(/\D/g, '');
  const email = String(customer.email || '').trim();
  const phone = String(customer.phone_number || customer.phone || '').replace(/\D/g, '');

  return (
    name.length >= 3 &&
    (document.length === 11 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length >= 10)
  );
}

function createTestPixPayment({ items }) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const productTotal = normalizedItems.reduce((sum, item) => {
    return sum + normalizeItemPrice(item) * Number(item?.qty || item?.quantity || 1);
  }, 0);
  const totalInCents = Math.round(productTotal * 100);

  if (!normalizedItems.length || totalInCents <= 0) {
    const error = new Error('Dados invalidos para gerar PIX.');
    error.statusCode = 400;
    throw error;
  }

  const transactionHash = `test-paid-${crypto.randomUUID()}`;
  const pixCode = `PIX-TESTE-PAGO-${transactionHash}-R$${productTotal.toFixed(2)}`;
  const payment = {
    transactionHash,
    status: 'paid',
    amount: totalInCents,
    paymentMethod: 'pix',
    isPaid: true,
    pixCode,
    updatedAt: new Date().toISOString(),
  };

  paymentStatusStore.set(transactionHash, payment);

  return {
    transaction_hash: transactionHash,
    status: 'paid',
    pix_code: pixCode,
    pix_base64: null,
    charged_total: productTotal,
    isPaid: true,
    source: 'local-test',
  };
}

async function createPixPayment({ items, customer = {}, delivery = {} }) {
  if (paymentTestMode === 'paid') {
    return createTestPixPayment({ items, customer, delivery });
  }

  requirePaymentConfig();

  const normalizedItems = Array.isArray(items) ? items : [];
  const productTotal = normalizedItems.reduce((sum, item) => {
    return sum + normalizeItemPrice(item) * Number(item?.qty || item?.quantity || 1);
  }, 0);
  const totalInCents = Math.round(productTotal * 100);

  if (!normalizedItems.length || totalInCents <= 0) {
    const error = new Error('Dados inválidos para gerar PIX.');
    error.statusCode = 400;
    throw error;
  }

  const productHash = process.env.IRONPAY_PRODUCT_HASH;
  const pixEndpoint = process.env.PAYMENT_PIX_ENDPOINT || '/transactions';
  const expireInDays = Number(process.env.IRONPAY_EXPIRE_IN_DAYS || 1);

  const cart = normalizedItems.map((item) => ({
    product_hash: productHash,
    title: item.title || 'Contribuicao de seguranca',
    cover: item.image || null,
    price: Math.round(normalizeItemPrice(item) * 100),
    quantity: Number(item?.qty || item?.quantity || 1),
    operation_type: 1,
    tangible: false,
  }));

  const response = await axios.post(
    `${process.env.PAYMENT_API_URL}${pixEndpoint}`,
    {
      offer_hash: process.env.IRONPAY_OFFER_HASH,
      amount: totalInCents,
      payment_method: 'pix',
      expire_in_days: expireInDays,
      transaction_origin: 'api',
      postback_url: process.env.IRONPAY_POSTBACK_URL || undefined,
      cart,
      customer: {
        name: customer.name || 'Cliente BetBoom Premios',
        email: customer.email || process.env.DEFAULT_CUSTOMER_EMAIL || 'cliente@betboompremios.local',
        phone_number: customer.phone_number || customer.phone || process.env.DEFAULT_PHONE_NUMBER || '',
        document: customer.document || customer.cpf || '',
        street_name: customer.street_name || delivery.address || 'Rua Pix',
        number: customer.number || delivery.number || '100',
        complement: customer.complement || delivery.complement || '',
        neighborhood: customer.neighborhood || delivery.neighborhood || process.env.DEFAULT_NEIGHBORHOOD || 'Centro',
        city: customer.city || delivery.city || process.env.DEFAULT_CITY || 'Rio de Janeiro',
        state: customer.state || delivery.state || process.env.DEFAULT_STATE || 'RJ',
        zip_code: customer.zip_code || delivery.zip_code || delivery.cep || process.env.DEFAULT_ZIP_CODE || '20000000',
      },
      tracking: {
        src: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        utm_term: '',
        utm_content: '',
      },
    },
    {
      params: {
        api_token: process.env.PAYMENT_API_KEY,
      },
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      proxy: false,
    }
  );

  const pixCode =
    response.data.pix_code ||
    response.data.pixCode ||
    response.data.pix?.pix_qr_code ||
    response.data.pix_qr_code ||
    null;

  const transactionHash =
    response.data.transaction_hash ||
    response.data.transactionHash ||
    response.data.pix?.transaction_hash ||
    response.data.pix?.transactionHash ||
    null;

  if (!pixCode) {
    const error = new Error('A API respondeu sem código PIX.');
    error.statusCode = 502;
    throw error;
  }

  if (transactionHash) {
    paymentStatusStore.set(transactionHash, {
      transactionHash,
      status: response.data.status || 'pending',
      amount: response.data.amount || totalInCents,
      paymentMethod: 'pix',
      isPaid: response.data.status === 'paid',
      pixCode,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    transaction_hash: transactionHash,
    status: response.data.status || 'pending',
    pix_code: pixCode,
    pix_base64:
      response.data.qr_code ||
      response.data.pix_base64 ||
      response.data.qrCode ||
      response.data.pix?.qr_code_base64 ||
      null,
    charged_total: productTotal,
    source: 'ironpay',
  };
}

app.post('/api/payments/checkout', async (req, res) => {
  try {
    const { items, customer, delivery, idempotencyKey } = req.body;

    if (!items || !customer || !idempotencyKey || !hasValidCheckoutCustomer(customer)) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

    pruneCheckoutCache();

    const cacheKey = getCheckoutCacheKey({ idempotencyKey, items, customer, delivery });
    const cachedCheckout = checkoutCache.get(cacheKey);

    if (cachedCheckout) {
      const payment = await cachedCheckout.promise;
      return res.json(payment);
    }

    assertCheckoutRateLimit(req);

    const promise = createPixPayment({ items, customer, delivery });
    checkoutCache.set(cacheKey, {
      promise,
      expiresAt: Date.now() + checkoutCacheTtlMs,
    });

    const payment = await promise;
    return res.json(payment);
  } catch (error) {
    if (req.body) {
      checkoutCache.delete(
        getCheckoutCacheKey({
          idempotencyKey: req.body.idempotencyKey,
          items: req.body.items,
          customer: req.body.customer,
          delivery: req.body.delivery,
        })
      );
    }

    const providerError = error.response?.data || error.message;
    console.error('[payments] Falha ao gerar PIX:', providerError);

    return res.status(error.statusCode || error.response?.status || 500).json({
      error: typeof providerError === 'string' ? providerError : JSON.stringify(providerError),
    });
  }
});

app.get('/api/payments/status/:transactionHash', (req, res) => {
  const payment = paymentStatusStore.get(req.params.transactionHash);

  if (!payment) {
    return res.json({
      transactionHash: req.params.transactionHash,
      status: 'pending',
      isPaid: false,
    });
  }

  return res.json(payment);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, host, () => {
  console.log(`Servidor rodando em http://${host}:${port}`);
});

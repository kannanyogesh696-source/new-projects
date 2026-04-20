// ╔══════════════════════════════════════════════════════════════╗
// ║         SmartMart — Zoho Creator Backend                    ║
// ║         server.js  (Node.js + Express)                      ║
// ╚══════════════════════════════════════════════════════════════╝
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Token cache ──────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

// ── ENV ──────────────────────────────────────────────────────
const {
  ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN,
  ZOHO_OWNER, ZOHO_APP_NAME, ZOHO_AUTH_URL, ZOHO_API_BASE, PORT
} = process.env;

// ── Zoho Creator form & report link names ────────────────────
// (exact names from your .ds file)
const FORMS = {
  product  : 'Product_Form',
  purchase : 'PURCHASE_FORM',
  sales    : 'SALES_FORM',
  customer : 'CUSTOMER_FORM',
  supplier : 'SUPPLIER_FORM',
};
const REPORTS = {
  product  : 'All_Products',
  purchase : 'PURCHASE_FORM_Report',
  sales    : 'SALES_FORM_Report',
  customer : 'CUSTOMER_FORM_Report',
  supplier : 'All_Supplier_Forms',
};

// ════════════════════════════════════════════════════════════
//  GET ACCESS TOKEN (auto-refresh)
// ════════════════════════════════════════════════════════════
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;

  const params = new URLSearchParams({
    refresh_token : ZOHO_REFRESH_TOKEN,
    client_id     : ZOHO_CLIENT_ID,
    client_secret : ZOHO_CLIENT_SECRET,
    grant_type    : 'refresh_token',
  });

  const { data } = await axios.post(ZOHO_AUTH_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('🔑 Access token refreshed OK');
  return cachedToken;
}

// ════════════════════════════════════════════════════════════
//  ZOHO API CALL — with full debug logging
// ════════════════════════════════════════════════════════════
async function zohoAPI(method, urlPath, body = null) {
  const token = await getAccessToken();
  const url   = `${ZOHO_API_BASE}/${ZOHO_OWNER}/${ZOHO_APP_NAME}/${urlPath}`;

  console.log('\n──────────────────────────────────────────────');
  console.log(`📤 ${method} → ${url}`);
  if (body) console.log('   BODY:', JSON.stringify(body));

  const { status, data } = await axios({
    method, url,
    headers: {
      Authorization  : `Zoho-oauthtoken ${token}`,
      'Content-Type' : 'application/json',
    },
    data           : body || undefined,
    validateStatus : () => true,   // Don't auto-throw on 4xx/5xx
  });

  console.log(`📥 HTTP ${status}  |  Zoho code: ${data.code}`);
  console.log('   RESPONSE:', JSON.stringify(data));
  console.log('──────────────────────────────────────────────\n');

  // ── HTTP-level errors ─────────────────────────────────────
  if (status === 401) {
    cachedToken = null;
    throw new Error('Zoho token expired — restart server');
  }
  if (status >= 400) throw new Error(`HTTP ${status}: ${data.message || JSON.stringify(data)}`);

  // ── Zoho code-level errors ────────────────────────────────
  // 3000 = success  |  3001 = no records (GET ok)  |  rest = error
  if (data.code !== undefined && data.code !== 3000 && data.code !== 3001) {
    throw new Error(`Zoho [${data.code}]: ${data.message || JSON.stringify(data)}`);
  }

  return data;
}

// ════════════════════════════════════════════════════════════
//  ROUTE: Test connection
// ════════════════════════════════════════════════════════════
app.get('/api/token-check', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ ok: true, message: 'Connected!', token: token.slice(0, 20) + '...' });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  ROUTE: Debug — see exact Zoho response for product POST
//  GET /api/debug/product
// ════════════════════════════════════════════════════════════
app.get('/api/debug/product', async (req, res) => {
  try {
    const token   = await getAccessToken();
    const url     = `${ZOHO_API_BASE}/${ZOHO_OWNER}/${ZOHO_APP_NAME}/form/${FORMS.product}`;
    const testBody = {
      data: {
        Category       : 'Milk',
        Brand          : 'Amul',
        Product_Name   : 'TEST_DEBUG_DELETE_ME',
        Cost_Price     : 10,
        Selling_Price  : 15,
        Stock_Quantity : 5,
        Reorder_Level  : 2,
      }
    };
    console.log('\n🔍 DEBUG TEST — sending to Zoho:', JSON.stringify(testBody, null, 2));
    const { status, data } = await axios.post(url, testBody, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    res.json({ url, status, zohoResponse: data, bodyWeSent: testBody });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  GET /api/:entity  — fetch records from report
// ════════════════════════════════════════════════════════════
app.get('/api/:entity', async (req, res) => {
  const report = REPORTS[req.params.entity];
  if (!report) return res.status(404).json({ error: 'Unknown: ' + req.params.entity });
  try {
    const q    = req.query.q ? `?criteria=${encodeURIComponent(req.query.q)}` : '';
    const data = await zohoAPI('GET', `report/${report}${q}`);
    res.json({ ok: true, data: data.data || [], count: (data.data || []).length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  POST /api/:entity  — create record in form
// ════════════════════════════════════════════════════════════
app.post('/api/:entity', async (req, res) => {
  const form = FORMS[req.params.entity];
  if (!form) return res.status(404).json({ error: 'Unknown: ' + req.params.entity });

  console.log(`\n🟢 CREATE ${req.params.entity} in form: ${form}`);
  console.log('   Fields:', Object.keys(req.body).join(', '));
  console.log('   Values:', JSON.stringify(req.body));

  try {
    const data = await zohoAPI('POST', `form/${form}`, { data: req.body });
    console.log(`✅ Created! Record ID: ${data.data || '—'}`);
    res.json({ ok: true, data: data.data, message: 'Created in Zoho Creator' });
  } catch (e) {
    console.error(`❌ CREATE FAILED: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  PATCH /api/:entity/:id  — update record
// ════════════════════════════════════════════════════════════
app.patch('/api/:entity/:id', async (req, res) => {
  const report = REPORTS[req.params.entity];
  if (!report) return res.status(404).json({ error: 'Unknown: ' + req.params.entity });
  try {
    const data = await zohoAPI('PATCH', `report/${report}/${req.params.id}`, { data: req.body });
    res.json({ ok: true, data: data.data, message: 'Updated in Zoho Creator' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  DELETE /api/:entity/:id  — delete record
// ════════════════════════════════════════════════════════════
app.delete('/api/:entity/:id', async (req, res) => {
  const report = REPORTS[req.params.entity];
  if (!report) return res.status(404).json({ error: 'Unknown: ' + req.params.entity });
  try {
    const data = await zohoAPI('DELETE', `report/${report}/${req.params.id}`);
    res.json({ ok: true, message: 'Deleted from Zoho Creator', data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  GET /api-stats/dashboard  — all counts in one call
// ════════════════════════════════════════════════════════════
app.get('/api-stats/dashboard', async (req, res) => {
  try {
    const [p, c, s, sl] = await Promise.all([
      zohoAPI('GET', `report/${REPORTS.product}`),
      zohoAPI('GET', `report/${REPORTS.customer}`),
      zohoAPI('GET', `report/${REPORTS.supplier}`),
      zohoAPI('GET', `report/${REPORTS.sales}`),
    ]);
    res.json({
      ok        : true,
      products  : p.data  || [],
      customers : c.data  || [],
      suppliers : s.data  || [],
      sales     : sl.data || [],
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  GET /api/record/:entity/:id  — single record
// ════════════════════════════════════════════════════════════
app.get('/api/record/:entity/:id', async (req, res) => {
  const report = REPORTS[req.params.entity];
  if (!report) return res.status(404).json({ error: 'Unknown: ' + req.params.entity });
  try {
    const data = await zohoAPI('GET', `report/${report}/${req.params.id}`);
    res.json({ ok: true, data: data.data || data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Serve SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────
const port = PORT || 3000;
app.listen(port, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║  🛒  SmartMart Server Started!             ║');
  console.log(`║  👉  http://localhost:${port}                ║`);
  console.log(`║  🔍  Debug: http://localhost:${port}/api/debug/product  ║`);
  console.log(`║  📦  App: ${(ZOHO_APP_NAME||'?').padEnd(30)}  ║`);
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');
  console.log('💡 Product add பண்ணும்போது terminal-ல் full Zoho response காண்பிக்கும்');
  console.log('');
});

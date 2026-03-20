// ─────────────────────────────────────────────────────────────────
// Load environment variables from .env file
// Must be the very first line before anything else
// ─────────────────────────────────────────────────────────────────
require('dotenv').config();

const express     = require('express');
const OAuthClient = require('intuit-oauth');
const QuickBooks  = require('node-quickbooks');
const path        = require('path');
const crypto      = require('crypto');
const fs          = require('fs');

const app = express();

// ─────────────────────────────────────────────────────────────────
// Persistent data directory
// On Render with a persistent disk mounted at /data, files survive deploys.
// Locally (no /data mount), falls back to current directory.
// ─────────────────────────────────────────────────────────────────
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;

// Parse JSON request bodies — 25mb limit for fax file uploads
app.use(express.json({ limit: '25mb' }));

// Serve the ARK dashboard at the root URL
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/ark-dashboard.html');
});

// ─────────────────────────────────────────────────────────────────
// Public website pages (privacy policy, terms, about, contact)
// These are needed for 10DLC campaign verification and brand presence
// ─────────────────────────────────────────────────────────────────
app.get('/about', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});
app.get('/privacy-policy', (req, res) => {
  res.sendFile(__dirname + '/public/privacy-policy.html');
});
app.get('/terms', (req, res) => {
  res.sendFile(__dirname + '/public/terms.html');
});
app.get('/opt-in', (req, res) => {
  res.sendFile(__dirname + '/public/opt-in.html');
});
app.get('/contact', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ─────────────────────────────────────────────────────────────────
// CORS — Cross-Origin Resource Sharing
// Your ARK dashboard (running at file:// or localhost) is a 
// different "origin" than your server (localhost:3000).
// Without this, the browser blocks requests between them.
// ─────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  // OPTIONS is a "preflight" request browsers send before POST
  // We just say OK and stop processing it
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────────────────────────────
// OAuth Client Setup
// This handles the entire OAuth 2.0 flow with Intuit
// ─────────────────────────────────────────────────────────────────
const oauthClient = new OAuthClient({
  clientId:     process.env.QBO_CLIENT_ID,
  clientSecret: process.env.QBO_CLIENT_SECRET,
  environment:  process.env.QBO_ENVIRONMENT,  // 'sandbox' or 'production'
  redirectUri:  process.env.QBO_REDIRECT_URI,
});

// ─────────────────────────────────────────────────────────────────
// Token Storage
// In production this goes in a database, encrypted.
// For sandbox testing, memory is fine — tokens reset when 
// you restart the server, just re-authorize.
// ─────────────────────────────────────────────────────────────────
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');

// Load tokens from file if they exist
let tokenData = null;
let realmId = process.env.QBO_REALM_ID || null;

if (fs.existsSync(TOKEN_FILE)) {
  try {
    tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    console.log('✓ Tokens loaded from file');
  } catch(e) {
    console.log('Could not load saved tokens, will need to re-authorize');
  }
}

// ─────────────────────────────────────────────────────────────────
// ROUTE 1: Start the OAuth flow
// When ARK calls this (or you open it in a browser), it builds
// the Intuit authorization URL and redirects the user there.
// ─────────────────────────────────────────────────────────────────
app.get('/qbo/auth', (req, res) => {
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: 'ark-qbo-' + Date.now(), // random state prevents CSRF attacks
  });
  console.log('Redirecting to Intuit auth:', authUri);
  res.redirect(authUri);
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 2: OAuth Callback
// After the user authorizes in Intuit, Intuit redirects them
// back here with a short-lived "authorization code" in the URL.
// We exchange that code for real access + refresh tokens.
// ─────────────────────────────────────────────────────────────────
app.get('/qbo/callback', async (req, res) => {
  try {
    console.log('Callback received. Exchanging code for tokens...');

    // Exchange the authorization code for tokens
    const authResponse = await oauthClient.createToken(req.url);
    tokenData = authResponse.getJson();
    realmId = req.query.realmId || realmId;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData)); // ← add this
    
    console.log('✓ Tokens received successfully');
    console.log('  Realm ID (Company ID):', realmId);
    console.log('  Access token expires in:', tokenData.expires_in, 'seconds');
    console.log('  Refresh token expires in:', tokenData.x_refresh_token_expires_in, 'seconds');

    // Send a success page back to the browser
    // The postMessage call notifies the ARK dashboard window if it opened this as a popup
    res.send(`<!DOCTYPE html>
<html>
<head><title>QBO Connected</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1b2a;color:#e8f0f8;">
  <div style="text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">✓</div>
    <h2 style="color:#4dffa0;margin-bottom:8px;">Connected to QuickBooks!</h2>
    <p style="color:#8bafc8;">Tokens stored. This window will close automatically.</p>
    <p style="color:#4a6f8a;font-size:12px;margin-top:16px;">Realm ID: ${realmId}</p>
  </div>
  <script>
    // Tell the ARK dashboard the connection succeeded
    if (window.opener) {
      window.opener.postMessage({ type: 'qbo-connected', realmId: '${realmId}' }, '*');
    }
    setTimeout(() => window.close(), 3000);
  </script>
</body>
</html>`);

  } catch (e) {
    console.error('❌ Token exchange failed:', e.message);
    res.status(500).send(`
      <h2 style="color:red;font-family:sans-serif;">Connection Failed</h2>
      <p style="font-family:sans-serif;">Error: ${e.message}</p>
      <p style="font-family:sans-serif;">Check your server console for details.</p>
    `);
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3: Status Check
// ARK dashboard calls this to know if the server is connected
// ─────────────────────────────────────────────────────────────────
app.get('/qbo/status', (req, res) => {
  res.json({
    connected:  !!tokenData,
    realmId:    realmId,
    expiresAt:  tokenData
      ? new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString()
      : null,
  });
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3b: Disconnect — clear tokens and force re-auth
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/disconnect', (req, res) => {
  tokenData = null;
  realmId = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch(_) {}
  console.log('QBO disconnected — tokens cleared');
  res.json({ disconnected: true });
});

// ─────────────────────────────────────────────────────────────────
// HELPER: Get a valid QBO client, refreshing token if needed
// This is called internally before every API action
// ─────────────────────────────────────────────────────────────────
async function getQBOClient() {
  if (!tokenData) throw new Error('Not connected to QBO — run the auth flow first');

  // Check if the access token is still valid
  // Access tokens last 60 minutes; refresh tokens last 100 days
  if (!oauthClient.isAccessTokenValid()) {
    console.log('Access token expired, refreshing...');
    try {
      const refreshResponse = await oauthClient.refresh();
      tokenData = refreshResponse.getJson();
      console.log('✓ Token refreshed successfully');
    } catch (e) {
      tokenData = null; // force re-auth
      throw new Error('Token refresh failed — please reconnect to QBO');
    }
  }

  // Create and return a configured QuickBooks client
  return new QuickBooks(
    process.env.QBO_CLIENT_ID,
    process.env.QBO_CLIENT_SECRET,
    tokenData.access_token,
    false,                                            // no token secret (OAuth2 doesn't use one)
    realmId,                                          // company ID
    process.env.QBO_ENVIRONMENT === 'sandbox',        // true = sandbox, false = production
    false,                                            // debug logging (set true to see raw API calls)
    null,                                             // minor version
    '2.0',                                            // OAuth version
    tokenData.refresh_token
  );
}

// ─────────────────────────────────────────────────────────────────
// ROUTE 4: Main API Proxy
// ARK sends all QBO operations here as POST requests with 
// { action: 'actionName', payload: {...} }
// This keeps all QBO logic server-side where tokens are safe
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/api', async (req, res) => {
  const { action, payload } = req.body;
  console.log(`QBO API call: ${action}`);

  let qbo;
  try {
    qbo = await getQBOClient();
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  // ── Action: Get Chart of Accounts ────────────────────────────
  if (action === 'getAccounts') {
    qbo.findAccounts({ Active: true }, (err, data) => {
      if (err) {
        console.error('getAccounts error:', err);
        return res.status(500).json({ error: err.message || 'Failed to fetch accounts' });
      }
      const accounts = (data.QueryResponse?.Account || []).map(a => ({
        id:   a.Id,
        name: a.Name,
        type: a.AccountType,
        subType: a.AccountSubType,
        active: a.Active,
      }));
      console.log(`  Returned ${accounts.length} accounts`);
      res.json({ success: true, accounts });
    });

  // ── Action: Create Journal Entry ─────────────────────────────
  } else if (action === 'createJournalEntry') {
    qbo.createJournalEntry(payload, (err, data) => {
      if (err) {
        console.error('createJournalEntry error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ 
          error: err.message || 'Failed to create journal entry',
          detail: err.Fault || err 
        });
      }
      console.log(`  ✓ Journal Entry created: ID ${data.Id}`);
      res.json({ 
        success: true, 
        id:      data.Id, 
        txnDate: data.TxnDate,
        docNum:  data.DocNumber,
      });
    });

  // ── Action: Create Expense (Purchase) ────────────────────────
  } else if (action === 'createExpense') {
    qbo.createPurchase(payload, (err, data) => {
      if (err) {
        console.error('createExpense error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ 
          error: err.message || 'Failed to create expense',
          detail: err.Fault || err 
        });
      }
      console.log(`  ✓ Expense created: ID ${data.Id}`);
      res.json({ success: true, id: data.Id, txnDate: data.TxnDate });
    });

  // ── Action: Get Vendors ───────────────────────────────────────
  } else if (action === 'getVendors') {
    qbo.findVendors({ Active: true }, (err, data) => {
      if (err) return res.status(500).json({ error: err.message });
      const vendors = (data.QueryResponse?.Vendor || []).map(v => ({
        id:   v.Id,
        name: v.DisplayName,
      }));
      res.json({ success: true, vendors });
    });

  // ── Action: Get Company Info ──────────────────────────────────
  } else if (action === 'getCompanyInfo') {
    qbo.getCompanyInfo(realmId, (err, data) => {
      if (err) {
        console.error('getCompanyInfo error:', err);
        return res.status(500).json({ error: err.message || 'getCompanyInfo failed' });
      }
      res.json({ companyInfo: data });
    });

  // ── Unknown action ────────────────────────────────────────────
  } else {
    res.status(400).json({ error: `Unknown action: "${action}"` });
  }
});

// ─────────────────────────────────────────────────────────────────
// Start the server
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────
// SINCH CONFIGURATION
// All credentials stored in env vars — never passed from client
// ─────────────────────────────────────────────────────────────────
const SINCH = {
  projectId:    process.env.SINCH_PROJECT_ID,
  fax: {
    keyId:      process.env.SINCH_FAX_KEY_ID,
    keySecret:  process.env.SINCH_FAX_KEY_SECRET,
    number:     process.env.SINCH_FAX_NUMBER,
  },
  sms: {
    apiToken:   process.env.SINCH_SMS_API_TOKEN,
    planId:     process.env.SINCH_SMS_PLAN_ID,
    number:     process.env.SINCH_SMS_NUMBER,
  },
};

// ─────────────────────────────────────────────────────────────────
// COMM STATUS — Dashboard checks this to know if fax/SMS are live
// ─────────────────────────────────────────────────────────────────
app.get('/comm/status', (req, res) => {
  res.json({
    fax: !!(SINCH.projectId && SINCH.fax.keyId && SINCH.fax.keySecret),
    sms: !!(SINCH.sms.planId && SINCH.sms.apiToken),
    faxNumber: SINCH.fax.number || null,
    smsNumber: SINCH.sms.number || null,
  });
});

// ─────────────────────────────────────────────────────────────────
// TEMP FILE SERVING — Sinch Fax pulls content from a URL
// ─────────────────────────────────────────────────────────────────
const TEMP_DIR = path.join(require('os').tmpdir(), 'ark-fax-temp');
fs.mkdirSync(TEMP_DIR, { recursive: true });
app.use('/temp', express.static(TEMP_DIR));

// ─────────────────────────────────────────────────────────────────
// FAX: Send via Sinch Fax API v3
// Dashboard sends: { toNumber, fileName, fileData (base64) }
// Server handles all auth — credentials never leave the server
// ─────────────────────────────────────────────────────────────────
app.post('/fax/send', async (req, res) => {
  const { toNumber, fileName, fileData } = req.body;

  if (!toNumber) return res.status(400).json({ error: 'Recipient fax number missing' });
  if (!fileData) return res.status(400).json({ error: 'No file data provided' });
  if (!SINCH.projectId || !SINCH.fax.keyId) {
    return res.status(500).json({ error: 'Sinch Fax not configured on server' });
  }

  let tempPath = null;
  try {
    // Save base64 file to temp directory so Sinch can pull it via URL
    const safeName = crypto.randomUUID() + '-' + (fileName || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    tempPath = path.join(TEMP_DIR, safeName);
    fs.writeFileSync(tempPath, Buffer.from(fileData, 'base64'));

    // Build the public URL that Sinch will fetch
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const contentUrl = `${serverUrl}/temp/${safeName}`;

    console.log(`Fax: sending to ${toNumber}, contentUrl: ${contentUrl}`);

    // Call Sinch Fax API v3
    const faxAuth = Buffer.from(SINCH.fax.keyId + ':' + SINCH.fax.keySecret).toString('base64');
    const response = await fetch(
      `https://fax.api.sinch.com/v3/projects/${SINCH.projectId}/faxes`,
      {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${faxAuth}`,
        },
        body: JSON.stringify({
          to:         toNumber.replace(/[^\d+]/g, ''),
          from:       SINCH.fax.number,
          contentUrl: contentUrl,
        }),
      }
    );

    const data = await response.json();
    console.log('Fax API response:', JSON.stringify(data));

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || data.detail || 'Sinch Fax API error', detail: data });
    }

    res.json({ success: true, faxId: data.id, ...data });
  } catch(e) {
    console.error('Fax send error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    // Clean up temp file after 5 minutes (give Sinch time to pull it)
    if (tempPath) {
      setTimeout(() => { try { fs.unlinkSync(tempPath); } catch(e){} }, 300000);
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// FAX: Check status via Sinch Fax API v3
// ─────────────────────────────────────────────────────────────────
app.get('/fax/status/:faxId', async (req, res) => {
  if (!SINCH.projectId || !SINCH.fax.keyId) {
    return res.status(500).json({ error: 'Sinch Fax not configured' });
  }

  try {
    const faxAuth = Buffer.from(SINCH.fax.keyId + ':' + SINCH.fax.keySecret).toString('base64');
    const response = await fetch(
      `https://fax.api.sinch.com/v3/projects/${SINCH.projectId}/faxes/${req.params.faxId}`,
      { headers: { 'Authorization': `Basic ${faxAuth}` } }
    );
    res.json(await response.json());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// SMS: Send via Sinch SMS API (service plan API token auth)
// Dashboard sends: { to, text }
// Server handles all auth — credentials never leave the server
// ─────────────────────────────────────────────────────────────────
app.post('/sms/send', async (req, res) => {
  const { to, text } = req.body;

  if (!to)   return res.status(400).json({ error: 'Recipient number missing' });
  if (!text) return res.status(400).json({ error: 'Message text missing' });
  if (!SINCH.sms.planId || !SINCH.sms.apiToken) {
    return res.status(500).json({ error: 'Sinch SMS not configured on server' });
  }

  try {
    const digits = to.replace(/\D/g, '');
    const toE164 = digits.startsWith('1') ? '+' + digits : '+1' + digits;

    console.log(`SMS: sending to ${toE164} from ${SINCH.sms.number}`);

    const url = `https://us.sms.api.sinch.com/xms/v1/${SINCH.sms.planId}/batches`;
    const response = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${SINCH.sms.apiToken}`,
        },
        body: JSON.stringify({
          from: SINCH.sms.number,
          to:   [toE164],
          body: text,
        }),
      }
    );

    const responseText = await response.text();
    console.log('SMS API response:', response.status, responseText);

    let data;
    try { data = JSON.parse(responseText); } catch(_) { data = {}; }

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.text || data.message || responseText || 'Sinch SMS API error',
        detail: data,
        raw: responseText,
        httpStatus: response.status,
      });
    }

    // Sinch SMS returns batch info with an id
    res.json({
      success: true,
      messageId: data.id,
      status: 'sent',
    });
  } catch(e) {
    console.error('SMS send error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// SMS: Inbound message buffer
// Stores inbound messages in memory. Dashboard polls and pulls them.
// Buffer clears after dashboard fetches — localStorage is the
// permanent store, server is just a pass-through.
// ─────────────────────────────────────────────────────────────────
let _smsInbox = [];

// Sinch inbound webhook — receives MO (mobile-originated) messages
app.post('/sms/inbound', (req, res) => {
  const msg = req.body;
  console.log('SMS inbound:', JSON.stringify(msg));

  // Sinch sends 'from' without '+', normalize to E.164
  const fromRaw = (msg.from || '').replace(/\D/g, '');
  const from = fromRaw.startsWith('1') ? '+' + fromRaw : '+1' + fromRaw;

  _smsInbox.push({
    id: crypto.randomUUID(),
    direction: 'inbound',
    phone: from,
    body: msg.body || '',
    timestamp: msg.received_at || new Date().toISOString(),
    sinchId: msg.id || '',
  });

  console.log(`SMS received from ${from}: ${(msg.body || '').slice(0, 50)}`);
  res.status(200).json({ ok: true });
});

// Dashboard polls this to get new inbound messages, then clears buffer
app.get('/sms/inbox', (req, res) => {
  const messages = [..._smsInbox];
  _smsInbox = [];
  res.json({ messages });
});

// ─────────────────────────────────────────────────────────────────
// PAYROLL ENTRY SYSTEM
// Public-facing form for clients to submit payroll data
// Server stores config (clients, stores, employees) and submissions
// ─────────────────────────────────────────────────────────────────
const PAYROLL_FILE = path.join(DATA_DIR, 'payroll-data.json');

// Load payroll data from persistent disk, or seed from repo copy if first deploy
let payrollData = { clients: {}, submissions: [] };
if (fs.existsSync(PAYROLL_FILE)) {
  try {
    payrollData = JSON.parse(fs.readFileSync(PAYROLL_FILE, 'utf8'));
    console.log(`✓ Payroll data loaded from ${PAYROLL_FILE}`);
  } catch(e) {
    console.log('Could not load payroll data, starting fresh');
  }
}

// Sync: if repo copy has more store/employee data, replace the client config
// (preserves submissions and session tokens on disk, but overwrites client configs from repo)
const localCopy = path.join(__dirname, 'payroll-data.json');
if (fs.existsSync(localCopy) && DATA_DIR !== __dirname) {
  try {
    const repoCopy = JSON.parse(fs.readFileSync(localCopy, 'utf8'));
    let updated = false;
    for (const [slug, repoClient] of Object.entries(repoCopy.clients || {})) {
      const diskClient = payrollData.clients[slug];
      // Count total employees in repo vs disk
      const repoEmpCount = Object.values(repoClient.stores || {}).reduce((sum, s) => sum + (s.employees || []).length, 0);
      const diskEmpCount = diskClient ? Object.values(diskClient.stores || {}).reduce((sum, s) => sum + (s.employees || []).length, 0) : 0;
      const repoStoreCount = Object.keys(repoClient.stores || {}).length;
      const diskStoreCount = diskClient ? Object.keys(diskClient.stores || {}).length : 0;

      if (!diskClient || repoEmpCount > diskEmpCount || repoStoreCount > diskStoreCount) {
        // Repo has more data — use repo version but preserve session token & notifications
        const preserved = {
          _sessionToken: diskClient?._sessionToken || null,
          _notifications: diskClient?._notifications || [],
        };
        payrollData.clients[slug] = { ...repoClient, ...preserved };
        updated = true;
        console.log(`  → Synced ${slug}: ${repoStoreCount} stores, ${repoEmpCount} employees`);
      }
    }
    if (updated) {
      fs.writeFileSync(PAYROLL_FILE, JSON.stringify(payrollData, null, 2));
      console.log('✓ Payroll data synced from repo to persistent disk');
    }
  } catch(e) {
    console.log('Could not sync payroll data from repo:', e.message);
  }
} else if (!fs.existsSync(PAYROLL_FILE) && fs.existsSync(localCopy)) {
  // First deploy — seed from repo
  try {
    payrollData = JSON.parse(fs.readFileSync(localCopy, 'utf8'));
    fs.writeFileSync(PAYROLL_FILE, JSON.stringify(payrollData, null, 2));
    console.log('✓ Payroll data seeded to persistent disk from repo');
  } catch(e) {
    console.log('Could not seed payroll data');
  }
}

function savePayrollData() {
  fs.writeFileSync(PAYROLL_FILE, JSON.stringify(payrollData, null, 2));
}

// Serve the payroll entry page
app.get('/payroll-entry', (req, res) => {
  res.sendFile(__dirname + '/public/payroll-entry.html');
});

// ── Client Authentication ────────────────────────────────────────
app.post('/payroll/login', (req, res) => {
  const { clientSlug, password } = req.body;
  if (!clientSlug || !password) return res.status(400).json({ error: 'Missing credentials' });

  const client = payrollData.clients[clientSlug];
  if (!client || client.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Generate a simple session token
  const token = crypto.randomUUID();
  client._sessionToken = token;
  savePayrollData();

  res.json({
    success: true,
    token,
    clientName: client.name,
    stores: Object.entries(client.stores || {})
      .filter(([id]) => id !== 'admin')
      .map(([id, s]) => ({
        id,
        name: s.name,
      })),
    payFrequency: client.payFrequency || '',
    workLocations: client.workLocations || [],
  });
});

// ── Get employees for a store ────────────────────────────────────
app.get('/payroll/employees/:clientSlug/:storeId', (req, res) => {
  const { clientSlug, storeId } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');

  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const store = (client.stores || {})[storeId];
  if (!store) return res.status(404).json({ error: 'Store not found' });

  res.json({
    employees: (store.employees || []).map(e => ({
      id: e.id,
      firstName: e.firstName,
      lastName: e.lastName,
      position: e.position || '',
      payRate: e.payRate || '',
      payType: e.payType || 'hourly',
    })),
  });
});

// ── Client adds a new employee on the fly ────────────────────────
app.post('/payroll/employees/:clientSlug/:storeId', (req, res) => {
  const { clientSlug, storeId } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');

  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const store = (client.stores || {})[storeId];
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const b = req.body;
  if (!b.firstName || !b.lastName) return res.status(400).json({ error: 'First and last name required' });

  const newEmp = {
    id: crypto.randomUUID(),
    firstName: b.firstName,
    lastName: b.lastName,
    ssn: b.ssn || '',
    dob: b.dob || '',
    hireDate: b.hireDate || '',
    email: b.email || '',
    address: { street: b.street || '', city: b.city || '', state: b.state || '', zip: b.zip || '' },
    workLocation: b.workLocation || '',
    paySchedule: b.paySchedule || '',
    payRates: b.payRates || [],  // [{ label, rate, type }]
    // Legacy single rate (used in hours grid display)
    payRate: (b.payRates && b.payRates.length) ? b.payRates[0].rate : (b.payRate || ''),
    payType: (b.payRates && b.payRates.length) ? b.payRates[0].type : (b.payType || 'hourly'),
    position: (b.payRates && b.payRates.length) ? b.payRates[0].label : (b.position || ''),
    directDeposit: {
      routingNumber: b.routingNumber || '',
      accountNumber: b.accountNumber || '',
      accountType: b.accountType || '',
    },
    tax: {
      filingStatus: b.filingStatus || '',
      allowances: b.allowances || '',
      additionalWithholding: b.additionalWithholding || '',
    },
    addedByClient: true,
    addedAt: new Date().toISOString(),
  };

  if (!store.employees) store.employees = [];
  store.employees.push(newEmp);

  // Also create a New Hire Report (basic info only)
  if (!payrollData.newHireReports) payrollData.newHireReports = [];
  payrollData.newHireReports.push({
    id: crypto.randomUUID(),
    clientSlug,
    clientName: client.name,
    storeId,
    storeName: store.name,
    firstName: b.firstName,
    lastName: b.lastName,
    ssn: b.ssn || '',
    dob: b.dob || '',
    hireDate: b.hireDate || '',
    address: { street: b.street || '', city: b.city || '', state: b.state || '', zip: b.zip || '' },
    submittedAt: new Date().toISOString(),
    status: 'pending',
  });

  // Flag for notification (dashboard will check this)
  if (!client._notifications) client._notifications = [];
  client._notifications.push({
    type: 'new-employee',
    storeId,
    storeName: store.name,
    employee: `${b.firstName} ${b.lastName}`,
    workLocation: b.workLocation || '',
    payRates: b.payRates || [],
    email: b.email || '',
    timestamp: new Date().toISOString(),
  });
  savePayrollData();

  res.json({ success: true, employee: newEmp });
});

// ── New Hire Paperwork — token generation ─────────────────────────
const _newHireTokens = {};

app.post('/payroll/new-hire-token', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const client = payrollData.clients[req.body.clientSlug];
  if (!client || client._sessionToken !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nhToken = crypto.randomUUID();
  _newHireTokens[nhToken] = {
    ...req.body,
    createdAt: Date.now(),
  };

  // Expire tokens after 2 hours
  setTimeout(() => { delete _newHireTokens[nhToken]; }, 7200000);

  res.json({ success: true, token: nhToken });
});

// ── New Hire Paperwork — serve page ───────────────────────────────
app.get('/new-hire', (req, res) => {
  res.sendFile(__dirname + '/public/new-hire.html');
});

// ── New Hire Paperwork — get pre-filled data ──────────────────────
app.get('/payroll/new-hire-data/:token', (req, res) => {
  const data = _newHireTokens[req.params.token];
  if (!data) return res.status(404).json({ error: 'Link expired or invalid' });
  // Don't expose SSN in the GET — it's already on the form that generated this
  res.json({
    firstName: data.firstName,
    lastName: data.lastName,
    dob: data.dob,
    street: data.street,
    city: data.city,
    state: data.state,
    zip: data.zip,
    position: data.position,
    payType: data.payType,
    payRate: data.payRate,
    clientName: data.clientName,
    storeName: data.storeName,
  });
});

// ── New Hire Paperwork — submit completed form ────────────────────
app.post('/payroll/new-hire-submit', (req, res) => {
  const { token, routingNumber, accountNumber, accountType, filingStatus, allowances, additionalWithholding, signature } = req.body;

  const data = _newHireTokens[token];
  if (!data) return res.status(404).json({ error: 'Link expired or invalid' });

  const client = payrollData.clients[data.clientSlug];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Store the new hire report
  if (!payrollData.newHireReports) payrollData.newHireReports = [];
  payrollData.newHireReports.push({
    id: crypto.randomUUID(),
    clientSlug: data.clientSlug,
    clientName: data.clientName,
    storeId: data.storeId,
    storeName: data.storeName,
    employee: {
      firstName: data.firstName,
      lastName: data.lastName,
      ssn: data.ssn,
      dob: data.dob,
      address: { street: data.street, city: data.city, state: data.state, zip: data.zip },
      position: data.position,
      payType: data.payType,
      payRate: data.payRate,
    },
    directDeposit: {
      routingNumber: routingNumber || '',
      accountNumber: accountNumber || '',
      accountType: accountType || '',
    },
    tax: {
      filingStatus: filingStatus || '',
      allowances: allowances || '',
      additionalWithholding: additionalWithholding || '',
    },
    signature: signature || '',
    submittedAt: new Date().toISOString(),
    status: 'pending',
  });

  // Add notification
  if (!client._notifications) client._notifications = [];
  client._notifications.push({
    type: 'new-hire-paperwork',
    employee: `${data.firstName} ${data.lastName}`,
    storeName: data.storeName,
    timestamp: new Date().toISOString(),
  });

  savePayrollData();
  delete _newHireTokens[token];

  console.log(`New hire paperwork submitted: ${data.firstName} ${data.lastName} (${data.clientName})`);
  res.json({ success: true });
});

// ── Submit payroll data ──────────────────────────────────────────
app.post('/payroll/submit', (req, res) => {
  const { clientSlug, storeId, payPeriodStart, payPeriodEnd, payDate, entries, rateChanges } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');

  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!storeId || !payPeriodStart || !payPeriodEnd || !payDate || !entries?.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Process pay rate changes — update stored employee data and create notifications
  if (rateChanges && Object.keys(rateChanges).length > 0) {
    const store = (client.stores || {})[storeId];
    if (store && store.employees) {
      const changeList = [];
      for (const [empId, change] of Object.entries(rateChanges)) {
        const emp = store.employees.find(e => e.id === empId);
        if (emp) {
          const oldRate = emp.payRate || 'none';
          emp.payRate = change.to;
          changeList.push(`${change.name}: $${oldRate} → $${change.to}`);
        }
      }
      if (changeList.length > 0) {
        if (!client._notifications) client._notifications = [];
        client._notifications.push({
          type: 'pay-rate-change',
          storeId,
          storeName: store.name,
          changes: changeList,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  const submission = {
    id: crypto.randomUUID(),
    clientSlug,
    clientName: client.name,
    storeId,
    storeName: (client.stores[storeId] || {}).name || storeId,
    payPeriodStart,
    payPeriodEnd,
    payDate,
    entries,
    rateChanges: rateChanges || null,
    submittedAt: new Date().toISOString(),
    status: 'pending',
  };

  payrollData.submissions.push(submission);
  savePayrollData();

  console.log(`Payroll submitted: ${client.name} / ${submission.storeName} — ${entries.length} employees`);
  if (rateChanges) console.log(`  Rate changes: ${Object.keys(rateChanges).length}`);
  res.json({ success: true, submissionId: submission.id });
});

// ── Dashboard: Get all payroll config ────────────────────────────
app.get('/payroll/config', (req, res) => {
  // Return config without passwords and session tokens
  const safe = {};
  for (const [slug, client] of Object.entries(payrollData.clients)) {
    safe[slug] = {
      ...client,
      password: '••••••',
      _sessionToken: undefined,
    };
  }
  res.json({ clients: safe });
});

// ── Dashboard: Save/update a payroll client config ───────────────
app.post('/payroll/config', (req, res) => {
  const { slug, name, password, stores, payFrequency } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'Slug and name required' });

  const existing = payrollData.clients[slug];
  payrollData.clients[slug] = {
    name,
    password: password || (existing ? existing.password : ''),
    stores: stores || (existing ? existing.stores : {}),
    payFrequency: payFrequency || (existing ? existing.payFrequency : ''),
    _sessionToken: existing ? existing._sessionToken : null,
    _notifications: existing ? existing._notifications : [],
  };
  savePayrollData();
  res.json({ success: true });
});

// ── Dashboard: Delete a payroll client config ────────────────────
app.delete('/payroll/config/:slug', (req, res) => {
  delete payrollData.clients[req.params.slug];
  savePayrollData();
  res.json({ success: true });
});

// ── Dashboard: Get pending submissions ───────────────────────────
app.get('/payroll/submissions', (req, res) => {
  res.json({ submissions: payrollData.submissions });
});

// ── Dashboard: Update submission status ──────────────────────────
app.patch('/payroll/submissions/:id', (req, res) => {
  const sub = payrollData.submissions.find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (req.body.status) sub.status = req.body.status;
  savePayrollData();
  res.json({ success: true, submission: sub });
});

// ── Dashboard: Get notifications (new employees, etc.) ───────────
app.get('/payroll/notifications', (req, res) => {
  const all = [];
  for (const [slug, client] of Object.entries(payrollData.clients)) {
    if (client._notifications?.length) {
      all.push(...client._notifications.map(n => ({ ...n, clientSlug: slug, clientName: client.name })));
    }
  }
  res.json({ notifications: all });
});

// ── Dashboard: Clear notifications ───────────────────────────────
app.post('/payroll/notifications/clear', (req, res) => {
  for (const client of Object.values(payrollData.clients)) {
    client._notifications = [];
  }
  savePayrollData();
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────
// Start listening
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ARK QBO Server running on http://localhost:${PORT}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  const faxOk = SINCH.fax.keyId ? '✓' : '✗';
  const smsOk = SINCH.sms.apiToken ? '✓' : '✗';
  console.log(`  Sinch Fax: ${faxOk}  |  Sinch SMS: ${smsOk}`);
});
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

const app = express();

// Parse JSON request bodies (needed so we can read req.body)
app.use(express.json());

// Serve the ARK dashboard at the root URL
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/ark-dashboard.html');
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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
const fs = require('fs');
const TOKEN_FILE = './tokens.json';

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
    keyId:      process.env.SINCH_SMS_KEY_ID,
    keySecret:  process.env.SINCH_SMS_KEY_SECRET,
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
    sms: !!(SINCH.sms.planId && SINCH.sms.keyId),
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

// Increase JSON body limit for fax file uploads (base64 PDFs can be large)
app.use('/fax/send', express.json({ limit: '25mb' }));

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
// SMS: OAuth2 token cache for Sinch SMS API
// ─────────────────────────────────────────────────────────────────
let _smsToken = null;
let _smsTokenExpiry = 0;

async function getSinchSmsToken() {
  if (_smsToken && Date.now() < _smsTokenExpiry) return _smsToken;

  console.log(`SMS OAuth: using keyId=${SINCH.sms.keyId}, secret=${SINCH.sms.keySecret ? '***' + SINCH.sms.keySecret.slice(-4) : 'MISSING'}`);
  const auth = Buffer.from(SINCH.sms.keyId + ':' + SINCH.sms.keySecret).toString('base64');
  const resp = await fetch('https://auth.sinch.com/oauth2/token', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: 'grant_type=client_credentials',
  });

  const rawBody = await resp.text();
  if (!resp.ok) {
    throw new Error(`Sinch OAuth failed (${resp.status}): ${rawBody}`);
  }

  const data = JSON.parse(rawBody);
  _smsToken = data.access_token;
  _smsTokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  console.log('✓ Sinch SMS OAuth token refreshed');
  return _smsToken;
}

// Diagnostic: test SMS OAuth token
app.get('/sms/test-auth', async (req, res) => {
  try {
    _smsToken = null; _smsTokenExpiry = 0; // force refresh
    const token = await getSinchSmsToken();
    res.json({ ok: true, tokenPrefix: token.slice(0, 20) + '...' });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// SMS: Send via Sinch SMS API
// Dashboard sends: { to, text }
// Server handles all auth — credentials never leave the server
// ─────────────────────────────────────────────────────────────────
app.post('/sms/send', async (req, res) => {
  const { to, text } = req.body;

  if (!to)   return res.status(400).json({ error: 'Recipient number missing' });
  if (!text) return res.status(400).json({ error: 'Message text missing' });
  if (!SINCH.sms.planId || !SINCH.sms.keyId) {
    return res.status(500).json({ error: 'Sinch SMS not configured on server' });
  }

  try {
    const token = await getSinchSmsToken();
    const digits = to.replace(/\D/g, '');
    // Ensure E.164 format
    const toE164 = digits.startsWith('1') ? '+' + digits : '+1' + digits;

    console.log(`SMS: sending to ${toE164} from ${SINCH.sms.number}`);
    console.log(`SMS: using projectId=${SINCH.projectId}, token=${token ? token.slice(0,20) + '...' : 'NONE'}`);

    // Use service plan ID with Bearer token (API token approach)
    const url = `https://us.sms.api.sinch.com/xms/v1/${SINCH.sms.planId}/batches`;
    console.log(`SMS: POST ${url}`);

    // Try with OAuth2 token first
    let response = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          from: SINCH.sms.number,
          to:   [toE164],
          body: text,
        }),
      }
    );

    // If 401 with OAuth, try service plan API token (keySecret as bearer)
    if (response.status === 401) {
      console.log('SMS: OAuth token rejected, trying API token approach');
      response = await fetch(url, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${SINCH.sms.keySecret}`,
          },
          body: JSON.stringify({
            from: SINCH.sms.number,
            to:   [toE164],
            body: text,
          }),
        }
      );
    }

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
// Start listening
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ARK QBO Server running on http://localhost:${PORT}`);
  const faxOk = SINCH.fax.keyId ? '✓' : '✗';
  const smsOk = SINCH.sms.keyId ? '✓' : '✗';
  console.log(`  Sinch Fax: ${faxOk}  |  Sinch SMS: ${smsOk}`);
});
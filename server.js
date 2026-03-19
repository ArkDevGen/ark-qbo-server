// ─────────────────────────────────────────────────────────────────
// Load environment variables from .env file
// Must be the very first line before anything else
// ─────────────────────────────────────────────────────────────────
require('dotenv').config();

const express     = require('express');
const OAuthClient = require('intuit-oauth');
const QuickBooks  = require('node-quickbooks');

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
// ── FAX: Send via Sinch/Phaxio API ──────────────────────────────
app.post('/fax/send', async (req, res) => {
  const { apiKey, apiSecret, fromNumber, toNumber, fileName, fileData, headerText } = req.body;

  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'API credentials missing' });
  if (!toNumber)             return res.status(400).json({ error: 'Recipient number missing' });
  if (!fileData)             return res.status(400).json({ error: 'No file data provided' });

  try {
    const fileBuffer = Buffer.from(fileData, 'base64');
    const FormData   = require('form-data');
    const form       = new FormData();
    form.append('to',   toNumber.replace(/\D/g, ''));
    form.append('file', fileBuffer, { filename: fileName || 'document.pdf', contentType: 'application/pdf' });
    if (headerText) form.append('header_text', headerText);
    if (fromNumber) form.append('caller_id',   fromNumber.replace(/\D/g, ''));

    const response = await fetch('https://api.phaxio.com/v2/faxes', {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64'),
        ...form.getHeaders()
      },
      body: form
    });

    const data = await response.json();
    res.json(data);
  } catch(e) {
    console.error('Fax send error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── FAX: Check status ────────────────────────────────────────────
app.get('/fax/status/:faxId', async (req, res) => {
  const { apiKey, apiSecret } = req.query;
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'Credentials missing' });

  try {
    const response = await fetch(`https://api.phaxio.com/v2/faxes/${req.params.faxId}`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64') }
    });
    res.json(await response.json());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// ── SMS: Send via Vonage/Nexmo ────────────────────────────────────
app.post('/sms/send', async (req, res) => {
  const { apiKey, apiSecret, from, to, text } = req.body;

  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'API credentials missing' });
  if (!to)   return res.status(400).json({ error: 'Recipient number missing' });
  if (!text) return res.status(400).json({ error: 'Message text missing' });

  try {
    const response = await fetch('https://rest.nexmo.com/sms/json', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:    apiKey,
        api_secret: apiSecret,
        to:   to.replace(/\D/g, ''),
        from: from.replace(/\D/g, ''),
        text
      })
    });
    const data = await response.json();
    res.json(data);
  } catch(e) {
    console.error('SMS send error:', e);
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ARK QBO Server running on http://localhost:${PORT}`);
  console.log(`Network access: http://192.168.254.137:${PORT}`);  // your actual IP
});
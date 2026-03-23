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
const multer      = require('multer');
const { S3Client, ListObjectsV2Command, PutObjectCommand,
        GetObjectCommand, DeleteObjectCommand, CopyObjectCommand,
        HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();

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
// BACKBLAZE B2 — S3-Compatible File Storage
// All file operations go through the server so B2 credentials
// never leave the backend. Dashboard sends/receives files via
// these /files/* endpoints.
// ─────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  endpoint:    process.env.B2_ENDPOINT,
  region:      process.env.B2_REGION || 'us-east-005',
  credentials: {
    accessKeyId:     process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
  forcePathStyle: true, // B2 requires path-style URLs
});
const B2_BUCKET = process.env.B2_BUCKET || 'ark-files';

// Multer — stores uploads in memory (streamed straight to B2)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
});

// ── Helper: check if B2 is configured ──
function b2Ready() {
  return !!(process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_ENDPOINT);
}

// ─────────────────────────────────────────────────────────────────
// FILES: Status — Dashboard checks if file storage is available
// ─────────────────────────────────────────────────────────────────
app.get('/files/status', (req, res) => {
  res.json({ available: b2Ready(), bucket: B2_BUCKET });
});

// ─────────────────────────────────────────────────────────────────
// FILES: List — Returns all files (optionally filtered by prefix)
// Query params: ?prefix=clients/abc123/tax/  &delimiter=/
// ─────────────────────────────────────────────────────────────────
app.get('/files/list', async (req, res) => {
  if (!b2Ready()) return res.status(500).json({ error: 'File storage not configured' });

  try {
    const prefix    = req.query.prefix || '';
    const delimiter = req.query.delimiter || undefined;

    const command = new ListObjectsV2Command({
      Bucket:    B2_BUCKET,
      Prefix:    prefix,
      Delimiter: delimiter,
      MaxKeys:   1000,
    });

    const data = await s3.send(command);

    // Files in this "folder"
    const files = (data.Contents || []).map(obj => ({
      key:      obj.Key,
      name:     obj.Key.split('/').filter(Boolean).pop(),
      size:     obj.Size,
      modified: obj.LastModified,
    }));

    // "Sub-folders" (common prefixes)
    const folders = (data.CommonPrefixes || []).map(p => ({
      prefix: p.Prefix,
      name:   p.Prefix.replace(prefix, '').replace(/\/$/, ''),
    }));

    res.json({ success: true, files, folders, prefix });
  } catch (e) {
    console.error('Files list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Upload — Multipart upload, streams to B2
// Form fields: folder (the B2 prefix), file (the file)
// Optional: uploadedBy (AM name for metadata)
// ─────────────────────────────────────────────────────────────────
app.post('/files/upload', upload.single('file'), async (req, res) => {
  if (!b2Ready()) return res.status(500).json({ error: 'File storage not configured' });
  if (!req.file)  return res.status(400).json({ error: 'No file provided' });

  try {
    const folder     = (req.body.folder || '').replace(/\/+$/, '');
    const safeName   = req.file.originalname.replace(/[^a-zA-Z0-9._\-() ]/g, '_');
    const key        = folder ? `${folder}/${safeName}` : safeName;
    const uploadedBy = req.body.uploadedBy || 'Unknown';

    const command = new PutObjectCommand({
      Bucket:      B2_BUCKET,
      Key:         key,
      Body:        req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream',
      Metadata:    { uploadedby: uploadedBy, uploadedat: new Date().toISOString() },
    });

    await s3.send(command);
    console.log(`File uploaded: ${key} (${(req.file.size / 1024).toFixed(1)} KB) by ${uploadedBy}`);

    res.json({ success: true, key, name: safeName, size: req.file.size });
  } catch (e) {
    console.error('File upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Download — Returns a pre-signed URL (valid 15 min)
// Query param: ?key=clients/abc123/tax/return.pdf
// ─────────────────────────────────────────────────────────────────
app.get('/files/download', async (req, res) => {
  if (!b2Ready()) return res.status(500).json({ error: 'File storage not configured' });

  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'File key is required' });

  try {
    const command = new GetObjectCommand({ Bucket: B2_BUCKET, Key: key });
    const url = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 min
    res.json({ success: true, url, key });
  } catch (e) {
    console.error('File download error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Delete — Remove a file from B2
// Body: { key: 'clients/abc123/tax/return.pdf' }
// ─────────────────────────────────────────────────────────────────
app.post('/files/delete', async (req, res) => {
  if (!b2Ready()) return res.status(500).json({ error: 'File storage not configured' });

  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'File key is required' });

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key }));
    console.log(`File deleted: ${key}`);
    res.json({ success: true, key });
  } catch (e) {
    console.error('File delete error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Rename / Move — Copy to new key, delete old key
// Body: { oldKey, newKey }
// ─────────────────────────────────────────────────────────────────
app.post('/files/rename', async (req, res) => {
  if (!b2Ready()) return res.status(500).json({ error: 'File storage not configured' });

  const { oldKey, newKey } = req.body;
  if (!oldKey || !newKey) return res.status(400).json({ error: 'oldKey and newKey are required' });

  try {
    // Copy to new location
    await s3.send(new CopyObjectCommand({
      Bucket:     B2_BUCKET,
      CopySource: `${B2_BUCKET}/${oldKey}`,
      Key:        newKey,
    }));
    // Delete old
    await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: oldKey }));
    console.log(`File renamed: ${oldKey} → ${newKey}`);
    res.json({ success: true, oldKey, newKey });
  } catch (e) {
    console.error('File rename error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Create folder — Puts an empty placeholder object
// Body: { prefix: 'clients/abc123/tax/2025/' }
// ─────────────────────────────────────────────────────────────────
app.post('/files/folder', async (req, res) => {
  if (!b2Ready()) return res.status(500).json({ error: 'File storage not configured' });

  let { prefix } = req.body;
  if (!prefix) return res.status(400).json({ error: 'Folder prefix is required' });
  if (!prefix.endsWith('/')) prefix += '/';

  try {
    // Check if folder already exists
    try {
      await s3.send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: prefix }));
      // If HeadObject succeeds, the folder already exists
      return res.status(409).json({ error: 'A folder with that name already exists' });
    } catch (headErr) {
      // 404 = doesn't exist = good, proceed to create
      if (headErr.name !== 'NotFound' && headErr.$metadata?.httpStatusCode !== 404) throw headErr;
    }

    await s3.send(new PutObjectCommand({
      Bucket:      B2_BUCKET,
      Key:         prefix,
      Body:        Buffer.alloc(0),
      ContentType: 'application/x-directory',
    }));
    console.log(`Folder created: ${prefix}`);
    res.json({ success: true, prefix });
  } catch (e) {
    console.error('Folder create error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Bulk list — All files across all clients (for File Center)
// Returns everything in the bucket with full metadata
// ─────────────────────────────────────────────────────────────────
app.get('/files/all', async (req, res) => {
  if (!b2Ready()) return res.status(500).json({ error: 'File storage not configured' });

  try {
    let allFiles = [];
    let continuationToken = undefined;

    // Paginate through all objects
    do {
      const command = new ListObjectsV2Command({
        Bucket:            B2_BUCKET,
        MaxKeys:           1000,
        ContinuationToken: continuationToken,
      });
      const data = await s3.send(command);

      (data.Contents || []).forEach(obj => {
        // Skip folder placeholders (0-byte objects ending in /)
        if (obj.Size === 0 && obj.Key.endsWith('/')) return;

        const parts = obj.Key.split('/');
        allFiles.push({
          key:      obj.Key,
          name:     parts[parts.length - 1],
          size:     obj.Size,
          modified: obj.LastModified,
          // Parse path structure: clients/{clientId}/{category}/...
          clientId: parts[0] === 'clients' ? parts[1] : null,
          category: parts[0] === 'clients' ? (parts[2] || 'general') : (parts[0] || 'general'),
          path:     parts.slice(0, -1).join('/'),
        });
      });

      continuationToken = data.IsTruncated ? data.NextContinuationToken : undefined;
    } while (continuationToken);

    res.json({ success: true, files: allFiles, count: allFiles.length });
  } catch (e) {
    console.error('Files all error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Start listening
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ARK QBO Server running on http://localhost:${PORT}`);
  const faxOk = SINCH.fax.keyId ? '✓' : '✗';
  const smsOk = SINCH.sms.apiToken ? '✓' : '✗';
  const b2Ok  = b2Ready() ? '✓' : '✗';
  console.log(`  Sinch Fax: ${faxOk}  |  Sinch SMS: ${smsOk}  |  B2 Files: ${b2Ok}`);
});
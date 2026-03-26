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
const multer      = require('multer');
// S3/B2 imports removed — now using ShareFile API
const { google }       = require('googleapis');

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
// CORS — Only allow requests from the dashboard origin
// Blocks random websites/scripts from hitting our API
// ─────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://ark-qbo-server.onrender.com',
];
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  // Allow same-origin requests (no Origin header) and allowed origins
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────────────────────────────
// SESSION AUTHENTICATION
// Dashboard logs in with the API key, gets a session token.
// All /files/* endpoints require a valid session token.
// ─────────────────────────────────────────────────────────────────
const _sessions = new Map(); // token → { userId, userName, role, createdAt }
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Clean up expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of _sessions) {
    if (now - session.createdAt > SESSION_TTL) _sessions.delete(token);
  }
}, 3600000);

// Login — dashboard sends API key + user info, gets a session token
app.post('/auth/login', (req, res) => {
  const { apiKey, userId, userName, role } = req.body;

  if (!apiKey || apiKey !== process.env.ARK_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  if (!userId || !userName) {
    return res.status(400).json({ error: 'User info required' });
  }

  const token = crypto.randomUUID();
  _sessions.set(token, {
    userId,
    userName,
    role: role || 'am',
    createdAt: Date.now(),
  });

  console.log(`Auth: session created for ${userName} (${role || 'am'})`);
  res.json({ success: true, token });
});

// Logout — invalidate session
app.post('/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) _sessions.delete(token);
  res.json({ success: true });
});

// Auth middleware — validates Bearer token on protected routes
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const session = _sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });

  // Check expiry
  if (Date.now() - session.createdAt > SESSION_TTL) {
    _sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  // Attach session to request for audit logging
  req.arkUser = session;
  next();
}

// ─────────────────────────────────────────────────────────────────
// FILE AUDIT LOG
// Logs every file operation for compliance & accountability
// ─────────────────────────────────────────────────────────────────
const AUDIT_FILE = path.join(DATA_DIR, 'file-audit.json');
let _auditLog = [];

// Load existing audit log
if (fs.existsSync(AUDIT_FILE)) {
  try { _auditLog = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); }
  catch(e) { console.log('Could not load audit log, starting fresh'); }
}

function auditLog(action, key, user, ip) {
  const entry = {
    action,          // 'upload', 'download', 'delete', 'rename', 'folder'
    key,             // file path in B2
    user: user ? `${user.userName} (${user.userId})` : 'unknown',
    role: user?.role || 'unknown',
    ip: ip || 'unknown',
    timestamp: new Date().toISOString(),
  };
  _auditLog.push(entry);
  // Keep last 10,000 entries
  if (_auditLog.length > 10000) _auditLog = _auditLog.slice(-10000);
  try { fs.writeFileSync(AUDIT_FILE, JSON.stringify(_auditLog, null, 2)); }
  catch(e) { console.error('Audit log write error:', e.message); }
}

// Admin: view audit log
app.get('/files/audit', requireAuth, (req, res) => {
  if (req.arkUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const limit = parseInt(req.query.limit) || 100;
  res.json({ success: true, entries: _auditLog.slice(-limit) });
});

// ─────────────────────────────────────────────────────────────────
// FILE TYPE WHITELIST
// Only allow safe document types — blocks executables & scripts
// ─────────────────────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set([
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'csv', 'txt', 'rtf',
  // Presentations
  'ppt', 'pptx',
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'bmp', 'webp',
  // Archives
  'zip',
  // Accounting / QuickBooks Desktop
  'qbw', 'qbb', 'qbm', 'qbo', 'qbx', 'qba', 'qby', 'qbj',
  'iif', 'ofx', 'qfx', 'ach', 'qwc', 'tlg', 'nd',
]);

function isAllowedFile(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

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
// Token Storage — Multi-Company
// Stores tokens per realmId so AMs can switch between QBO companies
// without re-authorizing. Format: { realmId: { access_token, ... } }
// ─────────────────────────────────────────────────────────────────
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');

// tokenStore: { [realmId]: { tokenData, companyName, linkedClients[], connectedAt, lastUsed } }
let tokenStore = {};
// activeRealmId tracks the "current" company for backward compat
let activeRealmId = process.env.QBO_REALM_ID || null;

if (fs.existsSync(TOKEN_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    // Migrate from old single-token format
    if (raw.access_token) {
      const rid = activeRealmId || 'unknown';
      tokenStore = { [rid]: { tokenData: raw, companyName: '', linkedClients: [], connectedAt: new Date().toISOString(), lastUsed: new Date().toISOString() } };
      console.log('✓ Migrated single-token format to multi-company store');
    } else {
      // Check if it's the old simple { realmId: tokenData } or new enriched format
      const firstVal = Object.values(raw)[0];
      if (firstVal && firstVal.access_token) {
        // Old simple format — wrap each entry
        for (const [rid, td] of Object.entries(raw)) {
          tokenStore[rid] = { tokenData: td, companyName: '', linkedClients: [], connectedAt: new Date().toISOString(), lastUsed: new Date().toISOString() };
        }
        console.log(`✓ Migrated ${Object.keys(tokenStore).length} company tokens to enriched format`);
      } else {
        tokenStore = raw;
        console.log(`✓ Token store loaded — ${Object.keys(tokenStore).length} company(ies)`);
      }
    }
    saveTokenStore();
  } catch(e) {
    console.log('Could not load saved tokens, will need to re-authorize');
  }
}

function saveTokenStore() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore, null, 2)); }
  catch(e) { console.error('Failed to save token store:', e.message); }
}

// Helpers for enriched token entries
function getTokenData(rid) {
  const entry = tokenStore[rid || activeRealmId];
  return entry?.tokenData || null;
}
function setTokenData(rid, data) {
  if (!tokenStore[rid]) {
    tokenStore[rid] = { tokenData: data, companyName: '', linkedClients: [], connectedAt: new Date().toISOString(), lastUsed: new Date().toISOString() };
  } else {
    tokenStore[rid].tokenData = data;
    tokenStore[rid].lastUsed = new Date().toISOString();
  }
  saveTokenStore();
}

// ─────────────────────────────────────────────────────────────────
// Google Calendar — OAuth2 Token Storage
// ─────────────────────────────────────────────────────────────────
const GCAL_TOKEN_FILE = path.join(DATA_DIR, 'gcal-tokens.json');
let gcalTokens = {};

if (fs.existsSync(GCAL_TOKEN_FILE)) {
  try {
    gcalTokens = JSON.parse(fs.readFileSync(GCAL_TOKEN_FILE, 'utf8'));
    console.log('✓ Google Calendar tokens loaded');
  } catch(e) {
    console.log('Could not load Google Calendar tokens');
  }
}

function saveGcalTokens() {
  fs.writeFileSync(GCAL_TOKEN_FILE, JSON.stringify(gcalTokens, null, 2));
}

function getGCalOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function getGCalClient() {
  const td = gcalTokens.primary;
  if (!td) throw new Error('Google Calendar not connected');

  const oauth2 = getGCalOAuth2Client();
  oauth2.setCredentials(td);

  // Auto-refresh if expired
  if (td.expiry_date && td.expiry_date < Date.now()) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      gcalTokens.primary = credentials;
      saveGcalTokens();
      oauth2.setCredentials(credentials);
    } catch(e) {
      delete gcalTokens.primary;
      saveGcalTokens();
      throw new Error('Google Calendar token expired — please reconnect');
    }
  }

  return google.calendar({ version: 'v3', auth: oauth2 });
}

// ─────────────────────────────────────────────────────────────────
// ROUTE 1: Start the OAuth flow
// When ARK calls this (or you open it in a browser), it builds
// the Intuit authorization URL and redirects the user there.
// ─────────────────────────────────────────────────────────────────
app.get('/qbo/auth', (req, res) => {
  const stateData = { ts: Date.now(), clientId: req.query.clientId || '' };
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: JSON.stringify(stateData),
  });
  console.log('Redirecting to Intuit auth (clientId:', stateData.clientId || 'none', ')');
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
    const newTokens = authResponse.getJson();
    const rid = req.query.realmId || activeRealmId;
    activeRealmId = rid;
    setTokenData(rid, newTokens);

    // Parse clientId from OAuth state parameter
    let clientId = '';
    try { const sd = JSON.parse(req.query.state || '{}'); clientId = sd.clientId || ''; } catch(_) {}
    if (clientId && tokenStore[rid] && !tokenStore[rid].linkedClients.includes(clientId)) {
      tokenStore[rid].linkedClients.push(clientId);
      saveTokenStore();
    }

    console.log('✓ Tokens received successfully');
    console.log('  Realm ID (Company ID):', rid);
    console.log('  Client ID:', clientId || '(none — QBO Center connect)');
    console.log('  Access token expires in:', newTokens.expires_in, 'seconds');
    console.log('  Total connected companies:', Object.keys(tokenStore).length);

    res.send(`<!DOCTYPE html>
<html>
<head><title>QBO Connected</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1b2a;color:#e8f0f8;">
  <div style="text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">✓</div>
    <h2 style="color:#4dffa0;margin-bottom:8px;">Connected to QuickBooks!</h2>
    <p style="color:#8bafc8;">Tokens stored. This window will close automatically.</p>
    <p style="color:#4a6f8a;font-size:12px;margin-top:16px;">Realm ID: ${rid}</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'qbo-connected', realmId: '${rid}', clientId: '${clientId}' }, '*');
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
  const companies = {};
  for (const [rid, entry] of Object.entries(tokenStore)) {
    companies[rid] = {
      connected:     !!entry.tokenData,
      companyName:   entry.companyName || '',
      linkedClients: entry.linkedClients || [],
      connectedAt:   entry.connectedAt || null,
      lastUsed:      entry.lastUsed || null,
    };
  }
  // Also include legacy fields for backward compat
  const rid = req.query.realmId || activeRealmId;
  const td = getTokenData(rid);
  res.json({
    companies,
    // Legacy fields (still used by some dashboard functions)
    connected:   !!td,
    realmId:     rid,
    allRealms:   Object.keys(tokenStore),
    expiresAt:   td ? new Date(Date.now() + (td.expires_in * 1000)).toISOString() : null,
    environment: process.env.QBO_ENVIRONMENT || 'production',
  });
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3b: Disconnect — clear tokens and force re-auth
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/disconnect', (req, res) => {
  const rid = req.body.realmId || activeRealmId;
  if (rid && tokenStore[rid]) {
    delete tokenStore[rid];
    saveTokenStore();
    console.log(`QBO disconnected — tokens cleared for realm ${rid}`);
  }
  if (rid === activeRealmId) activeRealmId = Object.keys(tokenStore)[0] || null;
  res.json({ disconnected: true, realmId: rid });
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3c: Link a CRM client to an existing QBO company
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/link-client', (req, res) => {
  const { realmId, clientId, franchiseId } = req.body;
  if (!realmId || !clientId) return res.status(400).json({ error: 'realmId and clientId required' });
  if (!tokenStore[realmId]) return res.status(404).json({ error: 'Realm not found — connect to QBO first' });
  if (!tokenStore[realmId].linkedClients) tokenStore[realmId].linkedClients = [];
  // Store as "clientId" or "clientId:franchiseId" for franchise-level linking
  const linkKey = franchiseId ? `${clientId}:${franchiseId}` : clientId;
  if (!tokenStore[realmId].linkedClients.includes(linkKey)) {
    tokenStore[realmId].linkedClients.push(linkKey);
    saveTokenStore();
  }
  console.log(`${franchiseId ? 'Franchise ' + franchiseId + ' of client' : 'Client'} ${clientId} linked to realm ${realmId}`);
  res.json({ success: true, linkedClients: tokenStore[realmId].linkedClients });
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3d: Unlink a CRM client from a QBO company
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/unlink-client', (req, res) => {
  const { realmId, clientId, franchiseId } = req.body;
  if (!realmId || !clientId) return res.status(400).json({ error: 'realmId and clientId required' });
  if (!tokenStore[realmId]) return res.status(404).json({ error: 'Realm not found' });
  const linkKey = franchiseId ? `${clientId}:${franchiseId}` : clientId;
  tokenStore[realmId].linkedClients = (tokenStore[realmId].linkedClients || []).filter(id => id !== linkKey);
  saveTokenStore();
  console.log(`${franchiseId ? 'Franchise ' + franchiseId + ' of client' : 'Client'} ${clientId} unlinked from realm ${realmId}`);
  res.json({ success: true, linkedClients: tokenStore[realmId].linkedClients });
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3e: Store/update company name for a realmId
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/update-company-name', (req, res) => {
  const { realmId, companyName } = req.body;
  if (!realmId) return res.status(400).json({ error: 'realmId required' });
  if (tokenStore[realmId]) {
    tokenStore[realmId].companyName = companyName || '';
    saveTokenStore();
  }
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────
// HELPER: Get a valid QBO client, refreshing token if needed
// This is called internally before every API action
// ─────────────────────────────────────────────────────────────────
async function getQBOClient(rid) {
  const targetRealm = rid || activeRealmId;
  const td = getTokenData(targetRealm);
  if (!td) throw new Error(`Not connected to QBO for realm ${targetRealm} — run the auth flow first`);

  // Check if the access token is still valid
  // Access tokens last 60 minutes; refresh tokens last 100 days
  if (!oauthClient.isAccessTokenValid()) {
    console.log(`Access token expired for realm ${targetRealm}, refreshing...`);
    try {
      // Set the token on the oauthClient before refreshing
      oauthClient.setToken(td);
      const refreshResponse = await oauthClient.refresh();
      const newTokens = refreshResponse.getJson();
      setTokenData(targetRealm, newTokens);
      console.log('✓ Token refreshed successfully');
      return buildQBOClient(targetRealm, newTokens);
    } catch (e) {
      // Clear token but preserve metadata (companyName, linkedClients)
      if (tokenStore[targetRealm]) tokenStore[targetRealm].tokenData = null;
      saveTokenStore();
      throw new Error(`Token refresh failed for realm ${targetRealm} — please reconnect`);
    }
  }

  return buildQBOClient(targetRealm, td);
}

function buildQBOClient(rid, td) {
  return new QuickBooks(
    process.env.QBO_CLIENT_ID,
    process.env.QBO_CLIENT_SECRET,
    td.access_token,
    false,                                            // no token secret (OAuth2 doesn't use one)
    rid,                                              // company ID
    process.env.QBO_ENVIRONMENT === 'sandbox',        // true = sandbox, false = production
    false,                                            // debug logging (set true to see raw API calls)
    null,                                             // minor version
    '2.0',                                            // OAuth version
    td.refresh_token
  );
}

// ─────────────────────────────────────────────────────────────────
// ROUTE 4: Main API Proxy
// ARK sends all QBO operations here as POST requests with 
// { action: 'actionName', payload: {...} }
// This keeps all QBO logic server-side where tokens are safe
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/api', async (req, res) => {
  const { action, payload, realmId: reqRealmId } = req.body;
  const targetRealm = reqRealmId || activeRealmId;
  console.log(`QBO API call: ${action} (realm: ${targetRealm})`);

  let qbo;
  try {
    qbo = await getQBOClient(targetRealm);
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

  // ── Action: Get Classes ──────────────────────────────────────
  } else if (action === 'getClasses') {
    qbo.findClasses({ Active: true }, (err, data) => {
      if (err) return res.status(500).json({ error: err.message || 'Failed to fetch classes' });
      const classes = (data.QueryResponse?.Class || []).map(c => ({
        id:   c.Id,
        name: c.FullyQualifiedName || c.Name,
      }));
      console.log(`  Returned ${classes.length} classes`);
      res.json({ success: true, classes });
    });

  // ── Action: Get Departments (Locations) ─────────────────────
  } else if (action === 'getDepartments') {
    qbo.findDepartments({ Active: true }, (err, data) => {
      if (err) return res.status(500).json({ error: err.message || 'Failed to fetch departments' });
      const departments = (data.QueryResponse?.Department || []).map(d => ({
        id:   d.Id,
        name: d.FullyQualifiedName || d.Name,
      }));
      console.log(`  Returned ${departments.length} departments`);
      res.json({ success: true, departments });
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
    qbo.getCompanyInfo(targetRealm, (err, data) => {
      if (err) {
        console.error('getCompanyInfo error:', err);
        return res.status(500).json({ error: err.message || 'getCompanyInfo failed' });
      }
      res.json({ companyInfo: data });
    });

  // ── Action: Get P&L Report (Summary or Detail) ────────────────
  } else if (action === 'getProfitAndLoss') {
    // payload: { startDate, endDate, reportType: 'summary'|'detail' }
    const { startDate, endDate, reportType } = payload || {};
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required' });
    }
    const params = {
      start_date: startDate,
      end_date: endDate,
    };

    const method = reportType === 'detail' ? 'reportProfitAndLossDetail' : 'reportProfitAndLoss';
    qbo[method](params, (err, data) => {
      if (err) {
        console.error(`${method} error:`, JSON.stringify(err, null, 2));
        return res.status(500).json({
          error: err.message || `Failed to fetch P&L ${reportType || 'summary'}`,
          detail: err.Fault || err,
        });
      }
      console.log(`  ✓ P&L ${reportType || 'summary'} returned for ${startDate} → ${endDate}`);
      res.json({ success: true, report: data });
    });

  // ── Action: Get P&L for Multiple Periods (history batch) ──────
  } else if (action === 'getProfitAndLossHistory') {
    // payload: { periods: [{ startDate, endDate, label }] }
    const { periods } = payload || {};
    if (!periods || !periods.length) {
      return res.status(400).json({ error: 'periods array required' });
    }

    const results = [];
    let errors = [];

    // Sequential to avoid rate limiting
    for (const period of periods) {
      try {
        const data = await new Promise((resolve, reject) => {
          qbo.reportProfitAndLoss({
            start_date: period.startDate,
            end_date: period.endDate,
          }, (err, d) => err ? reject(err) : resolve(d));
        });
        results.push({ label: period.label, startDate: period.startDate, endDate: period.endDate, report: data });
      } catch (e) {
        errors.push({ label: period.label, error: e.message || 'Failed' });
      }
    }

    console.log(`  ✓ P&L history batch: ${results.length} ok, ${errors.length} errors`);
    res.json({ success: true, results, errors });

  // ── Action: Switch Active Realm ────────────────────────────────
  } else if (action === 'switchRealm') {
    const rid = payload?.realmId;
    if (!rid || !tokenStore[rid]) {
      return res.status(400).json({ error: `No tokens for realm ${rid}` });
    }
    activeRealmId = rid;
    console.log(`  ✓ Switched active realm to ${rid}`);
    res.json({ success: true, activeRealmId: rid });

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
// SHAREFILE — File Storage via ShareFile REST API
// Replaces Backblaze B2. Uses OAuth2 for auth, folder IDs for nav.
// Dashboard sends/receives files via /files/* endpoints.
// ─────────────────────────────────────────────────────────────────
const SF_SUBDOMAIN   = process.env.SHAREFILE_SUBDOMAIN || '';
const SF_CLIENT_ID   = process.env.SHAREFILE_CLIENT_ID || '';
const SF_CLIENT_SECRET = process.env.SHAREFILE_CLIENT_SECRET || '';
const SF_API_BASE    = SF_SUBDOMAIN ? `https://${SF_SUBDOMAIN}.sf-api.com/sf/v3` : '';
const SF_TOKEN_FILE  = path.join(DATA_DIR, 'sharefile-tokens.json');

// Load saved ShareFile tokens
let sfTokens = null;
if (fs.existsSync(SF_TOKEN_FILE)) {
  try {
    sfTokens = JSON.parse(fs.readFileSync(SF_TOKEN_FILE, 'utf8'));
    console.log('✓ ShareFile tokens loaded from file');
  } catch(e) {
    console.log('Could not load ShareFile tokens, will need to re-authorize');
  }
}

function sfReady() {
  return !!(SF_CLIENT_ID && SF_CLIENT_SECRET && SF_SUBDOMAIN && sfTokens);
}

function saveSfTokens() {
  fs.writeFileSync(SF_TOKEN_FILE, JSON.stringify(sfTokens, null, 2));
}

// Auto-refresh ShareFile access token if expired
async function sfGetHeaders() {
  if (!sfTokens) throw new Error('ShareFile not connected — run the auth flow first');

  // Check if token is expired (with 5 min buffer)
  if (sfTokens.expires_at && Date.now() > sfTokens.expires_at - 300000) {
    console.log('ShareFile token expired, refreshing...');
    try {
      const params = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: sfTokens.refresh_token,
        client_id:     SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
      });
      const resp = await fetch(`https://${SF_SUBDOMAIN}.sharefile.com/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        sfTokens = null;
        saveSfTokens();
        throw new Error('Token refresh failed: ' + errText);
      }
      const data = await resp.json();
      sfTokens = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token || sfTokens.refresh_token,
        expires_at:    Date.now() + (data.expires_in * 1000),
        subdomain:     data.subdomain || SF_SUBDOMAIN,
      };
      saveSfTokens();
      console.log('✓ ShareFile token refreshed');
    } catch(e) {
      throw new Error('ShareFile token refresh failed — please reconnect');
    }
  }

  return {
    'Authorization': `Bearer ${sfTokens.access_token}`,
    'Content-Type':  'application/json',
  };
}

// Generic ShareFile API call helper
async function sfApi(endpoint, options = {}) {
  const headers = await sfGetHeaders();
  const apiBase = `https://${sfTokens.subdomain || SF_SUBDOMAIN}.sf-api.com/sf/v3`;
  const url = endpoint.startsWith('http') ? endpoint : `${apiBase}${endpoint}`;
  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers: { ...headers, ...(options.headers || {}) },
    body: options.body || undefined,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`ShareFile API ${resp.status}: ${errText}`);
  }
  if (resp.status === 204) return null; // No content (delete)
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('json')) return resp.json();
  return resp.text();
}

// Folder ID cache: path → { id, expires }
const sfFolderCache = new Map();
const SF_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Resolve a folderId — supports special aliases and cached IDs
async function sfResolveFolder(folderId) {
  if (!folderId || folderId === 'home') return 'home';
  if (folderId === 'top') return 'top';
  if (folderId === 'allshared') return 'allshared';
  if (folderId === 'favorites') return 'favorites';
  if (folderId === 'connectors') return 'connectors';
  return folderId;
}

// Multer — stores uploads in memory (streamed to ShareFile)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
});

// ─────────────────────────────────────────────────────────────────
// SHAREFILE: OAuth2 Flow
// ─────────────────────────────────────────────────────────────────
app.get('/sharefile/auth', (req, res) => {
  const authUrl = `https://secure.sharefile.com/oauth/authorize?` +
    `response_type=code` +
    `&client_id=${SF_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.SHAREFILE_REDIRECT_URI || `https://ark-qbo-server.onrender.com/sharefile/callback`)}` +
    `&state=ark-sf-${Date.now()}`;
  console.log('Redirecting to ShareFile auth:', authUrl);
  res.redirect(authUrl);
});

app.get('/sharefile/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) throw new Error('No authorization code received');

    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      redirect_uri:  process.env.SHAREFILE_REDIRECT_URI || 'https://ark-qbo-server.onrender.com/sharefile/callback',
    });

    const resp = await fetch(`https://${SF_SUBDOMAIN}.sharefile.com/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('Token exchange failed: ' + errText);
    }

    const data = await resp.json();
    sfTokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in * 1000),
      subdomain:     data.subdomain || SF_SUBDOMAIN,
    };
    saveSfTokens();

    console.log('✓ ShareFile connected successfully');
    console.log('  Subdomain:', sfTokens.subdomain);

    res.send(`<!DOCTYPE html>
<html>
<head><title>ShareFile Connected</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1b2a;color:#e8f0f8;">
  <div style="text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">✓</div>
    <h2 style="color:#4dffa0;margin-bottom:8px;">Connected to ShareFile!</h2>
    <p style="color:#8bafc8;">This window will close automatically.</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'sharefile-connected' }, '*');
    }
    setTimeout(() => window.close(), 3000);
  </script>
</body>
</html>`);
  } catch(e) {
    console.error('ShareFile auth error:', e.message);
    res.status(500).send(`<h2 style="color:red;font-family:sans-serif;">ShareFile Connection Failed</h2><p>${e.message}</p>`);
  }
});

app.get('/sharefile/status', (req, res) => {
  res.json({
    connected: sfReady(),
    subdomain: SF_SUBDOMAIN,
    expiresAt: sfTokens?.expires_at ? new Date(sfTokens.expires_at).toISOString() : null,
  });
});

app.post('/sharefile/disconnect', (req, res) => {
  sfTokens = null;
  try { fs.unlinkSync(SF_TOKEN_FILE); } catch(_) {}
  sfFolderCache.clear();
  console.log('ShareFile disconnected');
  res.json({ disconnected: true });
});

// ─────────────────────────────────────────────────────────────────
// FILES: Status — Dashboard checks if file storage is available
// ─────────────────────────────────────────────────────────────────
app.get('/files/status', requireAuth, (req, res) => {
  res.json({ available: sfReady(), provider: 'sharefile', subdomain: SF_SUBDOMAIN });
});

// ─────────────────────────────────────────────────────────────────
// FILES: List — Returns children of a ShareFile folder
// Query params: ?folderId=xxx  OR  ?folderId=home (default root)
// ─────────────────────────────────────────────────────────────────
app.get('/files/list', requireAuth, async (req, res) => {
  if (!sfReady()) return res.status(500).json({ error: 'ShareFile not connected' });

  try {
    const folderId = await sfResolveFolder(req.query.folderId || 'top');
    const data = await sfApi(`/Items(${folderId})?$expand=Children&$select=Id,Name,FileName,CreationDate,FileCount,Children/Id,Children/Name,Children/FileName,Children/CreationDate,Children/FileSizeBytes,Children/ProgenyEditDate,Children/odata.type`);

    const children = data.Children || [];
    const files = [];
    const folders = [];

    children.forEach(item => {
      const isFolder = (item['odata.type'] || '').includes('Folder');
      if (isFolder) {
        folders.push({
          id:   item.Id,
          name: item.Name || item.FileName,
        });
      } else {
        files.push({
          id:       item.Id,
          name:     item.FileName || item.Name,
          size:     item.FileSizeBytes || 0,
          modified: item.ProgenyEditDate || item.CreationDate,
        });
      }
    });

    res.json({
      success: true,
      files,
      folders,
      folderId,
      folderName: data.Name || '',
    });
  } catch (e) {
    console.error('Files list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Upload — Two-step ShareFile upload
// Auth + file type whitelist + audit log
// ─────────────────────────────────────────────────────────────────
app.post('/files/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!sfReady()) return res.status(500).json({ error: 'ShareFile not connected' });
  if (!req.file)  return res.status(400).json({ error: 'No file provided' });

  // File type whitelist check
  if (!isAllowedFile(req.file.originalname)) {
    const ext = req.file.originalname.split('.').pop();
    return res.status(400).json({ error: `File type ".${ext}" is not allowed.` });
  }

  try {
    const parentId   = req.body.folderId || 'home';
    const safeName   = req.file.originalname.replace(/[^a-zA-Z0-9._\-() ]/g, '_');
    const uploadedBy = req.body.uploadedBy || 'Unknown';

    // Step 1: Get upload specification
    const uploadSpec = await sfApi(`/Items(${parentId})/Upload2`, {
      method: 'POST',
      body: JSON.stringify({
        Method:   'standard',
        Raw:      true,
        FileName: safeName,
        FileSize: req.file.size,
      }),
    });

    const chunkUri = uploadSpec.ChunkUri;
    if (!chunkUri) throw new Error('No ChunkUri returned from ShareFile');

    // Step 2: Upload file content
    const headers = await sfGetHeaders();
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' });
    formData.append('File1', blob, safeName);

    const uploadResp = await fetch(chunkUri, {
      method: 'POST',
      body: formData,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      throw new Error('Upload failed: ' + errText);
    }

    auditLog('upload', safeName, req.arkUser, req.ip);
    console.log(`File uploaded to ShareFile: ${safeName} (${(req.file.size / 1024).toFixed(1)} KB) by ${uploadedBy}`);

    res.json({ success: true, name: safeName, size: req.file.size, parentId });
  } catch (e) {
    console.error('File upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Download — Returns ShareFile download URL
// Auth + audit log
// ─────────────────────────────────────────────────────────────────
app.get('/files/download', requireAuth, async (req, res) => {
  if (!sfReady()) return res.status(500).json({ error: 'ShareFile not connected' });

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'File id is required' });

  try {
    const data = await sfApi(`/Items(${id})/Download`, { method: 'GET' });
    // ShareFile returns a redirect URL or the download link
    const url = typeof data === 'string' ? data : (data.DownloadUrl || data.Uri || '');
    auditLog('download', id, req.arkUser, req.ip);
    res.json({ success: true, url, id });
  } catch (e) {
    // ShareFile may redirect directly — handle 302
    if (e.message && e.message.includes('302')) {
      // For redirects, construct the download URL directly
      const headers = await sfGetHeaders();
      const apiBase = `https://${sfTokens.subdomain || SF_SUBDOMAIN}.sf-api.com/sf/v3`;
      const resp = await fetch(`${apiBase}/Items(${id})/Download`, {
        method: 'GET',
        headers,
        redirect: 'manual',
      });
      if (resp.status === 302) {
        const url = resp.headers.get('location');
        auditLog('download', id, req.arkUser, req.ip);
        return res.json({ success: true, url, id });
      }
    }
    console.error('File download error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Delete — Remove a file/folder from ShareFile
// Auth + audit log
// ─────────────────────────────────────────────────────────────────
app.post('/files/delete', requireAuth, async (req, res) => {
  if (!sfReady()) return res.status(500).json({ error: 'ShareFile not connected' });

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Item id is required' });

  try {
    await sfApi(`/Items(${id})`, { method: 'DELETE' });
    sfFolderCache.clear(); // Invalidate cache
    auditLog('delete', id, req.arkUser, req.ip);
    console.log(`ShareFile item deleted: ${id}`);
    res.json({ success: true, id });
  } catch (e) {
    console.error('File delete error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Rename — Update item name in ShareFile
// Auth + audit log
// ─────────────────────────────────────────────────────────────────
app.post('/files/rename', requireAuth, async (req, res) => {
  if (!sfReady()) return res.status(500).json({ error: 'ShareFile not connected' });

  const { id, newName } = req.body;
  if (!id || !newName) return res.status(400).json({ error: 'id and newName are required' });

  try {
    await sfApi(`/Items(${id})`, {
      method: 'PATCH',
      body: JSON.stringify({ Name: newName, FileName: newName }),
    });
    sfFolderCache.clear(); // Invalidate cache
    auditLog('rename', `${id} → ${newName}`, req.arkUser, req.ip);
    console.log(`ShareFile item renamed: ${id} → ${newName}`);
    res.json({ success: true, id, newName });
  } catch (e) {
    console.error('File rename error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Create folder in ShareFile
// Auth + audit log
// ─────────────────────────────────────────────────────────────────
app.post('/files/folder', requireAuth, async (req, res) => {
  if (!sfReady()) return res.status(500).json({ error: 'ShareFile not connected' });

  const { parentId, name } = req.body;
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const parent = parentId || 'home';

  try {
    const folder = await sfApi(`/Items(${parent})/Folder`, {
      method: 'POST',
      body: JSON.stringify({ Name: name, Description: '' }),
    });
    sfFolderCache.clear(); // Invalidate cache
    auditLog('folder', `${parent}/${name}`, req.arkUser, req.ip);
    console.log(`ShareFile folder created: ${name} in ${parent}`);
    res.json({ success: true, id: folder.Id, name: folder.Name });
  } catch (e) {
    console.error('Folder create error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// FILES: Get root folders — Returns ShareFile top-level navigation
// Returns Personal Folders, Shared Folders, Favorites, etc.
// ─────────────────────────────────────────────────────────────────
app.get('/files/roots', requireAuth, async (req, res) => {
  if (!sfReady()) return res.status(500).json({ error: 'ShareFile not connected' });

  try {
    const roots = [];
    // Fetch the standard ShareFile root folders
    const specialFolders = [
      { alias: 'home',      label: 'Personal Folders' },
      { alias: 'allshared', label: 'Shared Folders' },
      { alias: 'favorites', label: 'Favorites' },
      { alias: 'connectors', label: 'Connectors' },
    ];

    for (const sf of specialFolders) {
      try {
        const data = await sfApi(`/Items(${sf.alias})?$select=Id,Name,FileCount,Children&$expand=Children/Id,Children/Name`);
        roots.push({
          id:    sf.alias,
          name:  data.Name || sf.label,
          label: sf.label,
          childCount: (data.Children || []).length,
        });
      } catch(e) {
        // Some folders may not be accessible — skip silently
      }
    }

    res.json({ success: true, roots });
  } catch (e) {
    console.error('Files roots error:', e);
    res.status(500).json({ error: e.message });
  }
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

// ── Admin: Force-reset payroll data from repo copy ───────────────
app.post('/payroll/force-sync', (req, res) => {
  const repoFile = path.join(__dirname, 'payroll-data.json');
  if (!fs.existsSync(repoFile)) return res.status(404).json({ error: 'No repo copy found' });
  try {
    const repoCopy = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
    // Preserve submissions, session tokens, notifications from disk
    repoCopy.submissions = payrollData.submissions || [];
    for (const [slug, client] of Object.entries(repoCopy.clients || {})) {
      const diskClient = payrollData.clients[slug];
      if (diskClient) {
        client._sessionToken = diskClient._sessionToken || null;
        client._notifications = diskClient._notifications || [];
      }
    }
    payrollData = repoCopy;
    savePayrollData();
    const stats = {};
    for (const [slug, client] of Object.entries(payrollData.clients)) {
      stats[slug] = {
        stores: Object.keys(client.stores || {}).length,
        employees: Object.values(client.stores || {}).reduce((s, st) => s + (st.employees || []).length, 0),
      };
    }
    res.json({ success: true, stats });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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

  // Include admin employees in every store so managers show up everywhere
  const adminStore = (client.stores || {}).admin;
  const adminEmps = (adminStore && adminStore.employees || []).map(e => ({
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    position: e.position || '(Admin)',
    payRate: e.payRate || '',
    payType: e.payType || 'hourly',
    isAdmin: true,
  }));

  const storeEmps = (store.employees || []).map(e => ({
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    position: e.position || '',
    payRate: e.payRate || '',
    payType: e.payType || 'hourly',
  }));

  res.json({
    employees: [...adminEmps, ...storeEmps],
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

// ═════════════════════════════════════════════════════════════════
// P&L DIGESTER — AI ANALYSIS + FLEET DATA + HISTORY
// ═════════════════════════════════════════════════════════════════

const PL_HISTORY_FILE = path.join(DATA_DIR, 'pl-history.json');
const FLEET_DATA_FILE = path.join(DATA_DIR, 'fleet-data.json');
const PL_THRESHOLDS_FILE = path.join(DATA_DIR, 'pl-thresholds.json');

// Load persisted data
let plHistory = {};    // { [realmId]: { [period]: { metrics, accounts, date } } }
let fleetData = {};    // { accounts: { [accountName]: { storeCount, totalAmount } }, storeCount: 0 }
let plThresholds = {}; // { _global: {...}, [realmId]: {...} }

function loadJsonFile(filepath, fallback) {
  if (!fs.existsSync(filepath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch(e) { return fallback; }
}
plHistory   = loadJsonFile(PL_HISTORY_FILE, {});
fleetData   = loadJsonFile(FLEET_DATA_FILE, { accounts: {}, storeCount: 0 });
plThresholds = loadJsonFile(PL_THRESHOLDS_FILE, { _global: {} });

function savePlHistory()   { fs.writeFileSync(PL_HISTORY_FILE, JSON.stringify(plHistory, null, 2)); }
function saveFleetData()   { fs.writeFileSync(FLEET_DATA_FILE, JSON.stringify(fleetData, null, 2)); }
function savePlThresholds(){ fs.writeFileSync(PL_THRESHOLDS_FILE, JSON.stringify(plThresholds, null, 2)); }

// ── P&L History CRUD ─────────────────────────────────────────────
app.get('/pl/history/:realmId', (req, res) => {
  res.json({ history: plHistory[req.params.realmId] || {} });
});

app.post('/pl/history/:realmId', (req, res) => {
  const rid = req.params.realmId;
  const { period, metrics, accounts } = req.body;
  if (!period) return res.status(400).json({ error: 'period required' });
  if (!plHistory[rid]) plHistory[rid] = {};
  plHistory[rid][period] = { metrics, accounts, savedAt: new Date().toISOString() };
  savePlHistory();
  res.json({ success: true });
});

app.delete('/pl/history/:realmId/:period', (req, res) => {
  const rid = req.params.realmId;
  if (plHistory[rid]) {
    delete plHistory[rid][req.params.period];
    savePlHistory();
  }
  res.json({ success: true });
});

// ── Fleet Intelligence ───────────────────────────────────────────
app.get('/pl/fleet', (req, res) => {
  res.json({ fleet: fleetData });
});

app.post('/pl/fleet/contribute', (req, res) => {
  const { realmId, accounts } = req.body;
  if (!accounts || !Array.isArray(accounts)) return res.status(400).json({ error: 'accounts array required' });

  // Track which stores have contributed (use realmId as unique store key)
  if (!fleetData._stores) fleetData._stores = {};
  const isNew = !fleetData._stores[realmId];
  fleetData._stores[realmId] = Date.now();
  fleetData.storeCount = Object.keys(fleetData._stores).length;

  // Merge account usage
  for (const acct of accounts) {
    const name = acct.name || acct;
    if (!fleetData.accounts[name]) {
      fleetData.accounts[name] = { storeCount: 0, stores: [] };
    }
    if (!fleetData.accounts[name].stores.includes(realmId)) {
      fleetData.accounts[name].stores.push(realmId);
      fleetData.accounts[name].storeCount = fleetData.accounts[name].stores.length;
    }
  }

  saveFleetData();
  res.json({ success: true, storeCount: fleetData.storeCount });
});

// ── Variance Thresholds ──────────────────────────────────────────
app.get('/pl/thresholds', (req, res) => {
  res.json({ thresholds: plThresholds });
});

app.post('/pl/thresholds', (req, res) => {
  const { realmId, thresholds } = req.body;
  const key = realmId || '_global';
  plThresholds[key] = { ...plThresholds[key], ...thresholds };
  savePlThresholds();
  res.json({ success: true });
});

// ── AI Analysis Endpoint ─────────────────────────────────────────
app.post('/pl/digest', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const { plData, preFlags, summary, history, fleetContext, clientName } = req.body;

  const systemPrompt = `You are a senior forensic bookkeeper reviewing a monthly P&L for a Scooters Coffee franchise store.
You work for ARK Financial Services. Your job is to identify errors, misclassifications, missing items, and anomalies.

RULES:
- Always include dollar amounts and percentages in your explanations
- When flagging a misclassification, suggest the SPECIFIC correct account from the Scooters COA
- Severity levels: CRITICAL (likely error), WARNING (review needed), INFO (informational)
- Be specific — "COGS is 42% of sales ($7,560 / $18,000) which exceeds the 35% benchmark" not "COGS seems high"
- If history data is provided, compare against rolling average and same-month-last-year
- If fleet data is provided, flag accounts that differ from 75%+ of other stores

Known Scooters COA structure:
- Revenue: Store Sales, Catering Income, Tip Income
- COGS: Consumable COGS (Harvest products), Paper COGS, Other COGS
- Royalties/Fees: Royalty Fees (~6% of sales), Ad Fund National (~2%), Ad Fund Local (~1-2%), Technology Fee
- Payroll: Wages, Payroll Taxes, Workers Comp, Health Insurance, 401k, Bonuses
- Occupancy: Rent, CAM, Utilities, Property Tax
- Operating: Bank Charges, Insurance, Repairs, Supplies, Marketing
- ALWAYS FLAG: Uncategorized Expense, Uncategorized Income, Uncategorized Asset, Ask My Accountant, Reconciliation Discrepancies

Return JSON array of flags: [{ severity, category, account, amount, message, suggestedAccount, variance }]`;

  const userPrompt = `Client: ${clientName || 'Unknown'}

P&L Data:
${JSON.stringify(plData, null, 2)}

${preFlags ? `Pre-analysis flags from rule engine:\n${JSON.stringify(preFlags, null, 2)}` : ''}
${summary ? `Summary metrics:\n${JSON.stringify(summary, null, 2)}` : ''}
${history ? `Historical comparison data:\n${JSON.stringify(history, null, 2)}` : ''}
${fleetContext ? `Fleet intelligence (other stores):\n${JSON.stringify(fleetContext, null, 2)}` : ''}

Analyze this P&L and return a JSON array of flags. Each flag: { severity: "CRITICAL"|"WARNING"|"INFO", category: string, account: string, amount: number|null, message: string, suggestedAccount: string|null, variance: string|null }`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: `AI service error: ${response.status}` });
    }

    const aiData = await response.json();
    const content = aiData.content?.[0]?.text || '[]';

    // Try to parse the JSON from the AI response
    let flags = [];
    try {
      // AI sometimes wraps in markdown code blocks
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) flags = JSON.parse(jsonMatch[0]);
    } catch(e) {
      console.error('Failed to parse AI flags:', e.message);
      flags = [{ severity: 'INFO', category: 'System', account: '', amount: null, message: 'AI analysis returned non-parseable results. Raw: ' + content.slice(0, 200), suggestedAccount: null, variance: null }];
    }

    console.log(`  ✓ P&L Digest: ${flags.length} AI flags generated`);
    res.json({ success: true, flags, usage: aiData.usage });

  } catch (e) {
    console.error('P&L Digest error:', e.message);
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// Health check for P&L Digester
app.get('/pl/health', (req, res) => {
  res.json({
    aiConfigured: !!process.env.ANTHROPIC_API_KEY,
    historyStores: Object.keys(plHistory).length,
    fleetStores: fleetData.storeCount || 0,
    thresholdSets: Object.keys(plThresholds).length,
  });
});

// ─────────────────────────────────────────────────────────────────
// Google Calendar Routes
// ─────────────────────────────────────────────────────────────────

// Start Google OAuth flow
app.get('/gcal/auth', (req, res) => {
  const oauth2 = getGCalOAuth2Client();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  res.redirect(url);
});

// OAuth callback
app.get('/gcal/callback', async (req, res) => {
  try {
    const oauth2 = getGCalOAuth2Client();
    const { tokens } = await oauth2.getToken(req.query.code);
    gcalTokens.primary = tokens;
    saveGcalTokens();
    console.log('✓ Google Calendar connected');

    res.send(`<!DOCTYPE html><html><body style="background:#0d1b2a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;">
      <div style="text-align:center;color:#fff;">
        <div style="font-size:48px;margin-bottom:16px;">✅</div>
        <div style="font-size:20px;font-weight:600;">Connected to Google Calendar!</div>
        <div style="font-size:14px;color:#8899aa;margin-top:8px;">This window will close automatically…</div>
      </div>
      <script>
        if(window.opener){ window.opener.postMessage({type:'gcal-connected'},'*'); }
        setTimeout(()=>window.close(), 2000);
      </script>
    </body></html>`);
  } catch(e) {
    console.error('Google Calendar callback error:', e.message);
    res.status(500).send('Authorization failed: ' + e.message);
  }
});

// Status check
app.get('/gcal/status', (req, res) => {
  const connected = !!gcalTokens.primary;
  res.json({ connected });
});

// Disconnect
app.post('/gcal/disconnect', (req, res) => {
  delete gcalTokens.primary;
  saveGcalTokens();
  res.json({ disconnected: true });
});

// Fetch calendar events
app.get('/gcal/events', async (req, res) => {
  try {
    const calendar = await getGCalClient();
    const days = parseInt(req.query.days) || 4;
    const tz = 'America/Chicago';

    // Build time range: start of today → end of (today + days)
    const now = new Date();
    const startOfToday = new Date(now.toLocaleDateString('en-US', { timeZone: tz }));
    const endDate = new Date(startOfToday);
    endDate.setDate(endDate.getDate() + days);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfToday.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: tz,
      maxResults: 100,
    });

    const events = response.data.items || [];
    const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // Group events by date
    const dayMap = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(startOfToday);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      dayMap[dateStr] = {
        date: dateStr,
        label: dayLabels[d.getDay()],
        dayNum: d.getDate(),
        allDay: [],
        events: [],
      };
    }

    for (const ev of events) {
      const isAllDay = !!ev.start.date;
      const dateKey = isAllDay
        ? ev.start.date
        : ev.start.dateTime.slice(0, 10);

      // For multi-day all-day events, add to each day in range
      if (isAllDay && ev.end.date) {
        const s = new Date(ev.start.date + 'T00:00:00');
        const e = new Date(ev.end.date + 'T00:00:00');
        for (let d = new Date(s); d < e; d.setDate(d.getDate() + 1)) {
          const dk = d.toISOString().slice(0, 10);
          if (dayMap[dk]) {
            dayMap[dk].allDay.push({
              summary: ev.summary || '(No title)',
              note: ev.description ? ev.description.slice(0, 80) : '',
              cat: 'personal',
            });
          }
        }
        continue;
      }

      const day = dayMap[dateKey];
      if (!day) continue;

      if (isAllDay) {
        day.allDay.push({
          summary: ev.summary || '(No title)',
          note: '',
          cat: 'personal',
        });
      } else {
        // Extract HH:MM from dateTime (already in tz thanks to timeZone param)
        const startDT = new Date(ev.start.dateTime);
        const endDT = new Date(ev.end.dateTime);
        const fmtTime = (dt) => {
          const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(dt);
          const h = (parts.find(p=>p.type==='hour')||{}).value||'00';
          const m = (parts.find(p=>p.type==='minute')||{}).value||'00';
          return `${h.padStart(2,'0')}:${m.padStart(2,'0')}`;
        };

        // Location handling
        const loc = ev.location || '';
        const isZoom = /zoom\.us|zoom meeting/i.test(loc) || /zoom/i.test(ev.summary || '');
        const isTeams = /teams\.microsoft|teams meeting/i.test(loc);
        const isVirtual = isZoom || isTeams;

        day.events.push({
          summary: ev.summary || '(No title)',
          start: fmtTime(startDT),
          end: fmtTime(endDT),
          cat: 'personal',
          note: isVirtual ? (isZoom ? 'Zoom' : 'Teams meeting') : (loc ? loc.slice(0, 60) : ''),
          loc: loc ? loc.slice(0, 80) : '',
          locIcon: isVirtual ? '💻' : (loc ? '📍' : ''),
          zoom: isZoom && ev.hangoutLink ? ev.hangoutLink : (isZoom && loc.match(/https:\/\/[^\s]+/) ? loc.match(/https:\/\/[^\s]+/)[0] : ''),
        });
      }
    }

    res.json({
      days: Object.values(dayMap),
      fetchedAt: new Date().toISOString(),
    });
  } catch(e) {
    if (e.message.includes('not connected') || e.message.includes('reconnect')) {
      return res.status(401).json({ error: 'not_connected' });
    }
    console.error('Google Calendar fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// DATABASE: Server-side persistent storage for dashboard data
// Both users share the same ark-db.json on disk
// ─────────────────────────────────────────────────────────────────
const ARK_DB_FILE = path.join(DATA_DIR, 'ark-db.json');

app.get('/db/load', requireAuth, (req, res) => {
  try {
    if (fs.existsSync(ARK_DB_FILE)) {
      const raw = fs.readFileSync(ARK_DB_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.log(`DB loaded by ${req.arkUser.userName} (${(raw.length / 1024).toFixed(1)} KB)`);
      res.json(data);
    } else {
      console.log(`DB load: no ark-db.json yet (${req.arkUser.userName})`);
      res.json(null);
    }
  } catch (e) {
    console.error('DB load error:', e.message);
    res.status(500).json({ error: 'Failed to load database' });
  }
});

app.post('/db/save', requireAuth, (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid DB payload' });
    }

    // Conflict detection (informational — last write wins)
    if (fs.existsSync(ARK_DB_FILE)) {
      try {
        const existing = JSON.parse(fs.readFileSync(ARK_DB_FILE, 'utf8'));
        if (existing._savedAt && payload._savedAt &&
            new Date(existing._savedAt) > new Date(payload._savedAt)) {
          console.warn(`DB conflict: ${req.arkUser.userName} overwrote newer data ` +
            `(server: ${existing._savedAt}, client: ${payload._savedAt})`);
        }
      } catch (_) { /* ignore parse errors on existing file */ }
    }

    payload._savedAt = new Date().toISOString();
    payload._savedBy = req.arkUser.userName;
    fs.writeFileSync(ARK_DB_FILE, JSON.stringify(payload));
    console.log(`DB saved by ${req.arkUser.userName} at ${payload._savedAt} (${(JSON.stringify(payload).length / 1024).toFixed(1)} KB)`);
    res.json({ success: true, savedAt: payload._savedAt });
  } catch (e) {
    console.error('DB save error:', e.message);
    res.status(500).json({ error: 'Failed to save database' });
  }
});

// ─────────────────────────────────────────────────────────────────
// Start listening
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ARK QBO Server running on http://localhost:${PORT}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  const faxOk = SINCH.fax.keyId ? '✓' : '✗';
  const smsOk = SINCH.sms.apiToken ? '✓' : '✗';
  const sfOk  = sfReady() ? '✓' : (SF_CLIENT_ID ? '○' : '✗');
  const aiOk  = process.env.ANTHROPIC_API_KEY ? '✓' : '✗';
  const gcalOk = gcalTokens.primary ? '✓' : '✗';
  console.log(`  Sinch Fax: ${faxOk}  |  Sinch SMS: ${smsOk}  |  ShareFile: ${sfOk}  |  AI: ${aiOk}  |  GCal: ${gcalOk}`);
});
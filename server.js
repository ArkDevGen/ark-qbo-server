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
const bcrypt      = require('bcryptjs');
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
// USER AUTHENTICATION & MANAGEMENT
// Per-user login with username/password, bcrypt hashing, role-based access
// ─────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let _users = [];

// Load users from file
if (fs.existsSync(USERS_FILE)) {
  try {
    _users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    console.log(`✓ Users loaded — ${_users.length} user(s)`);
  } catch (e) { console.log('Could not load users:', e.message); }
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(_users, null, 2));
}

function findUser(username) {
  return _users.find(u => u.username.toLowerCase() === username.toLowerCase() && (u.status||'').toLowerCase() === 'active');
}

function safeUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

const DEFAULT_PERMISSIONS = {
  admin: { canEditClients:true, canDeleteClients:true, canViewFiles:true, canUploadFiles:true, canDeleteFiles:true, canRunPayroll:true, canPushQBO:true, canManageUsers:true },
  am:    { canEditClients:true, canDeleteClients:false, canViewFiles:true, canUploadFiles:true, canDeleteFiles:false, canRunPayroll:true, canPushQBO:true, canManageUsers:false },
  pm:    { canEditClients:false, canDeleteClients:false, canViewFiles:true, canUploadFiles:true, canDeleteFiles:false, canRunPayroll:true, canPushQBO:false, canManageUsers:false },
  viewer:{ canEditClients:false, canDeleteClients:false, canViewFiles:true, canUploadFiles:false, canDeleteFiles:false, canRunPayroll:false, canPushQBO:false, canManageUsers:false },
};

// ─── Sessions ────────────────────────────────────────────────────
const _sessions = new Map(); // token → { userId, userName, role, user, createdAt }
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of _sessions) {
    if (now - session.createdAt > SESSION_TTL) _sessions.delete(token);
  }
}, 3600000);

// ─── Seed initial admin user (one-time) ──────────────────────────
app.post('/auth/seed', async (req, res) => {
  if (_users.length > 0) return res.json({ message: 'Users already exist', count: _users.length });

  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ARK_API_KEY not set' });

  const hash = await bcrypt.hash(apiKey, 10);
  const admin = {
    id: 'usr_' + crypto.randomUUID().slice(0, 8),
    username: 'jacob',
    passwordHash: hash,
    fname: 'Jacob',
    lname: 'Malousek',
    email: 'jacob@arkfinancialservices.com',
    role: 'admin',
    title: 'Owner / Admin',
    phone: '',
    color: '#1a2440',
    status: 'Active',
    assignedClients: [],
    permissions: { ...DEFAULT_PERMISSIONS.admin },
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };
  _users.push(admin);
  saveUsers();
  console.log('✓ Seeded initial admin user: jacob');
  res.json({ success: true, message: 'Admin user created', username: 'jacob' });
});

// ─── Login ───────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { username, password, apiKey, userId, userName, role } = req.body;

  // === NEW: Username + password login ===
  if (username && password) {
    const user = findUser(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    // Update last login
    user.lastLogin = new Date().toISOString();
    saveUsers();

    const token = crypto.randomUUID();
    _sessions.set(token, {
      userId: user.id,
      userName: `${user.fname} ${user.lname}`,
      role: user.role,
      user: safeUser(user),
      createdAt: Date.now(),
    });

    console.log(`Auth: ${user.fname} ${user.lname} logged in (${user.role})`);
    return res.json({ success: true, token, user: safeUser(user) });
  }

  // === LEGACY: API key login (backward compat) ===
  if (apiKey) {
    if (apiKey !== process.env.ARK_API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    if (!userId || !userName) {
      return res.status(400).json({ error: 'User info required' });
    }

    const token = crypto.randomUUID();
    const legacyUser = {
      id: userId,
      username: userId,
      fname: userName.split(' ')[0] || userName,
      lname: userName.split(' ').slice(1).join(' ') || '',
      role: role || 'admin',
      permissions: { ...DEFAULT_PERMISSIONS.admin },
      status: 'Active',
    };
    _sessions.set(token, {
      userId,
      userName,
      role: role || 'admin',
      user: legacyUser,
      createdAt: Date.now(),
    });

    console.log(`Auth (legacy): session created for ${userName}`);
    return res.json({ success: true, token, user: legacyUser });
  }

  return res.status(400).json({ error: 'Username/password or API key required' });
});

// ─── Logout ──────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) _sessions.delete(token);
  res.json({ success: true });
});

// ─── Verify password (for revealing sensitive fields) ────────────
app.post('/auth/verify-password', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const session = _sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Try matching against user's own password first
  const user = _users.find(u => u.id === session.userId);
  let verified = false;
  if (user) {
    verified = await bcrypt.compare(password, user.passwordHash);
  }
  // Fallback: check against API key
  if (!verified) {
    verified = password === process.env.ARK_API_KEY;
  }

  if (verified) console.log(`Password verified for ${session.userName}`);
  res.json({ verified });
});

// ─── Change own password ─────────────────────────────────────────
app.post('/auth/change-password', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const session = _sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = _users.find(u => u.id === session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  saveUsers();
  console.log(`Password changed for ${user.fname} ${user.lname}`);
  res.json({ success: true });
});

// ─── Auth middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token || '';
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const session = _sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });

  if (Date.now() - session.createdAt > SESSION_TTL) {
    _sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  req.arkUser = session;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.arkUser) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.arkUser.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

// ─── Emergency password reset (requires API key) ────────────────
app.post('/auth/reset-password', async (req, res) => {
  const { apiKey, username, newPassword } = req.body;
  if (!apiKey || apiKey !== process.env.ARK_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  if (!username || !newPassword) return res.status(400).json({ error: 'Username and newPassword required' });
  const user = _users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  saveUsers();
  console.log(`Emergency password reset for ${user.fname} ${user.lname}`);
  res.json({ success: true, message: `Password reset for ${username}` });
});

// ─── User CRUD (admin only) ─────────────────────────────────────
app.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ users: _users.map(safeUser) });
});

app.get('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const user = _users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(safeUser(user));
});

app.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, fname, lname, email, phone, role, title, color, assignedClients, permissions } = req.body;

  if (!username || !password || !fname || !lname) {
    return res.status(400).json({ error: 'Username, password, first name, and last name are required' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (_users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const validRoles = ['admin', 'am', 'pm', 'viewer'];
  const userRole = validRoles.includes(role) ? role : 'am';

  const newUser = {
    id: 'usr_' + crypto.randomUUID().slice(0, 8),
    username: username.toLowerCase().replace(/\s/g, ''),
    passwordHash: await bcrypt.hash(password, 10),
    fname, lname,
    email: email || '',
    phone: phone || '',
    role: userRole,
    title: title || '',
    color: color || '#1a2440',
    status: 'Active',
    assignedClients: assignedClients || [],
    permissions: permissions || { ...DEFAULT_PERMISSIONS[userRole] },
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };

  _users.push(newUser);
  saveUsers();
  console.log(`User created: ${fname} ${lname} (${username}, ${userRole}) by ${req.arkUser.userName}`);
  res.json({ success: true, user: safeUser(newUser) });
});

app.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const user = _users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { fname, lname, email, phone, role, title, color, status, assignedClients, permissions, newPassword } = req.body;

  if (fname !== undefined) user.fname = fname;
  if (lname !== undefined) user.lname = lname;
  if (email !== undefined) user.email = email;
  if (phone !== undefined) user.phone = phone;
  if (title !== undefined) user.title = title;
  if (color !== undefined) user.color = color;
  if (status !== undefined) user.status = status;
  if (role && ['admin', 'am', 'viewer'].includes(role)) user.role = role;
  if (assignedClients !== undefined) user.assignedClients = assignedClients;
  if (permissions !== undefined) user.permissions = permissions;
  if (newPassword && newPassword.length >= 6) {
    user.passwordHash = await bcrypt.hash(newPassword, 10);
  }

  saveUsers();
  console.log(`User updated: ${user.fname} ${user.lname} by ${req.arkUser.userName}`);
  res.json({ success: true, user: safeUser(user) });
});

app.delete('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const user = _users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Don't delete, just deactivate
  user.status = 'Inactive';
  saveUsers();
  console.log(`User deactivated: ${user.fname} ${user.lname} by ${req.arkUser.userName}`);
  res.json({ success: true });
});

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
// ROUTE 3c-pre: Clear all stale linkedClients (keeps QBO connections)
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/clear-links', (req, res) => {
  let cleared = 0;
  for (const rid of Object.keys(tokenStore)) {
    if (tokenStore[rid].linkedClients?.length) {
      cleared += tokenStore[rid].linkedClients.length;
      tokenStore[rid].linkedClients = [];
    }
  }
  saveTokenStore();
  console.log(`Cleared ${cleared} stale client links across ${Object.keys(tokenStore).length} companies`);
  res.json({ success: true, cleared });
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

  // ── Action: Get Customers ────────────────────────────────────
  } else if (action === 'getCustomers') {
    qbo.findCustomers({ Active: true }, (err, data) => {
      if (err) return res.status(500).json({ error: err.message || 'Failed to fetch customers' });
      const customers = (data.QueryResponse?.Customer || []).map(c => ({
        id:      c.Id,
        name:    c.DisplayName,
        email:   c.PrimaryEmailAddr?.Address || '',
        phone:   c.PrimaryPhone?.FreeFormNumber || '',
        balance: c.Balance || 0,
      }));
      console.log(`  Returned ${customers.length} customers`);
      res.json({ success: true, customers });
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
    annualRate: e.annualRate || '',
    periodRate: e.periodRate || '',
    isAdmin: true,
  }));

  const storeEmps = (store.employees || []).map(e => ({
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    position: e.position || '',
    payRate: e.payRate || '',
    payType: e.payType || 'hourly',
    annualRate: e.annualRate || '',
    periodRate: e.periodRate || '',
  }));

  res.json({
    employees: [...adminEmps, ...storeEmps],
  });
});

// ── Get all employees across all stores (for Find Employee) ──────
app.get('/payroll/employees-all/:clientSlug', (req, res) => {
  const { clientSlug } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');

  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const allEmps = [];
  const seen = new Set();
  for (const [storeId, store] of Object.entries(client.stores || {})) {
    for (const emp of (store.employees || [])) {
      // Deduplicate by employee ID
      if (seen.has(emp.id)) {
        // Add this store to existing entry
        const existing = allEmps.find(e => e.id === emp.id);
        if (existing && !existing.stores.includes(storeId)) existing.stores.push(storeId);
        continue;
      }
      seen.add(emp.id);
      allEmps.push({
        id: emp.id,
        firstName: emp.firstName,
        lastName: emp.lastName,
        position: emp.position || '',
        payRate: emp.payRate || '',
        payType: emp.payType || 'hourly',
        stores: [storeId],
      });
    }
  }

  res.json({ employees: allEmps });
});

// ── Link existing employee to another store ──────────────────────
app.post('/payroll/employees/:clientSlug/:storeId/link', (req, res) => {
  const { clientSlug, storeId } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');

  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const store = (client.stores || {})[storeId];
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const { employeeId } = req.body;
  if (!employeeId) return res.status(400).json({ error: 'employeeId required' });

  // Find the employee in any store
  let sourceEmp = null;
  for (const [sid, s] of Object.entries(client.stores || {})) {
    const found = (s.employees || []).find(e => e.id === employeeId);
    if (found) { sourceEmp = found; break; }
  }
  if (!sourceEmp) return res.status(404).json({ error: 'Employee not found' });

  // Check if already in this store
  if ((store.employees || []).some(e => e.id === employeeId)) {
    return res.status(409).json({ error: 'Employee already in this store' });
  }

  // Add a copy to this store
  if (!store.employees) store.employees = [];
  store.employees.push({ ...sourceEmp });
  savePayrollData();

  console.log(`Linked employee ${sourceEmp.firstName} ${sourceEmp.lastName} to store ${storeId} (${clientSlug})`);
  res.json({ success: true, employee: { id: sourceEmp.id, firstName: sourceEmp.firstName, lastName: sourceEmp.lastName, position: sourceEmp.position } });
});

// ── Payroll Admin Portal ─────────────────────────────────────────
app.get('/payroll-admin', (req, res) => {
  res.sendFile(__dirname + '/public/payroll-admin.html');
});

// Get all payroll data (admin only — requires valid CRM session)
app.get('/payroll/admin/data', requireAuth, (req, res) => {
  // Strip sensitive fields like passwords and session tokens before sending
  const safe = { clients: {} };
  for (const [slug, client] of Object.entries(payrollData.clients || {})) {
    const { _sessionToken, ...rest } = client;
    safe.clients[slug] = rest;
  }
  res.json(safe);
});

// Add employee (admin)
app.post('/payroll/admin/employee', requireAuth, (req, res) => {
  const { clientSlug, storeId, employee } = req.body;
  if (!clientSlug || !storeId || !employee) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = payrollData.clients[clientSlug];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const store = client.stores?.[storeId];
  if (!store) return res.status(404).json({ error: 'Store not found' });

  if (!store.employees) store.employees = [];

  const newEmp = {
    id: crypto.randomUUID(),
    firstName: employee.firstName || '',
    lastName: employee.lastName || '',
    position: employee.position || '',
    payRate: employee.payRate || '',
    payType: employee.payType || 'hourly',
    annualRate: employee.annualRate || '',
    periodRate: employee.periodRate || '',
    email: employee.email || '',
  };

  store.employees.push(newEmp);
  savePayrollData();

  console.log(`Admin added employee ${newEmp.firstName} ${newEmp.lastName} to ${clientSlug}/${storeId}`);
  res.json({ success: true, employee: newEmp });
});

// Update employee (admin)
app.put('/payroll/admin/employee', requireAuth, (req, res) => {
  const { clientSlug, storeId, empIdx, updates } = req.body;
  if (!clientSlug || !storeId || empIdx === undefined || !updates) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = payrollData.clients[clientSlug];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const store = client.stores?.[storeId];
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const emp = store.employees?.[empIdx];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  // Apply updates
  if (updates.firstName) emp.firstName = updates.firstName;
  if (updates.lastName) emp.lastName = updates.lastName;
  if (updates.position !== undefined) emp.position = updates.position;
  if (updates.payRate !== undefined) emp.payRate = updates.payRate;
  if (updates.payType) emp.payType = updates.payType;
  if (updates.annualRate !== undefined) emp.annualRate = updates.annualRate;
  if (updates.periodRate !== undefined) emp.periodRate = updates.periodRate;
  if (updates.email !== undefined) emp.email = updates.email;

  savePayrollData();
  console.log(`Admin updated employee ${emp.firstName} ${emp.lastName} in ${clientSlug}/${storeId}`);
  res.json({ success: true });
});

// Delete employee (admin)
app.delete('/payroll/admin/employee', requireAuth, (req, res) => {
  const { clientSlug, storeId, empIdx } = req.body;
  if (!clientSlug || !storeId || empIdx === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = payrollData.clients[clientSlug];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const store = client.stores?.[storeId];
  if (!store?.employees?.[empIdx]) return res.status(404).json({ error: 'Employee not found' });

  const removed = store.employees.splice(empIdx, 1)[0];
  savePayrollData();
  console.log(`Admin removed employee ${removed.firstName} ${removed.lastName} from ${clientSlug}/${storeId}`);
  res.json({ success: true });
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
const PL_ANTICIPATED_FILE = path.join(DATA_DIR, 'pl-anticipated.json');

// Load persisted data
let plHistory = {};       // { [realmId]: { [period]: { metrics, accounts, savedAt } } }
let fleetData = {};       // { accounts: { [name]: { storeCount, stores, amounts, avgPct, minPct, maxPct } }, storeCount: 0 }
let plThresholds = {};    // { _global: {...}, [realmId]: {...} }
let plAnticipated = {};   // { _templates: { scooters: [...] }, [realmId]: [...] }

function loadJsonFile(filepath, fallback) {
  if (!fs.existsSync(filepath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch(e) { return fallback; }
}
plHistory    = loadJsonFile(PL_HISTORY_FILE, {});
fleetData    = loadJsonFile(FLEET_DATA_FILE, { accounts: {}, storeCount: 0 });
plThresholds = loadJsonFile(PL_THRESHOLDS_FILE, { _global: {} });
plAnticipated = loadJsonFile(PL_ANTICIPATED_FILE, {
  _templates: {
    scooters: [
      { name: 'Rent', amount: 2500, pctOfSales: null, tolerance: 0.10 },
      { name: 'Royalty Fees', amount: null, pctOfSales: 0.06, tolerance: 0.15 },
      { name: 'Ad Fund National', amount: null, pctOfSales: 0.02, tolerance: 0.20 },
      { name: 'Technology Fee', amount: 250, pctOfSales: null, tolerance: 0.15 },
      { name: 'Payroll:Wages', amount: null, pctOfSales: 0.30, tolerance: 0.20 },
      { name: 'Payroll:Payroll Taxes', amount: null, pctOfSales: 0.04, tolerance: 0.25 },
      { name: 'Cost of Goods Sold', amount: null, pctOfSales: 0.28, tolerance: 0.20 },
      { name: 'Insurance', amount: 800, pctOfSales: null, tolerance: 0.15 },
      { name: 'Utilities', amount: 600, pctOfSales: null, tolerance: 0.25 },
      { name: 'Phone', amount: 200, pctOfSales: null, tolerance: 0.20 },
    ],
  },
});

function savePlHistory()    { fs.writeFileSync(PL_HISTORY_FILE, JSON.stringify(plHistory, null, 2)); }
function saveFleetData()    { fs.writeFileSync(FLEET_DATA_FILE, JSON.stringify(fleetData, null, 2)); }
function savePlThresholds() { fs.writeFileSync(PL_THRESHOLDS_FILE, JSON.stringify(plThresholds, null, 2)); }
function savePlAnticipated(){ fs.writeFileSync(PL_ANTICIPATED_FILE, JSON.stringify(plAnticipated, null, 2)); }

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
  const { realmId, accounts, revenue } = req.body;
  if (!accounts || !Array.isArray(accounts)) return res.status(400).json({ error: 'accounts array required' });

  // Track which stores have contributed
  if (!fleetData._stores) fleetData._stores = {};
  fleetData._stores[realmId] = Date.now();
  fleetData.storeCount = Object.keys(fleetData._stores).length;

  const totalRevenue = revenue || 1; // avoid div by zero

  // Merge account usage with dollar amounts and percentages
  for (const acct of accounts) {
    const name = acct.name || acct;
    const amount = acct.amount || 0;
    if (!fleetData.accounts[name]) {
      fleetData.accounts[name] = { storeCount: 0, stores: [], amounts: {} };
    }
    if (!fleetData.accounts[name].amounts) fleetData.accounts[name].amounts = {};

    if (!fleetData.accounts[name].stores.includes(realmId)) {
      fleetData.accounts[name].stores.push(realmId);
      fleetData.accounts[name].storeCount = fleetData.accounts[name].stores.length;
    }

    // Store this store's amount and % of revenue
    fleetData.accounts[name].amounts[realmId] = {
      amount: Math.abs(amount),
      pctOfRevenue: totalRevenue > 1 ? Math.abs(amount) / totalRevenue : 0,
      updatedAt: new Date().toISOString(),
    };

    // Recalculate fleet-wide stats for this account
    const storeAmounts = Object.values(fleetData.accounts[name].amounts);
    const pcts = storeAmounts.map(s => s.pctOfRevenue).filter(p => p > 0);
    if (pcts.length) {
      fleetData.accounts[name].avgPct = pcts.reduce((s, p) => s + p, 0) / pcts.length;
      fleetData.accounts[name].minPct = Math.min(...pcts);
      fleetData.accounts[name].maxPct = Math.max(...pcts);
      fleetData.accounts[name].avgAmount = storeAmounts.reduce((s, a) => s + a.amount, 0) / storeAmounts.length;
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
    anticipatedStores: Object.keys(plAnticipated).filter(k => k !== '_templates').length,
  });
});

// ── Anticipated Expenses ─────────────────────────────────────────
app.get('/pl/anticipated/templates', (req, res) => {
  const templates = plAnticipated._templates || {};
  res.json({ templates });
});

app.get('/pl/anticipated/:realmId', (req, res) => {
  const expenses = plAnticipated[req.params.realmId] || [];
  const templates = Object.keys(plAnticipated._templates || {});
  res.json({ expenses, templates });
});

app.post('/pl/anticipated/apply-template', (req, res) => {
  const { realmId, templateName } = req.body;
  if (!realmId || !templateName) return res.status(400).json({ error: 'realmId and templateName required' });
  const template = (plAnticipated._templates || {})[templateName];
  if (!template) return res.status(404).json({ error: `Template "${templateName}" not found` });
  // Merge: keep existing custom entries, add template ones that don't already exist
  const existing = plAnticipated[realmId] || [];
  const existingNames = new Set(existing.map(e => e.name.toLowerCase()));
  const merged = [...existing];
  for (const item of template) {
    if (!existingNames.has(item.name.toLowerCase())) {
      merged.push({ ...item });
    }
  }
  plAnticipated[realmId] = merged;
  savePlAnticipated();
  res.json({ success: true, expenses: merged });
});

app.post('/pl/anticipated/:realmId', (req, res) => {
  const { expenses } = req.body;
  if (!Array.isArray(expenses)) return res.status(400).json({ error: 'expenses array required' });
  plAnticipated[req.params.realmId] = expenses;
  savePlAnticipated();
  res.json({ success: true });
});

// ── Two-Pass AI Analysis (v2) ────────────────────────────────────

// Pass 1: Structural Analysis — forensic bookkeeper findings
app.post('/pl/digest/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { plData, preFlags, summary, history, fleetContext, anticipated, clientName, period } = req.body;

  const systemPrompt = `You are a senior forensic bookkeeper and financial analyst reviewing a monthly P&L for a Scooters Coffee franchise store. You work for ARK Financial Services. Your job is to find EVERYTHING that is wrong, missing, unusual, or noteworthy.

You have access to:
- The current month's P&L (account-level data with amounts)
- Up to 6 months of historical P&L data for this specific store
- Fleet-wide averages across all Scooters stores ARK manages
- A list of anticipated/expected monthly expenses configured for this store
- Pre-flags from our automated rule engine

YOUR ANALYSIS MUST COVER:

1. MISSING EXPENSES: Compare against anticipated expenses list AND historical patterns. If rent has posted every month for 6 months but not this month, that's a CRITICAL flag. If an anticipated expense of $2,500/mo for rent is missing, flag it.

2. VARIANCE ALERTS: For each account, compare the current amount against:
   - The store's own rolling 6-month average (flag >25% variance)
   - The fleet average % of revenue (flag if this store is an outlier)
   - The anticipated/expected amount if configured

3. TREND FINDINGS: Look for multi-month patterns:
   - Revenue growth or decline trends
   - Expense creep (payroll slowly climbing as % of sales over months)
   - Seasonal patterns that might explain current variances
   - Deteriorating or improving margins

4. ANOMALIES: Transactions or accounts that don't belong:
   - Accounts that should always be zero (Uncategorized, Ask My Accountant, Reconciliation Discrepancies)
   - Unusual account names that might be misclassified
   - Amounts that seem unreasonable for a coffee franchise ($50k in "Repairs"?)

5. FLEET COMPARISONS: How does this store compare to peers?
   - Flag any metric where this store is >1 standard deviation from fleet average
   - Note where this store outperforms or underperforms

6. NEW/DISAPPEARED ACCOUNTS: Accounts that appeared for the first time this month or disappeared.

RULES:
- ALWAYS include dollar amounts AND percentages in your explanations
- When flagging a misclassification, suggest the SPECIFIC correct account
- Be specific: "$7,560 COGS is 42% of $18,000 sales, exceeding the 35% benchmark" not "COGS seems high"
- Severity: CRITICAL (likely error or missing item), WARNING (review needed), INFO (informational/trend)

Return a JSON object with this EXACT structure:
{
  "missingExpenses": [{ "severity": "CRITICAL|WARNING", "account": "name", "expectedAmount": number|null, "message": "detailed explanation" }],
  "varianceAlerts": [{ "severity": "CRITICAL|WARNING", "account": "name", "currentAmount": number, "expectedAmount": number, "variance": "string", "message": "explanation" }],
  "trendFindings": [{ "severity": "WARNING|INFO", "metric": "name", "direction": "up|down|stable", "message": "explanation with numbers" }],
  "anomalies": [{ "severity": "CRITICAL|WARNING|INFO", "account": "name", "amount": number|null, "message": "explanation", "suggestedAccount": "string|null" }],
  "fleetComparisons": [{ "severity": "WARNING|INFO", "metric": "name", "storeValue": "string", "fleetAvg": "string", "message": "explanation" }],
  "newAccounts": [{ "severity": "INFO|WARNING", "account": "name", "amount": number, "message": "explanation" }],
  "disappearedAccounts": [{ "severity": "WARNING|INFO", "account": "name", "lastAmount": number|null, "message": "explanation" }]
}`;

  const userPrompt = `Client: ${clientName || 'Unknown'}
Period: ${period || 'Unknown'}

CURRENT MONTH P&L DATA:
${JSON.stringify(plData, null, 2)}

SUMMARY METRICS:
${JSON.stringify(summary || {}, null, 2)}

${anticipated && anticipated.length ? `ANTICIPATED MONTHLY EXPENSES (configured by AM):
${JSON.stringify(anticipated, null, 2)}` : 'No anticipated expenses configured.'}

${preFlags && preFlags.length ? `RULE ENGINE PRE-FLAGS:
${JSON.stringify(preFlags, null, 2)}` : ''}

${history ? `HISTORICAL DATA (up to 6 months):
${JSON.stringify(history, null, 2)}` : 'No historical data available.'}

${fleetContext ? `FLEET DATA (all Scooters stores):
${JSON.stringify(fleetContext, null, 2)}` : 'No fleet data available.'}

Analyze this P&L thoroughly and return the structured JSON object.`;

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
      console.error('Anthropic API error (analyze):', response.status, errBody);
      return res.status(502).json({ error: `AI service error: ${response.status}` });
    }

    const aiData = await response.json();
    const content = aiData.content?.[0]?.text || '{}';

    let findings = {};
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) findings = JSON.parse(jsonMatch[0]);
    } catch(e) {
      console.error('Failed to parse AI findings:', e.message);
      findings = { anomalies: [{ severity: 'INFO', account: '', amount: null, message: 'AI analysis returned non-parseable results.', suggestedAccount: null }] };
    }

    console.log(`  ✓ P&L Analyze (Pass 1): ${Object.values(findings).flat().length} total findings`);
    res.json({ success: true, findings, usage: aiData.usage });

  } catch (e) {
    console.error('P&L Analyze error:', e.message);
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// Pass 2: Meeting Prep — client-facing insights and talking points
app.post('/pl/digest/meeting-prep', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { findings, summary, clientName, period } = req.body;

  const systemPrompt = `You are a senior financial advisor at ARK Financial Services preparing a client meeting brief for a Scooters Coffee franchise owner. The owner is NOT an accountant — they understand their business but need financial information presented clearly and actionably.

Your job is to take the forensic analysis findings and translate them into:

1. EXECUTIVE SUMMARY: 2-3 sentences that give the owner the big picture. Start with the headline (good month? bad month? something needs attention?). Include the key numbers they care about: sales, net income, and the most important variance.

2. TALKING POINTS: 5-8 bullet points the ARK account manager should bring up in the meeting. Each should be specific, actionable, and include dollar amounts. Frame negatives as opportunities. Examples:
   - "Sales were $52,400, up 8% from last month — great momentum heading into summer"
   - "COGS hit 34% this month vs your usual 28% — that's an extra $3,120. Let's review vendor invoices"
   - "Rent didn't post this month — this is likely a timing issue but let's confirm with the landlord"

3. CLIENT INSIGHTS: 3-5 observations phrased FOR THE CLIENT (the owner), in plain English. These go in the PDF they receive. No accounting jargon. Focus on what matters for running their business.

4. ACTION ITEMS: Specific next steps for the AM or client. Be concrete: "Review the $4,200 in Uncategorized Expenses and reclassify before month-end" not "Clean up categorization."

Return a JSON object:
{
  "executiveSummary": "string",
  "talkingPoints": ["string", ...],
  "clientInsights": ["string", ...],
  "actionItems": ["string", ...]
}`;

  const userPrompt = `Client: ${clientName || 'Unknown'}
Period: ${period || 'Unknown'}

SUMMARY METRICS:
${JSON.stringify(summary || {}, null, 2)}

FORENSIC ANALYSIS FINDINGS:
${JSON.stringify(findings, null, 2)}

Generate the meeting prep brief.`;

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
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error (meeting-prep):', response.status, errBody);
      return res.status(502).json({ error: `AI service error: ${response.status}` });
    }

    const aiData = await response.json();
    const content = aiData.content?.[0]?.text || '{}';

    let prep = {};
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) prep = JSON.parse(jsonMatch[0]);
    } catch(e) {
      console.error('Failed to parse meeting prep:', e.message);
      prep = { executiveSummary: 'Meeting prep generation failed.', talkingPoints: [], clientInsights: [], actionItems: [] };
    }

    console.log(`  ✓ P&L Meeting Prep (Pass 2): ${(prep.talkingPoints||[]).length} talking points`);
    res.json({ success: true, prep, usage: aiData.usage });

  } catch (e) {
    console.error('P&L Meeting Prep error:', e.message);
    res.status(500).json({ error: 'Meeting prep failed: ' + e.message });
  }
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
    const offset = parseInt(req.query.offset) || 0; // days to shift from today (negative = past, positive = future)
    const tz = 'America/Chicago';

    // Build time range: start of (today + offset) → end of (today + offset + days)
    const now = new Date();
    const startOfToday = new Date(now.toLocaleDateString('en-US', { timeZone: tz }));
    startOfToday.setDate(startOfToday.getDate() + offset);
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
// SCOOTER'S: Sales Journal Entry Parser
// Reads Power BI Excel export → builds JE payloads for each franchise
// ─────────────────────────────────────────────────────────────────
const XLSX = require('xlsx');

// Load Scooter's config files
const SCOOTERS_CONFIG_DIR = path.join(__dirname, 'config');
let FRANCHISE_MAP = {}, ACCOUNT_PRESETS = {}, ROYALTY_OVERRIDES = {};
try {
  FRANCHISE_MAP = JSON.parse(fs.readFileSync(path.join(SCOOTERS_CONFIG_DIR, 'franchises.json'), 'utf8'));
  ACCOUNT_PRESETS = JSON.parse(fs.readFileSync(path.join(SCOOTERS_CONFIG_DIR, 'account_presets.json'), 'utf8'));
  ROYALTY_OVERRIDES = JSON.parse(fs.readFileSync(path.join(SCOOTERS_CONFIG_DIR, 'royalty_overrides.json'), 'utf8'));
  console.log(`✓ Scooter's config loaded — ${Object.keys(FRANCHISE_MAP).length} franchises`);
} catch (e) {
  console.log('Scooter\'s config not loaded:', e.message);
}

function sjeGetAccount(key, franchiseKey) {
  const presetName = FRANCHISE_MAP[franchiseKey]?.account_preset;
  if (presetName && ACCOUNT_PRESETS[presetName]?.[key]) return ACCOUNT_PRESETS[presetName][key];
  if (ACCOUNT_PRESETS.default?.[key]) return ACCOUNT_PRESETS.default[key];
  return key;
}

function sjeGetRoyaltyRate(franchiseKey, storeId) {
  const override = ROYALTY_OVERRIDES[franchiseKey];
  if (typeof override === 'object' && override !== null && !Array.isArray(override)) {
    if (storeId && override[storeId] !== undefined) return override[storeId];
    return ROYALTY_OVERRIDES.default_rate || 0.06;
  }
  if (override !== undefined && override !== null) return override;
  return ROYALTY_OVERRIDES.default_rate || 0.06;
}

function sjeGetAdFundRate() { return ROYALTY_OVERRIDES.ad_fund_rate || 0.02; }

function sjeFindColumn(headers, possibleNames) {
  for (const col of headers) {
    const lower = String(col).toLowerCase().trim();
    for (const p of possibleNames) {
      if (lower.includes(p.toLowerCase())) return col;
    }
  }
  return null;
}

function sjeBuildEntry(row, franchiseKey, className, dateStr, storeId) {
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const grossSales = num(row['Gross Sales']);
  const discount = num(row['Discount']);
  const empDiscount = num(row['Employee Discount']);
  const netSales = num(row['Net Sales']);
  const gcLoad = num(row['Gift Card Load']);
  const tax = num(row['Tax']);
  const tip = num(row['Tip']);
  const cash = num(row['Cash']);
  const cc = num(row['Credit Card']);
  const gc = num(row['Gift Card']);
  const mobile = num(row['Mobile App']);
  const donation = num(row['Donation']);
  const promo = num(row['Promotion']);
  const other = num(row['Other']);
  const recon = num(row['Reconciliation']);
  const rounding = num(row['Rounding']);
  const avgCheck = num(row['Avg Check']);
  const grossFood = num(row['Gross Food %']);
  const trafficCount = num(row['Traffic Count']);

  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const journalNo = grossSales === 0 ? `${mm}.${dd}.${yyyy} - NO DATA` : `${mm}.${dd}.${yyyy}`;
  const journalDate = `${mm}/${dd}/${yyyy}`;

  const adyenFees = Math.round(mobile * 0.0362 * 100) / 100;
  const adyenDeposits = Math.round((mobile - adyenFees) * 100) / 100;

  const royaltyRate = sjeGetRoyaltyRate(franchiseKey, storeId);
  const royaltyFees = Math.round(netSales * royaltyRate * 100) / 100;
  const adFund = Math.round(netSales * sjeGetAdFundRate() * 100) / 100;
  const royaltyPayable = royaltyFees + adFund;

  const royaltyDesc = Math.abs(royaltyRate - 0.08) < 0.0001 ? '8%' : '';

  const advTotal = other + promo - recon - donation - rounding;
  const advDebits = advTotal >= 0 ? Math.round(advTotal * 100) / 100 : null;
  const advCredits = advTotal < 0 ? Math.round(-advTotal * 100) / 100 : null;

  const descParts = [];
  if (avgCheck > 0) descParts.push(`Avg: $${avgCheck.toFixed(2)}`);
  if (grossFood > 0) descParts.push(`Food: ${grossFood.toFixed(1)}%`);
  if (trafficCount > 0) descParts.push(`T Count: ${Math.round(trafficCount)}`);
  const avgCheckDesc = descParts.join(' - ');

  const r = (v) => v !== null && v !== undefined ? Math.round(v * 100) / 100 : null;

  const lines = [
    { account: sjeGetAccount('sales', franchiseKey),              debit: null,           credit: r(grossSales),  description: avgCheckDesc, class: className },
    { account: sjeGetAccount('store_discounts', franchiseKey),    debit: r(discount),    credit: null,           description: '',           class: className },
    { account: sjeGetAccount('emp_discounts', franchiseKey),      debit: r(empDiscount), credit: null,           description: '',           class: className },
    { account: sjeGetAccount('gift_card_sold', franchiseKey),     debit: null,           credit: r(gcLoad),      description: 'Gift Cards Sold', class: className },
    { account: sjeGetAccount('sales_tax_payable', franchiseKey),  debit: null,           credit: r(tax),         description: '',           class: className },
    { account: sjeGetAccount('tips_received', franchiseKey),      debit: null,           credit: r(tip),         description: '',           class: className },
    { account: sjeGetAccount('cash_deposits', franchiseKey),      debit: r(cash),        credit: null,           description: '',           class: className },
    { account: sjeGetAccount('credit_card_deposits', franchiseKey), debit: r(cc),        credit: null,           description: '',           class: className },
    { account: sjeGetAccount('gift_card_redeemed', franchiseKey), debit: r(gc),          credit: null,           description: 'Gift Cards Redeemed', class: className },
    { account: sjeGetAccount('adyen_deposits', franchiseKey),     debit: r(adyenDeposits), credit: null,         description: '',           class: className },
    { account: sjeGetAccount('adyen_fees', franchiseKey),         debit: r(adyenFees),   credit: null,           description: '',           class: className },
    { account: sjeGetAccount('advertising_marketing', franchiseKey), debit: advDebits,   credit: advCredits,     description: 'Donations, Promo, Recon, Rounding & Other', class: className },
    { account: sjeGetAccount('royalty_fees', franchiseKey),       debit: r(royaltyFees), credit: null,           description: royaltyDesc,  class: className },
    { account: sjeGetAccount('ad_fund_national', franchiseKey),   debit: r(adFund),      credit: null,           description: '',           class: className },
    { account: sjeGetAccount('royalty_payable', franchiseKey),    debit: null,           credit: r(royaltyPayable), description: '',        class: className },
  ];

  return { date: journalDate, journalNo, lines };
}

app.post('/scooters/parse-sales', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    console.log(`Scooter's parse: ${req.file.originalname} (${(req.file.size/1024).toFixed(1)} KB) by ${req.arkUser.userName}`);

    // Parse Excel
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(sheet);

    if (!rawData.length) return res.status(400).json({ error: 'Excel file is empty' });

    // Map columns
    const headers = Object.keys(rawData[0]);
    const colMap = {
      'Store': sjeFindColumn(headers, ['store']),
      'Day': sjeFindColumn(headers, ['day', 'date']),
      'Franchise': sjeFindColumn(headers, ['franchise']),
      'Gross Sales': sjeFindColumn(headers, ['gross sales']),
      'Discount': sjeFindColumn(headers, ['discount']),
      'Employee Discount': sjeFindColumn(headers, ['employee discount', 'emp discount']),
      'Net Sales': sjeFindColumn(headers, ['net sales']),
      'Gift Card Load': sjeFindColumn(headers, ['gift card load', 'gift cards sold', 'gc load', 'gift card sold', 'loaded gift card', 'sold gc', 'gift load']),
      'Tax': sjeFindColumn(headers, ['tax']),
      'Donation': sjeFindColumn(headers, ['donation', 'donations']),
      'Tip': sjeFindColumn(headers, ['tip']),
      'Cash': sjeFindColumn(headers, ['cash']),
      'Credit Card': sjeFindColumn(headers, ['credit card']),
      'Gift Card': sjeFindColumn(headers, ['gift card redeemed', 'gift cards redeemed', 'gc redeemed', 'gift card used', 'redeemed gift card', 'gift redemption', 'gc redemption', 'gift redeemed', 'redeem gc']),
      'Mobile App': sjeFindColumn(headers, ['mobile app']),
      'Promotion': sjeFindColumn(headers, ['promotion']),
      'Other': sjeFindColumn(headers, ['other']),
      'Reconciliation': sjeFindColumn(headers, ['reconciliation']),
      'Rounding': sjeFindColumn(headers, ['rounding']),
      'Avg Check': sjeFindColumn(headers, ['avg check', 'average check', 'avg ticket']),
      'Discount %': sjeFindColumn(headers, ['discount %']),
      'Traffic Count': sjeFindColumn(headers, ['traffic count']),
      'Gross Food %': sjeFindColumn(headers, ['gross food %']),
    };

    // Normalize rows
    const rows = rawData.map(raw => {
      const row = {};
      for (const [newName, oldName] of Object.entries(colMap)) {
        row[newName] = oldName ? raw[oldName] : null;
      }
      // Parse date
      if (row['Day']) {
        if (row['Day'] instanceof Date) {
          row['_date'] = row['Day'];
        } else if (typeof row['Day'] === 'number') {
          // Excel serial date
          row['_date'] = new Date((row['Day'] - 25569) * 86400000);
        } else {
          row['_date'] = new Date(row['Day']);
        }
      }
      return row;
    }).filter(r => r['_date'] && !isNaN(r['_date'].getTime()));

    console.log(`  Parsed ${rows.length} valid rows, columns: ${Object.entries(colMap).filter(([k,v])=>v).map(([k])=>k).join(', ')}`);

    // Load CRM client data for realm ID matching
    let crmClients = [];
    try {
      if (fs.existsSync(ARK_DB_FILE)) {
        const db = JSON.parse(fs.readFileSync(ARK_DB_FILE, 'utf8'));
        crmClients = db.clients || [];
      }
    } catch (_) {}

    // Helper: find realmId and QBO name for a store number
    function findRealmForStore(storeNum) {
      for (const client of crmClients) {
        if (!client.franchises?.length) continue;
        for (const f of client.franchises) {
          if (f.storeNumber === storeNum && f.qboRealmId) {
            return { realmId: f.qboRealmId, qboName: f.qboName || '', clientName: client.biz };
          }
        }
      }
      return null;
    }

    // Process each franchise config
    const franchises = [];
    const warnings = [];
    let totalDebits = 0, totalCredits = 0, totalEntries = 0;

    for (const [franchiseKey, info] of Object.entries(FRANCHISE_MAP)) {
      // Filter rows matching this franchise
      const franchiseRows = rows.filter(r => {
        const fName = String(r['Franchise'] || '').trim();
        return (info.franchise_names || []).some(n => n.toLowerCase() === fName.toLowerCase());
      });

      if (!franchiseRows.length) continue;

      if (!info.use_classes) {
        // Simple: one store per franchise entry
        for (const [storeId, className] of Object.entries(info.stores || {})) {
          const storeRows = franchiseRows.filter(r => String(r['Store'] || '').includes(storeId));
          if (!storeRows.length) continue;

          const realm = findRealmForStore(storeId);
          const entries = [];
          let fDebits = 0, fCredits = 0;

          // Sort by date
          storeRows.sort((a, b) => a._date - b._date);
          const dates = [...new Set(storeRows.map(r => r._date.toISOString().slice(0, 10)))];

          for (const dateKey of dates) {
            const dayRows = storeRows.filter(r => r._date.toISOString().slice(0, 10) === dateKey);
            const entry = sjeBuildEntry(dayRows[0], franchiseKey, className || storeId, dayRows[0]._date.toISOString(), storeId);
            entries.push(entry);
            const d = entry.lines.reduce((s, l) => s + (l.debit || 0), 0);
            const c = entry.lines.reduce((s, l) => s + (l.credit || 0), 0);
            fDebits += d;
            fCredits += c;
          }

          const dateRange = dates.length ? `${storeRows[0]._date.toLocaleDateString('en-US')} - ${storeRows[storeRows.length-1]._date.toLocaleDateString('en-US')}` : '';

          franchises.push({
            key: franchiseKey,
            label: info.label || franchiseKey,
            storeId,
            className: className || '',
            realmId: realm?.realmId || '',
            qboCompanyName: realm?.qboName || realm?.clientName || '',
            linked: !!realm?.realmId,
            dateRange,
            entryCount: entries.length,
            totalDebits: Math.round(fDebits * 100) / 100,
            totalCredits: Math.round(fCredits * 100) / 100,
            balanced: Math.abs(fDebits - fCredits) < 0.01,
            entries,
          });

          totalDebits += fDebits;
          totalCredits += fCredits;
          totalEntries += entries.length;
        }
      } else {
        // Grouped mode — use_classes = true
        const groupings = info.grouping || Object.entries(info.stores || {}).map(([sid]) => ({ stores: [sid], label: info.label || sid }));

        for (const group of groupings) {
          const groupStores = group.stores || [];
          const groupLabel = group.label || groupStores.join(' & ');

          // Find realm from first store in group
          const realm = findRealmForStore(groupStores[0]);
          const entries = [];
          let fDebits = 0, fCredits = 0;

          // Collect all dates across all stores in group
          const allDates = new Set();
          for (const storeId of groupStores) {
            franchiseRows.filter(r => String(r['Store'] || '').includes(storeId))
              .forEach(r => allDates.add(r._date.toISOString().slice(0, 10)));
          }
          const sortedDates = [...allDates].sort();

          for (const dateKey of sortedDates) {
            for (const storeId of groupStores) {
              const className = info.stores?.[storeId] || storeId;
              const dayRows = franchiseRows.filter(r =>
                String(r['Store'] || '').includes(storeId) &&
                r._date.toISOString().slice(0, 10) === dateKey
              );
              if (!dayRows.length) continue;

              const entry = sjeBuildEntry(dayRows[0], franchiseKey, className, dayRows[0]._date.toISOString(), storeId);
              entries.push(entry);
              const d = entry.lines.reduce((s, l) => s + (l.debit || 0), 0);
              const c = entry.lines.reduce((s, l) => s + (l.credit || 0), 0);
              fDebits += d;
              fCredits += c;
            }
          }

          if (!entries.length) continue;

          const classNames = groupStores.map(s => info.stores?.[s] || s).filter(Boolean).join(', ');
          const dateRange = sortedDates.length ? `${new Date(sortedDates[0]).toLocaleDateString('en-US')} - ${new Date(sortedDates[sortedDates.length-1]).toLocaleDateString('en-US')}` : '';

          franchises.push({
            key: franchiseKey,
            label: groupLabel,
            storeId: groupStores.join(', '),
            className: classNames,
            realmId: realm?.realmId || '',
            qboCompanyName: realm?.qboName || realm?.clientName || '',
            linked: !!realm?.realmId,
            dateRange,
            entryCount: entries.length,
            totalDebits: Math.round(fDebits * 100) / 100,
            totalCredits: Math.round(fCredits * 100) / 100,
            balanced: Math.abs(fDebits - fCredits) < 0.01,
            entries,
          });

          totalDebits += fDebits;
          totalCredits += fCredits;
          totalEntries += entries.length;
        }
      }
    }

    // Check for unmatched franchise names in the data
    const allFranchiseNames = new Set();
    Object.values(FRANCHISE_MAP).forEach(info => (info.franchise_names || []).forEach(n => allFranchiseNames.add(n.toLowerCase())));
    const unmatchedNames = new Set();
    rows.forEach(r => {
      const fName = String(r['Franchise'] || '').trim();
      if (fName && !allFranchiseNames.has(fName.toLowerCase())) unmatchedNames.add(fName);
    });
    unmatchedNames.forEach(n => warnings.push(`Franchise "${n}" not found in config`));

    console.log(`  Generated ${franchises.length} franchise groups, ${totalEntries} entries, ${warnings.length} warnings`);

    res.json({
      franchises,
      warnings,
      stats: {
        totalFranchises: franchises.length,
        totalEntries,
        totalDebits: Math.round(totalDebits * 100) / 100,
        totalCredits: Math.round(totalCredits * 100) / 100,
      },
    });

  } catch (e) {
    console.error('Scooter\'s parse error:', e);
    res.status(500).json({ error: e.message });
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
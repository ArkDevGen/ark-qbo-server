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
// Web Push — optional dependency, loaded if available
let webpush = null;
try { webpush = require('web-push'); } catch(_) { /* web-push not installed — push notifications disabled */ }
// S3/B2 imports removed — now using ShareFile API
const { google }       = require('googleapis');

const app = express();

// Build version — set at server startup, used for update notifications
const BUILD_VERSION = new Date().toISOString();

// Recent changes — captured from git log at server startup so users see
// a human summary of what changed when an update banner appears
let BUILD_CHANGES = [];
try {
  const { execSync } = require('child_process');
  const raw = execSync('git log -10 --pretty=format:"%s|%h|%cI"', { cwd: __dirname, encoding: 'utf8' });
  BUILD_CHANGES = raw.split('\n').filter(Boolean).map(line => {
    const [subject, hash, date] = line.split('|');
    return { subject: subject.replace(/^"|"$/g, ''), hash, date };
  });
} catch (e) {
  console.log('Could not read git log for changelog:', e.message);
}

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

// ─── Auto-seed admin on empty boot (staging self-heal) ───────────
// When AUTO_SEED_ADMIN=true and the user DB is empty (e.g. after a
// Render free-tier restart wiped the ephemeral disk), automatically
// recreate the shared admin so the team doesn't have to re-seed by
// hand every time. Production should leave AUTO_SEED_ADMIN unset —
// there, an empty users file means something is wrong, not routine.
if (process.env.AUTO_SEED_ADMIN === 'true' && _users.length === 0) {
  // Prefer AUTO_SEED_PASSWORD (friendly staging password) over ARK_API_KEY.
  // Falls back to ARK_API_KEY so the feature still works with just the one var.
  const seedPassword = process.env.AUTO_SEED_PASSWORD || process.env.ARK_API_KEY;
  if (seedPassword) {
    (async () => {
      try {
        const hash = await bcrypt.hash(seedPassword, 10);
        const username = (process.env.AUTO_SEED_USERNAME || 'arkdev').toLowerCase().trim();
        _users.push({
          id: 'usr_' + crypto.randomUUID().slice(0, 8),
          username,
          passwordHash: hash,
          fname: process.env.AUTO_SEED_FNAME || 'ARK',
          lname: process.env.AUTO_SEED_LNAME || 'Dev',
          email: process.env.AUTO_SEED_EMAIL || 'dev@arkfinancialservices.com',
          role: 'admin',
          title: 'Shared Staging Admin',
          phone: '',
          color: '#f59e0b',
          status: 'Active',
          assignedClients: [],
          permissions: { ...DEFAULT_PERMISSIONS.admin },
          createdAt: new Date().toISOString(),
          lastLogin: null,
        });
        // Also seed a test user so @mentions and notifications can be
        // actually exercised on staging (mentions to yourself are skipped).
        _users.push({
          id: 'usr_' + crypto.randomUUID().slice(0, 8),
          username: 'testuser',
          passwordHash: hash, // same password as admin for simplicity
          fname: 'Test',
          lname: 'User',
          email: 'test@arkfinancialservices.com',
          role: 'am',
          title: 'Staging Test Account',
          phone: '',
          color: '#4c4aa8',
          status: 'Active',
          assignedClients: [],
          permissions: { ...DEFAULT_PERMISSIONS.am },
          createdAt: new Date().toISOString(),
          lastLogin: null,
        });
        saveUsers();
        console.log(`✓ Auto-seeded admin on empty boot: ${username}`);
        console.log(`✓ Auto-seeded test user: testuser (role: am)`);
      } catch (e) {
        console.log('Auto-seed failed:', e.message);
      }
    })();
  } else {
    console.log('AUTO_SEED_ADMIN=true but neither AUTO_SEED_PASSWORD nor ARK_API_KEY is set — skipping auto-seed');
  }
}

function findUser(username, includeInactive) {
  return _users.find(u => u.username.toLowerCase() === username.toLowerCase() && (includeInactive || (u.status||'').toLowerCase() === 'active'));
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
// Accepts optional { username, fname, lname, email } in the request body
// so the first user on a fresh environment (e.g. staging) can be whoever
// is actually bootstrapping it. Password is always ARK_API_KEY.
app.post('/auth/seed', async (req, res) => {
  if (_users.length > 0) return res.json({ message: 'Users already exist', count: _users.length });

  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ARK_API_KEY not set' });

  const b = req.body || {};
  const username = (b.username || 'arkdev').toLowerCase().trim();
  const fname    = b.fname || 'ARK';
  const lname    = b.lname || 'Dev';
  const email    = b.email || `dev@arkfinancialservices.com`;

  const hash = await bcrypt.hash(apiKey, 10);
  const admin = {
    id: 'usr_' + crypto.randomUUID().slice(0, 8),
    username,
    passwordHash: hash,
    fname,
    lname,
    email,
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
  console.log(`✓ Seeded initial admin user: ${username}`);
  res.json({ success: true, message: 'Admin user created', username });
});

// ─── Login ───────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { username, password, apiKey, userId, userName, role } = req.body;

  // === NEW: Username + password login ===
  if (username && password) {
    const user = findUser(username);
    console.log(`Login attempt: "${username}" (password length: ${password.length}, has symbols: ${/[^a-zA-Z0-9]/.test(password)})`);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    if (user.status === 'Inactive') return res.status(403).json({ error: 'Account is deactivated — contact an admin' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    console.log(`  bcrypt compare result: ${valid} (hash starts: ${user.passwordHash?.slice(0,20)})`);
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

// ─── Staging auto-login (no password) ────────────────────────────
// Only responds on the staging deployment — gated by hostname. Mints a
// session for the shared staging admin so the sandbox skips the login
// screen. Auto-seeds the default arkdev user if the staging DB is empty
// (staging has a disposable disk, so fresh deploys start with no users).
app.post('/auth/staging-login', async (req, res) => {
  const host = (req.headers.host || '').toLowerCase();
  const hostname = (req.hostname || '').toLowerCase();
  const isStaging = host.includes('staging') || hostname.includes('staging');
  if (!isStaging) {
    return res.status(403).json({ error: 'Staging-only endpoint' });
  }

  // Seed the default admin if the DB is empty
  if (_users.length === 0) {
    const apiKey = process.env.ARK_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ARK_API_KEY not set — cannot seed staging user' });
    const hash = await bcrypt.hash(apiKey, 10);
    _users.push({
      id: 'usr_' + crypto.randomUUID().slice(0, 8),
      username: 'arkdev',
      passwordHash: hash,
      fname: 'ARK',
      lname: 'Dev',
      email: 'dev@arkfinancialservices.com',
      role: 'admin',
      title: 'Owner / Admin',
      phone: '',
      color: '#1a2440',
      status: 'Active',
      assignedClients: [],
      permissions: { ...DEFAULT_PERMISSIONS.admin },
      createdAt: new Date().toISOString(),
      lastLogin: null,
    });
    saveUsers();
    console.log('Auth (staging): auto-seeded arkdev user');
  }

  let user = _users.find(u => u.username === 'arkdev' && u.status !== 'Inactive');
  if (!user) user = _users.find(u => u.role === 'admin' && u.status !== 'Inactive');
  if (!user) return res.status(503).json({ error: 'No active staging user available' });

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
  console.log(`Auth (staging): auto-login as ${user.username}`);
  return res.json({ success: true, token, user: safeUser(user) });
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

// Public team list — returns minimal info (name, id, role) for any authenticated user
app.get('/users/team', requireAuth, (req, res) => {
  res.json(_users.filter(u => u.active !== false).map(u => ({
    id: u.id, fname: u.fname, lname: u.lname, role: u.role, color: u.color,
  })));
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

  const { fname, lname, email, phone, role, title, color, status, assignedClients, permissions, newPassword, password } = req.body;

  if (fname !== undefined) user.fname = fname;
  if (lname !== undefined) user.lname = lname;
  if (email !== undefined) user.email = email;
  if (phone !== undefined) user.phone = phone;
  if (title !== undefined) user.title = title;
  if (color !== undefined) user.color = color;
  if (status !== undefined) user.status = status;
  if (role && ['admin', 'am', 'pm', 'viewer'].includes(role)) user.role = role;
  if (assignedClients !== undefined) user.assignedClients = assignedClients;
  if (permissions !== undefined) user.permissions = permissions;
  const pw = newPassword || password;
  if (pw && pw.length >= 6) {
    user.passwordHash = await bcrypt.hash(pw, 10);
  }

  saveUsers();
  console.log(`User updated: ${user.fname} ${user.lname} by ${req.arkUser.userName}`);
  res.json({ success: true, user: safeUser(user) });
});

// ─── User prefs (self-service, no admin required) ────────────────
app.put('/users/:id/prefs', requireAuth, (req, res) => {
  if (req.arkUser.userId !== req.params.id) return res.status(403).json({ error: 'Can only update your own prefs' });
  const user = _users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.prefs = { ...(user.prefs || {}), ...req.body };
  saveUsers();
  res.json({ success: true, prefs: user.prefs });
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

// ─── Reactivate user ─────────────────────────────────────────────
app.post('/users/:id/reactivate', requireAuth, (req, res) => {
  if (req.arkUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const user = _users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.status = 'Active';
  saveUsers();
  console.log(`User reactivated: ${user.fname} ${user.lname} by ${req.arkUser.userName}`);
  res.json({ success: true });
});

// ─── Emergency: reactivate + reset admin password (no auth required, uses API key) ──
app.post('/auth/reactivate-admins', async (req, res) => {
  const { apiKey, resetUsername, newPassword } = req.body;
  if (!apiKey || apiKey !== process.env.ARK_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // If resetUsername + newPassword provided, reset that specific user's password
  if (resetUsername && newPassword) {
    const user = _users.find(u => u.username.toLowerCase() === resetUsername.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found: ' + resetUsername });
    user.status = 'Active';
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    saveUsers();
    console.log(`Emergency reset: ${user.fname} ${user.lname} — reactivated + password reset`);
    return res.json({ success: true, message: `${user.username} reactivated and password reset` });
  }

  // Otherwise reactivate all admins
  let count = 0;
  _users.forEach(u => {
    if (u.role === 'admin' && u.status !== 'Active') {
      u.status = 'Active';
      count++;
    }
  });
  saveUsers();
  console.log(`Emergency reactivate: ${count} admin users reactivated`);
  res.json({ success: true, reactivated: count });
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
  // Compute absolute expiry from expires_in (seconds) if not already set
  if (data.expires_in && !data.expires_at) {
    data.expires_at = Date.now() + (data.expires_in * 1000);
  }
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
    expiresAt:   td?.expires_at ? new Date(td.expires_at).toISOString() : null,
    refreshTokenAge: td?.refresh_token ? '100-day lifetime (auto-refreshes on API calls)' : null,
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
// ROUTE 3c: Bulk token refresh — attempt to refresh all connected realms
// ─────────────────────────────────────────────────────────────────
app.post('/qbo/refresh-all', async (req, res) => {
  const results = { refreshed: 0, failed: 0, errors: [] };
  for (const [rid, entry] of Object.entries(tokenStore)) {
    if (!entry.tokenData?.refresh_token) continue;
    try {
      oauthClient.setToken(entry.tokenData);
      const refreshResponse = await oauthClient.refresh();
      const newTokens = refreshResponse.getJson();
      setTokenData(rid, newTokens);
      results.refreshed++;
      console.log(`  ✓ Refreshed realm ${rid} (${entry.companyName || 'unnamed'})`);
    } catch(e) {
      results.failed++;
      results.errors.push({ realmId: rid, companyName: entry.companyName || '', error: e.message });
      console.log(`  ✗ Failed to refresh realm ${rid}: ${e.message}`);
    }
  }
  console.log(`Token refresh: ${results.refreshed} ok, ${results.failed} failed`);
  res.json(results);
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
  // Must set token BEFORE checking validity so it checks the right realm
  oauthClient.setToken(td);

  // Force refresh if: library says expired, OR no expires_at stored, OR token is older than 50 min
  const tokenAge = td.expires_at ? Date.now() - (td.expires_at - 3600000) : Infinity;
  const needsRefresh = !oauthClient.isAccessTokenValid() || !td.expires_at || tokenAge > 3000000;

  if (needsRefresh) {
    console.log(`Access token needs refresh for realm ${targetRealm} (age: ${Math.round(tokenAge/60000)}min)...`);
    try {
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
    console.error(`getQBOClient failed for realm ${targetRealm}:`, e.message);
    return res.status(401).json({ error: e.message });
  }

  // Catch any unhandled errors in action handlers to prevent server crash
  try {

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
    // Use direct QBO API call instead of node-quickbooks to preserve AccountRef IDs
    console.log(`  Sending JE to QBO: DocNumber=${payload.DocNumber}, TxnDate=${payload.TxnDate}, Lines=${payload.Line?.length}`);
    try {
      // Get fresh token
      let tokens = getTokenData(targetRealm);
      oauthClient.setToken(tokens);
      const tokenAge = tokens.expires_at ? Date.now() - (tokens.expires_at - 3600000) : Infinity;
      if (tokenAge > 3000000 || !tokens.expires_at) {
        const rr = await oauthClient.refresh();
        tokens = rr.getJson();
        setTokenData(targetRealm, tokens);
      }

      const baseUrl = process.env.QBO_ENVIRONMENT === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com'
        : 'https://quickbooks.api.intuit.com';

      const resp = await fetch(`${baseUrl}/v3/company/${targetRealm}/journalentry?minorversion=65`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = await resp.json();

      if (!resp.ok) {
        const fault = body?.Fault;
        const faultMsg = fault?.Error?.[0]?.Detail || fault?.Error?.[0]?.Message || `QBO error ${resp.status}`;
        console.error('createJournalEntry error:', resp.status, faultMsg);
        return res.status(resp.status).json({ error: faultMsg, detail: fault || null });
      }

      const je = body.JournalEntry || body;
      console.log(`  ✓ Journal Entry created: ID ${je?.Id || 'unknown'}, DocNum ${je?.DocNumber || ''}`);
      res.json({ success: true, id: je?.Id, txnDate: je?.TxnDate, docNum: je?.DocNumber });
    } catch(e) {
      console.error('createJournalEntry exception:', e.message);
      res.status(500).json({ error: e.message });
    }

  // ── Action: Find Journal Entry by DocNumber ──────────────────
  // Used for pre-push duplicate detection. Returns existing JEs
  // (if any) so callers can decide whether to proceed.
  } else if (action === 'findJournalEntryByDocNumber') {
    const docNumber = String(payload?.docNumber || '').trim();
    if (!docNumber) return res.status(400).json({ error: 'docNumber required' });
    try {
      // Refresh token if needed
      let tokens = getTokenData(targetRealm);
      oauthClient.setToken(tokens);
      const tokenAge = tokens.expires_at ? Date.now() - (tokens.expires_at - 3600000) : Infinity;
      if (tokenAge > 3000000 || !tokens.expires_at) {
        const rr = await oauthClient.refresh();
        tokens = rr.getJson();
        setTokenData(targetRealm, tokens);
      }
      const baseUrl = process.env.QBO_ENVIRONMENT === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com'
        : 'https://quickbooks.api.intuit.com';
      // QBO query API — single-quote the DocNumber; escape any single quotes in value
      const q = `SELECT * FROM JournalEntry WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
      const url = `${baseUrl}/v3/company/${targetRealm}/query?query=${encodeURIComponent(q)}&minorversion=65`;
      const qResp = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
      });
      const qBody = await qResp.json();
      if (!qResp.ok) {
        const msg = qBody?.Fault?.Error?.[0]?.Detail || qBody?.Fault?.Error?.[0]?.Message || `QBO query error ${qResp.status}`;
        return res.status(qResp.status).json({ error: msg, detail: qBody?.Fault || null });
      }
      const found = qBody?.QueryResponse?.JournalEntry || [];
      const summary = found.map(je => ({
        id: je.Id,
        docNumber: je.DocNumber,
        txnDate: je.TxnDate,
        privateNote: je.PrivateNote,
        totalAmount: je.TotalAmt,
        lineCount: (je.Line || []).length,
        metaData: je.MetaData,
      }));
      return res.json({ success: true, found: summary });
    } catch (e) {
      console.error('findJournalEntryByDocNumber exception:', e.message);
      return res.status(500).json({ error: e.message });
    }

  // ── Action: Get Journal Entry by ID ──────────────────────────
  // Used for post-push verification — fetch the JE back after creating
  // and diff it against what we intended to send.
  } else if (action === 'getJournalEntry') {
    const jeId = String(payload?.id || '').trim();
    if (!jeId) return res.status(400).json({ error: 'id required' });
    try {
      let tokens = getTokenData(targetRealm);
      oauthClient.setToken(tokens);
      const tokenAge = tokens.expires_at ? Date.now() - (tokens.expires_at - 3600000) : Infinity;
      if (tokenAge > 3000000 || !tokens.expires_at) {
        const rr = await oauthClient.refresh();
        tokens = rr.getJson();
        setTokenData(targetRealm, tokens);
      }
      const baseUrl = process.env.QBO_ENVIRONMENT === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com'
        : 'https://quickbooks.api.intuit.com';
      const url = `${baseUrl}/v3/company/${targetRealm}/journalentry/${encodeURIComponent(jeId)}?minorversion=65`;
      const gResp = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
      });
      const gBody = await gResp.json();
      if (!gResp.ok) {
        const msg = gBody?.Fault?.Error?.[0]?.Detail || gBody?.Fault?.Error?.[0]?.Message || `QBO fetch error ${gResp.status}`;
        return res.status(gResp.status).json({ error: msg, detail: gBody?.Fault || null });
      }
      return res.json({ success: true, journalEntry: gBody.JournalEntry || gBody });
    } catch (e) {
      console.error('getJournalEntry exception:', e.message);
      return res.status(500).json({ error: e.message });
    }

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
    // Support class breakout (summarize_column_by=Class)
    if (payload.summarize_column_by) {
      params.summarize_column_by = payload.summarize_column_by;
    }

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

  // ── Action: List Invoices ─────────────────────────────────────
  } else if (action === 'getInvoices') {
    const { status, startDate, endDate, customerId } = payload || {};
    const criteria = { asc: 'TxnDate' };
    // Build query string for filtering
    const where = [];
    if (startDate) where.push(`TxnDate >= '${startDate}'`);
    if (endDate)   where.push(`TxnDate <= '${endDate}'`);
    if (customerId) where.push(`CustomerRef = '${customerId}'`);
    if (where.length) criteria.query = where.join(' AND ');
    criteria.fetchAll = true;

    qbo.findInvoices(criteria, (err, data) => {
      if (err) {
        console.error('getInvoices error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to fetch invoices' });
      }
      let invoices = (data.QueryResponse?.Invoice || []).map(inv => {
        const balance = parseFloat(inv.Balance || 0);
        const total = parseFloat(inv.TotalAmt || 0);
        const dueDate = inv.DueDate || '';
        let invStatus = 'Open';
        if (balance === 0) invStatus = 'Paid';
        else if (dueDate && new Date(dueDate) < new Date()) invStatus = 'Overdue';
        return {
          id:           inv.Id,
          docNumber:    inv.DocNumber || '',
          txnDate:      inv.TxnDate,
          dueDate,
          customerName: inv.CustomerRef?.name || '',
          customerId:   inv.CustomerRef?.value || '',
          total,
          balance,
          status:       invStatus,
          emailStatus:  inv.EmailStatus || '',
        };
      });
      // Client-side status filter
      if (status && status !== 'All') {
        invoices = invoices.filter(i => i.status === status);
      }
      console.log(`  Returned ${invoices.length} invoices`);
      res.json({ success: true, invoices });
    });

  // ── Action: Get Single Invoice Detail ───────────────────────
  } else if (action === 'getInvoice') {
    if (!payload?.id) return res.status(400).json({ error: 'Invoice id required' });
    qbo.getInvoice(payload.id, (err, data) => {
      if (err) {
        console.error('getInvoice error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to fetch invoice' });
      }
      res.json({ success: true, invoice: data });
    });

  // ── Action: Create Invoice ──────────────────────────────────
  } else if (action === 'createInvoice') {
    qbo.createInvoice(payload, (err, data) => {
      if (err) {
        console.error('createInvoice error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to create invoice', detail: err.Fault || err });
      }
      console.log(`  ✓ Invoice created: ID ${data.Id}, Doc# ${data.DocNumber}`);
      res.json({ success: true, id: data.Id, docNumber: data.DocNumber, txnDate: data.TxnDate });
    });

  // ── Action: Send Invoice via Email ──────────────────────────
  } else if (action === 'sendInvoice') {
    if (!payload?.id) return res.status(400).json({ error: 'Invoice id required' });
    qbo.sendInvoicePdf(payload.id, payload.sendTo || null, (err, data) => {
      if (err) {
        console.error('sendInvoice error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to send invoice' });
      }
      console.log(`  ✓ Invoice ${payload.id} sent via email`);
      res.json({ success: true, id: data.Id, emailStatus: data.EmailStatus });
    });

  // ── Action: Balance Sheet Report ────────────────────────────
  } else if (action === 'getBalanceSheet') {
    const { startDate, endDate } = payload || {};
    if (!endDate) return res.status(400).json({ error: 'endDate required (startDate optional for comparison)' });
    const params = { end_date: endDate };
    if (startDate) params.start_date = startDate;

    qbo.reportBalanceSheet(params, (err, data) => {
      if (err) {
        console.error('getBalanceSheet error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to fetch balance sheet', detail: err.Fault || err });
      }
      console.log(`  ✓ Balance Sheet returned for ${endDate}`);
      res.json({ success: true, report: data });
    });

  // ── Action: Aged Receivables Report ─────────────────────────
  } else if (action === 'getAgedReceivables') {
    const params = {};
    if (payload?.reportDate) params.report_date = payload.reportDate;
    if (payload?.agingMethod) params.aging_method = payload.agingMethod;

    qbo.reportAgedReceivables(params, (err, data) => {
      if (err) {
        console.error('getAgedReceivables error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to fetch AR aging' });
      }
      console.log('  ✓ AR Aging report returned');
      res.json({ success: true, report: data });
    });

  // ── Action: Aged Payables Report ────────────────────────────
  } else if (action === 'getAgedPayables') {
    const params = {};
    if (payload?.reportDate) params.report_date = payload.reportDate;

    qbo.reportAgedPayables(params, (err, data) => {
      if (err) {
        console.error('getAgedPayables error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to fetch AP aging' });
      }
      console.log('  ✓ AP Aging report returned');
      res.json({ success: true, report: data });
    });

  // ── Action: List Bills ──────────────────────────────────────
  } else if (action === 'getBills') {
    const { status, startDate, endDate, vendorId } = payload || {};
    const criteria = { asc: 'TxnDate', fetchAll: true };
    const where = [];
    if (startDate) where.push(`TxnDate >= '${startDate}'`);
    if (endDate)   where.push(`TxnDate <= '${endDate}'`);
    if (vendorId)  where.push(`VendorRef = '${vendorId}'`);
    if (where.length) criteria.query = where.join(' AND ');

    qbo.findBills(criteria, (err, data) => {
      if (err) {
        console.error('getBills error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to fetch bills' });
      }
      let bills = (data.QueryResponse?.Bill || []).map(bill => {
        const balance = parseFloat(bill.Balance || 0);
        const total = parseFloat(bill.TotalAmt || 0);
        const dueDate = bill.DueDate || '';
        let billStatus = 'Open';
        if (balance === 0) billStatus = 'Paid';
        else if (dueDate && new Date(dueDate) < new Date()) billStatus = 'Overdue';
        return {
          id:         bill.Id,
          docNumber:  bill.DocNumber || '',
          txnDate:    bill.TxnDate,
          dueDate,
          vendorName: bill.VendorRef?.name || '',
          vendorId:   bill.VendorRef?.value || '',
          total,
          balance,
          status:     billStatus,
        };
      });
      if (status && status !== 'All') {
        bills = bills.filter(b => b.status === status);
      }
      console.log(`  Returned ${bills.length} bills`);
      res.json({ success: true, bills });
    });

  // ── Action: Get Single Bill Detail ──────────────────────────
  } else if (action === 'getBill') {
    if (!payload?.id) return res.status(400).json({ error: 'Bill id required' });
    qbo.getBill(payload.id, (err, data) => {
      if (err) {
        console.error('getBill error:', JSON.stringify(err, null, 2));
        return res.status(500).json({ error: err.message || 'Failed to fetch bill' });
      }
      res.json({ success: true, bill: data });
    });

  // ── Action: Test JE creation (debug — returns full error) ──────
  } else if (action === 'testJournalEntry') {
    // Directly call QBO API to get full error response
    try {
      oauthClient.setToken(getTokenData(targetRealm));
      let tokens = getTokenData(targetRealm);
      // Force refresh
      try {
        const rr = await oauthClient.refresh();
        tokens = rr.getJson();
        setTokenData(targetRealm, tokens);
      } catch(re) { /* use existing token */ }

      const baseUrl = process.env.QBO_ENVIRONMENT === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com'
        : 'https://quickbooks.api.intuit.com';

      const testPayload = payload || {
        TxnDate: '2026-03-31',
        DocNumber: 'TEST.DELETE',
        PrivateNote: 'TEST',
        Line: [
          { DetailType: 'JournalEntryLineDetail', Amount: 100, Description: 'Test', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { name: 'Sales' } } },
          { DetailType: 'JournalEntryLineDetail', Amount: 100, Description: 'Test', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { name: 'Cash Deposits' } } },
        ],
      };

      const resp = await fetch(`${baseUrl}/v3/company/${targetRealm}/journalentry?minorversion=65`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(testPayload),
      });
      const body = await resp.json();
      console.log('testJournalEntry result:', resp.status, JSON.stringify(body).substring(0, 500));
      res.json({ status: resp.status, body });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }

  // ── Action: Find existing JEs by DocNumber prefix ──────────────
  } else if (action === 'findJournalEntries') {
    const { docNumberPrefix, docNumbers } = payload || {};
    if (!docNumberPrefix && !docNumbers?.length) return res.status(400).json({ error: 'docNumberPrefix or docNumbers required' });

    try {
      // Get fresh token
      let tokens = getTokenData(targetRealm);
      oauthClient.setToken(tokens);
      const tokenAge = tokens.expires_at ? Date.now() - (tokens.expires_at - 3600000) : Infinity;
      if (tokenAge > 3000000 || !tokens.expires_at) {
        const rr = await oauthClient.refresh();
        tokens = rr.getJson();
        setTokenData(targetRealm, tokens);
      }
      const baseUrl = process.env.QBO_ENVIRONMENT === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com'
        : 'https://quickbooks.api.intuit.com';

      const allEntries = [];

      if (docNumbers && docNumbers.length) {
        // Batch exact match in chunks of 30
        for (let i = 0; i < docNumbers.length; i += 30) {
          const chunk = docNumbers.slice(i, i + 30);
          const inList = chunk.map(d => `'${String(d).replace(/'/g, "''")}'`).join(',');
          const query = `SELECT Id, DocNumber, TxnDate FROM JournalEntry WHERE DocNumber IN (${inList}) MAXRESULTS 1000`;
          const resp = await fetch(`${baseUrl}/v3/company/${targetRealm}/query?query=${encodeURIComponent(query)}&minorversion=65`, {
            headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
          });
          if (resp.ok) {
            const data = await resp.json();
            (data.QueryResponse?.JournalEntry || []).forEach(je => {
              allEntries.push({ id: je.Id, docNumber: je.DocNumber, txnDate: je.TxnDate });
            });
          } else {
            console.error('findJournalEntries chunk failed:', resp.status);
          }
          await new Promise(r => setTimeout(r, 200));
        }
      } else {
        const query = `SELECT Id, DocNumber, TxnDate FROM JournalEntry WHERE DocNumber LIKE '${docNumberPrefix}%' MAXRESULTS 1000`;
        const resp = await fetch(`${baseUrl}/v3/company/${targetRealm}/query?query=${encodeURIComponent(query)}&minorversion=65`, {
          headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
        });
        if (resp.ok) {
          const data = await resp.json();
          (data.QueryResponse?.JournalEntry || []).forEach(je => {
            allEntries.push({ id: je.Id, docNumber: je.DocNumber, txnDate: je.TxnDate });
          });
        }
      }

      console.log(`  Found ${allEntries.length} existing JEs for realm ${targetRealm}`);
      res.json({ success: true, entries: allEntries });
    } catch(e) {
      console.error('findJournalEntries error:', e.message);
      res.status(500).json({ error: e.message });
    }

  // ── Action: Delete Journal Entry ────────────────────────────────
  } else if (action === 'deleteJournalEntry') {
    if (!payload?.id) return res.status(400).json({ error: 'JE id required' });
    try {
      let tokens = getTokenData(targetRealm);
      oauthClient.setToken(tokens);
      const tokenAge = tokens.expires_at ? Date.now() - (tokens.expires_at - 3600000) : Infinity;
      if (tokenAge > 3000000 || !tokens.expires_at) {
        const rr = await oauthClient.refresh();
        tokens = rr.getJson();
        setTokenData(targetRealm, tokens);
      }
      const baseUrl = process.env.QBO_ENVIRONMENT === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com'
        : 'https://quickbooks.api.intuit.com';

      // First get the JE to get SyncToken
      const getResp = await fetch(`${baseUrl}/v3/company/${targetRealm}/journalentry/${payload.id}?minorversion=65`, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
      });
      if (!getResp.ok) throw new Error(`Failed to fetch JE ${payload.id}: ${getResp.status}`);
      const jeData = await getResp.json();
      const syncToken = jeData.JournalEntry?.SyncToken;

      // Delete it
      const delResp = await fetch(`${baseUrl}/v3/company/${targetRealm}/journalentry?operation=delete&minorversion=65`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ Id: payload.id, SyncToken: syncToken }),
      });
      if (!delResp.ok) {
        const errBody = await delResp.json().catch(() => ({}));
        throw new Error(errBody?.Fault?.Error?.[0]?.Detail || `Delete failed: ${delResp.status}`);
      }
      console.log(`  ✓ Deleted JE ${payload.id} from realm ${targetRealm}`);
      res.json({ success: true, deleted: payload.id });
    } catch(e) {
      console.error('deleteJournalEntry error:', e.message);
      res.status(500).json({ error: e.message });
    }

  // ── Action: Find duplicate JEs and clean up ─────────────────────
  } else if (action === 'cleanupDuplicates') {
    try {
      let tokens = getTokenData(targetRealm);
      oauthClient.setToken(tokens);
      const tokenAge = tokens.expires_at ? Date.now() - (tokens.expires_at - 3600000) : Infinity;
      if (tokenAge > 3000000 || !tokens.expires_at) {
        const rr = await oauthClient.refresh();
        tokens = rr.getJson();
        setTokenData(targetRealm, tokens);
      }
      const baseUrl = process.env.QBO_ENVIRONMENT === 'sandbox'
        ? 'https://sandbox-quickbooks.api.intuit.com'
        : 'https://quickbooks.api.intuit.com';

      // Query all recent JEs (last 60 days) then filter by memo in code
      const sinceDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const query = `SELECT Id, DocNumber, TxnDate, SyncToken, PrivateNote FROM JournalEntry WHERE TxnDate >= '${sinceDate}' ORDERBY DocNumber MAXRESULTS 1000`;
      const qResp = await fetch(`${baseUrl}/v3/company/${targetRealm}/query?query=${encodeURIComponent(query)}&minorversion=65`, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
      });
      if (!qResp.ok) throw new Error(`Query failed: ${qResp.status}`);
      const qData = await qResp.json();
      const allJEs = (qData.QueryResponse?.JournalEntry || []).filter(je =>
        (je.PrivateNote || '').includes('EchoSync')
      );

      // Find duplicates — group by DocNumber, keep first (lowest Id), delete rest
      const byDocNum = {};
      for (const je of allJEs) {
        if (!byDocNum[je.DocNumber]) byDocNum[je.DocNumber] = [];
        byDocNum[je.DocNumber].push(je);
      }

      let deleted = 0, errors = 0;
      const deletedList = [];
      for (const [docNum, entries] of Object.entries(byDocNum)) {
        if (entries.length <= 1) continue; // no duplicates
        // Sort by Id ascending, keep the first, delete the rest
        entries.sort((a, b) => parseInt(a.Id) - parseInt(b.Id));
        for (let i = 1; i < entries.length; i++) {
          try {
            const delResp = await fetch(`${baseUrl}/v3/company/${targetRealm}/journalentry?operation=delete&minorversion=65`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ Id: entries[i].Id, SyncToken: entries[i].SyncToken }),
            });
            if (delResp.ok) {
              deleted++;
              deletedList.push({ docNumber: docNum, id: entries[i].Id, date: entries[i].TxnDate });
            } else {
              errors++;
            }
            await new Promise(r => setTimeout(r, 200)); // rate limit
          } catch(e) { errors++; }
        }
      }

      console.log(`  Cleanup realm ${targetRealm}: ${deleted} duplicates deleted, ${errors} errors`);
      res.json({ success: true, totalJEs: allJEs.length, duplicateSets: Object.values(byDocNum).filter(v => v.length > 1).length, deleted, errors, deletedList });
    } catch(e) {
      console.error('cleanupDuplicates error:', e.message);
      res.status(500).json({ error: e.message });
    }

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
  } catch (unhandled) {
    console.error(`UNHANDLED ERROR in /qbo/api (${action}, realm ${targetRealm}):`, unhandled.message, unhandled.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error: ' + unhandled.message });
    }
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

// Static fonts (MICR E-13B for check printing, etc.)
app.use('/fonts', express.static(path.join(__dirname, 'fonts')));

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
// Also saves as a chat message in the sms~ channel so it appears in Team Chat
app.post('/sms/inbound', (req, res) => {
  const msg = req.body;
  console.log('SMS inbound:', JSON.stringify(msg));

  // Sinch sends 'from' without '+', normalize to E.164
  const fromRaw = (msg.from || '').replace(/\D/g, '');
  const from = fromRaw.startsWith('1') ? '+' + fromRaw : '+1' + fromRaw;

  // Keep legacy inbox for Comm Center backward compat
  _smsInbox.push({
    id: crypto.randomUUID(),
    direction: 'inbound',
    phone: from,
    body: msg.body || '',
    timestamp: msg.received_at || new Date().toISOString(),
    sinchId: msg.id || '',
  });

  // Also save as a chat message so it appears in Team Chat
  const channelId = 'sms~' + from;
  const chatMsg = {
    id: crypto.randomUUID(),
    channelId,
    senderId: from,
    senderName: _smsResolveContactName(from),
    text: msg.body || '',
    createdAt: msg.received_at || new Date().toISOString(),
    smsType: 'inbound',
  };
  const messages = _loadChatMessages();
  messages.push(chatMsg);
  if (messages.length > 10000) messages.splice(0, messages.length - 10000);
  _saveChatMessages(messages);

  // Broadcast to all team members via SSE
  _sseBroadcastChat(chatMsg);

  console.log(`SMS received from ${from}: ${(msg.body || '').slice(0, 50)}`);
  res.status(200).json({ ok: true });
});

// Resolve phone number to a client owner name (best-effort)
function _smsResolveContactName(phone) {
  const digits = phone.replace(/\D/g, '');
  try {
    if (!fs.existsSync(ARK_DB_FILE)) return phone;
    const db = JSON.parse(fs.readFileSync(ARK_DB_FILE, 'utf8'));
    for (const client of (db.clients || [])) {
      for (const owner of (client.owners || [])) {
        const ownerDigits = (owner.mobile || owner.phone || '').replace(/\D/g, '');
        if (ownerDigits && ownerDigits.length >= 10 && digits.endsWith(ownerDigits.slice(-10))) {
          return `${owner.name || ''} (${client.biz || ''})`.trim();
        }
      }
      // Also check client-level phone
      const clientDigits = (client.phone || '').replace(/\D/g, '');
      if (clientDigits && clientDigits.length >= 10 && digits.endsWith(clientDigits.slice(-10))) {
        return client.biz || phone;
      }
    }
  } catch (_) {}
  return phone;
}

// Dashboard polls this to get new inbound messages, then clears buffer
app.get('/sms/inbox', (req, res) => {
  const messages = [..._smsInbox];
  _smsInbox = [];
  res.json({ messages });
});

// SMS delivery reports — Sinch POSTs status updates here
// Set as Default URL in Sinch dashboard → REST API → Callback URLs
app.post('/sms/delivery', (req, res) => {
  const report = req.body;
  console.log('SMS delivery report:', JSON.stringify(report));

  // Sinch delivery report types:
  // - recipient_delivery_report_sms: per-recipient status
  // - delivery_report_sms: batch-level summary
  const type = report.type || '';
  const statuses = report.statuses || [];
  const batchId = report.batch_id || '';

  if (type.includes('recipient')) {
    // Per-recipient status update
    const status = report.status || 'unknown';
    const code = report.code || 0;
    const recipient = report.at || report.recipient || '';
    console.log(`SMS delivery: ${recipient} → ${status} (code: ${code}, batch: ${batchId})`);
  } else if (statuses.length) {
    // Batch summary
    for (const s of statuses) {
      console.log(`SMS batch ${batchId}: ${s.count} ${s.status}`);
    }
  }

  res.status(200).json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────
// SHAREFILE — File Storage via ShareFile REST API
// Uses password-based token auth (no OAuth redirect needed)
// ─────────────────────────────────────────────────────────────────
const SF_SUBDOMAIN     = process.env.SHAREFILE_SUBDOMAIN || '';
const SF_CLIENT_ID     = process.env.SHAREFILE_CLIENT_ID || '';
const SF_CLIENT_SECRET = process.env.SHAREFILE_CLIENT_SECRET || '';
const SF_USERNAME      = process.env.SHAREFILE_USERNAME || '';
const SF_PASSWORD      = process.env.SHAREFILE_PASSWORD || '';
const SF_API_BASE      = SF_SUBDOMAIN ? `https://${SF_SUBDOMAIN}.sf-api.com/sf/v3` : '';
const SF_TOKEN_FILE    = path.join(DATA_DIR, 'sharefile-tokens.json');

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
  return !!(SF_CLIENT_ID && SF_SUBDOMAIN && sfTokens && sfTokens.access_token);
}

function saveSfTokens() {
  fs.writeFileSync(SF_TOKEN_FILE, JSON.stringify(sfTokens, null, 2));
}

// Get a fresh token using password grant (no OAuth redirect needed)
async function sfPasswordAuth() {
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET || !SF_SUBDOMAIN || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('ShareFile credentials not configured');
  }
  const params = new URLSearchParams({
    grant_type:    'password',
    client_id:     SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
    username:      SF_USERNAME,
    password:      SF_PASSWORD,
  });
  const resp = await fetch(`https://${SF_SUBDOMAIN}.sharefile.com/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('ShareFile password auth failed: ' + errText);
  }
  const data = await resp.json();
  sfTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + ((data.expires_in || 28800) * 1000),
    subdomain:     data.subdomain || SF_SUBDOMAIN,
  };
  saveSfTokens();
  console.log('✓ ShareFile token obtained via password auth');
  return sfTokens;
}

// Auto-refresh ShareFile access token if expired
async function sfGetHeaders() {
  if (!sfTokens || !sfTokens.access_token) {
    throw new Error('ShareFile not connected — click Connect ShareFile in File Center');
  }

  // Check if token is expired (with 5 min buffer) — use refresh_token
  if (sfTokens.expires_at && Date.now() > sfTokens.expires_at - 300000) {
    console.log('ShareFile token expired, refreshing...');
    if (sfTokens.refresh_token) {
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
        if (resp.ok) {
          const data = await resp.json();
          sfTokens = {
            access_token:  data.access_token,
            refresh_token: data.refresh_token || sfTokens.refresh_token,
            expires_at:    Date.now() + ((data.expires_in || 28800) * 1000),
            subdomain:     data.subdomain || SF_SUBDOMAIN,
          };
          saveSfTokens();
          console.log('✓ ShareFile token refreshed');
        } else {
          sfTokens = null; saveSfTokens();
          throw new Error('ShareFile refresh failed — please reconnect');
        }
      } catch(e) {
        throw new Error('ShareFile token refresh failed — please reconnect');
      }
    } else {
      throw new Error('ShareFile token expired with no refresh token — please reconnect');
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
// Set ShareFile token directly (for manual token entry)
app.post('/sharefile/set-token', requireAuth, (req, res) => {
  try {
    const { access_token } = req.body;
    if (!access_token) return res.status(400).json({ error: 'access_token required' });
    sfTokens = { access_token, token_type: 'bearer', subdomain: SF_SUBDOMAIN };
    saveSfTokens();
    console.log('ShareFile: token set manually');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Connect to ShareFile using password auth (no OAuth redirect needed)
// ShareFile OAuth — redirects to ShareFile login page, user approves, callback gets token
app.get('/sharefile/auth', (req, res) => {
  const redirectUri = process.env.SHAREFILE_REDIRECT_URI || 'https://ark-qbo-server.onrender.com/sharefile/callback';
  const authUrl = `https://${SF_SUBDOMAIN}.sharefile.com/oauth/authorize?` +
    `response_type=code` +
    `&client_id=${SF_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=ark-sf-${Date.now()}`;
  console.log('ShareFile OAuth redirect:', authUrl);
  res.redirect(authUrl);
});

app.get('/sharefile/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) throw new Error('No authorization code received');
    const redirectUri = process.env.SHAREFILE_REDIRECT_URI || 'https://ark-qbo-server.onrender.com/sharefile/callback';
    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      redirect_uri:  redirectUri,
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
      expires_at:    Date.now() + ((data.expires_in || 28800) * 1000),
      subdomain:     data.subdomain || SF_SUBDOMAIN,
    };
    saveSfTokens();
    console.log('✓ ShareFile connected via OAuth');
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
    if (window.opener) window.opener.postMessage({ type: 'sharefile-connected' }, '*');
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

// Sync: smart merge — runtime additions/edits on disk survive deploys.
// Rules:
//   • New client in repo  → seed entirely from repo
//   • New store in repo   → add to disk
//   • New employee ID in repo not on disk → add to disk (CSV bakes land here)
//   • Employee already on disk → keep disk version (preserves admin edits & additions)
//   • Client meta (name, payFrequency, etc.) → updated from repo
//   • Auth fields (password, _sessionToken, _notifications) → always from disk
// Use POST /payroll/force-sync to intentionally overwrite disk with repo (e.g. after pruning).
const localCopy = path.join(__dirname, 'payroll-data.json');
if (fs.existsSync(localCopy) && DATA_DIR !== __dirname) {
  try {
    const repoCopy = JSON.parse(fs.readFileSync(localCopy, 'utf8'));
    let changed = false;

    for (const [slug, repoClient] of Object.entries(repoCopy.clients || {})) {
      if (!payrollData.clients[slug]) {
        // Brand-new client — seed entirely from repo
        payrollData.clients[slug] = { ...repoClient };
        changed = true;
        console.log(`  → Seeded new client ${slug}`);
        continue;
      }

      const diskClient = payrollData.clients[slug];

      // Update top-level client meta from repo, but preserve auth/runtime fields from disk
      const { stores: repoStores, ...repoMeta } = repoClient;
      const authFields = {
        _sessionToken:  diskClient._sessionToken  ?? null,
        _notifications: diskClient._notifications ?? [],
        password:       diskClient.password       ?? null,
        _drafts:        diskClient._drafts        ?? {},
        _prefill:       diskClient._prefill       ?? null,
        _changeLog:     diskClient._changeLog     ?? [],
      };
      Object.assign(diskClient, repoMeta, authFields);

      // Merge stores
      for (const [storeId, repoStore] of Object.entries(repoStores || {})) {
        if (!diskClient.stores) diskClient.stores = {};

        if (!diskClient.stores[storeId]) {
          // New store — add entirely from repo
          diskClient.stores[storeId] = { ...repoStore };
          changed = true;
          console.log(`  → Added new store ${storeId} to ${slug}`);
          continue;
        }

        const diskStore = diskClient.stores[storeId];

        // Update store-level meta (name, etc.) from repo
        const { employees: repoEmps, ...storeMeta } = repoStore;
        Object.assign(diskStore, storeMeta);

        // Add any employee IDs from repo that don't exist on disk yet
        const diskEmpIds = new Set((diskStore.employees || []).map(e => e.id));
        let added = 0;
        for (const repoEmp of (repoEmps || [])) {
          if (!diskEmpIds.has(repoEmp.id)) {
            if (!diskStore.employees) diskStore.employees = [];
            diskStore.employees.push({ ...repoEmp });
            diskEmpIds.add(repoEmp.id);
            added++;
            changed = true;
          }
          // Employee already on disk → keep disk version (admin edits preserved)
        }
        if (added > 0) console.log(`  → Added ${added} new employee(s) to ${storeId} (${slug})`);
      }
    }

    if (changed) {
      fs.writeFileSync(PAYROLL_FILE, JSON.stringify(payrollData, null, 2));
      console.log('✓ Payroll data merged from repo into disk');
    } else {
      console.log('✓ Payroll data up to date — no merge needed');
    }
  } catch(e) {
    console.log('Could not merge payroll data from repo:', e.message);
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
        client._drafts = diskClient._drafts || {};
        client._prefill = diskClient._prefill || null;
        client._changeLog = diskClient._changeLog || [];
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

  const prefill = client._prefill;
  res.json({
    success: true,
    token,
    clientName: client.name,
    stores: Object.entries(client.stores || {})
      .map(([id, s]) => ({
        id,
        name: id === 'admin' ? (s.name || 'Admin') : s.name,
      })),
    payFrequency: client.payFrequency || '',
    workLocations: client.workLocations || [],
    hasPrefill: !!prefill,
    prefillDates: prefill ? {
      payPeriodStart: prefill.payPeriodStart,
      payPeriodEnd: prefill.payPeriodEnd,
      payDate: prefill.payDate,
      createdAt: prefill.createdAt,
    } : null,
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

  const isAdminStore = storeId === 'admin';
  const storeEmps = (store.employees || []).map(e => ({
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    goByName: e.goByName || '',
    position: e.position || '',
    payRate: e.payRate || '',
    payType: e.payType || 'hourly',
    annualRate: e.annualRate || '',
    periodRate: e.periodRate || '',
    excludeFromTips: e.excludeFromTips !== undefined ? !!e.excludeFromTips : isAdminStore,
  }));

  const storePrefill = client._prefill?.stores?.[storeId] || null;
  res.json({
    employees: storeEmps,
    prefillData: storePrefill || null,
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

  const { employeeId, position, payRate } = req.body;
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

  // Add a copy to this store — use provided position/payRate if given (store-specific), otherwise blank
  if (!store.employees) store.employees = [];
  const { position: _p, payRate: _r, payRates: _rs, ...empBase } = sourceEmp;
  store.employees.push({ ...empBase, position: position || '', payRate: payRate || '', payRates: [] });
  savePayrollData();

  console.log(`Linked employee ${sourceEmp.firstName} ${sourceEmp.lastName} to store ${storeId} (${clientSlug})`);
  res.json({ success: true, employee: { id: sourceEmp.id, firstName: sourceEmp.firstName, lastName: sourceEmp.lastName, position: sourceEmp.position } });
});

// ── Update employee store-specific fields (position, payRate) ────
app.patch('/payroll/employees/:clientSlug/:storeId/:empId', (req, res) => {
  const { clientSlug, storeId, empId } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');

  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) return res.status(401).json({ error: 'Unauthorized' });

  const store = (client.stores || {})[storeId];
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const emp = (store.employees || []).find(e => e.id === empId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const { position, payRate, goByName, excludeFromTips } = req.body;
  const diffs = [];
  if (position !== undefined && position !== emp.position) diffs.push(`Position: ${emp.position||'none'}→${position}`);
  if (payRate !== undefined && String(payRate) !== String(emp.payRate)) diffs.push(`Rate: $${emp.payRate||0}→$${payRate}`);
  if (goByName !== undefined && goByName !== (emp.goByName||'')) diffs.push(`Go-by: ${goByName||'removed'}`);
  if (excludeFromTips !== undefined && !!excludeFromTips !== !!emp.excludeFromTips) diffs.push(excludeFromTips ? 'Excluded from tips' : 'Included in tips');

  if (position !== undefined) emp.position = position;
  if (payRate  !== undefined) emp.payRate  = payRate;
  if (goByName !== undefined) emp.goByName = goByName;
  if (excludeFromTips !== undefined) emp.excludeFromTips = !!excludeFromTips;

  if (diffs.length) {
    logEmployeeChange(client, { action: 'edited', employeeName: `${emp.firstName} ${emp.lastName}`, storeId, storeName: store.name, changes: diffs.join(', '), source: 'client' });
  }
  savePayrollData();

  res.json({ success: true, employee: { id: emp.id, position: emp.position, payRate: emp.payRate, goByName: emp.goByName || '', excludeFromTips: !!emp.excludeFromTips } });
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

// ── Employee Change Log helper ───────────────────────────────────
function logEmployeeChange(client, { action, employeeName, storeId, storeName, changes, source }) {
  if (!client._changeLog) client._changeLog = [];
  const entry = { action, employeeName, storeId, storeName: storeName || storeId, changes: changes || null, source: source || 'admin', timestamp: new Date().toISOString() };
  client._changeLog.unshift(entry);
  if (client._changeLog.length > 200) client._changeLog.length = 200; // cap at 200
  // Also push notification
  if (!client._notifications) client._notifications = [];
  client._notifications.push({
    type: action === 'added' ? 'new-employee' : action === 'edited' ? 'employee-edited' : 'employee-removed',
    storeId, storeName: storeName || storeId,
    employee: employeeName,
    changes: changes || null,
    source,
    timestamp: entry.timestamp,
  });
}

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
    goByName: employee.goByName || '',
    position: employee.position || '',
    payRate: employee.payRate || '',
    payType: employee.payType || 'hourly',
    annualRate: employee.annualRate || '',
    periodRate: employee.periodRate || '',
    email: employee.email || '',
    excludeFromTips: !!employee.excludeFromTips,
  };

  store.employees.push(newEmp);
  logEmployeeChange(client, { action: 'added', employeeName: `${newEmp.firstName} ${newEmp.lastName}`, storeId, storeName: store.name, changes: `${newEmp.position || 'No position'}, ${newEmp.payType === 'salary' ? 'Salary' : '$' + (newEmp.payRate || '0') + '/hr'}`, source: 'admin' });
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

  // Track what changed for the log
  const diffs = [];
  if (updates.firstName && updates.firstName !== emp.firstName) diffs.push(`Name: ${emp.firstName}→${updates.firstName}`);
  if (updates.lastName && updates.lastName !== emp.lastName) diffs.push(`Last: ${emp.lastName}→${updates.lastName}`);
  if (updates.position !== undefined && updates.position !== emp.position) diffs.push(`Position: ${emp.position||'none'}→${updates.position||'none'}`);
  if (updates.payRate !== undefined && String(updates.payRate) !== String(emp.payRate)) diffs.push(`Rate: $${emp.payRate||0}→$${updates.payRate}`);
  if (updates.email !== undefined && updates.email !== emp.email) diffs.push(`Email updated`);

  // Apply updates
  if (updates.firstName) emp.firstName = updates.firstName;
  if (updates.lastName) emp.lastName = updates.lastName;
  if (updates.position !== undefined) emp.position = updates.position;
  if (updates.payRate !== undefined) emp.payRate = updates.payRate;
  if (updates.payType) emp.payType = updates.payType;
  if (updates.annualRate !== undefined) emp.annualRate = updates.annualRate;
  if (updates.periodRate !== undefined) emp.periodRate = updates.periodRate;
  if (updates.email !== undefined) emp.email = updates.email;
  if (updates.goByName !== undefined) emp.goByName = updates.goByName;
  if (updates.excludeFromTips !== undefined) emp.excludeFromTips = !!updates.excludeFromTips;

  if (diffs.length) {
    logEmployeeChange(client, { action: 'edited', employeeName: `${emp.firstName} ${emp.lastName}`, storeId, storeName: store.name, changes: diffs.join(', '), source: 'admin' });
  }
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
  logEmployeeChange(client, { action: 'removed', employeeName: `${removed.firstName} ${removed.lastName}`, storeId, storeName: store.name, changes: removed.position || null, source: 'admin' });
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
    goByName: b.goByName || '',
    excludeFromTips: !!b.excludeFromTips,
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

  // Log change and notify
  logEmployeeChange(client, { action: 'added', employeeName: `${b.firstName} ${b.lastName}`, storeId, storeName: store.name, changes: `Added by client. Email: ${b.email || 'none'}`, source: 'client' });
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
  const { slug, name, password, stores, payFrequency, contactEmail, workLocations } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'Slug and name required' });

  const existing = payrollData.clients[slug];
  payrollData.clients[slug] = {
    name,
    password: password || (existing ? existing.password : ''),
    stores: stores || (existing ? existing.stores : {}),
    payFrequency: payFrequency || (existing ? existing.payFrequency : ''),
    contactEmail: contactEmail !== undefined ? contactEmail : (existing ? (existing.contactEmail || '') : ''),
    workLocations: workLocations || (existing ? existing.workLocations : []),
    _sessionToken: existing ? existing._sessionToken : null,
    _notifications: existing ? existing._notifications : [],
    _prefill: existing ? existing._prefill : undefined,
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

// ── Dashboard: Save contact email for a payroll client ───────────
app.patch('/payroll/config/:slug/email', requireAuth, (req, res) => {
  const client = payrollData.clients[req.params.slug];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  client.contactEmail = req.body.contactEmail || '';
  savePayrollData();
  res.json({ success: true });
});

// ── Dashboard: Save pre-filled hours for a client (AM uploads) ───
app.post('/payroll/prefill/:slug', requireAuth, (req, res) => {
  const client = payrollData.clients[req.params.slug];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { payPeriodStart, payPeriodEnd, payDate, stores } = req.body;
  if (!payPeriodStart || !payPeriodEnd || !payDate || !stores) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  client._prefill = {
    payPeriodStart, payPeriodEnd, payDate, stores,
    createdAt: new Date().toISOString(),
  };
  savePayrollData();
  res.json({ success: true });
});

// ── Clear prefill data for a client (admin OR client token) ───────
app.delete('/payroll/prefill/:slug', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const client = payrollData.clients[req.params.slug];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  // Accept client session token OR admin CRM session token
  const isClient = client._sessionToken === token;
  const isAdmin = _sessions.has(token);
  if (!isClient && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  delete client._prefill;
  savePayrollData();
  res.json({ success: true });
});

// ── Payroll Drafts (server-side, shared across logins) ───────────
app.get('/payroll/drafts/:clientSlug/:storeId', (req, res) => {
  const { clientSlug, storeId } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');
  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) return res.status(401).json({ error: 'Unauthorized' });

  const draft = client._drafts?.[storeId] || null;
  res.json({ draft });
});

app.put('/payroll/drafts/:clientSlug/:storeId', (req, res) => {
  const { clientSlug, storeId } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');
  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) return res.status(401).json({ error: 'Unauthorized' });

  if (!client._drafts) client._drafts = {};
  client._drafts[storeId] = { ...req.body, savedAt: new Date().toISOString() };
  savePayrollData();
  res.json({ success: true });
});

app.delete('/payroll/drafts/:clientSlug/:storeId', (req, res) => {
  const { clientSlug, storeId } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');
  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) return res.status(401).json({ error: 'Unauthorized' });

  if (client._drafts) {
    delete client._drafts[storeId];
    savePayrollData();
  }
  res.json({ success: true });
});

app.delete('/payroll/drafts/:clientSlug', (req, res) => {
  const { clientSlug } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');
  const client = payrollData.clients[clientSlug];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  // Accept client session token OR admin CRM session token
  const isClient = client._sessionToken === token;
  const isAdmin = _sessions.has(token);
  if (!isClient && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  client._drafts = {};
  savePayrollData();
  res.json({ success: true });
});

// ── Admin: Clear all drafts for a client ──────────────────────────
app.delete('/payroll/admin/drafts/:clientSlug', requireAuth, (req, res) => {
  const client = payrollData.clients[req.params.clientSlug];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  client._drafts = {};
  savePayrollData();
  res.json({ success: true });
});

// ── Get all draft statuses for a client (see which stores are confirmed) ──
app.get('/payroll/drafts/:clientSlug', (req, res) => {
  const { clientSlug } = req.params;
  const token = req.headers.authorization?.replace('Bearer ', '');
  const client = payrollData.clients[clientSlug];
  if (!client || client._sessionToken !== token) return res.status(401).json({ error: 'Unauthorized' });

  const drafts = client._drafts || {};
  const summary = {};
  for (const [storeId, draft] of Object.entries(drafts)) {
    summary[storeId] = {
      confirmed: !!draft.confirmed,
      savedAt: draft.savedAt || null,
      periodStart: draft.periodStart || null,
      periodEnd: draft.periodEnd || null,
    };
  }
  res.json({ drafts: summary });
});

// ── Employee Change Log ──────────────────────────────────────────
app.get('/payroll/changelog/:clientSlug', (req, res) => {
  const { clientSlug } = req.params;
  const client = payrollData.clients[clientSlug];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json({ changelog: client._changeLog || [] });
});

app.get('/payroll/changelog', (req, res) => {
  // All clients' changelogs combined
  const all = [];
  for (const [slug, client] of Object.entries(payrollData.clients || {})) {
    (client._changeLog || []).forEach(entry => {
      all.push({ ...entry, clientSlug: slug, clientName: client.name });
    });
  }
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ changelog: all.slice(0, 100) });
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

// ── Dashboard: Delete a submission ───────────────────────────────
app.delete('/payroll/submissions/:id', (req, res) => {
  const idx = payrollData.submissions.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Submission not found' });
  payrollData.submissions.splice(idx, 1);
  savePayrollData();
  res.json({ success: true });
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
const PL_OVERRIDES_FILE = path.join(DATA_DIR, 'pl-overrides.json');
const PL_REVIEWS_FILE = path.join(DATA_DIR, 'pl-reviews.json');
const CLOSE_TRACKER_FILE = path.join(DATA_DIR, 'close-tracker.json');
const PL_FLEET_KNOWLEDGE_FILE = path.join(DATA_DIR, 'pl-fleet-knowledge.json');

// Load persisted data
let plHistory = {};       // { [realmId]: { [period]: { metrics, accounts, savedAt } } }
let fleetData = {};       // { accounts: { [name]: { storeCount, stores, amounts, avgPct, minPct, maxPct } }, storeCount: 0 }
let plThresholds = {};    // { _global: {...}, [realmId]: {...} }
let plAnticipated = {};   // { _templates: { scooters: [...] }, [realmId]: [...] }
let plOverrides = {};     // { [realmId]: { [accountName]: { expectedAmount, tolerance, note, expiresAt, setBy, setAt } } }
let plReviews = {};       // { [realmId:period]: { decisions, notes, completedAt } }
let closeTracker = {};    // { [realmId:YYYY-MM]: { realmId, clientId, clientName, period, checklist, status, flagCount, ... } }

function loadJsonFile(filepath, fallback) {
  if (!fs.existsSync(filepath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch(e) { return fallback; }
}
plHistory    = loadJsonFile(PL_HISTORY_FILE, {});
fleetData    = loadJsonFile(FLEET_DATA_FILE, { accounts: {}, storeCount: 0 });
plThresholds = loadJsonFile(PL_THRESHOLDS_FILE, { _global: {} });
plOverrides  = loadJsonFile(PL_OVERRIDES_FILE, {});
plReviews    = loadJsonFile(PL_REVIEWS_FILE, {});
closeTracker = loadJsonFile(CLOSE_TRACKER_FILE, {});

// Fleet-wide P&L knowledge — aliases (account name → real account name)
// learned across all stores, plus vendor → typical-account patterns.
//   aliases: { [canonical]: { candidates: [{ actual, votes, stores[], firstTaught, lastTaught }], rejected: [...] } }
//   vendorPatterns: { [vendor_lower]: { [accountName]: count } }
let plFleetKnowledge = loadJsonFile(PL_FLEET_KNOWLEDGE_FILE, { aliases: {}, vendorPatterns: {} });
if (!plFleetKnowledge.aliases) plFleetKnowledge.aliases = {};
if (!plFleetKnowledge.vendorPatterns) plFleetKnowledge.vendorPatterns = {};
function savePlFleetKnowledge() { fs.writeFileSync(PL_FLEET_KNOWLEDGE_FILE, JSON.stringify(plFleetKnowledge, null, 2)); }
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
function savePlOverrides()  { fs.writeFileSync(PL_OVERRIDES_FILE, JSON.stringify(plOverrides, null, 2)); }
function savePlReviews()    { fs.writeFileSync(PL_REVIEWS_FILE, JSON.stringify(plReviews, null, 2)); }
function saveCloseTracker() { fs.writeFileSync(CLOSE_TRACKER_FILE, JSON.stringify(closeTracker, null, 2)); }

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

// ── Fleet Sales Trends (MOM & YOY) ──────────────────────────────
app.get('/pl/fleet/sales-trends', (req, res) => {
  // Compute fleet-wide MOM and YOY sales % from all stores' history
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  // Build monthly fleet totals: { "2026-03": { totalSales: X, storeCount: N }, ... }
  const monthlyTotals = {};

  for (const [realmId, periods] of Object.entries(plHistory)) {
    for (const [periodKey, data] of Object.entries(periods)) {
      const sales = data.metrics?.sales;
      if (!sales || sales <= 0) continue;

      // Period key is "YYYY-MM-DD_YYYY-MM-DD" — extract the month from start date
      const startDate = periodKey.split('_')[0];
      if (!startDate) continue;
      const month = startDate.slice(0, 7); // "YYYY-MM"

      if (!monthlyTotals[month]) monthlyTotals[month] = { totalSales: 0, storeCount: 0, stores: [] };
      // Avoid double-counting same store in same month
      if (!monthlyTotals[month].stores.includes(realmId)) {
        monthlyTotals[month].totalSales += sales;
        monthlyTotals[month].storeCount++;
        monthlyTotals[month].stores.push(realmId);
      }
    }
  }

  // Current month and comparison months
  const curMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const prevMonth = now.getMonth() === 0
    ? `${now.getFullYear() - 1}-12`
    : `${now.getFullYear()}-${pad(now.getMonth())}`;
  const yoyMonth = `${now.getFullYear() - 1}-${pad(now.getMonth() + 1)}`;

  // Also check last completed month if current month has no data yet
  const cur = monthlyTotals[curMonth];
  const prev = monthlyTotals[prevMonth];
  const useMonth = cur ? curMonth : prevMonth;
  const usePrev = cur ? prevMonth : (now.getMonth() <= 1
    ? `${now.getFullYear() - 1}-${pad(now.getMonth() === 0 ? 11 : now.getMonth() - 1 + 1)}`
    : `${now.getFullYear()}-${pad(now.getMonth() - 1)}`);
  const useYoy = cur
    ? `${now.getFullYear() - 1}-${pad(now.getMonth() + 1)}`
    : `${now.getFullYear() - 1}-${pad(now.getMonth())}`;

  const currentData = monthlyTotals[useMonth];
  const prevData = monthlyTotals[usePrev];
  const yoyData = monthlyTotals[useYoy];

  const result = {
    currentMonth: useMonth,
    currentSales: currentData?.totalSales || 0,
    currentStoreCount: currentData?.storeCount || 0,
    momPct: null,
    momPrevMonth: usePrev,
    momPrevSales: prevData?.totalSales || 0,
    yoyPct: null,
    yoyPrevMonth: useYoy,
    yoyPrevSales: yoyData?.totalSales || 0,
  };

  // MOM: compare per-store average (handles different store counts)
  if (currentData && prevData && prevData.storeCount > 0 && currentData.storeCount > 0) {
    const curAvg = currentData.totalSales / currentData.storeCount;
    const prevAvg = prevData.totalSales / prevData.storeCount;
    if (prevAvg > 0) result.momPct = ((curAvg - prevAvg) / prevAvg) * 100;
  }

  // YOY: compare per-store average
  if (currentData && yoyData && yoyData.storeCount > 0 && currentData.storeCount > 0) {
    const curAvg = currentData.totalSales / currentData.storeCount;
    const yoyAvg = yoyData.totalSales / yoyData.storeCount;
    if (yoyAvg > 0) result.yoyPct = ((curAvg - yoyAvg) / yoyAvg) * 100;
  }

  res.json(result);
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

// ── AM Overrides ────────────────────────────────────────────────
app.get('/pl/overrides/:realmId', (req, res) => {
  const overrides = plOverrides[req.params.realmId] || {};
  // Filter out expired overrides
  const now = new Date().toISOString();
  const active = {};
  for (const [acct, ov] of Object.entries(overrides)) {
    if (!ov.expiresAt || ov.expiresAt > now) active[acct] = ov;
  }
  res.json({ overrides: active });
});

app.post('/pl/overrides/:realmId', (req, res) => {
  const rid = req.params.realmId;
  const { account, override } = req.body;
  if (!account) return res.status(400).json({ error: 'account required' });
  if (!plOverrides[rid]) plOverrides[rid] = {};
  plOverrides[rid][account] = {
    ...override,
    setAt: new Date().toISOString(),
  };
  savePlOverrides();
  res.json({ success: true });
});

app.delete('/pl/overrides/:realmId/:account', (req, res) => {
  const rid = req.params.realmId;
  const account = decodeURIComponent(req.params.account);
  if (plOverrides[rid]) {
    delete plOverrides[rid][account];
    savePlOverrides();
  }
  res.json({ success: true });
});

// ── Review State Persistence ────────────────────────────────────
app.get('/pl/review/:realmId/:period', (req, res) => {
  const key = `${req.params.realmId}:${req.params.period}`;
  res.json({ review: plReviews[key] || null });
});

app.post('/pl/review/:realmId/:period', (req, res) => {
  const key = `${req.params.realmId}:${req.params.period}`;
  const { decisions, notes, completedAt } = req.body;
  plReviews[key] = { decisions: decisions || {}, notes: notes || {}, completedAt: completedAt || null, savedAt: new Date().toISOString() };
  savePlReviews();
  res.json({ success: true });
});

// ── Monthly Close Tracker ───────────────────────────────────────

// Get all close-tracker entries, optionally filtered by period
app.get('/pl/close-tracker', (req, res) => {
  const period = req.query.period; // YYYY-MM
  if (period) {
    const filtered = {};
    for (const [key, entry] of Object.entries(closeTracker)) {
      if (entry.period === period) filtered[key] = entry;
    }
    return res.json({ entries: filtered });
  }
  res.json({ entries: closeTracker });
});

// Get single store close-tracker entry
app.get('/pl/close-tracker/:realmId/:period', (req, res) => {
  const key = `${req.params.realmId}:${req.params.period}`;
  res.json({ entry: closeTracker[key] || null });
});

// Create or update a store's close-tracker entry (partial merge)
app.post('/pl/close-tracker/:realmId/:period', (req, res) => {
  const { realmId, period } = req.params;
  const key = `${realmId}:${period}`;
  const existing = closeTracker[key] || {
    realmId,
    clientId: null,
    clientName: null,
    period,
    checklist: {
      salesJE:     { checked: false, checkedBy: null, checkedAt: null },
      cogsJE:      { checked: false, checkedBy: null, checkedAt: null },
      payroll:     { checked: false, checkedBy: null, checkedAt: null },
      recurringJE: { checked: false, checkedBy: null, checkedAt: null },
      bankRec:     { checked: false, checkedBy: null, checkedAt: null },
    },
    status: 'closing',
    flagCount: 0,
    criticalCount: 0,
    revenue: null,
    cogsPct: null,
    payrollPct: null,
    netPct: null,
    lastReviewedAt: null,
    lastReviewedBy: null,
  };
  // Merge incoming fields (shallow merge, deep merge checklist)
  const body = req.body;
  if (body.clientId !== undefined)       existing.clientId = body.clientId;
  if (body.clientName !== undefined)     existing.clientName = body.clientName;
  if (body.status !== undefined)         existing.status = body.status;
  if (body.flagCount !== undefined)      existing.flagCount = body.flagCount;
  if (body.criticalCount !== undefined)  existing.criticalCount = body.criticalCount;
  if (body.revenue !== undefined)        existing.revenue = body.revenue;
  if (body.cogsPct !== undefined)        existing.cogsPct = body.cogsPct;
  if (body.payrollPct !== undefined)     existing.payrollPct = body.payrollPct;
  if (body.netPct !== undefined)         existing.netPct = body.netPct;
  if (body.lastReviewedAt !== undefined) existing.lastReviewedAt = body.lastReviewedAt;
  if (body.lastReviewedBy !== undefined) existing.lastReviewedBy = body.lastReviewedBy;
  if (body.checklist) {
    for (const [item, val] of Object.entries(body.checklist)) {
      if (existing.checklist[item]) Object.assign(existing.checklist[item], val);
    }
  }
  existing.updatedAt = new Date().toISOString();
  closeTracker[key] = existing;
  saveCloseTracker();
  res.json({ success: true, entry: existing });
});

// Toggle a single checklist item
app.post('/pl/close-tracker/:realmId/:period/check', (req, res) => {
  const { realmId, period } = req.params;
  const key = `${realmId}:${period}`;
  const { item, checked, checkedBy } = req.body;
  if (!item) return res.status(400).json({ error: 'item required' });

  // Auto-create entry if it doesn't exist
  if (!closeTracker[key]) {
    closeTracker[key] = {
      realmId, clientId: null, clientName: null, period,
      checklist: {
        salesJE:     { checked: false, checkedBy: null, checkedAt: null },
        cogsJE:      { checked: false, checkedBy: null, checkedAt: null },
        payroll:     { checked: false, checkedBy: null, checkedAt: null },
        recurringJE: { checked: false, checkedBy: null, checkedAt: null },
        bankRec:     { checked: false, checkedBy: null, checkedAt: null },
      },
      status: 'closing', flagCount: 0, criticalCount: 0,
      revenue: null, cogsPct: null, payrollPct: null, netPct: null,
      lastReviewedAt: null, lastReviewedBy: null,
    };
  }

  const entry = closeTracker[key];
  if (!entry.checklist[item]) return res.status(400).json({ error: 'unknown checklist item' });

  entry.checklist[item].checked = !!checked;
  entry.checklist[item].checkedBy = checked ? (checkedBy || null) : null;
  entry.checklist[item].checkedAt = checked ? new Date().toISOString() : null;

  // Recalculate status
  const allDone = Object.values(entry.checklist).every(c => c.checked);
  if (allDone && entry.status === 'closing') {
    entry.status = 'ready';
  } else if (!allDone) {
    entry.status = 'closing';
  }
  entry.updatedAt = new Date().toISOString();
  saveCloseTracker();
  res.json({ success: true, allDone, entry });
});

// Fleet Scoreboard — aggregated view across all stores for a period
// ── P&L Fleet Knowledge ──────────────────────────────────────────
// Cross-store learning so the Digester gets smarter as AMs use it.
//
// Aliases: when an AM teaches "this account is what we mean by 'Sales'",
// every other store benefits. Stored with provenance so bad mappings can
// be audited and removed.
//
// Vendor patterns: silent accumulation — every detail report run, the
// dashboard POSTs vendor → account observations. Future misposted-detection
// will use this to flag charges in unusual accounts for known vendors.

app.get('/pl/fleet-knowledge', (req, res) => {
  res.json({ knowledge: plFleetKnowledge });
});

// Teach: an AM/admin says "anticipated 'Sales' was actually found at 'Coffee Sales'".
// Upserts into candidates and increments vote counter.
app.post('/pl/fleet-knowledge/alias', (req, res) => {
  const { canonical, actual, realmId, by } = req.body || {};
  if (!canonical || !actual) return res.status(400).json({ error: 'canonical and actual required' });

  const c = String(canonical).trim();
  const a = String(actual).trim();
  if (!c || !a) return res.status(400).json({ error: 'empty values not allowed' });

  if (!plFleetKnowledge.aliases[c]) plFleetKnowledge.aliases[c] = { candidates: [], rejected: [] };
  const bucket = plFleetKnowledge.aliases[c];

  // If this exact mapping is on the rejected list, ignore the teach
  if (bucket.rejected.some(r => r.actual.toLowerCase() === a.toLowerCase())) {
    return res.json({ success: false, error: 'mapping was previously rejected; un-reject first' });
  }

  let cand = bucket.candidates.find(x => x.actual.toLowerCase() === a.toLowerCase());
  const now = new Date().toISOString();
  if (!cand) {
    cand = {
      actual: a,
      votes: 0,
      stores: [],
      firstTaught: { by: by || 'Unknown', at: now, realmId: realmId || null },
      lastTaught: { by: by || 'Unknown', at: now, realmId: realmId || null },
    };
    bucket.candidates.push(cand);
  }
  cand.votes++;
  if (realmId && !cand.stores.includes(realmId)) cand.stores.push(realmId);
  cand.lastTaught = { by: by || 'Unknown', at: now, realmId: realmId || null };

  // Sort candidates by votes desc so consumers can take the top easily
  bucket.candidates.sort((x, y) => y.votes - x.votes);

  savePlFleetKnowledge();
  res.json({ success: true, candidate: cand });
});

// Reject: admin removes a bad mapping (e.g., someone taught "Sales" → "Frozen Yogurt")
app.post('/pl/fleet-knowledge/alias/reject', (req, res) => {
  const { canonical, actual, by } = req.body || {};
  if (!canonical || !actual) return res.status(400).json({ error: 'canonical and actual required' });
  const c = String(canonical).trim();
  const a = String(actual).trim();
  const bucket = plFleetKnowledge.aliases[c];
  if (!bucket) return res.json({ success: true, removed: 0 });
  const before = bucket.candidates.length;
  bucket.candidates = bucket.candidates.filter(x => x.actual.toLowerCase() !== a.toLowerCase());
  if (!bucket.rejected.some(r => r.actual.toLowerCase() === a.toLowerCase())) {
    bucket.rejected.push({ actual: a, by: by || 'Unknown', at: new Date().toISOString() });
  }
  savePlFleetKnowledge();
  res.json({ success: true, removed: before - bucket.candidates.length });
});

// Vendor pattern accumulation — bulk increment from a detail-report run
app.post('/pl/fleet-knowledge/vendors', (req, res) => {
  const { patterns } = req.body || {};
  if (!Array.isArray(patterns)) return res.status(400).json({ error: 'patterns array required' });
  let added = 0;
  for (const p of patterns) {
    if (!p || !p.vendor || !p.account) continue;
    const v = String(p.vendor).toLowerCase().trim();
    const a = String(p.account).trim();
    if (!v || !a) continue;
    if (!plFleetKnowledge.vendorPatterns[v]) plFleetKnowledge.vendorPatterns[v] = {};
    plFleetKnowledge.vendorPatterns[v][a] = (plFleetKnowledge.vendorPatterns[v][a] || 0) + 1;
    added++;
  }
  if (added > 0) savePlFleetKnowledge();
  res.json({ success: true, added });
});

app.get('/pl/fleet/scoreboard', (req, res) => {
  const now = new Date();
  const period = req.query.period || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rows = [];

  for (const [key, entry] of Object.entries(closeTracker)) {
    if (entry.period !== period) continue;

    const checkedCount = Object.values(entry.checklist).filter(c => c.checked).length;
    const totalItems = Object.keys(entry.checklist).length;

    // Enrich with P&L history if available
    let revenue = entry.revenue, cogsPct = entry.cogsPct, payrollPct = entry.payrollPct, netPct = entry.netPct;
    if (revenue === null && entry.realmId && plHistory[entry.realmId]) {
      const periods = Object.keys(plHistory[entry.realmId]).sort();
      const latest = periods[periods.length - 1];
      if (latest) {
        const m = plHistory[entry.realmId][latest]?.metrics;
        if (m) {
          revenue = m.sales || m.revenue || null;
          cogsPct = m.cogsPct || null;
          payrollPct = m.payrollPct || null;
          netPct = m.netPct || null;
        }
      }
    }

    // Enrich with review flag counts
    let flagCount = entry.flagCount || 0;
    let criticalCount = entry.criticalCount || 0;
    const reviewKey = `${entry.realmId}:${period}`;
    // plReviews may have been populated after digest
    if (plReviews[reviewKey] && plReviews[reviewKey].completedAt && entry.status === 'ready') {
      // Review was completed but status wasn't updated yet
    }

    rows.push({
      realmId: entry.realmId,
      clientId: entry.clientId,
      clientName: entry.clientName,
      period: entry.period,
      status: entry.status,
      checkedCount,
      totalItems,
      revenue,
      cogsPct,
      payrollPct,
      netPct,
      flagCount,
      criticalCount,
      lastReviewedAt: entry.lastReviewedAt,
      lastReviewedBy: entry.lastReviewedBy,
    });
  }

  // Sort: needs-action first, then ready, then closing, then clean/reviewed
  const statusOrder = { 'needs-action': 0, 'ready': 1, 'closing': 2, 'reviewed': 3, 'clean': 4 };
  rows.sort((a, b) => (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5) || (a.clientName || '').localeCompare(b.clientName || ''));

  res.json({ period, rows, total: rows.length });
});

// ── Auto-Learned Benchmarks ─────────────────────────────────────
app.get('/pl/benchmarks/:realmId', (req, res) => {
  const rid = req.params.realmId;
  const history = plHistory[rid] || {};
  const periods = Object.keys(history).sort().slice(-12); // last 12 months
  if (periods.length < 3) return res.json({ benchmarks: {}, periods: periods.length });

  const accountData = {};
  for (const p of periods) {
    const accts = history[p]?.accounts || [];
    const metrics = history[p]?.metrics || {};
    const sales = metrics.sales || 1;
    for (const a of accts) {
      if (!a.name || Math.abs(a.amount) < 1) continue;
      if (!accountData[a.name]) accountData[a.name] = [];
      accountData[a.name].push({ amount: Math.abs(a.amount), pctOfSales: Math.abs(a.amount) / sales });
    }
  }

  const benchmarks = {};
  for (const [name, data] of Object.entries(accountData)) {
    if (data.length < 3) continue;
    const amounts = data.map(d => d.amount);
    const pcts = data.map(d => d.pctOfSales);
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const stdDev = Math.sqrt(amounts.reduce((s, a) => s + (a - avg) ** 2, 0) / amounts.length);
    const pctAvg = pcts.reduce((s, p) => s + p, 0) / pcts.length;
    benchmarks[name] = { avg, stdDev, min: Math.min(...amounts), max: Math.max(...amounts), pctAvg, months: data.length };
  }

  res.json({ benchmarks, periods: periods.length });
});

// ── Two-Pass AI Analysis (v2) ────────────────────────────────────

// Pass 1: Structural Analysis — forensic bookkeeper findings
app.post('/pl/digest/analyze', async (req, res) => {
  const { plData, preFlags, summary, history, historySMLY, fleetContext, fleetCohort, vendorConsolidationHints, anticipated, clientName, period, overrides, coaAccounts } = req.body;

  // Validate the one field we truly can't work without — before key check
  if (!Array.isArray(plData)) {
    return res.status(400).json({ error: 'plData array is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  // Build COA context string — use client's real COA if available, fall back to generic template
  let coaSection = '';
  if (coaAccounts && coaAccounts.length > 0) {
    const byType = {};
    for (const a of coaAccounts) {
      const t = a.type || 'Other';
      if (!byType[t]) byType[t] = [];
      byType[t].push(a.name + (a.subType ? ` (${a.subType})` : ''));
    }
    coaSection = `\n\nTHIS CLIENT'S ACTUAL CHART OF ACCOUNTS (${coaAccounts.length} accounts from QBO):
${Object.entries(byType).map(([type, names]) => `${type}:\n${names.map(n => '  - ' + n).join('\n')}`).join('\n')}

IMPORTANT: When suggesting account reclassifications, ONLY suggest accounts from this list. Do not invent account names.`;
  } else {
    coaSection = `\n\nKnown Scooters COA structure (generic — client's actual COA was not available):
- Revenue: Sales (may also appear as "Store Sales"), Catering Income, Tip Income
- COGS: Consumable COGS (Harvest products), Paper COGS, Other COGS
- Royalties/Fees: Royalty Fees (~6% of sales), Ad Fund National (~2%), Ad Fund Local (~1-2%), Technology Fee
- Payroll: Wages, Payroll Taxes, Workers Comp, Health Insurance, 401k, Bonuses
- Occupancy: Rent, CAM, Utilities, Property Tax
- Operating: Bank Charges, Insurance, Repairs, Supplies, Marketing`;
  }

  const systemPrompt = `You are a senior forensic bookkeeper and financial analyst reviewing a monthly P&L for a Scooters Coffee franchise store. You work for ARK Financial Services. Your job is to find EVERYTHING that is wrong, missing, unusual, or noteworthy.

You have access to:
- The current month's P&L (account-level data with amounts)
- Up to 13 months of historical P&L data for this specific store (enables MoM AND YoY comparison)
- A dedicated same-month-last-year (SMLY) comparison block with YoY deltas on the key metrics
- Fleet-wide averages across all Scooters stores ARK manages
- A list of anticipated/expected monthly expenses configured for this store
- Pre-flags from our automated rule engine (includes 'mom' and 'smly' source flags for month-over-month and year-over-year variances)
- AM overrides (accounts the AM has previously reviewed and marked as acceptable — DO NOT re-flag these unless the amount has changed significantly beyond the override tolerance)
- The client's actual Chart of Accounts from QuickBooks Online${coaSection}

IMPORTANT — AVOID DUPLICATE FLAGS:
The pre-flags from our rule engine are already shown to the user. DO NOT re-flag accounts that already appear in the pre-flags list. Instead, focus on finding NEW issues the rule engine missed. If an account is already flagged as MISSING, VARIANCE, or any other issue in the pre-flags, skip it entirely. Your value is catching things the rule engine cannot see.

YOUR ANALYSIS MUST COVER:

1. MISSING EXPENSES — ONLY flag items NOT already in the pre-flags. Check anticipated expenses and historical patterns, but skip any account already flagged by the rule engine.

2. VARIANCE ALERTS: For each account, compare the current amount against:
   - The store's own rolling 12-month average (flag >25% variance)
   - Same-month-last-year (use the historySMLY block — flag YoY swings that aren't explained by seasonality or store growth)
   - The fleet average % of revenue (flag if this store is an outlier)
   - The anticipated/expected amount if configured

3. TREND FINDINGS: Look for multi-month patterns:
   - Revenue growth or decline trends (use full 13-month history)
   - Expense creep (payroll slowly climbing as % of sales over months)
   - Seasonal patterns — compare this month vs SMLY to distinguish seasonal shifts from structural changes
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

${history ? `HISTORICAL DATA (trailing 13 months — includes SMLY when available):
${JSON.stringify(history, null, 2)}` : 'No historical data available.'}

${historySMLY ? `SAME-MONTH-LAST-YEAR (YoY comparison, ${historySMLY.period || 'prior year'}):
${JSON.stringify(historySMLY, null, 2)}` : 'No SMLY data yet (store has <12 months of history).'}

${fleetContext ? `FLEET DATA (all Scooters stores):
${JSON.stringify(fleetContext, null, 2)}` : 'No fleet data available.'}

${fleetCohort ? `PEER COHORT (this store is in the "${fleetCohort.tier}" revenue tier of ${fleetCohort.tierSize} stores):
Use these peer averages when comparing this store — they are more meaningful than fleet-wide averages because they control for store size. Revenue range for this tier: ${fleetCohort.tierRevenueRange ? `$${Math.round(fleetCohort.tierRevenueRange.min).toLocaleString()} – $${Math.round(fleetCohort.tierRevenueRange.max).toLocaleString()}` : 'unknown'}.
${JSON.stringify(fleetCohort.peerAvgs, null, 2)}` : ''}

${vendorConsolidationHints && vendorConsolidationHints.length ? `VENDOR CONSOLIDATION HINTS (vendors mapped to multiple accounts across the fleet):
These vendors appear under different accounts at different stores. If any of this store's transactions involve these vendors, consider whether the account matches the fleet majority.
${JSON.stringify(vendorConsolidationHints, null, 2)}` : ''}

${overrides && Object.keys(overrides).length ? `AM OVERRIDES (previously approved — skip these unless amount changed significantly):
${JSON.stringify(overrides, null, 2)}` : ''}

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
    const truncated = aiData.stop_reason === 'max_tokens';

    let findings = {};
    let parseError = null;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) findings = JSON.parse(jsonMatch[0]);
      else parseError = 'No JSON object in AI response';
    } catch(e) {
      parseError = e.message;
      console.error('Failed to parse AI findings:', e.message);
      findings = { anomalies: [{ severity: 'INFO', account: '', amount: null, message: `AI analysis returned non-parseable results${truncated ? ' (response was truncated at max_tokens)' : ''}.`, suggestedAccount: null }] };
    }

    const findingCount = Object.values(findings).flat().length;
    console.log(`  ✓ P&L Analyze (Pass 1): ${findingCount} total findings${truncated ? ' [TRUNCATED]' : ''}${parseError ? ' [parse: ' + parseError + ']' : ''}`);
    res.json({ success: true, findings, truncated, parseError, usage: aiData.usage });

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
  // Scale max_tokens with finding volume — larger analyses need more room
  // for the brief without getting truncated mid-JSON.
  const findingCount = findings && typeof findings === 'object' ? Object.values(findings).flat().length : 0;
  const maxTokens = findingCount > 20 ? 4096 : (findingCount > 10 ? 3072 : 2048);

  const systemPrompt = `You are a senior financial advisor at ARK Financial Services preparing a client meeting brief for a Scooters Coffee franchise owner. The owner is NOT an accountant — they understand their business but need financial information presented clearly and actionably.

Your job is to take the forensic analysis findings and translate them into:

1. EXECUTIVE SUMMARY: 2-3 sentences that give the owner the big picture. Start with the headline (good month? bad month? something needs attention?). Include the key numbers they care about: sales, net income, and the most important variance.

2. TALKING POINTS: 5-8 bullet points the ARK account manager should bring up in the meeting. Each should be specific, actionable, and include dollar amounts. Frame negatives as opportunities. If fleet sales trends (MOM% and YOY%) are provided in the summary, ALWAYS include a talking point about how the fleet is trending overall — this gives the owner context on how the brand is performing, not just their store. Examples:
   - "Sales were $52,400, up 8% from last month — great momentum heading into summer"
   - "Across the Scooters fleet, sales are up 4.2% month-over-month and 12.1% year-over-year — the brand is growing"
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
        max_tokens: maxTokens,
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
    const truncated = aiData.stop_reason === 'max_tokens';

    let prep = {};
    let parseError = null;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) prep = JSON.parse(jsonMatch[0]);
      else parseError = 'No JSON object in AI response';
    } catch(e) {
      parseError = e.message;
      console.error('Failed to parse meeting prep:', e.message);
      prep = { executiveSummary: `Meeting prep generation failed${truncated ? ' (response truncated at max_tokens)' : ''}.`, talkingPoints: [], clientInsights: [], actionItems: [] };
    }

    console.log(`  ✓ P&L Meeting Prep (Pass 2): ${(prep.talkingPoints||[]).length} talking points [max=${maxTokens}]${truncated ? ' [TRUNCATED]' : ''}${parseError ? ' [parse: ' + parseError + ']' : ''}`);
    res.json({ success: true, prep, truncated, parseError, usage: aiData.usage });

  } catch (e) {
    console.error('P&L Meeting Prep error:', e.message);
    res.status(500).json({ error: 'Meeting prep failed: ' + e.message });
  }
});

// ── Import Wizard: AI column mapping ─────────────────────────────
// Proxies an Anthropic call to map CSV headers → ARK CRM field keys.
// Lives server-side so the API key never touches the browser. Body:
//   { headers: string[], samples: string[][], arkFields: [{key,label}] }
// Returns: { success, mapping: { [header]: arkKey } }
app.post('/api/import/map-columns', async (req, res) => {
  const { headers, samples, arkFields } = req.body || {};
  if (!Array.isArray(headers) || !headers.length) {
    return res.status(400).json({ error: 'headers array is required' });
  }
  if (!Array.isArray(arkFields) || !arkFields.length) {
    return res.status(400).json({ error: 'arkFields array is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const sampleLines = headers.map((h, i) => {
    const vals = (Array.isArray(samples) ? samples : []).slice(0, 3).map(r => (r && r[i]) || '').filter(Boolean);
    return `"${h}": [${vals.map(v => `"${String(v).replace(/"/g,'\\"')}"`).join(', ')}]`;
  });
  const fieldList = arkFields.map(f => `${f.key} (${f.label})`).join(', ');

  const prompt = `You are a data analyst mapping CSV column headers to a CRM field schema.

CSV column headers and sample values:
${sampleLines.join('\n')}

Available ARK CRM fields:
${fieldList}

For each CSV column, suggest the best matching ARK field key, or "_skip" if none fits.
Reply ONLY with a JSON object: { "columnName": "arkFieldKey", ... }
Use exact ARK field keys. If a column contains sensitive data (SSN, EIN, bank account, password, routing number, PIN), map it to "_skip".`;

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
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error (import/map-columns):', response.status, errBody);
      return res.status(502).json({ error: `AI service error: ${response.status}` });
    }

    const aiData = await response.json();
    const content = (aiData.content || []).map(b => b.text || '').join('');
    const jsonMatch = content.match(/\{[\s\S]+\}/);
    if (!jsonMatch) {
      return res.status(502).json({ error: 'No JSON object in AI response' });
    }
    let mapping = {};
    try { mapping = JSON.parse(jsonMatch[0]); }
    catch (e) { return res.status(502).json({ error: 'AI returned non-parseable JSON: ' + e.message }); }

    const validKeys = new Set(arkFields.map(f => f.key).concat(['_skip']));
    const cleanMapping = {};
    for (const h of headers) {
      const v = mapping[h];
      cleanMapping[h] = validKeys.has(v) ? v : '_skip';
    }

    console.log(`  ✓ Import AI map-columns: ${Object.keys(cleanMapping).length} headers mapped`);
    res.json({ success: true, mapping: cleanMapping, usage: aiData.usage });

  } catch (e) {
    console.error('Import map-columns error:', e.message);
    res.status(500).json({ error: 'Column mapping failed: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Zoom Integration (Server-to-Server OAuth)
// ─────────────────────────────────────────────────────────────────

const ZOOM_ACCOUNT_ID     = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID      = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET  = process.env.ZOOM_CLIENT_SECRET;
const ZOOM_USER_ID        = process.env.ZOOM_USER_ID || 'me'; // email or 'me' — S2S apps may need the account owner's email

let zoomTokenCache = { token: null, expiresAt: 0 };

async function getZoomToken() {
  if (zoomTokenCache.token && Date.now() < zoomTokenCache.expiresAt) {
    return zoomTokenCache.token;
  }
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    throw new Error('Zoom credentials not configured');
  }
  const basicAuth = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Zoom token error:', res.status, err);
    throw new Error(`Zoom auth failed: ${res.status}`);
  }
  const data = await res.json();
  zoomTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  console.log('  ✓ Zoom token refreshed');
  return data.access_token;
}

// Status check
app.get('/zoom/status', (req, res) => {
  res.json({ configured: !!(ZOOM_ACCOUNT_ID && ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET) });
});

// Create a Zoom meeting
app.post('/zoom/create-meeting', async (req, res) => {
  try {
    const token = await getZoomToken();
    const { topic, startTime, duration, agenda } = req.body;
    const zoomRes = await fetch(`https://api.zoom.us/v2/users/${ZOOM_USER_ID}/meetings`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: topic || 'ARK Financial Meeting',
        type: startTime ? 2 : 1, // 2=scheduled, 1=instant
        start_time: startTime || undefined,
        duration: duration || 60,
        timezone: 'America/Chicago',
        agenda: agenda || '',
        settings: {
          join_before_host: true,
          waiting_room: false,
          auto_recording: 'cloud',
          meeting_authentication: false,
        },
      }),
    });
    if (!zoomRes.ok) {
      const err = await zoomRes.text();
      console.error('Zoom create error:', zoomRes.status, err);
      return res.status(502).json({ error: `Zoom API error: ${zoomRes.status}` });
    }
    const meeting = await zoomRes.json();
    console.log(`  ✓ Zoom meeting created: ${meeting.id}`);
    res.json({
      success: true,
      meetingId: meeting.id,
      joinUrl: meeting.join_url,
      startUrl: meeting.start_url,
      password: meeting.password,
    });
  } catch (e) {
    console.error('Zoom create-meeting error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// List upcoming Zoom meetings
app.get('/zoom/meetings', async (req, res) => {
  try {
    const token = await getZoomToken();
    const zoomRes = await fetch(`https://api.zoom.us/v2/users/${ZOOM_USER_ID}/meetings?type=upcoming&page_size=30`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!zoomRes.ok) {
      const err = await zoomRes.text();
      console.error('Zoom meetings error:', zoomRes.status, err);
      return res.status(502).json({ error: `Zoom API error: ${zoomRes.status}`, detail: err });
    }
    const data = await zoomRes.json();
    res.json({ success: true, meetings: data.meetings || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get past meeting details (for recording links, duration)
app.get('/zoom/meeting/:id', async (req, res) => {
  try {
    const token = await getZoomToken();
    const zoomRes = await fetch(`https://api.zoom.us/v2/past_meetings/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!zoomRes.ok) {
      const err = await zoomRes.text();
      return res.status(502).json({ error: `Zoom API error: ${zoomRes.status}` });
    }
    const data = await zoomRes.json();
    res.json({ success: true, meeting: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
// CALENDLY — Scheduling Integration
// OAuth2 flow + event retrieval for client meeting tracking
// ─────────────────────────────────────────────────────────────────
const CALENDLY_CLIENT_ID     = process.env.CALENDLY_CLIENT_ID || '';
const CALENDLY_CLIENT_SECRET = process.env.CALENDLY_CLIENT_SECRET || '';
const CALENDLY_TOKEN_FILE    = path.join(DATA_DIR, 'calendly-tokens.json');

let calendlyTokens = null;
if (fs.existsSync(CALENDLY_TOKEN_FILE)) {
  try {
    calendlyTokens = JSON.parse(fs.readFileSync(CALENDLY_TOKEN_FILE, 'utf8'));
    console.log('✓ Calendly tokens loaded');
  } catch(e) {
    console.log('Could not load Calendly tokens');
  }
}

function saveCalendlyTokens() {
  fs.writeFileSync(CALENDLY_TOKEN_FILE, JSON.stringify(calendlyTokens, null, 2));
}

function calendlyReady() {
  return !!(calendlyTokens && calendlyTokens.access_token);
}

async function getCalendlyHeaders() {
  if (!calendlyTokens) throw new Error('Calendly not connected — run the auth flow first');

  // Check if token is expired (5 min buffer)
  if (calendlyTokens.expires_at && Date.now() > calendlyTokens.expires_at - 300000) {
    console.log('Calendly token expired, refreshing...');
    try {
      const resp = await fetch('https://auth.calendly.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: calendlyTokens.refresh_token,
          client_id:     CALENDLY_CLIENT_ID,
          client_secret: CALENDLY_CLIENT_SECRET,
        }).toString(),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        calendlyTokens = null;
        saveCalendlyTokens();
        throw new Error('Token refresh failed: ' + errText);
      }
      const data = await resp.json();
      calendlyTokens = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token || calendlyTokens.refresh_token,
        expires_at:    Date.now() + (data.expires_in * 1000),
        owner_uri:     calendlyTokens.owner_uri,
        org_uri:       calendlyTokens.org_uri,
      };
      saveCalendlyTokens();
      console.log('✓ Calendly token refreshed');
    } catch(e) {
      throw new Error('Calendly token refresh failed — please reconnect');
    }
  }

  return {
    'Authorization': `Bearer ${calendlyTokens.access_token}`,
    'Content-Type':  'application/json',
  };
}

// --- Calendly OAuth routes ---

app.get('/calendly/auth', (req, res) => {
  if (!CALENDLY_CLIENT_ID) return res.status(500).send('Calendly not configured — set CALENDLY_CLIENT_ID');
  const redirectUri = process.env.CALENDLY_REDIRECT_URI || 'https://ark-qbo-server.onrender.com/calendly/callback';
  const url = `https://auth.calendly.com/oauth/authorize?` +
    `response_type=code` +
    `&client_id=${CALENDLY_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=ark-cal-${Date.now()}`;
  res.redirect(url);
});

app.get('/calendly/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) throw new Error('No authorization code received');

    const redirectUri = process.env.CALENDLY_REDIRECT_URI || 'https://ark-qbo-server.onrender.com/calendly/callback';
    const resp = await fetch('https://auth.calendly.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     CALENDLY_CLIENT_ID,
        client_secret: CALENDLY_CLIENT_SECRET,
        redirect_uri:  redirectUri,
      }).toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('Token exchange failed: ' + errText);
    }

    const data = await resp.json();

    // Fetch user info to get owner URI and org URI
    const meResp = await fetch('https://api.calendly.com/users/me', {
      headers: { 'Authorization': `Bearer ${data.access_token}` },
    });
    const meData = meResp.ok ? await meResp.json() : {};

    calendlyTokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in * 1000),
      owner_uri:     meData.resource?.uri || '',
      org_uri:       meData.resource?.current_organization || '',
    };
    saveCalendlyTokens();
    console.log('✓ Calendly connected');

    res.send(`<!DOCTYPE html><html><body style="background:#0d1b2a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;">
      <div style="text-align:center;color:#fff;">
        <div style="font-size:48px;margin-bottom:16px;">✅</div>
        <div style="font-size:20px;font-weight:600;">Connected to Calendly!</div>
        <div style="font-size:14px;color:#8899aa;margin-top:8px;">This window will close automatically…</div>
      </div>
      <script>
        if(window.opener){ window.opener.postMessage({type:'calendly-connected'},'*'); }
        setTimeout(()=>window.close(), 2000);
      </script>
    </body></html>`);
  } catch(e) {
    console.error('Calendly callback error:', e.message);
    res.status(500).send(`<h2 style="color:red;font-family:sans-serif;">Calendly Connection Failed</h2><p>${e.message}</p>`);
  }
});

app.get('/calendly/status', (req, res) => {
  res.json({
    connected: calendlyReady(),
    owner: calendlyTokens?.owner_uri || null,
    expiresAt: calendlyTokens?.expires_at ? new Date(calendlyTokens.expires_at).toISOString() : null,
  });
});

app.post('/calendly/disconnect', (req, res) => {
  calendlyTokens = null;
  try { fs.unlinkSync(CALENDLY_TOKEN_FILE); } catch(_) {}
  console.log('Calendly disconnected');
  res.json({ disconnected: true });
});

// Personal access token quick-connect (no OAuth needed)
app.post('/calendly/connect-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const meResp = await fetch('https://api.calendly.com/users/me', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!meResp.ok) return res.status(401).json({ error: 'Invalid token' });

    const meData = await meResp.json();
    calendlyTokens = {
      access_token:  token,
      refresh_token: null,
      expires_at:    null,  // PATs don't expire
      owner_uri:     meData.resource?.uri || '',
      org_uri:       meData.resource?.current_organization || '',
    };
    saveCalendlyTokens();
    console.log('✓ Calendly connected via PAT');
    res.json({ connected: true, name: meData.resource?.name || 'Unknown' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch scheduled events
app.get('/calendly/events', async (req, res) => {
  try {
    const headers = await getCalendlyHeaders();
    const days = parseInt(req.query.days) || 14;
    const status = req.query.status || 'active';
    const now = new Date();
    const future = new Date(now.getTime() + days * 86400000);

    const params = new URLSearchParams({
      user:       calendlyTokens.owner_uri,
      min_start_time: now.toISOString(),
      max_start_time: future.toISOString(),
      status,
      count:      '50',
      sort:       'start_time:asc',
    });

    const resp = await fetch(`https://api.calendly.com/scheduled_events?${params}`, { headers });
    if (!resp.ok) {
      if (resp.status === 401) {
        calendlyTokens = null;
        saveCalendlyTokens();
        return res.status(401).json({ error: 'not_connected' });
      }
      throw new Error(`Calendly API error: ${resp.status}`);
    }

    const data = await resp.json();
    const events = (data.collection || []).map(ev => ({
      uri:        ev.uri,
      name:       ev.name,
      status:     ev.status,
      start:      ev.start_time,
      end:        ev.end_time,
      location:   ev.location?.location || ev.location?.join_url || '',
      locationType: ev.location?.type || '',
      invitees:   ev.event_memberships?.map(m => m.user_name) || [],
      cancelUrl:  ev.cancellation?.canceled_by || null,
      link:       ev.uri ? `https://calendly.com/app/scheduled_events/${ev.uri.split('/').pop()}` : '',
    }));

    res.json({ events, total: data.pagination?.count || events.length });
  } catch(e) {
    if (e.message.includes('not connected') || e.message.includes('reconnect')) {
      return res.status(401).json({ error: 'not_connected' });
    }
    console.error('Calendly fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fetch event types (booking links)
app.get('/calendly/event-types', async (req, res) => {
  try {
    const headers = await getCalendlyHeaders();
    const params = new URLSearchParams({
      user:   calendlyTokens.owner_uri,
      active: 'true',
    });

    const resp = await fetch(`https://api.calendly.com/event_types?${params}`, { headers });
    if (!resp.ok) throw new Error(`Calendly API error: ${resp.status}`);

    const data = await resp.json();
    const types = (data.collection || []).map(t => ({
      uri:        t.uri,
      name:       t.name,
      slug:       t.slug,
      duration:   t.duration,
      active:     t.active,
      color:      t.color,
      bookingUrl: t.scheduling_url,
    }));

    res.json({ types });
  } catch(e) {
    console.error('Calendly event types error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────────────────────────
// ENGAGEMENT LETTERS — PDF generation + public download/upload
// No external e-signature subscription needed. Workflow:
//   1. Dashboard generates PDF (client-side jsPDF)
//   2. Server stores PDF + creates public token link
//   3. Client receives SMS/fax with link → downloads PDF
//   4. Client signs and uploads signed copy via public upload page
//   5. Status tracked: draft → sent → signed
// ─────────────────────────────────────────────────────────────────
const LETTERS_FILE = path.join(DATA_DIR, 'letters.json');
let lettersStore = {};

if (fs.existsSync(LETTERS_FILE)) {
  try {
    lettersStore = JSON.parse(fs.readFileSync(LETTERS_FILE, 'utf8'));
    console.log(`✓ Letters store loaded — ${Object.keys(lettersStore).length} letter(s)`);
  } catch(e) {
    console.log('Could not load letters store');
  }
}

function saveLetters() {
  try { fs.writeFileSync(LETTERS_FILE, JSON.stringify(lettersStore, null, 2)); }
  catch(e) { console.error('Failed to save letters:', e.message); }
}

// Serve the public sign-upload page
app.get('/sign-upload', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sign-upload.html'));
});

// List all letters (authenticated)
app.get('/letters', requireAuth, (req, res) => {
  const letters = Object.values(lettersStore).map(l => ({
    id: l.id, token: l.token, clientId: l.clientId, clientName: l.clientName,
    services: l.services, monthlyFee: l.monthlyFee, status: l.status,
    createdAt: l.createdAt, sentAt: l.sentAt, sentVia: l.sentVia,
    signedAt: l.signedAt, validUntil: l.validUntil,
  }));
  letters.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ success: true, letters });
});

// Create a new letter (authenticated)
app.post('/letters', requireAuth, (req, res) => {
  const { clientId, clientName, services, monthlyFee, terms, validUntil, pdfBase64 } = req.body;
  if (!clientName || !pdfBase64) return res.status(400).json({ error: 'clientName and pdfBase64 required' });

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(16).toString('hex');

  lettersStore[id] = {
    id, token, clientId: clientId || '', clientName, services: services || [],
    monthlyFee: monthlyFee || 0, terms: terms || '', validUntil: validUntil || '',
    status: 'draft', pdfBase64,
    createdAt: new Date().toISOString(), createdBy: req.arkUser?.userName || '',
    sentAt: null, sentVia: null, signedAt: null, signedFileUrl: null,
  };
  saveLetters();
  console.log(`✓ Engagement letter created: ${id} for ${clientName}`);

  const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://ark-qbo-server.onrender.com`;
  res.json({ success: true, id, token, downloadUrl: `${baseUrl}/letters/${token}`, uploadUrl: `${baseUrl}/sign-upload?token=${token}` });
});

// Update letter status (authenticated) — mark as sent, etc.
app.patch('/letters/:id', requireAuth, (req, res) => {
  const letter = lettersStore[req.params.id];
  if (!letter) return res.status(404).json({ error: 'Letter not found' });

  const { status, sentVia } = req.body;
  if (status) letter.status = status;
  if (sentVia) { letter.sentVia = sentVia; letter.sentAt = new Date().toISOString(); }
  saveLetters();
  res.json({ success: true });
});

// Delete letter (authenticated)
app.delete('/letters/:id', requireAuth, (req, res) => {
  if (!lettersStore[req.params.id]) return res.status(404).json({ error: 'Letter not found' });
  delete lettersStore[req.params.id];
  saveLetters();
  res.json({ success: true });
});

// ── Public endpoints (no auth — token-based access) ──

// Download engagement letter PDF
app.get('/letters/:token', (req, res) => {
  const letter = Object.values(lettersStore).find(l => l.token === req.params.token);
  if (!letter) return res.status(404).send('Letter not found or expired');
  if (!letter.pdfBase64) return res.status(404).send('No PDF available');

  // Check expiry (30 days from creation)
  const created = new Date(letter.createdAt);
  if (Date.now() - created.getTime() > 30 * 86400000) {
    letter.status = 'expired';
    saveLetters();
    return res.status(410).send('This letter has expired');
  }

  const pdfBuffer = Buffer.from(letter.pdfBase64, 'base64');
  const safeName = (letter.clientName || 'Engagement-Letter').replace(/[^a-zA-Z0-9 -]/g, '').replace(/\s+/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}-Engagement-Letter.pdf"`);
  res.send(pdfBuffer);
});

// Get letter info for the upload page (public)
app.get('/letters/:token/info', (req, res) => {
  const letter = Object.values(lettersStore).find(l => l.token === req.params.token);
  if (!letter) return res.status(404).json({ error: 'Letter not found' });

  const created = new Date(letter.createdAt);
  const expired = Date.now() - created.getTime() > 30 * 86400000;
  if (expired) { letter.status = 'expired'; saveLetters(); }

  res.json({
    clientName: letter.clientName,
    services:   letter.services,
    status:     letter.status,
    createdAt:  letter.createdAt,
    expired,
    alreadySigned: letter.status === 'signed',
  });
});

// Upload signed copy (public — multer for file upload)
const letterUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/letters/:token/upload', letterUpload.single('file'), async (req, res) => {
  try {
    const letter = Object.values(lettersStore).find(l => l.token === req.params.token);
    if (!letter) return res.status(404).json({ error: 'Letter not found' });
    if (letter.status === 'expired') return res.status(410).json({ error: 'Letter expired' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Validate file type
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) {
      return res.status(400).json({ error: 'Only PDF, JPG, and PNG files accepted' });
    }

    // Try to upload to ShareFile if connected
    let signedFileUrl = null;
    if (sfReady()) {
      try {
        const headers = await sfGetHeaders();
        // Upload to ShareFile root personal folder
        const rootResp = await fetch(`${SF_API_BASE}/Items`, { headers });
        const rootData = rootResp.ok ? await rootResp.json() : null;
        const folderId = rootData?.Id || 'home';

        const safeName = (letter.clientName || 'Client').replace(/[^a-zA-Z0-9 -]/g, '') + '-Signed-Engagement.' + ext;
        // Get upload URL
        const uploadSpec = await fetch(`${SF_API_BASE}/Items(${folderId})/Upload2`, { headers });
        const specData = uploadSpec.ok ? await uploadSpec.json() : null;
        if (specData?.ChunkUri) {
          const formData = new FormData();
          formData.append('File1', new Blob([req.file.buffer]), safeName);
          // Note: ShareFile upload is complex — store locally as fallback
        }
        console.log('ShareFile upload attempted for signed letter');
      } catch(sfErr) {
        console.log('ShareFile upload failed, storing locally:', sfErr.message);
      }
    }

    // Store signed file as base64 in the letter record (always works)
    letter.signedFileBase64 = req.file.buffer.toString('base64');
    letter.signedFileName = req.file.originalname;
    letter.signedAt = new Date().toISOString();
    letter.status = 'signed';
    if (signedFileUrl) letter.signedFileUrl = signedFileUrl;
    saveLetters();

    console.log(`✓ Signed engagement letter received: ${letter.clientName}`);
    res.json({ success: true, status: 'signed' });
  } catch(e) {
    console.error('Letter upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Download the signed copy (authenticated)
app.get('/letters/:id/signed', requireAuth, (req, res) => {
  const letter = lettersStore[req.params.id];
  if (!letter || !letter.signedFileBase64) return res.status(404).json({ error: 'No signed copy available' });

  const ext = (letter.signedFileName || 'signed.pdf').split('.').pop().toLowerCase();
  const mimeMap = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  const safeName = (letter.clientName || 'Client').replace(/[^a-zA-Z0-9 -]/g, '') + '-Signed.' + ext;

  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.send(Buffer.from(letter.signedFileBase64, 'base64'));
});


// ─────────────────────────────────────────────────────────────────
// TIME PUNCHES — Dedicated server-side storage (not in shared ark-db.json)
// Prevents data loss from DB sync conflicts between users
// ─────────────────────────────────────────────────────────────────

const TIME_PUNCHES_FILE = path.join(DATA_DIR, 'time-punches.json');
const TIME_PTO_FILE = path.join(DATA_DIR, 'time-pto.json');

function _loadTimePunches() {
  try { if (fs.existsSync(TIME_PUNCHES_FILE)) return JSON.parse(fs.readFileSync(TIME_PUNCHES_FILE, 'utf8')); } catch (_) {}
  return {};
}
function _saveTimePunches(data) { fs.writeFileSync(TIME_PUNCHES_FILE, JSON.stringify(data)); }

function _loadTimePTO() {
  try { if (fs.existsSync(TIME_PTO_FILE)) return JSON.parse(fs.readFileSync(TIME_PTO_FILE, 'utf8')); } catch (_) {}
  return {};
}
function _saveTimePTO(data) { fs.writeFileSync(TIME_PTO_FILE, JSON.stringify(data)); }

// Migration: move timePunches/timePTO from ark-db.json to dedicated files on first startup
(function _migrateTimePunches() {
  try {
    if (fs.existsSync(TIME_PUNCHES_FILE)) return; // already migrated
    if (!fs.existsSync(ARK_DB_FILE)) return;
    const db = JSON.parse(fs.readFileSync(ARK_DB_FILE, 'utf8'));
    if (db.timePunches && Object.keys(db.timePunches).length > 0) {
      _saveTimePunches(db.timePunches);
      console.log(`Time punches migrated: ${Object.keys(db.timePunches).length} employees`);
    }
    if (db.timePTO && Object.keys(db.timePTO).length > 0) {
      _saveTimePTO(db.timePTO);
      console.log(`Time PTO migrated: ${Object.keys(db.timePTO).length} employees`);
    }
  } catch (e) { console.log('Time punch migration error:', e.message); }
})();

// GET /time/punches — get punches for an employee
app.get('/time/punches', requireAuth, (req, res) => {
  try {
    const { empId, startDate, endDate } = req.query;
    if (!empId) return res.status(400).json({ error: 'empId required' });
    const all = _loadTimePunches();
    let punches = all[empId] || [];
    if (startDate) punches = punches.filter(p => p.date >= startDate);
    if (endDate) punches = punches.filter(p => p.date <= endDate);
    punches.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    res.json(punches);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /time/punches/all — get all punches (for admin/dashboard clocked-in display)
app.get('/time/punches/all', requireAuth, (req, res) => {
  try {
    const all = _loadTimePunches();
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /time/punches — add a punch
app.post('/time/punches', requireAuth, (req, res) => {
  try {
    const { empId, type, date, time, enteredBy, override, afterMeta } = req.body;
    if (!empId || !type || !date || !time) return res.status(400).json({ error: 'empId, type, date, time required' });
    const all = _loadTimePunches();
    if (!all[empId]) all[empId] = [];
    const entry = {
      id: crypto.randomUUID(),
      type, date, time,
      loggedAt: new Date().toISOString(),
      enteredBy: enteredBy || req.arkUser.userName,
      override: override || false,
    };
    if (afterMeta) entry.afterMeta = afterMeta;
    all[empId].push(entry);
    all[empId].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    _saveTimePunches(all);
    res.json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /time/punches/:id — edit a punch
app.put('/time/punches/:id', requireAuth, (req, res) => {
  try {
    const { empId, time, date } = req.body;
    if (!empId) return res.status(400).json({ error: 'empId required' });
    const all = _loadTimePunches();
    const punches = all[empId] || [];
    const punch = punches.find(p => p.id === req.params.id);
    if (!punch) return res.status(404).json({ error: 'Punch not found' });
    if (time) punch.time = time;
    if (date) punch.date = date;
    punch.editedAt = new Date().toISOString();
    punch.editedBy = req.arkUser.userName;
    all[empId].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    _saveTimePunches(all);
    res.json(punch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /time/punches/:id — delete a punch
app.delete('/time/punches/:id', requireAuth, (req, res) => {
  try {
    const { empId } = req.query;
    if (!empId) return res.status(400).json({ error: 'empId required' });
    const all = _loadTimePunches();
    if (!all[empId]) return res.status(404).json({ error: 'No punches for employee' });
    const before = all[empId].length;
    all[empId] = all[empId].filter(p => p.id !== req.params.id);
    if (all[empId].length === before) return res.status(404).json({ error: 'Punch not found' });
    _saveTimePunches(all);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /time/pto — get PTO entries for an employee
app.get('/time/pto', requireAuth, (req, res) => {
  try {
    const { empId } = req.query;
    if (!empId) return res.status(400).json({ error: 'empId required' });
    const all = _loadTimePTO();
    res.json(all[empId] || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /time/pto — add PTO entry
app.post('/time/pto', requireAuth, (req, res) => {
  try {
    const { empId, date, hours, note, enteredBy } = req.body;
    if (!empId || !date || !hours) return res.status(400).json({ error: 'empId, date, hours required' });
    const all = _loadTimePTO();
    if (!all[empId]) all[empId] = [];
    const entry = {
      id: crypto.randomUUID(),
      date, hours: parseFloat(hours),
      note: note || '',
      enteredBy: enteredBy || req.arkUser.userName,
      loggedAt: new Date().toISOString(),
    };
    all[empId].push(entry);
    _saveTimePTO(all);
    res.json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /time/pto/:id — delete PTO entry
app.delete('/time/pto/:id', requireAuth, (req, res) => {
  try {
    const { empId } = req.query;
    if (!empId) return res.status(400).json({ error: 'empId required' });
    const all = _loadTimePTO();
    if (!all[empId]) return res.status(404).json({ error: 'No PTO for employee' });
    all[empId] = all[empId].filter(p => p.id !== req.params.id);
    _saveTimePTO(all);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// SCOOTER'S COGS — Harvest Invoice CSV Parser
// Parses HarvestInvoiceBreakdown CSVs into COGS journal entries
// ─────────────────────────────────────────────────────────────────
const COGS_PRESETS = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'cogs_account_presets.json'), 'utf8'));

function cogsGetAccount(key) {
  return COGS_PRESETS.default?.[key] || key;
}

app.post('/scooters/parse-harvest', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    console.log(`Harvest COGS: received file "${req.file.originalname}" (${req.file.size} bytes, type: ${req.file.mimetype})`);
    const wb = require('xlsx').read(req.file.buffer, { cellDates: true, type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawData = require('xlsx').utils.sheet_to_json(ws);

    if (!rawData.length) return res.status(400).json({ error: `File "${req.file.originalname}" is empty (0 data rows)` });
    console.log(`  Columns: ${Object.keys(rawData[0]).join(', ')}`);

    console.log(`Harvest COGS parse: ${rawData.length} rows`);

    // COA columns to extract
    const coaCols = [
      { key: 'advertising',     csv: 'COA_Advertising___Marketing' },
      { key: 'consumable_cogs', csv: 'COA_Cost_of_Goods_Sold_Consumable_COGS' },
      { key: 'dairy_cogs',      csv: 'COA_Cost_of_Goods_Sold_Dairy_COGS' },
      { key: 'supplies_cogs',   csv: 'COA_Cost_of_Goods_Sold_Supplies_COGS' },
      { key: 'repairs',         csv: 'COA_Repairs___Maintenance' },
      { key: 'shipping',        csv: 'COA_Shipping_Expense' },
      { key: 'store_supplies',  csv: 'COA_Store_Supplies' },
      { key: 'uniforms',        csv: 'COA_Uniforms' },
      { key: 'tax',             csv: 'Sales_Tax' },
    ];

    // Load CRM clients for realm lookup
    let crmClients = [];
    try {
      if (fs.existsSync(ARK_DB_FILE)) {
        const db = JSON.parse(fs.readFileSync(ARK_DB_FILE, 'utf8'));
        crmClients = db.clients || [];
      }
    } catch(e) { console.log('Could not load CRM clients for Harvest parse'); }

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

    // Extract store number from Store_Name
    // Prefers "Store XXXX" pattern, falls back to last 3-4 digit number
    function extractStoreNum(storeName) {
      const s = String(storeName || '');
      // First: look for "Store 1103" or "Store 660" pattern
      const storeMatch = s.match(/Store\s+(\d{3,4})/i);
      if (storeMatch) return storeMatch[1];
      // Second: look for standalone 3-4 digit number at end of string
      const endMatch = s.match(/(\d{3,4})\s*$/);
      if (endMatch) return endMatch[1];
      // Third: look for any 3-4 digit number (last one to avoid matching company names like "555")
      const allNums = s.match(/\d{3,4}/g);
      if (allNums && allNums.length) return allNums[allNums.length - 1];
      return null;
    }

    // Normalize strings for matching (strip apostrophes, extra spaces)
    const normalize = (s) => String(s || '').toLowerCase().replace(/[''`]/g, '').replace(/\s+/g, ' ').trim();

    // Group rows by resolved store number (not raw Store_Name)
    // This merges rows with different names but same store (e.g., "Jessica and Ty O'Toole Store 660" + "Waterman")
    const storeGroups = {};
    const storeNameMap = {}; // storeNum → first Store_Name seen
    for (const row of rawData) {
      const storeName = String(row['Store_Name'] || row['store_name'] || '').trim();
      if (!storeName) continue;
      // Resolve store number for grouping
      let sNum = extractStoreNum(storeName);
      if (!sNum) sNum = findStoreNumFromCRM(storeName);
      if (!sNum) sNum = findStoreNumFromConfig(storeName);
      const groupKey = sNum || storeName; // fall back to name if no number found
      if (!storeGroups[groupKey]) {
        storeGroups[groupKey] = [];
        storeNameMap[groupKey] = storeName;
      }
      storeGroups[groupKey].push(row);
    }
    function findStoreNumFromCRM(storeName) {
      const csvNorm = normalize(storeName);
      for (const client of crmClients) {
        if (!client.franchises?.length) continue;
        const bizNorm = normalize(client.biz);
        const legalNorm = normalize(client.legalName);
        for (const f of client.franchises) {
          const fNameNorm = normalize(f.legalName || f.name);
          if (f.storeNumber && (
            (fNameNorm && csvNorm.includes(fNameNorm)) ||
            (fNameNorm && fNameNorm.includes(csvNorm.replace(/\s*(llc|inc|corp|store\s*\d+)\s*/gi, '').trim())) ||
            (bizNorm && csvNorm.includes(bizNorm)) ||
            (legalNorm && csvNorm.includes(legalNorm)) ||
            csvNorm.includes('store ' + f.storeNumber)
          )) {
            return f.storeNumber;
          }
        }
      }
      return null;
    }

    // Fallback: match against franchise config
    function findStoreNumFromConfig(storeName) {
      const csvNorm = normalize(storeName);
      for (const [key, info] of Object.entries(FRANCHISE_MAP)) {
        for (const fname of (info.franchise_names || [])) {
          const fnameNorm = normalize(fname);
          if (csvNorm.includes(fnameNorm) || fnameNorm.includes(csvNorm.replace(/\s*(llc|inc|corp|store\s*\d+)\s*/gi, '').trim())) {
            const storeIds = Object.keys(info.stores || {});
            if (storeIds.length === 1) return storeIds[0];
          }
        }
      }
      return null;
    }

    const franchises = [];
    const warnings = [];
    let totalDebits = 0, totalCredits = 0, totalEntries = 0;

    for (const [groupKey, rows] of Object.entries(storeGroups)) {
      const storeName = storeNameMap[groupKey] || groupKey;
      // groupKey is already the resolved store number (or raw name if none found)
      const storeNum = /^\d+$/.test(groupKey) ? groupKey : null;
      console.log(`  Store "${storeName}" → #${storeNum || 'NONE'} (${rows.length} rows)`);
      const realm = storeNum ? findRealmForStore(storeNum) : null;
      const entries = [];
      let fDebits = 0, fCredits = 0;

      for (const row of rows) {
        const invoiceNum = String(row['Invoice_Number'] || row['invoice_number'] || '').trim();
        const orderNum = String(row['Order_Number'] || row['order_number'] || '').trim();
        let invoiceDate = row['Invoice_Date'] || row['invoice_date'] || '';
        if (invoiceDate instanceof Date) invoiceDate = invoiceDate.toISOString().slice(0, 10);
        else invoiceDate = String(invoiceDate).trim();

        if (!invoiceNum) continue;

        const r = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;
        const lines = [];

        // Build debit lines from COA columns
        let debitTotal = 0;
        for (const col of coaCols) {
          const amount = r(row[col.csv]);
          if (amount !== 0) {
            lines.push({
              account: cogsGetAccount(col.key),
              debit: amount > 0 ? amount : null,
              credit: amount < 0 ? Math.abs(amount) : null,
              description: '',
              class: '',
            });
            debitTotal += amount;
          }
        }

        if (lines.length === 0) continue;

        // Check if shipping-only
        const isShippingOnly = r(row['COA_Shipping_Expense']) !== 0 &&
          coaCols.filter(c => c.key !== 'shipping').every(c => r(row[c.csv]) === 0);
        const description = isShippingOnly ? 'Monthly Delivery Fee' : orderNum;

        // Set description on first line only
        if (lines.length > 0) lines[0].description = description;

        // Balancing line: Harvest Payable
        // Normal invoice: credit. Credit memo (negative total): debit.
        if (debitTotal >= 0) {
          lines.push({
            account: cogsGetAccount('harvest_payable'),
            debit: null,
            credit: r(debitTotal),
            description: '',
            class: '',
          });
        } else {
          lines.push({
            account: cogsGetAccount('harvest_payable'),
            debit: r(Math.abs(debitTotal)),
            credit: null,
            description: '',
            class: '',
          });
        }

        const entryDebits = lines.reduce((s, l) => s + (l.debit || 0), 0);
        const entryCredits = lines.reduce((s, l) => s + (l.credit || 0), 0);
        fDebits += entryDebits;
        fCredits += entryCredits;

        entries.push({
          date: invoiceDate,
          journalNo: invoiceNum,
          memo: `${storeName} - Powered By EchoSync`,
          lines,
        });
      }

      if (!entries.length) continue;

      totalDebits += fDebits;
      totalCredits += fCredits;
      totalEntries += entries.length;

      // Look up class from franchise config
      let className = '';
      if (storeNum) {
        for (const [key, info] of Object.entries(FRANCHISE_MAP)) {
          if (info.stores?.[storeNum] !== undefined) {
            className = info.stores[storeNum] || '';
            break;
          }
        }
      }
      // Apply class to all lines if present
      if (className) {
        for (const entry of entries) {
          for (const line of entry.lines) {
            line.class = className;
          }
        }
      }

      // Look up the franchise config label (same as sales JE uses)
      let franchiseLabel = storeName;
      if (storeNum) {
        for (const [key, info] of Object.entries(FRANCHISE_MAP)) {
          if (info.stores?.[storeNum] !== undefined) {
            franchiseLabel = info.label || key;
            break;
          }
        }
      }

      franchises.push({
        key: storeName,
        label: franchiseLabel,
        storeId: storeNum || '',
        realmId: realm?.realmId || null,
        qboCompanyName: realm?.qboName || realm?.clientName || '',
        linked: !!realm?.realmId,
        className: className || '',
        dateRange: entries.length ? `${entries[0].date} - ${entries[entries.length - 1].date}` : '',
        entryCount: entries.length,
        entries,
        totalDebits: Math.round(fDebits * 100) / 100,
        totalCredits: Math.round(fCredits * 100) / 100,
        balanced: Math.abs(fDebits - fCredits) < 0.02,
      });
    }

    // Sort by label
    franchises.sort((a, b) => a.label.localeCompare(b.label));

    console.log(`  Generated ${franchises.length} store groups, ${totalEntries} entries`);
    res.json({
      success: true,
      franchises,
      warnings,
      totalDebits: Math.round(totalDebits * 100) / 100,
      totalCredits: Math.round(totalCredits * 100) / 100,
      totalEntries,
    });
  } catch(e) {
    console.error('Harvest parse error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────────────────────────
// STAGING: Proxy Render API to report staging service deploy status
// back to the production CRM's Team Hub → Staging tab.
// ─────────────────────────────────────────────────────────────────
const STAGING_SERVICE_ID = process.env.RENDER_STAGING_SERVICE_ID || '';
app.get('/staging/deploy-status', requireAuth, async (req, res) => {
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RENDER_API_KEY not set' });
  try {
    let serviceId = STAGING_SERVICE_ID;
    // Auto-discover the staging service if the env var isn't set yet.
    if (!serviceId) {
      const svcResp = await fetch('https://api.render.com/v1/services?limit=50', {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      if (!svcResp.ok) return res.status(502).json({ error: 'Render service list failed' });
      const svcs = await svcResp.json();
      const match = (svcs || []).map(x => x.service || x).find(s => /staging/i.test(s.name || ''));
      if (!match) return res.json({ status: 'unknown', note: 'No staging service found' });
      serviceId = match.id;
    }
    const depResp = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=1`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!depResp.ok) return res.status(502).json({ error: 'Render deploy fetch failed' });
    const list = await depResp.json();
    const latest = (list[0] && (list[0].deploy || list[0])) || null;
    if (!latest) return res.json({ status: 'unknown' });
    res.json({
      status: latest.status || 'unknown',
      finishedAt: latest.finishedAt || latest.updatedAt || null,
      commitId: latest.commit?.id || null,
      commitMessage: latest.commit?.message || null,
    });
  } catch (e) {
    console.error('staging/deploy-status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// STAGING FILE PUSH — lets non-developer team members edit the CRM
// on staging without needing GitHub access. All three endpoints are
// gated to the staging hostname, and the branch is hardcoded to
// 'staging' so production is physically unreachable from here.
// ─────────────────────────────────────────────────────────────────
function _isStagingHost(req){
  const host = (req.headers.host || '').toLowerCase();
  const hostname = (req.hostname || '').toLowerCase();
  return host.includes('staging') || hostname.includes('staging');
}

const GITHUB_OWNER = 'ArkDevGen';
const GITHUB_REPO  = 'ark-qbo-server';
const STAGING_BRANCH = 'staging';

// Fetch a file's current content from the staging branch (so the editor
// can pre-fill with the real file before the user modifies it).
// NOTE: GitHub's Contents API omits inline content for files > 1 MB, so
// for big files (ark-dashboard.html is ~2.8 MB) we fall back to the
// Blobs API which has a ~100 MB limit.
app.get('/staging/file', requireAuth, async (req, res) => {
  if (!_isStagingHost(req)) return res.status(403).json({ error: 'Staging-only endpoint' });
  const filePath = (req.query.path || '').toString();
  if (!filePath || filePath.includes('..')) return res.status(400).json({ error: 'Bad path' });
  const pat = process.env.GITHUB_PAT;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ark-crm-staging' };
  if (pat) headers.Authorization = `Bearer ${pat}`;
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${STAGING_BRANCH}`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: `GitHub: ${r.status} ${txt.slice(0, 200)}` });
    }
    const data = await r.json();
    if (data.type !== 'file') return res.status(400).json({ error: 'Path is not a file' });

    let content;
    if (data.content) {
      // Small file — content is inline, base64-encoded
      content = Buffer.from(data.content, 'base64').toString('utf8');
    } else if (data.sha) {
      // Big file (> 1 MB) — fetch via the Blobs API using the SHA
      const blobUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${data.sha}`;
      const blobResp = await fetch(blobUrl, { headers });
      if (!blobResp.ok) {
        const txt = await blobResp.text();
        return res.status(blobResp.status).json({ error: `GitHub blob fetch: ${blobResp.status} ${txt.slice(0, 200)}` });
      }
      const blob = await blobResp.json();
      content = Buffer.from(blob.content || '', 'base64').toString('utf8');
    } else {
      return res.status(502).json({ error: 'GitHub response missing both content and sha' });
    }

    res.json({ path: filePath, content, sha: data.sha, size: data.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Push multiple files to the staging branch as a SINGLE atomic commit.
// This is the right endpoint for features that touch both server.js and
// ark-dashboard.html — one commit, one Render deploy, no half-broken state.
// Uses the Git Data API (blobs → tree → commit → ref) since the Contents
// API only supports one file per call.
app.post('/staging/push-files', requireAuth, async (req, res) => {
  if (!_isStagingHost(req)) return res.status(403).json({ error: 'Staging-only endpoint' });
  const pat = process.env.GITHUB_PAT;
  if (!pat) return res.status(500).json({ error: 'GITHUB_PAT not set on staging server — ask an admin to add it in Render.' });

  const { files, message } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files[] required' });
  for (const f of files) {
    if (!f || !f.path || typeof f.content !== 'string') return res.status(400).json({ error: 'Each file needs { path, content }' });
    if (f.path.includes('..') || f.path.startsWith('/')) return res.status(400).json({ error: 'Bad path: ' + f.path });
  }

  const who = req.arkUser?.userName || 'staging user';
  const trimmedMsg = (message || `update ${files.length} file(s)`).slice(0, 120);
  const commitMsg = `[staging] ${trimmedMsg}\n\nPushed via staging CRM by ${who}\n\nFiles:\n` + files.map(f => '- ' + f.path).join('\n');

  const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ark-crm-staging' };
  const owner = GITHUB_OWNER, repo = GITHUB_REPO, branch = STAGING_BRANCH;

  try {
    // 1. Latest commit SHA on staging
    const refResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, { headers });
    if (!refResp.ok) { const t = await refResp.text(); return res.status(502).json({ error: `Ref fetch (${refResp.status}): ${t.slice(0,200)}` }); }
    const latestCommitSha = (await refResp.json()).object.sha;

    // 2. Base tree SHA
    const commitResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${latestCommitSha}`, { headers });
    if (!commitResp.ok) { const t = await commitResp.text(); return res.status(502).json({ error: `Commit fetch (${commitResp.status}): ${t.slice(0,200)}` }); }
    const baseTreeSha = (await commitResp.json()).tree.sha;

    // 3. Create a blob per file
    const blobs = [];
    for (const f of files) {
      const blobResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64' }),
      });
      if (!blobResp.ok) { const t = await blobResp.text(); return res.status(502).json({ error: `Blob create for ${f.path} (${blobResp.status}): ${t.slice(0,200)}` }); }
      blobs.push({ path: f.path, sha: (await blobResp.json()).sha });
    }

    // 4. Create a tree on top of the base tree with all new blobs
    const treeResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: blobs.map(b => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
      }),
    });
    if (!treeResp.ok) { const t = await treeResp.text(); return res.status(502).json({ error: `Tree create (${treeResp.status}): ${t.slice(0,200)}` }); }
    const newTreeSha = (await treeResp.json()).sha;

    // 5. Create the commit
    const newCommitResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMsg, tree: newTreeSha, parents: [latestCommitSha] }),
    });
    if (!newCommitResp.ok) { const t = await newCommitResp.text(); return res.status(502).json({ error: `Commit create (${newCommitResp.status}): ${t.slice(0,200)}` }); }
    const newCommit = await newCommitResp.json();

    // 6. Fast-forward the staging ref to the new commit
    const updateRefResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    });
    if (!updateRefResp.ok) { const t = await updateRefResp.text(); return res.status(502).json({ error: `Ref update (${updateRefResp.status}): ${t.slice(0,200)}` }); }

    console.log(`Staging batch push by ${who}: ${files.length} file(s) → ${newCommit.sha.slice(0, 7)}`);
    res.json({
      ok: true,
      commitSha: newCommit.sha,
      commitUrl: newCommit.html_url || `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
      fileCount: files.length,
      paths: files.map(f => f.path),
    });
  } catch (e) {
    console.error('Staging batch push error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Push an updated file to the staging branch on GitHub. Requires GITHUB_PAT
// (fine-grained, Contents: write). Render auto-redeploys staging on push.
app.post('/staging/push-file', requireAuth, async (req, res) => {
  if (!_isStagingHost(req)) return res.status(403).json({ error: 'Staging-only endpoint' });
  const pat = process.env.GITHUB_PAT;
  if (!pat) return res.status(500).json({ error: 'GITHUB_PAT not set on staging server — ask an admin to add it in Render.' });

  const { path: filePath, content, message } = req.body || {};
  if (!filePath || typeof content !== 'string') return res.status(400).json({ error: 'path and content required' });
  if (filePath.includes('..') || filePath.startsWith('/')) return res.status(400).json({ error: 'Bad path' });

  const who = req.arkUser?.userName || 'staging user';
  const trimmedMsg = (message || `update ${filePath}`).slice(0, 120);
  const commitMsg = `[staging] ${trimmedMsg}\n\nPushed via staging CRM by ${who}`;

  try {
    // Look up the current file SHA (required for updates; absent means "new file")
    let currentSha = null;
    const getUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${STAGING_BRANCH}`;
    const getResp = await fetch(getUrl, {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ark-crm-staging' },
    });
    if (getResp.ok) {
      const data = await getResp.json();
      currentSha = data.sha;
    } else if (getResp.status !== 404) {
      const txt = await getResp.text();
      return res.status(502).json({ error: `GitHub read failed (${getResp.status}): ${txt.slice(0, 300)}` });
    }

    const putUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
    const body = {
      message: commitMsg,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: STAGING_BRANCH,
    };
    if (currentSha) body.sha = currentSha;

    const putResp = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ark-crm-staging',
      },
      body: JSON.stringify(body),
    });

    if (!putResp.ok) {
      const txt = await putResp.text();
      return res.status(502).json({ error: `GitHub push failed (${putResp.status}): ${txt.slice(0, 500)}` });
    }

    const data = await putResp.json();
    console.log(`Staging push by ${who}: ${filePath} → ${data.commit?.sha?.slice(0, 7)}`);
    res.json({
      ok: true,
      commitSha: data.commit?.sha || '',
      commitUrl: data.commit?.html_url || '',
      path: filePath,
    });
  } catch (e) {
    console.error('Staging push error:', e.message);
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

// Arrays that should be merged by record ID with per-record conflict resolution
// (newer _updatedAt wins). Records only present on one side are preserved.
// This prevents data loss when two users save concurrently with partially
// overlapping edits.
const _MERGE_ARRAYS_BY_ID = [
  // Core records
  'clients', 'employees', 'vendors', 'form1099s', 'w2s', 'w2cs',
  'tasks', 'meetings', 'proposals', 'leads', 'notebooks', 'notebookEntries',
  'projectGroups', 'postage', 'ideas', 'accountManagers', 'users',
  // Logs & messages (also need per-record merge to prevent overwrites)
  'activity', 'notifications', 'efw2Log', 'nachaLog',
  'faxOutbox', 'faxInbox', 'smsLog', 'smsMessages',
  // Dev Hub
  'devProjects', 'devTemplates',
  // Scooters JE push history
  'sjePushLog',
  // HTeaO Revel integration
  'hteaoStores',    // per-store config: Revel code -> realmId + account IDs
  'hteaoPushLog',   // history of HTeaO JE pushes to QBO
  // Sales Tax Filing Center
  'salesTaxRates',       // jurisdiction rate database (state/city/county)
  'salesTaxFilings',     // filing history per client per period
  'salesTaxClientSetup', // per-client sales tax config (jurisdictions, import profile, portal URL)
  'salesTaxDrafts',      // in-progress filings saved for later resume
];

function _mergeArrayById(existing, incoming) {
  if (!Array.isArray(existing)) return Array.isArray(incoming) ? incoming : [];
  if (!Array.isArray(incoming)) return existing;
  const byId = new Map();
  // Seed with existing records
  for (const rec of existing) {
    if (!rec || !rec.id) continue;
    byId.set(rec.id, rec);
  }
  // Merge in incoming — if same id, take the one with the newer _updatedAt
  for (const rec of incoming) {
    if (!rec || !rec.id) continue;
    const current = byId.get(rec.id);
    if (!current) {
      byId.set(rec.id, rec);
      continue;
    }
    const curTime = current._updatedAt ? new Date(current._updatedAt).getTime() : 0;
    const incTime = rec._updatedAt ? new Date(rec._updatedAt).getTime() : 0;
    // If incoming has a newer (or equal with tiebreak to incoming) timestamp, use it.
    // If existing has a newer timestamp (meaning another user saved more recently),
    // keep existing — prevents stale client from overwriting fresh edits.
    if (incTime >= curTime) byId.set(rec.id, rec);
  }
  // Preserve order: incoming order first, then any existing-only records appended
  const seen = new Set();
  const result = [];
  for (const rec of incoming) {
    if (rec && rec.id && byId.has(rec.id) && !seen.has(rec.id)) {
      result.push(byId.get(rec.id));
      seen.add(rec.id);
    }
  }
  for (const rec of existing) {
    if (rec && rec.id && byId.has(rec.id) && !seen.has(rec.id)) {
      result.push(byId.get(rec.id));
      seen.add(rec.id);
    }
  }
  return result;
}

app.post('/db/save', requireAuth, (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid DB payload' });
    }

    // Load existing server state so we can merge (not wholesale overwrite)
    let existing = null;
    if (fs.existsSync(ARK_DB_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(ARK_DB_FILE, 'utf8'));
      } catch (_) { /* corrupt — fall through to fresh write */ }
    }

    let merged = payload;
    if (existing) {
      merged = { ...existing, ...payload };
      // Merge id-keyed arrays per-record instead of wholesale replacement so
      // concurrent editors don't clobber each other's changes.
      for (const key of _MERGE_ARRAYS_BY_ID) {
        if (Array.isArray(existing[key]) || Array.isArray(payload[key])) {
          merged[key] = _mergeArrayById(existing[key], payload[key]);
        }
      }
      // Merge object-keyed data (notes, calls, commConfig, nachaCfg) by
      // combining keys from both sides — incoming overwrites per-key but
      // keys only in existing are preserved (not lost by stale client)
      const _MERGE_OBJECTS = ['notes', 'calls', 'commConfig', 'nachaCfg'];
      for (const key of _MERGE_OBJECTS) {
        if (existing[key] && typeof existing[key] === 'object' && !Array.isArray(existing[key])) {
          merged[key] = { ...existing[key], ...(payload[key] || {}) };
        }
      }
      // Log merge activity so we can spot concurrent edits in the console
      if (existing._savedAt && payload._savedAt &&
          new Date(existing._savedAt) > new Date(payload._savedAt)) {
        console.log(`DB merge: ${req.arkUser.userName} saved over a newer server state ` +
          `(server: ${existing._savedAt}, client: ${payload._savedAt}) — records preserved via per-record merge`);
      }
    }

    merged._savedAt = new Date().toISOString();
    merged._savedBy = req.arkUser.userName;
    fs.writeFileSync(ARK_DB_FILE, JSON.stringify(merged));
    console.log(`DB saved by ${req.arkUser.userName} at ${merged._savedAt} (${(JSON.stringify(merged).length / 1024).toFixed(1)} KB)`);
    res.json({ success: true, savedAt: merged._savedAt });
  } catch (e) {
    console.error('DB save error:', e.message);
    res.status(500).json({ error: 'Failed to save database' });
  }
});

// ─────────────────────────────────────────────────────────────────
// SALES TAX: Seed data + legacy rate migration
// Serves static seed files that the dashboard imports on first use
// ─────────────────────────────────────────────────────────────────
const SALES_TAX_CONFIG_DIR = path.join(__dirname, 'config');

app.get('/sales-tax/seed/ne-jurisdictions', requireAuth, (req, res) => {
  try {
    const p = path.join(SALES_TAX_CONFIG_DIR, 'ne-jurisdictions.json');
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Seed file not found' });
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.json({ jurisdictions: data, count: data.length });
  } catch (e) {
    console.error('NE jurisdictions seed error:', e.message);
    res.status(500).json({ error: 'Failed to load NE jurisdictions' });
  }
});

app.get('/sales-tax/legacy-rates', requireAuth, (req, res) => {
  try {
    const p = path.join(SALES_TAX_CONFIG_DIR, 'legacy-store-rates.json');
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Legacy rates file not found' });
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.json({ rates: data, count: data.length });
  } catch (e) {
    console.error('Legacy rates error:', e.message);
    res.status(500).json({ error: 'Failed to load legacy rates' });
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
  // Check royalty_overrides.json first
  const override = ROYALTY_OVERRIDES[franchiseKey];
  if (typeof override === 'object' && override !== null && !Array.isArray(override)) {
    if (storeId && override[storeId] !== undefined) return override[storeId];
    return ROYALTY_OVERRIDES.default_rate || 0.06;
  }
  if (override !== undefined && override !== null) return override;

  // Fallback: check franchise config's royalty_overrides field
  const franchiseInfo = FRANCHISE_MAP[franchiseKey];
  if (franchiseInfo?.royalty_overrides) {
    if (storeId && franchiseInfo.royalty_overrides[storeId] !== undefined) return franchiseInfo.royalty_overrides[storeId];
    // Check if there's a blanket override (empty key)
    if (franchiseInfo.royalty_overrides[''] !== undefined) return franchiseInfo.royalty_overrides[''];
  }

  return ROYALTY_OVERRIDES.default_rate || 0.06;
}

function sjeGetAdFundRate() { return ROYALTY_OVERRIDES.ad_fund_rate || 0.02; }

function sjeFindColumn(headers, possibleNames, exclude = []) {
  const excludeSet = new Set(exclude.map(e => String(e).toLowerCase().trim()));
  // First pass: exact match (case-insensitive)
  for (const col of headers) {
    const lower = String(col).toLowerCase().trim();
    if (excludeSet.has(lower)) continue;
    for (const p of possibleNames) {
      if (lower === p.toLowerCase()) return col;
    }
  }
  // Second pass: includes match (for partial/fuzzy matching)
  for (const col of headers) {
    const lower = String(col).toLowerCase().trim();
    if (excludeSet.has(lower)) continue;
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

  // Use class from data file if present, otherwise fall back to config
  const rowClass = row['Class'] ? String(row['Class']).trim() : '';
  if (rowClass) className = rowClass;
  const avgCheck = num(row['Avg Check']);
  const grossFood = num(row['Gross Food %']);
  const trafficCount = num(row['Traffic Count']);

  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  // Append letter suffix for classed stores (so classed stores in same QBO company have unique DocNumbers)
  // Uses alphabetical letter based on store position in franchise config: A, B, C...
  let classSuffix = '';
  if (className && storeId) {
    const franchiseInfo = FRANCHISE_MAP[franchiseKey];
    if (franchiseInfo) {
      const storeIds = Object.keys(franchiseInfo.stores || {});
      const idx = storeIds.indexOf(storeId);
      const offset = franchiseInfo.letterOffset || 0; // e.g., 2 for C (skips A,B used by another config)
      classSuffix = '-' + String.fromCharCode(65 + offset + (idx >= 0 ? idx : 0)); // A, B, C...
    }
  }
  const journalNo = grossSales === 0 ? `${mm}.${dd}.${yyyy}-ND${classSuffix}` : `${mm}.${dd}.${yyyy}${classSuffix}`;
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
  if (grossFood > 0) descParts.push(`Food: ${(grossFood < 1 ? (grossFood * 100) : grossFood).toFixed(1)}%`);
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

    // Map columns — build sequentially so claimed columns are excluded from later mappings
    // This prevents "Gift Card Load" from stealing the "Gift Card" (redeemed) column via includes matching
    const headers = Object.keys(rawData[0]);
    const claimed = []; // already-claimed column names
    function mapCol(possibleNames) {
      const result = sjeFindColumn(headers, possibleNames, claimed);
      if (result) claimed.push(result);
      return result;
    }
    const colMap = {
      'Store': mapCol(['store']),
      'Day': mapCol(['day', 'date']),
      'Franchise': mapCol(['franchise']),
      'Gross Sales': mapCol(['gross sales']),
      'Discount': mapCol(['discount']),
      'Employee Discount': mapCol(['employee discount', 'emp discount']),
      'Net Sales': mapCol(['net sales']),
      'Gift Card Load': mapCol(['gift card load', 'gift cards sold', 'gc load', 'gift card sold', 'loaded gift card', 'sold gc', 'gift load']),
      'Tax': mapCol(['tax']),
      'Donation': mapCol(['donation', 'donations']),
      'Tip': mapCol(['tip']),
      'Cash': mapCol(['cash']),
      'Credit Card': mapCol(['credit card']),
      'Gift Card': mapCol(['gift card', 'gift card redeemed', 'gift cards redeemed', 'gc redeemed', 'gift card used', 'redeemed gift card', 'gift redemption', 'gc redemption', 'gift redeemed', 'redeem gc']),
      'Mobile App': mapCol(['mobile app']),
      'Promotion': mapCol(['promotion']),
      'Other': mapCol(['other']),
      'Reconciliation': mapCol(['reconciliation']),
      'Rounding': mapCol(['rounding']),
      'Avg Check': mapCol(['avg check', 'average check', 'avg ticket']),
      'Discount %': mapCol(['discount %']),
      'Traffic Count': mapCol(['traffic count']),
      'Gross Food %': mapCol(['gross food %']),
      'Class': mapCol(['class']),
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
    });

    const totalRawRows = rows.length;
    const rowsBeforeFilter = rows.slice();
    const filteredRows = rows.filter(r => r['_date'] && !isNaN(r['_date'].getTime()));
    rows.length = 0;
    rows.push(...filteredRows);

    // If every row got dropped for missing date, return a specific error
    // so the user knows *why* the upload silently produced nothing.
    if (totalRawRows > 0 && rows.length === 0) {
      const hasAnyDay = rowsBeforeFilter.some(r => r['Day']);
      const mapped = Object.entries(colMap).filter(([k,v]) => v).map(([k]) => k);
      const missing = !colMap['Day']
        ? `No "Day"/"Date" column found in this file — the parser needs a date per row to build daily journal entries.`
        : (hasAnyDay
            ? `"Day" column exists but no rows had a parseable date value. Check the Day column's format.`
            : `"Day" column exists but every row is blank there.`);
      return res.status(400).json({
        error: missing,
        detail: {
          rowsInFile: totalRawRows,
          mappedColumns: mapped,
          hint: 'Re-export the report from Power BI with a "Day" column (one row per store per day).',
        },
      });
    }

    console.log(`  Parsed ${rows.length} valid rows, columns: ${Object.entries(colMap).filter(([k,v])=>v).map(([k])=>k).join(', ')}`);
    // Log unique franchise names and stores in the data for debugging
    const dataFranchises = [...new Set(rows.map(r => String(r['Franchise'] || '').trim()))];
    const dataStores = [...new Set(rows.map(r => String(r['Store'] || '').trim()))];
    console.log(`  Data franchise names: [${dataFranchises.join(', ')}]`);
    console.log(`  Data store numbers: [${dataStores.join(', ')}]`);

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

      // Log franchise matching for debugging
      const uniqueStores = [...new Set(franchiseRows.map(r => String(r['Store'] || '').trim()))];
      console.log(`  Franchise "${franchiseKey}": matched ${franchiseRows.length} rows, stores: [${uniqueStores.join(', ')}]`);

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
            const entry = sjeBuildEntry(dayRows[0], franchiseKey, className || '', dayRows[0]._date.toISOString(), storeId);
            const d = Math.round(entry.lines.reduce((s, l) => s + (l.debit || 0), 0) * 100) / 100;
            const c = Math.round(entry.lines.reduce((s, l) => s + (l.credit || 0), 0) * 100) / 100;
            entry.entryDebits = d;
            entry.entryCredits = c;
            entry.entryBalanced = Math.abs(d - c) < 0.01;
            entries.push(entry);
            fDebits += d;
            fCredits += c;
          }

          // Log imbalanced entries for debugging
          const imbalancedEntries = entries.filter(e => !e.entryBalanced);
          if (imbalancedEntries.length) {
            console.log(`  ⚠ ${franchiseKey} (${storeId}): ${imbalancedEntries.length} imbalanced entries:`);
            for (const e of imbalancedEntries) {
              console.log(`    ${e.journalNo}: D=${e.entryDebits} C=${e.entryCredits} diff=${Math.round((e.entryDebits - e.entryCredits) * 100) / 100}`);
              if (e === imbalancedEntries[0]) {
                for (const l of e.lines) {
                  if (l.debit || l.credit) console.log(`      ${l.account}: D=${l.debit || 0} C=${l.credit || 0} ${l.description || ''}`);
                }
              }
            }
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
            imbalancedCount: imbalancedEntries.length,
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
              const d = Math.round(entry.lines.reduce((s, l) => s + (l.debit || 0), 0) * 100) / 100;
              const c = Math.round(entry.lines.reduce((s, l) => s + (l.credit || 0), 0) * 100) / 100;
              entry.entryDebits = d;
              entry.entryCredits = c;
              entry.entryBalanced = Math.abs(d - c) < 0.01;
              entries.push(entry);
              fDebits += d;
              fCredits += c;
            }
          }

          if (!entries.length) continue;

          // Log imbalanced entries for debugging
          const imbalancedEntries = entries.filter(e => !e.entryBalanced);
          if (imbalancedEntries.length) {
            console.log(`  ⚠ ${franchiseKey}: ${imbalancedEntries.length} imbalanced entries:`);
            for (const e of imbalancedEntries) {
              console.log(`    ${e.journalNo}: D=${e.entryDebits} C=${e.entryCredits} diff=${Math.round((e.entryDebits - e.entryCredits) * 100) / 100}`);
              // Log each line for the first imbalanced entry
              if (e === imbalancedEntries[0]) {
                for (const l of e.lines) {
                  if (l.debit || l.credit) console.log(`      ${l.account}: D=${l.debit || 0} C=${l.credit || 0} ${l.description || ''}`);
                }
              }
            }
          }

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
            imbalancedCount: imbalancedEntries.length,
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
// HTEAO — Revel Sales Summary parser
// Parses a Revel "Sales Summary" CSV into a balanced monthly JE.
//
// Output JE structure (confirmed by the user against manual QBO entries):
//   1  Sales                                       CR  Gross Sales
//   2  Discounts                                   DR  Total Discounts
//   3  Sales Tax Payable                           CR  Sales Tax
//   4  Suspense Deposits (Gift Cards Sold)         CR  Gift Sales
//   5  Suspense Deposits (Gift Cards Redeemed)     DR  Gift Payments
//   6  Employee Tips                               CR  Tips Total + Liabilities Tips Total + Declared Tips
//   7  Suspense Deposits (bank deposit)            DR  PLUG (balances the JE)
// ─────────────────────────────────────────────────────────────────
app.post('/hteao/parse-revel', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    console.log(`HTeaO parse: received "${req.file.originalname}" (${req.file.size} bytes)`);

    // Parse CSV — Revel exports as comma-delimited UTF-8
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false, raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'CSV is empty' });

    // Find the "Total" row (last row — Time To column contains literal "Total")
    const totalRow = rows.find(r => String(r['Time To'] || '').trim().toLowerCase() === 'total');
    if (!totalRow) return res.status(400).json({ error: 'Could not find a "Total" summary row in the CSV' });

    // Find daily rows (everything except the Total) to compute the period
    const dailyRows = rows.filter(r => {
      const t = String(r['Time To'] || '').trim().toLowerCase();
      return t && t !== 'total';
    });

    // Parse Revel dollar strings ("1,886.23", "0.00", "41.28% ") to numbers
    const money = (v) => {
      if (v === null || v === undefined || v === '') return 0;
      const s = String(v).replace(/[$,\s%]/g, '').trim();
      const n = parseFloat(s);
      return isFinite(n) ? n : 0;
    };

    // Extract period from the first and last daily rows
    let periodStart = '', periodEnd = '';
    if (dailyRows.length) {
      // "Time From" is like "03/01/2026 12:00 AM"; "Time To" on last row is "04/01/2026 12:00 AM"
      const firstFrom = String(dailyRows[0]['Time From'] || '').split(' ')[0];
      const lastFrom  = String(dailyRows[dailyRows.length - 1]['Time From'] || '').split(' ')[0];
      const toISO = (s) => {
        const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (!m) return '';
        return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      };
      periodStart = toISO(firstFrom);
      periodEnd   = toISO(lastFrom);
    }

    // Extract Revel store code from original filename
    // Revel filenames look like:
    //   Sales_Summary_tx-67-tyler-old-jacksonvill_2026-03-01_00-00_2026-04-01_00-00.csv
    let storeCode = '';
    const nameMatch = (req.file.originalname || '').match(/^Sales_Summary_(.+?)_\d{4}-\d{2}-\d{2}/i);
    if (nameMatch) storeCode = nameMatch[1];

    // Extract mapped values from the Total row
    const grossSales     = money(totalRow['Gross Sales']);
    const totalDiscounts = money(totalRow['Total Discounts']);
    const salesTax       = money(totalRow['Sales Tax']);
    const giftSales      = money(totalRow['Gift Sales']);      // new liability, credit
    const giftPayments   = money(totalRow['Gift Payments']);   // reduces liability, debit
    const tipsTotal      = money(totalRow['Tips Total']);
    const liabTips       = money(totalRow['Liabilities Tips Total']);
    const declaredTips   = money(totalRow['Declared Tips']);

    const employeeTips = tipsTotal + liabTips + declaredTips;

    // JE math — compute the bank-deposit DR as the plug
    const credits     = grossSales + salesTax + giftSales + employeeTips;
    const knownDebits = totalDiscounts + giftPayments;
    const bankDeposit = +(credits - knownDebits).toFixed(2);

    // Build JE line structure using logical account keys;
    // the UI maps these to QBO account IDs per store.
    const lines = [
      { lineNo: 1, accountKey: 'sales',             credit: +grossSales.toFixed(2),     description: '' },
      { lineNo: 2, accountKey: 'discounts',         debit:  +totalDiscounts.toFixed(2), description: '' },
      { lineNo: 3, accountKey: 'salesTaxPayable',   credit: +salesTax.toFixed(2),       description: '' },
      { lineNo: 4, accountKey: 'suspenseDeposits',  credit: +giftSales.toFixed(2),      description: 'Gift Cards Sold' },
      { lineNo: 5, accountKey: 'suspenseDeposits',  debit:  +giftPayments.toFixed(2),   description: 'Gift Cards Redeemed' },
      { lineNo: 6, accountKey: 'employeeTips',      credit: +employeeTips.toFixed(2),   description: '' },
      { lineNo: 7, accountKey: 'suspenseDeposits',  debit:  +bankDeposit.toFixed(2),    description: '' },
    ];

    // Journal date and ref number
    let journalDate = '';
    let refNo = '';
    if (periodEnd) {
      // Use the last day OF the period (not the exclusive end) as the JE date
      const d = new Date(periodEnd + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      journalDate = `${yyyy}-${mm}-${dd}`;
      refNo = `REVEL ${parseInt(mm, 10)}.${yyyy}`;
    }

    const creditsTotal = lines.reduce((s, l) => s + (l.credit || 0), 0);
    const debitsTotal  = lines.reduce((s, l) => s + (l.debit  || 0), 0);

    res.json({
      success: true,
      storeCode,
      period: { start: periodStart, end: periodEnd },
      journal: {
        refNo,
        date: journalDate,
        lines,
        totals: {
          credits: +creditsTotal.toFixed(2),
          debits:  +debitsTotal.toFixed(2),
          balanced: Math.abs(creditsTotal - debitsTotal) < 0.01,
        },
      },
      sourceFile: {
        name: req.file.originalname,
        size: req.file.size,
      },
      daysInPeriod: dailyRows.length,
    });
  } catch (e) {
    console.error('HTeaO parse error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// NOTIFICATIONS — SSE real-time + push broadcast
// ─────────────────────────────────────────────────────────────────

// Active SSE connections: Map<userId, Set<Response>>
const _sseClients = new Map();

// SSE stream endpoint — clients connect to receive real-time notifications
app.get('/notifications/stream', requireAuth, (req, res) => {
  const userId = req.arkUser.userId;

  res.set('Content-Type', 'text/event-stream');
  res.set('Cache-Control', 'no-cache');
  res.set('Connection', 'keep-alive');
  res.status(200);
  res.write('data: {"type":"connected"}\n\n');

  // Register this connection
  if (!_sseClients.has(userId)) _sseClients.set(userId, new Set());
  _sseClients.get(userId).add(res);
  console.log(`SSE: ${req.arkUser.userName} connected (${_sseClients.get(userId).size} connections)`);

  // Keepalive every 30s to prevent Render timeout
  const keepalive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch (_) { clearInterval(keepalive); }
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    const clients = _sseClients.get(userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) _sseClients.delete(userId);
    }
    console.log(`SSE: ${req.arkUser.userName} disconnected`);
  });
});

// Broadcast a notification to a specific user via SSE + future Web Push
app.post('/notifications/push', requireAuth, async (req, res) => {
  try {
    const { notification } = req.body;
    if (!notification || !notification.targetAm) {
      return res.status(400).json({ error: 'Missing notification or targetAm' });
    }

    // Broadcast via SSE to all connections for this user
    const clients = _sseClients.get(notification.targetAm);
    if (clients && clients.size > 0) {
      const data = `data: ${JSON.stringify(notification)}\n\n`;
      for (const client of clients) {
        try { client.write(data); } catch (_) { clients.delete(client); }
      }
      console.log(`Notif push: sent to ${clients.size} SSE client(s) for user ${notification.targetAm}`);
    }

    // Web Push to all subscriptions for targetAm
    const pushSubs = webpush ? _loadPushSubscriptions(notification.targetAm) : [];
    let pushSent = 0;
    for (const sub of pushSubs) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({
          id: notification.id, title: notification.title, body: notification.body, taskId: notification.taskId,
        }));
        pushSent++;
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          // Subscription expired — remove it
          _removePushSubscription(notification.targetAm, sub.subscription.endpoint);
        }
      }
    }

    res.json({ ok: true, sseDelivered: (clients && clients.size) || 0, pushSent });
  } catch (e) {
    console.error('Notification push error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// TEAM CHAT — DMs + General Channel
// ─────────────────────────────────────────────────────────────────

const CHAT_FILE = path.join(DATA_DIR, 'chat-messages.json');
const CHAT_READ_FILE = path.join(DATA_DIR, 'chat-read-status.json');

// Normalize old dm_ channel IDs to dm~ format
function _normalizeDmChannelId(channelId) {
  if (!channelId || !channelId.startsWith('dm_') || channelId.startsWith('dm~')) return channelId;
  const matches = channelId.match(/usr_[a-f0-9]+/g);
  if (matches && matches.length >= 2) return 'dm~' + matches.sort().join('~');
  return channelId;
}

function _loadChatMessages() {
  try { if (fs.existsSync(CHAT_FILE)) return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch (_) {}
  return [];
}

// One-time migration: convert old dm_ channel IDs to dm~ format
let _chatMigrated = false;
function _migrateChatChannelIds() {
  if (_chatMigrated) return;
  _chatMigrated = true;
  try {
    if (!fs.existsSync(CHAT_FILE)) return;
    const messages = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
    let changed = false;
    for (const m of messages) {
      const norm = _normalizeDmChannelId(m.channelId);
      if (norm !== m.channelId) { m.channelId = norm; changed = true; }
    }
    if (changed) {
      fs.writeFileSync(CHAT_FILE, JSON.stringify(messages));
      console.log('Chat: migrated old dm_ channel IDs to dm~ format');
    }
    // Also migrate read status
    if (fs.existsSync(CHAT_READ_FILE)) {
      const readStatus = JSON.parse(fs.readFileSync(CHAT_READ_FILE, 'utf8'));
      let rsChanged = false;
      for (const uid of Object.keys(readStatus)) {
        const newObj = {};
        for (const [ch, ts] of Object.entries(readStatus[uid])) {
          const norm2 = _normalizeDmChannelId(ch);
          newObj[norm2] = ts;
          if (norm2 !== ch) rsChanged = true;
        }
        readStatus[uid] = newObj;
      }
      if (rsChanged) fs.writeFileSync(CHAT_READ_FILE, JSON.stringify(readStatus));
    }
  } catch (e) { console.log('Chat migration error:', e.message); }
}

function _saveChatMessages(messages) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify(messages));
}

function _loadChatReadStatus() {
  try { if (fs.existsSync(CHAT_READ_FILE)) return JSON.parse(fs.readFileSync(CHAT_READ_FILE, 'utf8')); } catch (_) {}
  return {};
}

function _saveChatReadStatus(status) {
  fs.writeFileSync(CHAT_READ_FILE, JSON.stringify(status));
}

// Helper: broadcast a chat message to relevant SSE connections
function _sseBroadcastChat(msg) {
  const payload = `data: ${JSON.stringify({ type: 'chat', message: msg })}\n\n`;
  if (msg.channelId === 'general' || msg.channelId.startsWith('sms~')) {
    // Broadcast to ALL connected users (general chat + SMS are shared)
    for (const [userId, clients] of _sseClients) {
      for (const client of clients) {
        try { client.write(payload); } catch (_) { clients.delete(client); }
      }
    }
  } else if (msg.channelId.startsWith('dm_') || msg.channelId.startsWith('dm~')) {
    // DM — broadcast to both participants only
    const parts = msg.channelId.includes('~')
      ? msg.channelId.replace(/^dm~/, '').split('~')
      : (msg.channelId.match(/usr_[a-f0-9]+/g) || msg.channelId.replace('dm_', '').split('_'));
    for (const uid of parts) {
      const clients = _sseClients.get(uid);
      if (clients) {
        for (const client of clients) {
          try { client.write(payload); } catch (_) { clients.delete(client); }
        }
      }
    }
  }
}

// Helper: build DM channel ID (sorted so both users get same ID)
function _dmChannelId(uid1, uid2) {
  return 'dm_' + [uid1, uid2].sort().join('_');
}

// Get channels the user participates in
app.get('/chat/channels', requireAuth, (req, res) => {
  try {
    const userId = req.arkUser.userId;
    const allMessages = _loadChatMessages();
    const readStatus = _loadChatReadStatus();
    const userRead = readStatus[userId] || {};
    const hidden = _loadChatHidden()[userId] || { messages: [], channels: [], channelsHiddenAt: {} };

    // Filter out hidden messages, hidden channels, AND messages that are older
    // than the point at which this user deleted the channel. channelsHiddenAt
    // is a per-user { channelId: isoTimestamp } map that survives auto-unhide:
    // when the other participant sends a new message we unhide the channel,
    // but pre-delete messages stay filtered out so they don't resurrect.
    const hiddenAt = hidden.channelsHiddenAt || {};
    const messages = allMessages.filter(m => {
      if (hidden.messages.includes(m.id)) return false;
      if (hidden.channels.includes(m.channelId)) return false;
      const t = hiddenAt[m.channelId];
      if (t && m.createdAt < t) return false;
      return true;
    });

    // Build channel map
    const channelMap = {};
    for (const msg of messages) {
      const ch = msg.channelId;
      if (hidden.channels.includes(ch)) continue;
      // Include: general, DMs involving this user, and ALL SMS channels (shared)
      if (ch === 'general' || ch.startsWith('sms~') || ((ch.startsWith('dm_') || ch.startsWith('dm~')) && ch.includes(userId))) {
        if (!channelMap[ch]) channelMap[ch] = { channelId: ch, messages: 0, lastMessage: null };
        channelMap[ch].messages++;
        if (!channelMap[ch].lastMessage || msg.createdAt > channelMap[ch].lastMessage.createdAt) {
          channelMap[ch].lastMessage = msg;
        }
      }
    }

    // Always include general even if empty
    if (!channelMap['general']) channelMap['general'] = { channelId: 'general', messages: 0, lastMessage: null };

    // Calculate unread counts + resolve DM participant names
    const channels = Object.values(channelMap).map(ch => {
      const lastRead = userRead[ch.channelId] || '1970-01-01T00:00:00Z';
      const unread = messages.filter(m => m.channelId === ch.channelId && m.createdAt > lastRead && m.senderId !== userId).length;
      // For SMS channels, resolve phone to contact name
      let smsContactName = null;
      if (ch.channelId.startsWith('sms~')) {
        const phone = ch.channelId.replace('sms~', '');
        smsContactName = _smsResolveContactName(phone);
      }
      // For DM channels, resolve participant names
      let participants = null;
      if (ch.channelId !== 'general' && (ch.channelId.startsWith('dm_') || ch.channelId.startsWith('dm~'))) {
        let parts;
        if (ch.channelId.includes('~')) parts = ch.channelId.replace(/^dm~/, '').split('~');
        else { const m2 = ch.channelId.match(/usr_[a-f0-9]+/g); parts = m2 && m2.length >= 2 ? m2 : ch.channelId.replace(/^dm_/, '').split('_'); }
        participants = {};
        for (const pid of parts) {
          const u = _users.find(x => x.id === pid || x.username === pid);
          participants[pid] = u ? `${u.fname || ''} ${u.lname || ''}`.trim() || u.username : pid;
        }
      }
      return { ...ch, unread, participants, smsContactName };
    });

    // Sort: general first, then by last message time
    channels.sort((a, b) => {
      if (a.channelId === 'general') return -1;
      if (b.channelId === 'general') return 1;
      const aTime = a.lastMessage?.createdAt || '';
      const bTime = b.lastMessage?.createdAt || '';
      return bTime.localeCompare(aTime);
    });

    res.json(channels);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get messages for a channel (paginated)
app.get('/chat/messages', requireAuth, (req, res) => {
  try {
    const { channelId, before, limit: lim } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const userId = req.arkUser.userId;
    // Security: allow general, DMs involving this user, and SMS channels (shared)
    if (channelId !== 'general' && !channelId.startsWith('sms~') && !((channelId.startsWith('dm_') || channelId.startsWith('dm~')) && channelId.includes(userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const allMessages = _loadChatMessages();
    const hidden = _loadChatHidden()[userId] || { messages: [], channels: [], channelsHiddenAt: {} };
    const hiddenAt = (hidden.channelsHiddenAt || {})[channelId];
    let filtered = allMessages.filter(m => {
      if (m.channelId !== channelId) return false;
      if (hidden.messages.includes(m.id)) return false;
      // If the user deleted this channel at some point, hide everything before
      // that moment — so "deleted" messages don't reappear when the conversation
      // resurfaces from a new incoming message.
      if (hiddenAt && m.createdAt < hiddenAt) return false;
      return true;
    });
    if (before) filtered = filtered.filter(m => m.createdAt < before);
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
    const pageSize = Math.min(parseInt(lim) || 50, 100);
    const page = filtered.slice(0, pageSize);

    // Mark channel as read
    const readStatus = _loadChatReadStatus();
    if (!readStatus[userId]) readStatus[userId] = {};
    readStatus[userId][channelId] = new Date().toISOString();
    _saveChatReadStatus(readStatus);

    res.json({ messages: page.reverse(), hasMore: filtered.length > pageSize }); // return chronological order
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send a message (internal chat OR SMS — routed by channel type)
app.post('/chat/messages', requireAuth, async (req, res) => {
  try {
    const { channelId, text } = req.body;
    if (!channelId || !text?.trim()) return res.status(400).json({ error: 'channelId and text required' });

    const userId = req.arkUser.userId;
    const senderName = req.arkUser.user ? `${req.arkUser.user.fname || ''} ${req.arkUser.user.lname || ''}`.trim() : (req.arkUser.userName || 'Unknown');

    // Security check — allow general, SMS, and DMs involving this user
    if (channelId !== 'general' && !channelId.startsWith('sms~') && !((channelId.startsWith('dm_') || channelId.startsWith('dm~')) && channelId.includes(userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // ── SMS channel: send via Sinch, then save as chat message ──
    if (channelId.startsWith('sms~')) {
      const toPhone = channelId.replace('sms~', '');
      const digits = toPhone.replace(/\D/g, '');
      const toE164 = digits.startsWith('1') ? '+' + digits : '+1' + digits;

      if (!SINCH.sms.planId || !SINCH.sms.apiToken) {
        return res.status(500).json({ error: 'SMS not configured on server' });
      }

      // Send via Sinch
      const smsUrl = `https://us.sms.api.sinch.com/xms/v1/${SINCH.sms.planId}/batches`;
      const smsResp = await fetch(smsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SINCH.sms.apiToken}` },
        body: JSON.stringify({ from: SINCH.sms.number, to: [toE164], body: text.trim() }),
      });

      if (!smsResp.ok) {
        const errBody = await smsResp.text();
        console.error(`SMS send failed: ${smsResp.status} ${errBody}`);
        return res.status(502).json({ error: 'SMS delivery failed', status: smsResp.status, detail: errBody.slice(0, 200) });
      }

      const smsData = await smsResp.json();
      console.log(`SMS sent to ${toE164} via chat: batch ${smsData.id}`);

      // Save as chat message
      const msg = {
        id: crypto.randomUUID(), channelId, senderId: userId, senderName,
        text: text.trim(), createdAt: new Date().toISOString(),
        smsType: 'outbound', smsBatchId: smsData.id,
      };

      const messages = _loadChatMessages();
      messages.push(msg);
      if (messages.length > 10000) messages.splice(0, messages.length - 10000);
      _saveChatMessages(messages);

      const readStatus = _loadChatReadStatus();
      if (!readStatus[userId]) readStatus[userId] = {};
      readStatus[userId][channelId] = msg.createdAt;
      _saveChatReadStatus(readStatus);

      _sseBroadcastChat(msg);
      return res.json(msg);
    }

    // ── Regular internal chat message ──
    const msg = {
      id: crypto.randomUUID(), channelId, senderId: userId, senderName,
      text: text.trim(), createdAt: new Date().toISOString(),
    };

    const messages = _loadChatMessages();
    messages.push(msg);
    if (messages.length > 10000) messages.splice(0, messages.length - 10000);
    _saveChatMessages(messages);

    const readStatus = _loadChatReadStatus();
    if (!readStatus[userId]) readStatus[userId] = {};
    readStatus[userId][channelId] = msg.createdAt;
    _saveChatReadStatus(readStatus);

    // If either DM participant had this channel hidden (deleted), resurrect it
    // so the conversation shows up in both sides' lists again. Old messages
    // stay hidden via the channelsHiddenAt timestamp.
    _chatUnhideDmForParticipants(channelId);

    _sseBroadcastChat(msg);

    console.log(`Chat: ${req.arkUser.userName} → ${channelId}: "${text.trim().slice(0, 50)}"`);
    res.json(msg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark a channel as read
app.post('/chat/read', requireAuth, (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    const readStatus = _loadChatReadStatus();
    if (!readStatus[req.arkUser.userId]) readStatus[req.arkUser.userId] = {};
    readStatus[req.arkUser.userId][channelId] = new Date().toISOString();
    _saveChatReadStatus(readStatus);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a message (own messages only)
// Per-user hidden messages/channels — deleting only hides for you, not the other person
const CHAT_HIDDEN_FILE = path.join(DATA_DIR, 'chat-hidden.json');

function _loadChatHidden() {
  try { if (fs.existsSync(CHAT_HIDDEN_FILE)) return JSON.parse(fs.readFileSync(CHAT_HIDDEN_FILE, 'utf8')); } catch (_) {}
  return {};
}

function _saveChatHidden(data) {
  fs.writeFileSync(CHAT_HIDDEN_FILE, JSON.stringify(data, null, 2));
}

// Hide a message (per-user, DMs only)
app.delete('/chat/messages/:id', requireAuth, (req, res) => {
  try {
    const messages = _loadChatMessages();
    const msg = messages.find(m => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.channelId === 'general') return res.status(403).json({ error: 'Cannot delete Team Chat messages' });

    const userId = req.arkUser.userId;
    const hidden = _loadChatHidden();
    if (!hidden[userId]) hidden[userId] = { messages: [], channels: [] };
    if (!hidden[userId].messages.includes(req.params.id)) {
      hidden[userId].messages.push(req.params.id);
    }
    _saveChatHidden(hidden);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hide an entire DM channel (per-user, not allowed for 'general')
app.delete('/chat/channels/:channelId', requireAuth, (req, res) => {
  try {
    const channelId = req.params.channelId;
    if (channelId === 'general') return res.status(403).json({ error: 'Cannot delete Team Chat' });
    if (!channelId.startsWith('dm_') && !channelId.startsWith('dm~')) return res.status(403).json({ error: 'Can only delete DM channels' });
    const userId = req.arkUser.userId;
    if (!channelId.includes(userId)) return res.status(403).json({ error: 'Not a participant' });

    const hidden = _loadChatHidden();
    if (!hidden[userId]) hidden[userId] = { messages: [], channels: [], channelsHiddenAt: {} };
    if (!hidden[userId].channels.includes(channelId)) {
      hidden[userId].channels.push(channelId);
    }
    // Record the delete time so pre-delete messages stay hidden if the
    // channel resurfaces later (auto-unhide on new inbound/outbound message).
    if (!hidden[userId].channelsHiddenAt) hidden[userId].channelsHiddenAt = {};
    hidden[userId].channelsHiddenAt[channelId] = new Date().toISOString();
    _saveChatHidden(hidden);

    console.log(`Chat: ${req.arkUser.userName} hid channel ${channelId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper — unhide a DM channel for any participant who had it hidden.
// Leaves channelsHiddenAt[channelId] in place so pre-delete messages stay
// filtered out when the channel reappears in their list.
function _chatUnhideDmForParticipants(channelId) {
  if (!(channelId.startsWith('dm_') || channelId.startsWith('dm~'))) return;
  const parts = channelId.includes('~')
    ? channelId.replace(/^dm~/, '').split('~')
    : (channelId.match(/usr_[a-f0-9]+/g) || channelId.replace(/^dm_/, '').split('_'));
  const hiddenAll = _loadChatHidden();
  let changed = false;
  for (const pid of parts) {
    if (hiddenAll[pid]?.channels?.includes(channelId)) {
      hiddenAll[pid].channels = hiddenAll[pid].channels.filter(c => c !== channelId);
      changed = true;
    }
  }
  if (changed) _saveChatHidden(hiddenAll);
}

// ─────────────────────────────────────────────────────────────────
// WEB PUSH — VAPID setup, subscription management
// ─────────────────────────────────────────────────────────────────

// Configure VAPID keys
if (webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:info@arkfinancialservices.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    console.log('Web Push: VAPID keys configured');
  } catch(e) { console.log('Web Push VAPID setup failed:', e.message); webpush = null; }
} else {
  console.log('Web Push: not available — push notifications disabled');
}

// Push subscription persistence
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');

function _loadAllPushSubscriptions() {
  try {
    if (fs.existsSync(PUSH_SUBS_FILE)) return JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function _savePushSubscriptions(data) {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(data, null, 2));
}

function _loadPushSubscriptions(userId) {
  const all = _loadAllPushSubscriptions();
  return all[userId] || [];
}

function _removePushSubscription(userId, endpoint) {
  const all = _loadAllPushSubscriptions();
  if (all[userId]) {
    all[userId] = all[userId].filter(s => s.subscription.endpoint !== endpoint);
    _savePushSubscriptions(all);
  }
}

// Return VAPID public key so client can subscribe
app.get('/push/vapid-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Store a push subscription for the authenticated user
app.post('/push/subscribe', requireAuth, (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });

    const userId = req.arkUser.userId;
    const all = _loadAllPushSubscriptions();
    if (!all[userId]) all[userId] = [];

    // Avoid duplicates
    const exists = all[userId].find(s => s.subscription.endpoint === subscription.endpoint);
    if (!exists) {
      all[userId].push({ subscription, createdAt: new Date().toISOString() });
      _savePushSubscriptions(all);
      console.log(`Push: ${req.arkUser.userName} subscribed (${all[userId].length} devices)`);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove a push subscription
app.delete('/push/subscribe', requireAuth, (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    _removePushSubscription(req.arkUser.userId, endpoint);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve the service worker from root scope
app.get('/sw-push.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw-push.js'));
});

// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// CLOCK-IN / CLOCK-OUT REMINDERS — server-side scheduled push
// Runs every minute, fires at 8:30am and 4:30pm America/Chicago on weekdays.
// Sends Web Push to subscribed users who haven't clocked in/out by the trigger.
// ─────────────────────────────────────────────────────────────────
const REMINDER_TZ = 'America/Chicago';
const REMINDER_CLOCK_IN  = { hour: 8,  minute: 30 };
const REMINDER_CLOCK_OUT = { hour: 16, minute: 30 };

// Track which reminders we've already sent today (per user) so we don't spam
// across the every-minute polling. Keyed by `${userId}:${date}:${type}`.
let _reminderSentToday = new Set();
let _reminderSentDate = null;

function _resetRemindersIfNewDay(localDate) {
  if (_reminderSentDate !== localDate) {
    _reminderSentDate = localDate;
    _reminderSentToday = new Set();
  }
}

// Get the current time components in REMINDER_TZ
function _getLocalNow() {
  // en-CA gives YYYY-MM-DD format
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: REMINDER_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10) % 24, // sometimes returns "24"
    minute: parseInt(parts.minute, 10),
    weekday: parts.weekday, // Mon, Tue, Wed, Thu, Fri, Sat, Sun
  };
}

async function _sendClockReminder(userId, type, message) {
  if (!webpush) return;
  const subs = _loadPushSubscriptions(userId);
  if (!subs.length) return;
  const payload = JSON.stringify({
    title: 'ARK Time Reminder',
    body: message,
    tag: 'clock-reminder-' + type,
    id: 'clock-reminder-' + type + '-' + Date.now(),
  });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, payload);
    } catch (e) {
      // Subscription expired or invalid — clean it up
      if (e.statusCode === 404 || e.statusCode === 410) {
        _removePushSubscription(userId, sub.subscription.endpoint);
      } else {
        console.warn(`Push reminder failed for ${userId}:`, e.statusCode || e.message);
      }
    }
  }
}

async function _checkClockReminders() {
  if (!webpush) return;
  const now = _getLocalNow();
  _resetRemindersIfNewDay(now.date);
  // Skip weekends
  if (now.weekday === 'Sat' || now.weekday === 'Sun') return;

  // Determine if we're in a reminder window (within 5 min after the trigger)
  const isClockInWindow = (now.hour === REMINDER_CLOCK_IN.hour && now.minute >= REMINDER_CLOCK_IN.minute && now.minute < REMINDER_CLOCK_IN.minute + 5);
  const isClockOutWindow = (now.hour === REMINDER_CLOCK_OUT.hour && now.minute >= REMINDER_CLOCK_OUT.minute && now.minute < REMINDER_CLOCK_OUT.minute + 5);
  if (!isClockInWindow && !isClockOutWindow) return;

  const allPunches = _loadTimePunches();
  const allSubs = _loadAllPushSubscriptions();

  // Check every user with at least one push subscription (active employees only)
  for (const userId of Object.keys(allSubs)) {
    if (!allSubs[userId] || !allSubs[userId].length) continue;
    const user = _users.find(u => u.id === userId);
    if (!user || (user.status && user.status.toLowerCase() !== 'active')) continue;
    const todayPunches = (allPunches[userId] || []).filter(p => p.date === now.date);
    const ins = todayPunches.filter(p => p.type === 'in');
    const outs = todayPunches.filter(p => p.type === 'out');

    if (isClockInWindow) {
      const key = `${userId}:${now.date}:in`;
      if (!_reminderSentToday.has(key) && ins.length === 0) {
        await _sendClockReminder(userId, 'in', "Don't forget to clock in!");
        _reminderSentToday.add(key);
      }
    }
    if (isClockOutWindow) {
      const key = `${userId}:${now.date}:out`;
      // Open shift = more clock-ins than clock-outs
      if (!_reminderSentToday.has(key) && ins.length > outs.length) {
        await _sendClockReminder(userId, 'out', "Don't forget to clock out!");
        _reminderSentToday.add(key);
      }
    }
  }
}

// Poll every minute — only fires push during the 5-min window after trigger time
setInterval(() => { _checkClockReminders().catch(e => console.warn('Clock reminder check error:', e.message)); }, 60 * 1000);
console.log('Clock reminders scheduled: 8:30am/4:30pm America/Chicago (weekdays)');

// ─────────────────────────────────────────────────────────────────
// HELP BOARD — Q&A posts with attachments (Reddit-style threads)
// Posts stored in DB (chat-messages style). Files on persistent disk.
// ─────────────────────────────────────────────────────────────────
const HELP_ATTACH_DIR = path.join(DATA_DIR, 'help-attachments');
fs.mkdirSync(HELP_ATTACH_DIR, { recursive: true });
const HELP_POSTS_FILE = path.join(DATA_DIR, 'help-posts.json');

function _loadHelpPosts() {
  try { if (fs.existsSync(HELP_POSTS_FILE)) return JSON.parse(fs.readFileSync(HELP_POSTS_FILE, 'utf8')); } catch (_) {}
  return [];
}
function _saveHelpPosts(posts) { fs.writeFileSync(HELP_POSTS_FILE, JSON.stringify(posts)); }

// Upload attachment(s) for a help post. Returns the saved file metadata.
const helpUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 }, // 15MB per file, 10 files max
});

app.post('/help/upload', requireAuth, helpUpload.array('files', 10), (req, res) => {
  try {
    const postId = req.body.postId || crypto.randomUUID();
    const dir = path.join(HELP_ATTACH_DIR, postId);
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const f of (req.files || [])) {
      const safeName = Date.now() + '-' + f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      fs.writeFileSync(path.join(dir, safeName), f.buffer);
      saved.push({
        name: f.originalname,
        savedAs: safeName,
        size: f.size,
        type: f.mimetype,
        url: `/help/attachment/${postId}/${safeName}`,
      });
    }
    res.json({ ok: true, postId, attachments: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve attachment files (auth required so files aren't public)
app.get('/help/attachment/:postId/:filename', requireAuth, (req, res) => {
  try {
    const safePostId = req.params.postId.replace(/[^a-zA-Z0-9-]/g, '');
    const safeName = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(HELP_ATTACH_DIR, safePostId, safeName);
    if (!filePath.startsWith(HELP_ATTACH_DIR)) return res.status(403).end(); // path traversal guard
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.sendFile(filePath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List all help posts (everyone can see all)
app.get('/help/posts', requireAuth, (req, res) => {
  try {
    const posts = _loadHelpPosts();
    // Sort newest first, with open posts before answered/closed
    posts.sort((a, b) => {
      const aOpen = a.status === 'open' ? 0 : 1;
      const bOpen = b.status === 'open' ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create or update a help post
app.post('/help/posts', requireAuth, (req, res) => {
  try {
    const { id, title, body, category, priority, mentionIds, attachments, status,
            devGoal, devCurrent, devTried, devCode, devErrors, devArea } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
    const userId = req.arkUser.userId;
    const userName = req.arkUser.user ? `${req.arkUser.user.fname || ''} ${req.arkUser.user.lname || ''}`.trim() : (req.arkUser.userName || 'Unknown');
    const validPri = ['urgent','high','low'].includes(priority) ? priority : 'low';
    // Dev-specific fields only get applied when category=development.
    // Strings that weren't sent stay undefined (not saved).
    const devFields = (category === 'development') ? {
      devGoal:    (devGoal    ?? '').toString(),
      devCurrent: (devCurrent ?? '').toString(),
      devTried:   (devTried   ?? '').toString(),
      devCode:    (devCode    ?? '').toString(),
      devErrors:  (devErrors  ?? '').toString(),
      devArea:    (devArea    ?? '').toString(),
    } : null;
    const posts = _loadHelpPosts();
    let post;
    if (id) {
      post = posts.find(p => p.id === id);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      // Only author or admin can edit basic fields
      if (post.authorId !== userId && req.arkUser.role !== 'admin') return res.status(403).json({ error: 'Cannot edit others\' posts' });
      Object.assign(post, {
        title: title.trim(),
        body: (body || '').trim(),
        category: category || post.category,
        mentionIds: mentionIds || post.mentionIds || [],
        attachments: attachments || post.attachments || [],
        status: status || post.status,
        _updatedAt: new Date().toISOString(),
        _updatedBy: userName,
      });
      if (devFields) Object.assign(post, devFields);
      // Priority changes go through dedicated endpoint with required note
    } else {
      post = {
        id: crypto.randomUUID(),
        title: title.trim(),
        body: (body || '').trim(),
        category: category || 'general',
        priority: validPri,
        priorityHistory: [],
        authorId: userId,
        authorName: userName,
        mentionIds: mentionIds || [],
        attachments: attachments || [],
        status: 'open',
        acceptedReplyId: null,
        replies: [],
        createdAt: new Date().toISOString(),
        _updatedAt: new Date().toISOString(),
        _updatedBy: userName,
      };
      if (devFields) Object.assign(post, devFields);
      posts.push(post);
    }
    _saveHelpPosts(posts);
    // Broadcast: bell notif to mentions
    _helpNotifyMentions(post, post.mentionIds || [], userId, userName, 'new-post');
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a reply to a post
app.post('/help/posts/:id/replies', requireAuth, (req, res) => {
  try {
    const { body, mentionIds, attachments } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Reply body required' });
    const userId = req.arkUser.userId;
    const userName = req.arkUser.user ? `${req.arkUser.user.fname || ''} ${req.arkUser.user.lname || ''}`.trim() : (req.arkUser.userName || 'Unknown');
    const posts = _loadHelpPosts();
    const post = posts.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const reply = {
      id: crypto.randomUUID(),
      authorId: userId,
      authorName: userName,
      body: body.trim(),
      mentionIds: mentionIds || [],
      attachments: attachments || [],
      createdAt: new Date().toISOString(),
    };
    if (!post.replies) post.replies = [];
    post.replies.push(reply);
    post._updatedAt = new Date().toISOString();
    _saveHelpPosts(posts);
    // Notify post author + any @mentions in the reply
    const notifyIds = new Set(reply.mentionIds || []);
    if (post.authorId && post.authorId !== userId) notifyIds.add(post.authorId);
    _helpNotifyMentions(post, [...notifyIds], userId, userName, 'reply');
    res.json({ post, reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark a reply as the accepted answer (closes the question)
app.post('/help/posts/:id/accept', requireAuth, (req, res) => {
  try {
    const { replyId } = req.body;
    const userId = req.arkUser.userId;
    const posts = _loadHelpPosts();
    const post = posts.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.authorId !== userId && req.arkUser.role !== 'admin') return res.status(403).json({ error: 'Only the author or admin can accept an answer' });
    post.acceptedReplyId = replyId || null;
    post.status = replyId ? 'answered' : 'open';
    post._updatedAt = new Date().toISOString();
    _saveHelpPosts(posts);
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Change post priority — anyone can do this but must provide a reason note
app.post('/help/posts/:id/priority', requireAuth, (req, res) => {
  try {
    const { priority, note } = req.body;
    if (!['urgent', 'high', 'low'].includes(priority)) return res.status(400).json({ error: 'Invalid priority (must be urgent/high/low)' });
    if (!note?.trim()) return res.status(400).json({ error: 'A reason note is required when changing priority' });
    const userId = req.arkUser.userId;
    const userName = req.arkUser.user ? `${req.arkUser.user.fname || ''} ${req.arkUser.user.lname || ''}`.trim() : (req.arkUser.userName || 'Unknown');
    const posts = _loadHelpPosts();
    const post = posts.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const oldPriority = post.priority || 'low';
    if (oldPriority === priority) return res.status(400).json({ error: 'Priority is already ' + priority });
    if (!post.priorityHistory) post.priorityHistory = [];
    post.priorityHistory.push({
      from: oldPriority,
      to: priority,
      changedBy: userName,
      changedById: userId,
      note: note.trim(),
      at: new Date().toISOString(),
    });
    post.priority = priority;
    post._updatedAt = new Date().toISOString();
    _saveHelpPosts(posts);
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Change post status (open / answered / closed)
app.post('/help/posts/:id/status', requireAuth, (req, res) => {
  try {
    const { status } = req.body;
    if (!['open', 'answered', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const userId = req.arkUser.userId;
    const posts = _loadHelpPosts();
    const post = posts.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.authorId !== userId && req.arkUser.role !== 'admin') return res.status(403).json({ error: 'Cannot change others\' post status' });
    post.status = status;
    post._updatedAt = new Date().toISOString();
    _saveHelpPosts(posts);
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a post (author or admin)
app.delete('/help/posts/:id', requireAuth, (req, res) => {
  try {
    const userId = req.arkUser.userId;
    const posts = _loadHelpPosts();
    const idx = posts.findIndex(p => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Post not found' });
    if (posts[idx].authorId !== userId && req.arkUser.role !== 'admin') return res.status(403).json({ error: 'Cannot delete others\' posts' });
    // Clean up attachment dir
    try {
      const dir = path.join(HELP_ATTACH_DIR, req.params.id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
    posts.splice(idx, 1);
    _saveHelpPosts(posts);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send bell + push notifications to mentioned users
function _helpNotifyMentions(post, userIds, fromUserId, fromUserName, type) {
  if (!userIds || !userIds.length) return;
  const isReply = type === 'reply';
  const title = isReply ? `New reply to "${post.title}"` : `${fromUserName} posted on Help Board`;
  const body = isReply ? `${fromUserName} replied to your post` : post.title;
  for (const uid of userIds) {
    if (uid === fromUserId) continue; // don't notify yourself
    const notif = {
      id: crypto.randomUUID(),
      type: 'help-' + type,
      targetAm: uid,
      title,
      body,
      taskId: null,
      helpPostId: post.id,
      from: fromUserName,
      sentBy: fromUserId,
      read: false,
      createdAt: new Date().toISOString(),
    };
    // Broadcast via SSE
    const clients = _sseClients.get(uid);
    if (clients) {
      const data = `data: ${JSON.stringify(notif)}\n\n`;
      for (const client of clients) {
        try { client.write(data); } catch (_) { clients.delete(client); }
      }
    }
    // Web push
    if (webpush) {
      const subs = _loadPushSubscriptions(uid);
      for (const sub of subs) {
        webpush.sendNotification(sub.subscription, JSON.stringify({
          id: notif.id, title, body, helpPostId: post.id,
        })).catch(e => {
          if (e.statusCode === 410 || e.statusCode === 404) _removePushSubscription(uid, sub.subscription.endpoint);
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// HEALTH CHECK — Render uses this for zero-downtime deploys
// ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), dataDir: DATA_DIR, version: BUILD_VERSION });
});

// Version check — lightweight endpoint for client polling
app.get('/version', (req, res) => {
  res.json({ version: BUILD_VERSION, changes: BUILD_CHANGES });
});

// ─────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN — flush all in-memory data to disk before exit
// ─────────────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n${signal} received — flushing all data to disk...`);
  try {
    savePayrollData();
    console.log('  ✓ Payroll data saved');
  } catch (e) { console.error('  ✗ Payroll data save failed:', e.message); }
  try {
    saveUsers();
    console.log('  ✓ Users saved');
  } catch (e) { console.error('  ✗ Users save failed:', e.message); }
  try {
    saveTokenStore();
    console.log('  ✓ Token store saved');
  } catch (e) { console.error('  ✗ Token store save failed:', e.message); }
  try {
    saveGcalTokens();
    console.log('  ✓ GCal tokens saved');
  } catch (e) { console.error('  ✗ GCal tokens save failed:', e.message); }
  try {
    saveSfTokens();
    console.log('  ✓ ShareFile tokens saved');
  } catch (e) { console.error('  ✗ ShareFile tokens save failed:', e.message); }
  try {
    if (calendlyTokens) { saveCalendlyTokens(); console.log('  ✓ Calendly tokens saved'); }
  } catch (e) { console.error('  ✗ Calendly tokens save failed:', e.message); }
  try {
    saveLetters(); console.log('  ✓ Letters store saved');
  } catch (e) { console.error('  ✗ Letters save failed:', e.message); }
  try {
    savePlHistory();
    saveFleetData();
    savePlThresholds();
    savePlAnticipated();
    console.log('  ✓ P&L / Fleet data saved');
  } catch (e) { console.error('  ✗ P&L / Fleet data save failed:', e.message); }
  console.log('All data flushed. Shutting down.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Start listening
// ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  _migrateChatChannelIds();
  console.log(`ARK QBO Server running on http://localhost:${PORT}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  const faxOk = SINCH.fax.keyId ? '✓' : '✗';
  const smsOk = SINCH.sms.apiToken ? '✓' : '✗';
  const sfOk  = sfReady() ? '✓' : (SF_CLIENT_ID ? '○' : '✗');
  const aiOk  = process.env.ANTHROPIC_API_KEY ? '✓' : '✗';
  const gcalOk = gcalTokens.primary ? '✓' : '✗';
  const calOk  = calendlyReady() ? '✓' : (CALENDLY_CLIENT_ID ? '○' : '✗');
  const ltOk   = Object.keys(lettersStore).length;
  console.log(`  Sinch Fax: ${faxOk}  |  Sinch SMS: ${smsOk}  |  ShareFile: ${sfOk}  |  AI: ${aiOk}  |  GCal: ${gcalOk}`);
  console.log(`  Calendly: ${calOk}  |  Letters: ${ltOk} stored`);
});

// Prevent unhandled errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (server kept running):', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (server kept running):', reason);
});
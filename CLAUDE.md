# ARK Dashboard & QBO Server

## What This Is
ARK Financial's internal CRM/operations dashboard — a single-file HTML app (`ark-dashboard.html`) served by an Express.js API server (`server.js`). Used daily for client management, payroll, tax, communications, and QuickBooks integration.

## Architecture

### Dashboard (`ark-dashboard.html`)
- **Single-file app**: All HTML, CSS, and JS in one file (~22k+ lines)
- **Data storage**: `localStorage` via a `DB` object (clients, tasks, logs, etc.)
- **No build step**: Pure vanilla JS, no frameworks, no bundler
- **Styling**: CSS custom properties defined at top of file, uses `Cormorant Garamond` for headings and `DM Sans` for body text
- **Navigation**: `nav('pageKey')` function shows/hides `.view` divs, updates topbar title

### Server (`server.js`)
- **Express.js** on Node.js — serves the dashboard at `/` and proxies all API calls
- **QBO**: OAuth2 flow via `intuit-oauth`, API calls via `node-quickbooks`
- **Fax**: Sinch Fax API v3 — Basic auth, saves file to temp dir, passes `contentUrl` to Sinch
- **SMS**: Sinch SMS REST API — uses service plan API token (Bearer), NOT OAuth2
- **CORS**: Allows all origins (dashboard may load from `file://` or Render URL)

### Deployment
- **Hosting**: Render Web Service (free plan), auto-deploys from `main` branch
- **URL**: `https://ark-qbo-server.onrender.com`
- **Env vars**: Managed on Render (QBO credentials, Sinch credentials, PORT)
- **Secrets**: Never committed — `.env` is gitignored, credentials live in Render env vars only

## Key Patterns

### Adding a New Center (nav page)
1. Add nav item in the sidebar HTML (~line 726): `<div class="nav-item" onclick="nav('mypage')"><span class="ni">ICON</span>Page Name</div>`
2. Add view div: `<div class="view content" id="view-mypage">...</div>` (before `<!-- /main -->`)
3. Add to `navMap` and `titles` objects inside `nav()` function
4. Add render call: `if(page==='mypage'){ renderMyPage(); }` in `nav()`

### Adding a New API Endpoint
1. Add route in `server.js`
2. Credentials go in `.env` locally and Render env vars for production
3. Dashboard calls the Render URL directly: `fetch('https://ark-qbo-server.onrender.com/endpoint')`

### Client Data Model
Clients are stored in `DB.clients` array. Key fields: `id`, `biz` (business name), `entity`, `ein`, `status`, `owners[]`, `prPlatform`, `prScript`, `services[]`, `am` (account manager ID). Full schema visible in the client modal save functions.

### Payroll Center
- `PAYROLL_SCRIPTS` object maps script names to async handler functions
- Each client has a `prScript` field set in Client Center > Payroll tab
- To add a new script: add `<option>` to `mc-pr-script` select, then register `PAYROLL_SCRIPTS['Name'] = async (file, client) => { return {blob, fileName}; }`

## Rules

- **Never commit secrets** — no API keys, tokens, or passwords in code. Use env vars.
- **Preserve formatting** — the dashboard has very specific styling. Don't change fonts, colors, or spacing unless asked.
- **Card overflow** — `.card` class has `overflow:hidden`. If you need a dropdown to escape a card, add `overflow:visible;position:relative;z-index:10;` to that card's inline style.
- **Test locally first** — run `node server.js` to test server changes before pushing.
- **Single-file discipline** — the dashboard is intentionally one file. Don't split it up.
- **Commit messages** — use short, descriptive messages. Squash debugging commits when possible.

## Common Commands

```bash
# Run server locally
node server.js

# Server starts on http://localhost:3000
# Dashboard at http://localhost:3000/

# Push to deploy (Render auto-deploys from main)
git add <files>
git commit -m "description"
git push
```

## Environment Variables (for .env file)

```
QBO_CLIENT_ID=...
QBO_CLIENT_SECRET=...
QBO_REDIRECT_URI=http://localhost:3000/qbo/callback
QBO_ENVIRONMENT=production
PORT=3000

SINCH_PROJECT_ID=...
SINCH_FAX_KEY_ID=...
SINCH_FAX_KEY_SECRET=...
SINCH_FAX_NUMBER=...
SINCH_SMS_API_TOKEN=...
SINCH_SMS_PLAN_ID=...
SINCH_SMS_NUMBER=...
```

Ask Jacob for the actual values — never share them in chat or commit them.

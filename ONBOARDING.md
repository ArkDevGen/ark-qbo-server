# Developer Onboarding — ARK Dashboard & QBO Server

This doc gets a new developer from zero to "editing the CRM, testing locally, pushing to production." Work through it top to bottom.

## Using Claude to help with setup

You can have Claude walk you through this doc as you go — recommended if you're not already comfortable with a terminal.

- **Steps 1–2 (access grants + installing tools):** drop this file into [claude.ai](https://claude.ai) and ask it questions as you go. Example: *"I'm on Windows 11 — walk me through installing Node.js."* claude.ai can't run commands on your computer, but it's a great co-pilot for clicking through installers.
- **Steps 3–7 (clone repo and onward):** once you've installed Claude Code in Step 2, open a terminal in the cloned `ark-qbo-server` folder and run `claude`. It automatically picks up this doc, [CLAUDE.md](CLAUDE.md), and the whole repo. From there Claude can **actually execute** the commands — `git clone`, `npm install`, `node server.js`, edits, commits — with your permission for each action.

If you get stuck at any step, paste the exact error message into Claude and ask what to do.

## What this project is

The ARK dashboard is a single-file HTML app (`ark-dashboard.html`) served by an Express server (`server.js`). It deploys to Render automatically on every push to `main`. There's no build step — you edit the file, test locally, push, and it's live in ~2 minutes.

Read [CLAUDE.md](CLAUDE.md) for the architecture overview and rules. **Do this before your first commit.**

## Prerequisites — what to collect from the new dev

- GitHub username (for repo access)
- Render account email (for team invite)
- Operating system (Windows / Mac / Linux — steps below assume Windows; Mac/Linux diffs are called out)

## Step 1 — Grant access (existing admin does this)

**GitHub repo access:**
1. Go to https://github.com/ArkDevGen/ark-qbo-server/settings/access
2. Click **Add people**, enter the new dev's GitHub username, pick **Write** role
3. New dev accepts the email invite

**Render team access:**
1. Go to https://dashboard.render.com/team
2. **Invite Member** → their email → **Developer** role (can deploy and view logs, cannot change billing)
3. New dev accepts the email invite

**Ark dashboard user account:**
- Open the live dashboard → Team & Users → add them with the appropriate role. They'll use this account to log in both locally and on the live site.

## Step 2 — Install tools on the new dev's machine

In order:

1. **Git** — https://git-scm.com/download/win (Mac: already installed, or `brew install git`). During Windows install, accept defaults and pick **"Use Git from the command line and also from 3rd-party software."**
2. **Node.js LTS** — https://nodejs.org — pick the current LTS (22.x at time of writing). Installs both `node` and `npm`.
3. **VS Code** — https://code.visualstudio.com
4. **Claude Code** (optional, recommended for AI-assisted work) — https://docs.anthropic.com/en/docs/claude-code/overview

Verify in a fresh terminal (PowerShell on Windows, Terminal on Mac):

```
git --version
node --version
npm --version
```

All three should print versions.

## Step 3 — Clone the repo

Pick a sensible folder (e.g. `C:\Users\<you>\Dev\` on Windows, `~/Dev/` on Mac). In a terminal:

```
git clone https://github.com/ArkDevGen/ark-qbo-server.git
cd ark-qbo-server
npm install
```

First push will prompt for GitHub credentials — sign in via browser.

## Step 4 — Create the `.env` file

The `.env` file is **not in the repo** (it's gitignored) — you have to create it locally.

1. In the repo root, create a file named exactly `.env` (leading dot matters)
2. Paste the template below
3. Get the real values from an existing admin (copy from Render's Environment tab or from their `.env`)

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

**Never email or Slack these values.** Share via 1Password or a secure channel.

## Step 5 — Run the server locally

```
node server.js
```

You'll see a startup banner like:

```
━━━ QBO Token Persistence ━━━
  DATA_DIR     : C:\Users\...\ark-qbo-server
  Persistent?  :   NO — ephemeral, tokens WILL be wiped on redeploy
```

The "NO" is expected locally. Only the Render production server has a `/data` persistent disk.

Open http://localhost:3000 — the dashboard loads. Log in with the Ark dashboard user account.

## Step 6 — The daily workflow

Each work session:

```
git pull                        # get latest from main
# edit files in VS Code
node server.js                  # test locally at localhost:3000
git status                      # see what changed
git add ark-dashboard.html      # stage specific files (avoid "git add .")
git commit -m "short description of the change"
git push                        # Render auto-deploys within ~2 minutes
```

After `git push`, watch the deploy at https://dashboard.render.com. If it fails, check the logs tab — usually a typo or syntax error.

## Step 7 — The rules (non-negotiables)

- **Never commit secrets.** No API keys, tokens, or passwords in code. `.env` is the only place for credentials.
- **Preserve formatting.** Fonts, colors, spacing are intentional. Don't change them unless asked.
- **Keep the dashboard one file.** `ark-dashboard.html` is intentionally a single file — don't split it.
- **Test locally before pushing.** Broken pushes deploy to production instantly.
- **Short, descriptive commit messages.** Squash debugging commits before pushing when possible.
- **Stage specific files.** Avoid `git add .` or `git add -A` — you might accidentally commit a local `.env` or a sensitive file.

## Common tasks reference

- **Pull remote changes before starting work:** `git pull`
- **See what you've changed:** `git status` and `git diff <file>`
- **Undo uncommitted changes in a file:** `git restore <file>` (careful — this is destructive)
- **Check deploy status:** https://dashboard.render.com → ark-qbo-server → Events tab
- **Check prod server token persistence:** https://ark-qbo-server.onrender.com/qbo/diag
- **View prod logs:** Render dashboard → ark-qbo-server → Logs tab

## Getting unstuck

- **Architecture questions:** read [CLAUDE.md](CLAUDE.md)
- **Node.js won't start:** usually a missing `.env` value or a port conflict. Kill anything else on port 3000 and try again.
- **Push rejected:** someone else pushed first. Run `git pull --rebase origin main` then `git push`.
- **Render deploy failed:** check the Logs tab on Render for the exact error — usually a syntax error in `server.js`.

# ARK Dashboard — Team Setup Guide

Follow these steps exactly in order. If you get stuck on any step, ask Jacob.

---

## Step 1: Install Node.js

Node.js is what runs the server on your computer.

1. Go to https://nodejs.org
2. Click the big green **"Download Node.js (LTS)"** button
3. Run the installer — click Next/Accept on everything, use all default options
4. When it finishes, restart your computer

**Verify it worked:** Open Command Prompt (search "cmd" in Start menu) and type:
```
node --version
```
You should see a version number like `v22.x.x`. If you get an error, restart your computer and try again.

---

## Step 2: Install Git

Git is how we share code and deploy changes.

1. Go to https://git-scm.com/download/win
2. The download should start automatically
3. Run the installer — click Next on everything, use all default options
4. When it finishes, close and reopen Command Prompt

**Verify it worked:** In Command Prompt, type:
```
git --version
```
You should see something like `git version 2.x.x`.

---

## Step 3: Install Claude Code

Claude Code is the AI assistant that helps you make changes to the dashboard.

1. Open Command Prompt
2. Type this and press Enter:
```
npm install -g @anthropic-ai/claude-code
```
3. Wait for it to finish (may take a minute)

**Verify it worked:**
```
claude --version
```

---

## Step 4: Set Up a GitHub Account

1. Go to https://github.com and create an account (or sign in if you have one)
2. Tell Jacob your GitHub username so he can add you as a collaborator on the repo

---

## Step 5: Clone the Project

This downloads the project files to your computer.

1. Open Command Prompt
2. Navigate to where you want the project folder. For example, to put it on your Desktop:
```
cd Desktop
```
3. Clone the repo:
```
git clone https://github.com/ArkDevGen/ark-qbo-server.git
```
4. Go into the folder:
```
cd ark-qbo-server
```
5. Install the project dependencies:
```
npm install
```

---

## Step 6: Create Your .env File

The `.env` file has all the secret API keys. **Never share this file or commit it to GitHub.**

1. In the `ark-qbo-server` folder, create a new file called `.env` (no name before the dot, just `.env`)
   - Easiest way: in Command Prompt, while in the ark-qbo-server folder, type:
   ```
   notepad .env
   ```
   - It will ask if you want to create a new file — click **Yes**
2. Jacob will send you the contents to paste in — paste them, then Save and close Notepad

---

## Step 7: Test Locally

Make sure everything works on your computer before making changes.

1. In Command Prompt, make sure you're in the `ark-qbo-server` folder
2. Start the server:
```
node server.js
```
3. You should see:
```
ARK QBO Server running on http://localhost:3000
  Sinch Fax: ✓  |  Sinch SMS: ✓
```
4. Open your browser and go to `http://localhost:3000` — you should see the ARK Dashboard
5. Press `Ctrl+C` in Command Prompt to stop the server when done testing

---

## Step 8: Start Using Claude Code

This is how you make changes to the dashboard with AI assistance.

1. Open Command Prompt
2. Navigate to the project folder:
```
cd Desktop\ark-qbo-server
```
(or wherever you cloned it)

3. Start Claude:
```
claude
```
4. Claude will load the project guide automatically and understand the entire dashboard
5. Tell Claude what you want to change in plain English, e.g.:
   - *"Add a new field called 'Notes' to the Payroll tab in the client modal"*
   - *"Change the Payroll Center header color to match the other centers"*
   - *"Add a new payroll script option called 'Weekly Hourly' to the script dropdown"*
6. Claude will make the changes and show you what it did
7. You can test locally (`node server.js`) to see the changes before deploying

---

## Step 9: Save and Deploy Your Changes

When you're happy with your changes, push them to GitHub and they'll auto-deploy.

1. Claude can do this for you — just say: *"commit and push my changes"*

**Or do it manually in Command Prompt:**
```
git add -A
git commit -m "Brief description of what you changed"
git push
```

Changes will be live at https://ark-qbo-server.onrender.com within ~2 minutes.

---

## Important Rules

- **Never commit the `.env` file** — it's already set up to be ignored, but double check
- **Always test locally** before pushing (`node server.js` → check `localhost:3000`)
- **Don't split the dashboard into multiple files** — it's intentionally one file
- **Don't change fonts, colors, or spacing** unless Jacob asks you to
- **Ask Jacob for API keys** — never share them in GitHub, chat, or email

---

## Quick Reference

| What | Command |
|---|---|
| Go to project folder | `cd Desktop\ark-qbo-server` |
| Start Claude | `claude` |
| Run server locally | `node server.js` |
| Stop server | `Ctrl+C` |
| Check what you changed | `git status` |
| Push changes live | `git add -A` then `git commit -m "message"` then `git push` |
| Get latest changes from team | `git pull` |
| Open dashboard locally | `http://localhost:3000` in browser |
| Live dashboard | `https://ark-qbo-server.onrender.com` |

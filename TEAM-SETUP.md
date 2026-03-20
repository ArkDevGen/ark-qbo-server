# ARK Dashboard — Team Setup Guide

Follow these steps exactly in order. Every step matters. If you get stuck, ask Jacob.

---

## Step 1: Install VS Code (Code Editor)

VS Code is the code editor we use. It's free.

1. Open your browser and go to: **https://code.visualstudio.com/download**
2. Click the big blue **"Windows"** button to download
3. Find the downloaded file (usually in your Downloads folder) — it will be called something like `VSCodeSetup-x64-1.xx.x.exe`
4. Double-click it to run the installer
5. Click **"I accept the agreement"** → **Next**
6. On the "Select Additional Tasks" screen, **check all the boxes**, especially:
   - ✅ "Add to PATH"
   - ✅ "Add 'Open with Code' action to Windows Explorer file context menu"
   - ✅ "Add 'Open with Code' action to Windows Explorer directory context menu"
7. Click **Next** → **Install** → **Finish**

---

## Step 2: Install Node.js

Node.js is what runs the server on your computer.

1. Open your browser and go to: **https://nodejs.org/en/download**
2. Click the big green **"Download Node.js (LTS)"** button — it will download a `.msi` file
3. Find the downloaded file in your Downloads folder (something like `node-v22.x.x-x64.msi`)
4. Double-click it to run the installer
5. Click **Next** on every screen — use all the default options
6. On the "Tools for Native Modules" screen, **check the box** if it asks to install additional tools
7. Click **Next** → **Install** → **Finish**
8. **Restart your computer**

**Verify it worked:**
1. Press the **Windows key** on your keyboard
2. Type **cmd** and press Enter (this opens Command Prompt — a black window)
3. Type this and press Enter:
```
node --version
```
4. You should see a version number like `v22.14.0`. If you see an error, restart your computer and try again.

---

## Step 3: Install Git

Git is how we share code and deploy changes.

1. Open your browser and go to: **https://git-scm.com/downloads/win**
2. Click **"Click here to download"** at the top of the page — it will download a `.exe` file
3. Find the downloaded file in your Downloads folder (something like `Git-2.xx.x-64-bit.exe`)
4. Double-click it to run the installer
5. Click **Next** on every screen — **use all the default options for everything**
   - There are a LOT of screens — just keep clicking Next
6. Click **Install** → **Finish**
7. **Close Command Prompt** if it's open, then reopen it (press Windows key, type **cmd**, press Enter)

**Verify it worked:** In the new Command Prompt window, type:
```
git --version
```
You should see something like `git version 2.47.1.windows.1`.

---

## Step 4: Install Claude Code

Claude Code is the AI assistant that helps you make changes to the dashboard.

1. Open Command Prompt (press Windows key → type **cmd** → press Enter)
2. Type this entire line and press Enter:
```
npm install -g @anthropic-ai/claude-code
```
3. Wait for it to finish — it may take 1-2 minutes. You'll see a bunch of text scrolling. When it's done, you'll see your cursor blinking on a new line.

**Verify it worked:** Type this and press Enter:
```
claude --version
```
You should see a version number.

---

## Step 5: Set Up a GitHub Account

GitHub is where our code lives online.

1. Open your browser and go to: **https://github.com/signup**
2. Follow the steps to create a free account
   - Pick a username, enter your email, create a password
   - Verify your email when GitHub sends you a confirmation
3. **Tell Jacob your GitHub username** so he can give you access to the project

**Wait for Jacob to add you before continuing to Step 6.**

---

## Step 6: Configure Git on Your Computer

This tells Git who you are so your changes are labeled with your name.

1. Open Command Prompt
2. Type these two commands (replace with YOUR name and email), pressing Enter after each:
```
git config --global user.name "Your Full Name"
```
```
git config --global user.email "your-email@example.com"
```
(Use the same email you used for GitHub)

---

## Step 7: Clone the Project

This downloads the project files to your computer.

1. Open Command Prompt
2. Navigate to your Desktop by typing:
```
cd %USERPROFILE%\Desktop
```
3. Download the project by typing:
```
git clone https://github.com/ArkDevGen/ark-qbo-server.git
```
   - If it asks you to sign in to GitHub, sign in with your account
   - You should see "Cloning into 'ark-qbo-server'..." and then it finishes
4. Go into the project folder:
```
cd ark-qbo-server
```
5. Install the project's dependencies:
```
npm install
```
   - This downloads the packages the server needs. Wait for it to finish.

You now have a folder on your Desktop called `ark-qbo-server` with all the project files.

---

## Step 8: Create Your .env File

The `.env` file has all the secret API keys the server needs to work. **Never share this file or put it on GitHub.**

1. Make sure you're in the project folder in Command Prompt. If not, type:
```
cd %USERPROFILE%\Desktop\ark-qbo-server
```
2. Create the file by typing:
```
notepad .env
```
3. Notepad will open and ask **"Do you want to create a new file?"** — click **Yes**
4. **Ask Jacob for the .env contents** — he will send them to you privately
5. Paste the contents into Notepad
6. Press **Ctrl+S** to save, then close Notepad

---

## Step 9: Test Locally

Make sure everything works on your computer before making any changes.

1. In Command Prompt, make sure you're in the project folder:
```
cd %USERPROFILE%\Desktop\ark-qbo-server
```
2. Start the server:
```
node server.js
```
3. You should see this in the Command Prompt:
```
ARK QBO Server running on http://localhost:3000
  Sinch Fax: ✓  |  Sinch SMS: ✓
```
4. Open your browser (Chrome, Edge, etc.) and go to: **http://localhost:3000**
5. You should see the ARK Dashboard load up
6. When you're done looking, go back to Command Prompt and press **Ctrl+C** to stop the server
   - It might ask "Terminate batch job?" — type **Y** and press Enter

---

## Step 10: Open the Project in VS Code

This is how you view and browse the project files.

1. Open VS Code (search for "Visual Studio Code" in your Start menu)
2. Click **File** → **Open Folder...**
3. Navigate to **Desktop** → **ark-qbo-server** → click **Select Folder**
4. You'll see all the project files in the left sidebar:
   - `ark-dashboard.html` — the entire dashboard (this is the main file)
   - `server.js` — the API server
   - `CLAUDE.md` — project guide for Claude
   - `package.json` — project dependencies

---

## Step 11: Start Using Claude Code

This is how you make changes to the dashboard with AI assistance.

1. Open Command Prompt
2. Navigate to the project folder:
```
cd %USERPROFILE%\Desktop\ark-qbo-server
```
3. Start Claude by typing:
```
claude
```
4. Claude will start up and automatically read the project guide (`CLAUDE.md`). It already understands the entire dashboard.
5. Type what you want to change in plain English. Examples:
   - *"Add a new field called 'Notes' to the Payroll tab in the client modal"*
   - *"Add a new payroll script option called 'Weekly Hourly' to the script dropdown"*
   - *"Show me how the Payroll Center works"*
6. Claude will make the changes to the files. You'll see exactly what it changed.
7. Test your changes locally:
   - Open a **second** Command Prompt window
   - Navigate to the project: `cd %USERPROFILE%\Desktop\ark-qbo-server`
   - Run the server: `node server.js`
   - Check **http://localhost:3000** in your browser
8. When you're done, type `/exit` in Claude to quit

---

## Step 12: Save and Deploy Your Changes

When you're happy with your changes, push them to GitHub. They'll go live automatically in about 2 minutes.

**Easiest way — tell Claude to do it:**
In your Claude session, just type: *"commit and push my changes"*

**Or do it manually in Command Prompt:**
```
cd %USERPROFILE%\Desktop\ark-qbo-server
git add -A
git commit -m "Brief description of what you changed"
git push
```

After pushing, changes will be live at: **https://ark-qbo-server.onrender.com** within ~2 minutes.

---

## Before You Start Working Each Day

Always get the latest changes from the team first:

1. Open Command Prompt
2. Go to the project folder:
```
cd %USERPROFILE%\Desktop\ark-qbo-server
```
3. Pull the latest code:
```
git pull
```
4. Then start Claude: `claude`

---

## Important Rules

- **Never commit the `.env` file** — it has secret API keys. It's already set up to be ignored, but be careful.
- **Always test locally before pushing** — run `node server.js` and check `localhost:3000`
- **Always `git pull` before starting work** — get the latest changes from the team first
- **Don't change fonts, colors, or spacing** unless Jacob asks you to
- **Don't split the dashboard into multiple files** — it's intentionally one file
- **Ask Jacob for any API keys or secrets** — never share them in GitHub, chat, or email

---

## Quick Reference

| What | Command |
|---|---|
| Open Command Prompt | Windows key → type **cmd** → Enter |
| Go to project folder | `cd %USERPROFILE%\Desktop\ark-qbo-server` |
| Get latest code from team | `git pull` |
| Start Claude | `claude` |
| Exit Claude | `/exit` |
| Run server locally | `node server.js` |
| Stop server | `Ctrl+C` |
| View dashboard locally | **http://localhost:3000** in browser |
| View live dashboard | **https://ark-qbo-server.onrender.com** |
| Check what you changed | `git status` |
| Push changes live | `git add -A` → `git commit -m "message"` → `git push` |

---

## Troubleshooting

**"node is not recognized"** — Restart your computer. Node.js needs a restart after install.

**"git is not recognized"** — Close Command Prompt and reopen it. If still broken, restart your computer.

**"npm is not recognized"** — Same fix as Node.js above — restart your computer.

**"Permission denied" when pushing** — Make sure Jacob added you as a collaborator on GitHub, and that you're signed into GitHub in your browser.

**"EADDRINUSE" when running server** — Another server is already running on port 3000. Close all Command Prompt windows and try again.

**Dashboard looks weird or old** — Hard refresh your browser: press **Ctrl+Shift+R**.

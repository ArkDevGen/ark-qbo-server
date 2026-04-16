# ARK CRM Staging Environment

## What it is

A live copy of the ARK CRM that the team can experiment in without touching
real client data. Use it to try out changes, test new features, or onboard
new team members before anything is promoted to production.

| Environment | URL | Branch | Data |
|---|---|---|---|
| **Production** | https://ark-qbo-server.onrender.com | `main` | Real client data |
| **Staging** | https://ark-qbo-server-staging.onrender.com | `staging` | Test data only — resets on deploy |

When you're on staging you'll see an orange **STAGING ENVIRONMENT** banner
at the top of the screen and a 🟠 in the browser tab. If you don't see it,
you're on production — stop and double-check before making changes.

---

## Logins

**Staging:** username `arkdev` — password shared via 1Password (ask Mackenzie)

**Production:** your individual user account (not the shared `arkdev` login)

---

## How the branches work

```
    main (production)
      │
      │  every push auto-syncs ──────────────────┐
      ▼                                          ▼
  production Render                       staging Render
  ark-qbo-server                          ark-qbo-server-staging
                                                  ▲
                                                  │
                                           staging branch
                                      (team experiments here)
```

- **`main`** → whatever is here deploys to production. Only Mackenzie,
  Jacob, and Shira can push directly to `main`.
- **`staging`** → whatever is here deploys to staging. Anyone on the team
  can push here to test changes.
- **Every push to `main` auto-merges into `staging`** via a GitHub Action
  so staging always has the latest production code plus any staging-only
  experiments layered on top.

---

## Team workflow: pushing a test change to staging

If you want to try a code change in staging without writing code locally,
the easiest path is the GitHub web editor:

1. Go to https://github.com/ArkDevGen/ark-qbo-server
2. Click the branch dropdown (top-left of file list) → switch to **`staging`**
3. Click the file you want to edit (e.g. `ark-dashboard.html`)
4. Click the pencil icon (✏️ "Edit this file")
5. Make your change
6. Scroll to the bottom → **Commit changes**:
   - Commit message: short description of what you changed
   - ✅ Select "Commit directly to the `staging` branch"
7. Click **Commit changes**
8. Wait ~3 minutes → your change is live on
   https://ark-qbo-server-staging.onrender.com

---

## Promoting a staging change to production

When a staging experiment is working well and should become real:

1. On GitHub, click **Pull requests** → **New pull request**
2. Base: `main` ← Compare: `staging`
3. Click **Create pull request**
4. One of the three admins (Mackenzie, Jacob, Shira) reviews and approves
5. Merge → production deploys automatically

---

## Staging data is disposable

The staging Render service does **not** have a persistent disk, which means:

- Every time code is pushed to staging, the DB may be wiped
- Every time the service sleeps (after 15 min of no traffic) and wakes up,
  it starts from scratch
- Don't put anything in staging that you need to keep

If you need test data, re-seed the admin user by running this in PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri "https://ark-qbo-server-staging.onrender.com/auth/seed"
```

---

## If the auto-sync breaks

Every push to `main` triggers the "Sync main → staging" GitHub Action.
If that action ever fails (merge conflict between main and staging),
you'll see a red ❌ on the repo's Actions tab.

Fix: someone needs to manually reconcile:

```bash
git checkout staging
git pull origin staging
git merge main       # resolve any conflicts here
git push origin staging
```

Usually only happens if someone edits the same file on both branches.

# Team Access — GitHub & Render

How to add (or remove) teammates to the two platforms this project runs on.

---

## GitHub — `ArkDevGen/ark-qbo-server`

Needed so a teammate can clone, pull, push, or review code.

The repo is owned by the **`ArkDevGen`** personal GitHub account. Because it's a personal account (not an Organization), role options are simpler than most docs describe: there's only **Owner** (ArkDevGen itself) and **Collaborator** (everyone else you invite). Collaborators can push code and review PRs, but cannot change repo settings or invite other collaborators — that has to be done signed in as ArkDevGen.

### Add someone

1. Sign in as `ArkDevGen` (only the owner account can invite collaborators)
2. Go to https://github.com/ArkDevGen/ark-qbo-server/settings/access
3. Click **"Add people"** (green button, top right)
4. Type their **GitHub username** → select from the dropdown
5. Click **"Add [username] to this repository"**
6. They receive an invite email — they click the accept link, then access is live

### Remove someone

Same page → find them in the collaborator list → click the trash icon next to their row. Immediate.

### Prereqs for the teammate

- They need a personal GitHub account (free, 60 seconds to sign up at [github.com/signup](https://github.com/signup))
- Each teammate should have **their own** personal account, **not** share the `ArkDevGen` login — that way commits are properly attributed to the real person
- Ask them to send you their username once they've signed up

### Future: converting to a GitHub Organization

Right now only the shared `ArkDevGen` login can change settings or invite collaborators. That's the only real limitation of the current setup, and at current team size it barely matters — needing to sign into ArkDevGen happens maybe 1–2 times a year (when onboarding someone new). Day-to-day coding, pushing, PRs, and reviews all work fine from personal accounts.

**So: not something to do today.** But worth knowing about for when the situation changes.

#### When to revisit

Convert to an Organization when **any** of these become true:

| Signal | Why it matters |
|---|---|
| Team grows past 4–5 people | Managing the shared login friction compounds |
| You want Jacob, Shira, or anyone else to be a real Admin | Impossible on a personal-account repo |
| You add a second repo (e.g. marketing site, internal tool) | Orgs are built for multi-repo |
| You want enforced code review or branch protection | Some of that works on personal repos, but the full feature set is org-only |
| You want to split the team into groups with different access (devs vs. auditors vs. interns) | "Teams" feature is org-only |
| The shared `ArkDevGen` login leaks or someone with access leaves | Forcing a password reset across everyone is painful; orgs are per-user |

#### What the migration actually looks like

Roughly 30 minutes when it's time. High-level steps:

1. Create a GitHub Organization — free tier is fine for this size (free orgs have unlimited public + private repos, unlimited collaborators; the paid Team plan at $4/user/mo unlocks larger CI/storage quotas we don't currently need).
2. **Transfer** the `ark-qbo-server` repo into the new org (Settings → Transfer ownership). Preserves all commits, issues, PRs, and stars.
3. Re-add everyone as org members with proper roles:
   - Mackenzie → Admin (or "Maintain" if we want to scope narrower)
   - Jacob → Admin
   - Shira → Write
4. Update Render's deploy webhook to point at the new repo URL (Render → Service → Settings → Build & Deploy).
5. Update `git remote` on any laptops already cloned:
   ```
   git remote set-url origin https://github.com/<new-org>/ark-qbo-server.git
   ```
6. Update references in `TEAM-ACCESS.md`, `CLAUDE.md`, and this repo's README.
7. Verify Render still auto-deploys on push (the main thing to smoke-test).
8. Optionally: delete or archive the old `ArkDevGen/ark-qbo-server` location (or keep it as a redirect — GitHub forwards transferred repos automatically).

#### Bottom line

Current personal-account setup works fine. Organization conversion is a lightweight future project, not a pre-emptive one. Revisit this section whenever one of the signals above hits.

---

## Render — ARK Workspace

Needed so a teammate can view deploys, read logs, push configuration changes, or manage services.

### Add someone

1. Log in to https://dashboard.render.com
2. Top-left: make sure the ARK workspace is selected
3. **Workspace Settings** (gear icon) → **Members**
4. Click **"Invite"**, enter their email
5. Choose a role:
   - **Viewer** — read-only access to dashboards/logs
   - **Developer** — can deploy, manage services _(standard)_
   - **Admin** — full control + billing + members management
     _(Jacob-only)_
6. They'll receive an email with an accept link.

### Remove someone

Same page — find them in the Members list → click "Remove" on their row. Immediate.

### Prereq

They need a Render account (free, 60 seconds at render.com/register). Their invited email must match the account they create.

### Cost note

Current plan: **Pro ($25/mo, flat)**. **Unlimited seats, no per-user fee.** Add as many people as the team needs — the subscription doesn't change.

---

## Quick reference — who has what today

> _Update this section when access changes._
> _Last reviewed: April 23, 2026_

| Person | GitHub | Render | Notes |
|---|---|---|---|
| Jacob Malousek | Owner of `ArkDevGen` | Admin | Not yet on a personal GitHub account — still operating via shared ArkDevGen login for now |
| Mackenzie Hallstrom | [`mackenziehallstrom`](https://github.com/mackenziehallstrom) · Collaborator | _(see Render Members)_ | Admin inside the ARK Dashboard app |
| Shira (last name) | `shira-ark` · Collaborator | _(see Render Members)_ | — |

---

## Related

- QBO/Sinch API credentials: managed in Render → service → Environment. Not GitHub.
- Team/user permissions _inside the ARK Dashboard_ (Client Center, Reports, etc.) are managed in the app under **Admin → Team & Users**, not on GitHub or Render.

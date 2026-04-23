# Team Access — GitHub & Render

How to add (or remove) teammates to the two platforms this project runs on.

---

## GitHub — `ArkDevGen/ark-qbo-server`

Needed so a teammate can clone, pull, push, or review code.

### Add someone

1. Go to https://github.com/ArkDevGen/ark-qbo-server/settings/access
2. Click **"Add people"** (green button, top right)
3. Enter their GitHub username or email → send invite
4. Choose a role:
   - **Read** — view and clone only (good for auditors / observers)
   - **Write** — can push commits, open PRs _(standard for team devs)_
   - **Admin** — full control; can manage settings and collaborators
     _(Jacob-only — don't grant casually)_
5. They'll receive an email with an accept link. Access is live the moment they accept.

### Remove someone

Same page — find them in the collaborator list → click the trash icon next to their name. Immediate.

### Prereq

They need a GitHub account (free, 60 seconds to sign up at github.com). Ask them to send their username once they've signed up.

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

| Person | GitHub | Render | Last updated |
|---|---|---|---|
| Jacob Malousek | Admin | Admin | — |
| Mackenzie Hallstrom | — | — | — |

---

## Related

- QBO/Sinch API credentials: managed in Render → service → Environment. Not GitHub.
- Team/user permissions _inside the ARK Dashboard_ (Client Center, Reports, etc.) are managed in the app under **Admin → Team & Users**, not on GitHub or Render.

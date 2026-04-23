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

### If we ever need true multi-admin control

Right now only the `ArkDevGen` account can change settings or invite people. If managing that single shared login becomes a pain, we can convert to a GitHub **Organization** — takes ~15 minutes, transfers the repo, and unlocks the full Read/Write/Admin/Maintain role ladder so multiple people can be Admin without sharing any login. Not needed today.

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

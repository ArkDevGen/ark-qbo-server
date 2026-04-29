# ARK Dashboard Roadmap

Running backlog. Mackenzie adds new items by prefixing a chat message with `note:`.
This file is checked in so it survives across sessions — any new chat can read it.

Items aren't strictly ordered; categories group related work. Move things between
sections (or strike them out under "✅ Shipped") as they progress.

---

## 🐛 Bugs (current)

- **Production — grouping still not fully working.** After two passes (data heal +
  fallback grouping by clientName), tasks are still ending up in the wrong bucket.
  Needs a fresh look — get specifics from Mackenzie on which task is in the wrong
  place.
- **Team & Users — last-login timestamps inaccurate.**
- **Client Center — QBO sync overrides typed/saved values.** When a user types in a
  field or overrides a QBO-pulled value, the next QBO sync wipes it. The user's
  edit must win on save. (Also tracked in MEMORY: "QBO overwrites CRM edits on
  save".)
- **Comm Center / SMS — incoming texts from team members don't show their name.**
  Texts from Jacob render as the raw `+1…` number even though his number is on
  his user profile. Likely an `+1` prefix-mismatch on lookup (stored without
  the prefix, incoming Sinch payload has it). Lookup should normalize both
  sides before matching.

---

## 🧹 Cleanup

- **Quick Actions card** — needs cleaning up. Includes:
  - Drop the "SOON" badge on Outlook (it's a working link now).
  - Possibly spacing / button order / what's actually shown.
- **Tools Center** — remove New Hire Report (it lives in Payroll Center now).
- **Tools Center** — surface Postage tool here too (keep on the dashboard
  Quick Actions; just also expose it as a tile in Tools Center for users who
  navigate by tool).
- **Scooter's QBO Center** — collapse the row of Sales / COGS / P&L / etc. buttons
  into dropdowns. Currently too cluttered.

---

## 📊 Review / Decision (think before build)

- **Custom widgets on Dashboard** — evaluate whether they're worth keeping or need
  a different design.
- **Schedule widget** — show client's AM on event cards and notify the AM on new
  meeting. Build after calendar-event-to-client matching is reliable. (From
  MEMORY.)

---

## 🔬 Research / Discovery

- **JE Creator engine** — first compile a list of who creates JEs for which
  payroll clients. Need that picture before designing the engine itself.

---

## 🆕 New Features

### Dashboard / UX
- Priority pop-ups (urgent tier exists in notification system; broader use TBD)
- Weekly backup
- **Right-click → open in new tab — Phase 2 (per-entity)** — let users
  right-click a client row, task card, etc. and open *that specific entity* in
  a new tab. Needs per-entity deep links (e.g. `#/clients/123`) and a router
  that opens the right modal/view on load. Phase 1 (sidebar pages) shipped —
  decide if Phase 2 is wanted before building.

### Security
- SMS confidentiality
- MFA / passcodes (double security)

### Comm Center
- **Saved contacts / contacts folder** — today only client phones get
  recognized in the Comm Center. Add a place to store labeled non-client
  numbers (Homebase, verification-code senders, vendors, payroll platforms,
  etc.) so incoming SMS surfaces a meaningful sender name instead of a raw
  number. Should also be reusable from the user's profile (team numbers).

### API / Integrations
- Lightspeed, Toast, PowerBI, Patriot, SurePay (real-time updates)
- Otter API
- Vonage API — AM availability indicator + time tracker on DND (red)
- ShareFile — click to open files
- Sales tax — connect accounts for real-time updates, alert on rate not updated in
  > 1 month
- Payroll — connect accounts for real-time updates, alert on tax/UI changes

### Payroll
- **JE Creator engine** (cross-listed under Research above)
- New Hire — import, show active, employee database, drop-in census
- Turn off auto-send reports before DB is created
- Text-to-employee for interview questions / WOTC paperwork
- **Work Opportunity Tax Credit engine** — new-hire screening, tracking through
  6/12-month milestones, billing

### Books / QuickBooks
- QBO Center: show only bank/CC accounts in expense push; payment method (check #)
- Desktop QB import options for CRM (where possible)
- Sales JE for Scooters: verify # of JEs equals days in month
- P&L Digester for clean-up + Balance Tool Digester
- Expense Tool — split transactions per client/store when one card is used

### P&L Review
- Flag possible 1099 transactions, check QBO for W9 on file

### Client Center
- Tabs: point of contact, payroll, books, etc.
- Add FBC info for Scooters clients
- GoFormz integration?

### Scooters
- Dedicated Scooters dashboard
- Deposit Checker — Adyen / cash / credit card (also potentially for others)

### Tools
- Tokens — balance count on CRM (e.g. $25 daily limit set in console)
- Fixed-rate tool — >$2,500 tool on P&L digester (need more info from Jacob)

### Ideas & Feedback
- Per-user creation, save for all statuses, make details required

### Team Hub / Production
- Notes on Production — attach PDF/email
- Sandbox/staging — notify admin when dev complete, push "help wanted" tasks
- Help Wanted priorities — nice-to-have / need-help (notify, accept comments) /
  urgent (send to all AMs immediately, confirmation when accepted)
- **Emoji picker on team chat** — add an emoji picker so users can drop emojis
  into chat messages.

### New CRM / Hub Builds
- Hardy CRM/Hub
- RTBS CRM/Hub

### Branding / Domain
- Change domain for all surfaces (CRM, GC Hub, client entry page, Robidoux
  GJE Builder at `/robidoux-entry`, etc.)
- Compile all login information in one place

---

## ✅ Shipped (recent)

- Transfer Breakdown payroll widget (per-client opt-in)
- Tip Pool Calculator widget (per-client opt-in)
- P&L Report polish — `% of Income` default checked, inline company picker,
  `% Variance` view mode, `Whole Franchise` view mode, auto-check sales/COGS
  close-checklist on JE push
- Master Search (Ctrl+K) — fuzzy global search across clients, tasks, ideas,
  proposals, leads, meetings, payroll, JE batches, team
- Notification pop-ups — stacking sliding cards with priority tiers (urgent /
  high / normal)
- Topbar page-title alignment with sidebar labels
- Sidebar reorg — Workspace group (QBO + File + Tools & Reports), Payroll +
  New Hires merged, sidebar highlight bug fixed for Meetings + File Center
- Production sidebar grouping — heal tasks missing clientId; fallback grouping
  by clientName so tasks with clients leave Personal
- Clock-in/out reminders — no longer pops on every refresh; only fires at the
  designated time. Added 5/10/15/20/30 min snooze.
- Sidebar logo — enlarged + centered in a true square white area
- Right-click → open in new tab (Phase 1) — sidebar nav pages now have hash
  routes (`#/clients`, `#/payroll`, etc.). Right-clicking a sidebar item lets
  the browser "Open Link in New Tab" land on that page directly. Per-entity
  deep links (Phase 2) tracked under Dashboard / UX.
- Quick Actions — Office dropdown added next to Payroll, with Calendly,
  Zoom, Otter Notes, Eakes, and Check Orders.
- Robidoux GJE Builder — hosted at `/robidoux-entry` behind per-client access
  keys. Tools Center has a "Robidoux GJE Builder" tile that opens credential
  management (add/edit/delete clients, copy or regenerate access keys).

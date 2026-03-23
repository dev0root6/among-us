# TRACKER

A self-hosted project management tool with Kanban board, timeline view, and admin panel.  
**Stack**: Neon PostgreSQL · Cloudflare Workers · React (single HTML file)

---

## Architecture

```
frontend/index.html      — Single-file React SPA (no build step required)
worker/src/index.js      — Cloudflare Worker REST API
db/schema.sql            — Neon PostgreSQL schema
```

---

## 1 — Set Up Neon Database

1. Create a free project at https://neon.tech
2. Open the **SQL Editor** in the Neon console
3. Paste and run the entire contents of `db/schema.sql`
4. Copy your **connection string** (Settings → Connection Details)  
   Format: `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`

---

## 2 — Deploy the Cloudflare Worker

### Prerequisites
```bash
npm install -g wrangler
wrangler login
```

### Install dependencies
```bash
cd worker
npm install
```

### Set secrets
```bash
wrangler secret put DATABASE_URL
# paste your Neon connection string

wrangler secret put JWT_SECRET
# paste any long random string, e.g.: openssl rand -hex 32
```

### Deploy
```bash
wrangler deploy
```

Note the deployed URL, e.g.:  
`https://tracker-worker.YOUR-SUBDOMAIN.workers.dev`

---

## 3 — Configure & Serve the Frontend

Open `frontend/index.html` and update line ~220:

```js
const API = (window.TRACKER_API || 'https://tracker-worker.YOUR-SUBDOMAIN.workers.dev');
```

Replace with your actual Worker URL.

### Serving options

**Option A — Local (no server)**  
Just open `frontend/index.html` in your browser directly.

**Option B — Cloudflare Pages**  
1. Push `frontend/` to a GitHub repo
2. Connect to Cloudflare Pages → deploy from `frontend/` directory
3. No build command needed, output is `index.html`

**Option C — Any static host**  
Netlify, Vercel, GitHub Pages — just drop the `index.html` file.

---

## 4 — First Run

1. Open the app in your browser
2. Click **Register**
3. Create the first account — it automatically becomes **admin**
4. All subsequent registrations default to **member** role

---

## Auth Model

| Feature | Detail |
|---------|--------|
| Credentials | Custom username + email + password |
| Storage | bcrypt-hashed passwords in Neon |
| Token | HMAC-SHA256 signed JWT, 7-day expiry |
| First user | Automatically promoted to `admin` |

---

## Roles & Permissions

| Action | admin | member |
|--------|-------|--------|
| View all projects | ✓ | own + shared only |
| Create project | ✓ | ✓ |
| Delete any project | ✓ | own only |
| Add/remove users | ✓ | ✗ |
| Change user roles | ✓ | ✗ |
| Admin dashboard | ✓ | ✗ |
| Create/edit tasks | ✓ | ✓ (in accessible projects) |

---

## Features

### Kanban Board
- 4 columns: **Backlog · To Do · In Progress · Done**
- Drag tasks between columns via the ⋮ context menu
- Priority badges: Low · Medium · High · Urgent
- Assignee avatars, due dates with overdue highlighting

### Timeline View
- Horizontal Gantt-style chart across 5 months
- Tasks with `start_date` and/or `due_date` appear as bars
- Red "today" line marker
- Color-coded by task status

### Admin Panel
- Global stats: users, projects, tasks by status
- Full user table: add, edit role/email/password, delete
- Project overview across all teams

---

## API Reference

```
POST /api/auth/register      { username, email, password }
POST /api/auth/login         { username, password }
GET  /api/auth/me

GET  /api/projects
POST /api/projects
GET  /api/projects/:id
PATCH /api/projects/:id
DELETE /api/projects/:id
GET  /api/projects/:id/tasks
POST /api/projects/:id/tasks
GET  /api/projects/:id/members
POST /api/projects/:id/members

PATCH  /api/tasks/:id
DELETE /api/tasks/:id

GET  /api/users              (admin)
PATCH /api/users/:id         (admin)
DELETE /api/users/:id        (admin)
GET  /api/admin/stats        (admin)
```

---

## Local Development (Worker)

```bash
cd worker
npm run dev
# runs on http://localhost:8787
```

Update `API` in `frontend/index.html` to `http://localhost:8787` for local testing.

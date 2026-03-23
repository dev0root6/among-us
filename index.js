/**
 * TRACKER — Cloudflare Worker Backend
 * Routes: /api/auth/*, /api/projects/*, /api/tasks/*, /api/admin/*, /api/users/*
 */

import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';

// ─── CORS ────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsHeaders(extra = {}) {
  return { ...CORS, 'Content-Type': 'application/json', ...extra };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ─── TOKEN (simple signed token, no jose dependency) ─────────────────────────
async function signToken(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = btoa(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const key    = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${sigB64}`;
}

async function verifyToken(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const data = `${header}.${body}`;
    const key  = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
async function requireAuth(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return [null, err('Unauthorized', 401)];

  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return [null, err('Invalid or expired token', 401)];

  const sql = neon(env.DATABASE_URL);
  const rows = await sql`SELECT id, username, email, role FROM users WHERE id = ${payload.userId}`;
  if (!rows.length) return [null, err('User not found', 401)];
  return [rows[0], null];
}

function requireAdmin(user) {
  if (user.role !== 'admin') return err('Forbidden: admin only', 403);
  return null;
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url      = new URL(request.url);
    const path     = url.pathname.replace(/\/$/, '');
    const method   = request.method;
    const sql      = neon(env.DATABASE_URL);
    const segments = path.split('/').filter(Boolean); // ['api','projects','uuid',...]

    try {
      // ── Auth ──────────────────────────────────────────────────────────────
      if (path === '/api/auth/register' && method === 'POST') {
        const { username, email, password } = await request.json();
        if (!username || !email || !password) return err('username, email and password required');

        const exists = await sql`SELECT id FROM users WHERE email=${email} OR username=${username}`;
        if (exists.length) return err('Username or email already taken', 409);

        const hash = await bcrypt.hash(password, 10);
        // First user becomes admin
        const countRow = await sql`SELECT COUNT(*) as c FROM users`;
        const role = parseInt(countRow[0].c) === 0 ? 'admin' : 'member';

        const [user] = await sql`
          INSERT INTO users (username, email, password, role)
          VALUES (${username}, ${email}, ${hash}, ${role})
          RETURNING id, username, email, role, created_at
        `;

        const token = await signToken(
          { userId: user.id, role: user.role, exp: Math.floor(Date.now()/1000) + 86400*7 },
          env.JWT_SECRET
        );
        return json({ user, token });
      }

      if (path === '/api/auth/login' && method === 'POST') {
        const { username, password } = await request.json();
        if (!username || !password) return err('username and password required');

        const [user] = await sql`SELECT * FROM users WHERE username=${username} OR email=${username}`;
        if (!user) return err('Invalid credentials', 401);

        const match = await bcrypt.compare(password, user.password);
        if (!match) return err('Invalid credentials', 401);

        const token = await signToken(
          { userId: user.id, role: user.role, exp: Math.floor(Date.now()/1000) + 86400*7 },
          env.JWT_SECRET
        );
        const { password: _, ...safeUser } = user;
        return json({ user: safeUser, token });
      }

      if (path === '/api/auth/me' && method === 'GET') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        return json({ user });
      }

      // ── Users (admin) ─────────────────────────────────────────────────────
      if (path === '/api/users' && method === 'GET') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const adminErr = requireAdmin(user);
        if (adminErr) return adminErr;

        const users = await sql`SELECT id, username, email, role, created_at, updated_at FROM users ORDER BY created_at`;
        return json({ users });
      }

      if (path.match(/^\/api\/users\/[^/]+$/) && method === 'PATCH') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const adminErr = requireAdmin(user);
        if (adminErr) return adminErr;

        const targetId = segments[2];
        const body = await request.json();
        const updates = {};

        if (body.role)     updates.role     = body.role;
        if (body.username) updates.username = body.username;
        if (body.email)    updates.email    = body.email;
        if (body.password) updates.password = await bcrypt.hash(body.password, 10);

        if (!Object.keys(updates).length) return err('Nothing to update');

        const [updated] = await sql`
          UPDATE users SET
            username = COALESCE(${updates.username ?? null}, username),
            email    = COALESCE(${updates.email    ?? null}, email),
            role     = COALESCE(${updates.role     ?? null}, role),
            password = COALESCE(${updates.password ?? null}, password),
            updated_at = NOW()
          WHERE id = ${targetId}
          RETURNING id, username, email, role, created_at, updated_at
        `;
        if (!updated) return err('User not found', 404);
        return json({ user: updated });
      }

      if (path.match(/^\/api\/users\/[^/]+$/) && method === 'DELETE') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const adminErr = requireAdmin(user);
        if (adminErr) return adminErr;

        const targetId = segments[2];
        if (targetId === user.id) return err('Cannot delete yourself');
        await sql`DELETE FROM users WHERE id = ${targetId}`;
        return json({ success: true });
      }

      // ── Projects ──────────────────────────────────────────────────────────
      if (path === '/api/projects' && method === 'GET') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;

        let projects;
        if (user.role === 'admin') {
          projects = await sql`
            SELECT p.*, u.username as owner_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as task_count
            FROM projects p
            JOIN users u ON u.id = p.owner_id
            ORDER BY p.created_at DESC
          `;
        } else {
          projects = await sql`
            SELECT p.*, u.username as owner_name, pm.permission,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as task_count
            FROM projects p
            JOIN users u ON u.id = p.owner_id
            LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ${user.id}
            WHERE p.owner_id = ${user.id} OR pm.user_id = ${user.id}
            ORDER BY p.created_at DESC
          `;
        }
        return json({ projects });
      }

      if (path === '/api/projects' && method === 'POST') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;

        const { name, description } = await request.json();
        if (!name) return err('name required');

        const [project] = await sql`
          INSERT INTO projects (name, description, owner_id)
          VALUES (${name}, ${description ?? null}, ${user.id})
          RETURNING *
        `;
        await sql`
          INSERT INTO project_members (project_id, user_id, permission)
          VALUES (${project.id}, ${user.id}, 'owner')
          ON CONFLICT DO NOTHING
        `;
        return json({ project }, 201);
      }

      if (path.match(/^\/api\/projects\/[^/]+$/) && method === 'GET') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const projectId = segments[2];

        const [project] = await sql`
          SELECT p.*, u.username as owner_name
          FROM projects p JOIN users u ON u.id = p.owner_id
          WHERE p.id = ${projectId}
        `;
        if (!project) return err('Project not found', 404);
        return json({ project });
      }

      if (path.match(/^\/api\/projects\/[^/]+$/) && method === 'PATCH') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const projectId = segments[2];
        const { name, description } = await request.json();

        const [project] = await sql`
          UPDATE projects SET
            name        = COALESCE(${name ?? null}, name),
            description = COALESCE(${description ?? null}, description),
            updated_at  = NOW()
          WHERE id = ${projectId} AND owner_id = ${user.id}
          RETURNING *
        `;
        if (!project) return err('Project not found or permission denied', 404);
        return json({ project });
      }

      if (path.match(/^\/api\/projects\/[^/]+$/) && method === 'DELETE') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const projectId = segments[2];
        if (user.role !== 'admin') {
          const [p] = await sql`SELECT id FROM projects WHERE id=${projectId} AND owner_id=${user.id}`;
          if (!p) return err('Forbidden', 403);
        }
        await sql`DELETE FROM projects WHERE id = ${projectId}`;
        return json({ success: true });
      }

      // Project members
      if (path.match(/^\/api\/projects\/[^/]+\/members$/) && method === 'GET') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const projectId = segments[2];

        const members = await sql`
          SELECT u.id, u.username, u.email, u.role, pm.permission, pm.added_at
          FROM project_members pm
          JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = ${projectId}
          ORDER BY pm.added_at
        `;
        return json({ members });
      }

      if (path.match(/^\/api\/projects\/[^/]+\/members$/) && method === 'POST') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const projectId = segments[2];
        const { userId: targetUserId, permission = 'viewer' } = await request.json();

        const [member] = await sql`
          INSERT INTO project_members (project_id, user_id, permission)
          VALUES (${projectId}, ${targetUserId}, ${permission})
          ON CONFLICT (project_id, user_id) DO UPDATE SET permission = EXCLUDED.permission
          RETURNING *
        `;
        return json({ member }, 201);
      }

      // ── Tasks ─────────────────────────────────────────────────────────────
      if (path.match(/^\/api\/projects\/[^/]+\/tasks$/) && method === 'GET') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const projectId = segments[2];

        const tasks = await sql`
          SELECT t.*, 
            u.username as assignee_name,
            cb.username as created_by_name
          FROM tasks t
          LEFT JOIN users u ON u.id = t.assignee_id
          LEFT JOIN users cb ON cb.id = t.created_by
          WHERE t.project_id = ${projectId}
          ORDER BY t.status, t.position, t.created_at
        `;
        return json({ tasks });
      }

      if (path.match(/^\/api\/projects\/[^/]+\/tasks$/) && method === 'POST') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const projectId = segments[2];
        const { title, description, status = 'backlog', priority = 'medium', assignee_id, due_date, start_date } = await request.json();

        if (!title) return err('title required');

        const [maxPos] = await sql`
          SELECT COALESCE(MAX(position), -1) + 1 as pos FROM tasks WHERE project_id=${projectId} AND status=${status}
        `;

        const [task] = await sql`
          INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, due_date, start_date, position)
          VALUES (${projectId}, ${title}, ${description ?? null}, ${status}, ${priority},
                  ${assignee_id ?? null}, ${user.id}, ${due_date ?? null}, ${start_date ?? null}, ${maxPos.pos})
          RETURNING *
        `;
        return json({ task }, 201);
      }

      if (path.match(/^\/api\/tasks\/[^/]+$/) && method === 'PATCH') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const taskId = segments[2];
        const body = await request.json();

        const [task] = await sql`
          UPDATE tasks SET
            title       = COALESCE(${body.title       ?? null}, title),
            description = COALESCE(${body.description ?? null}, description),
            status      = COALESCE(${body.status      ?? null}, status),
            priority    = COALESCE(${body.priority    ?? null}, priority),
            assignee_id = CASE WHEN ${body.assignee_id !== undefined} THEN ${body.assignee_id ?? null} ELSE assignee_id END,
            due_date    = CASE WHEN ${body.due_date    !== undefined} THEN ${body.due_date    ?? null} ELSE due_date    END,
            start_date  = CASE WHEN ${body.start_date  !== undefined} THEN ${body.start_date  ?? null} ELSE start_date  END,
            position    = COALESCE(${body.position    ?? null}, position),
            updated_at  = NOW()
          WHERE id = ${taskId}
          RETURNING *
        `;
        if (!task) return err('Task not found', 404);
        return json({ task });
      }

      if (path.match(/^\/api\/tasks\/[^/]+$/) && method === 'DELETE') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const taskId = segments[2];
        await sql`DELETE FROM tasks WHERE id = ${taskId}`;
        return json({ success: true });
      }

      // ── Admin: Stats ──────────────────────────────────────────────────────
      if (path === '/api/admin/stats' && method === 'GET') {
        const [user, authErr] = await requireAuth(request, env);
        if (authErr) return authErr;
        const adminErr = requireAdmin(user);
        if (adminErr) return adminErr;

        const [users]    = await sql`SELECT COUNT(*) as c FROM users`;
        const [projects] = await sql`SELECT COUNT(*) as c FROM projects`;
        const [tasks]    = await sql`SELECT COUNT(*) as c FROM tasks`;
        const byStatus   = await sql`SELECT status, COUNT(*) as c FROM tasks GROUP BY status`;

        return json({ stats: {
          users:    parseInt(users.c),
          projects: parseInt(projects.c),
          tasks:    parseInt(tasks.c),
          byStatus: Object.fromEntries(byStatus.map(r => [r.status, parseInt(r.c)]))
        }});
      }

      return err('Not found', 404);
    } catch (e) {
      console.error(e);
      return err(`Server error: ${e.message}`, 500);
    }
  }
};

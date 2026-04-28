import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

export const config = {
  path: [
    '/api/album',
    '/api/photo',
    '/api/info',
    '/api/bulk-info',
    '/api/expand',
    '/api/shrink',
    '/api/login',
    '/api/logout',
    '/api/me'
  ]
};

const DEFAULT_SIZE = 49;
const META_STORE = 'album-meta';
const PHOTO_STORE = 'album-photos';
const SESSION_DAYS = 7;

const stores = () => ({
  meta: getStore(META_STORE),
  photos: getStore(PHOTO_STORE)
});

const emptySlot = () => ({ name: '', rut: '', hasPhoto: false, contentType: null });

async function loadMeta(curso) {
  const { meta } = stores();
  const data = await meta.get(`meta:${curso}`, { type: 'json' });
  if (!data || !Array.isArray(data.slots)) {
    return { size: DEFAULT_SIZE, slots: Array.from({ length: DEFAULT_SIZE }, emptySlot) };
  }
  return data;
}

async function saveMeta(curso, data) {
  const { meta } = stores();
  await meta.setJSON(`meta:${curso}`, data);
}

const ensureSize = (meta, position) => {
  while (meta.slots.length <= position) meta.slots.push(emptySlot());
  meta.size = meta.slots.length;
};

// ---------- AUTH ----------

const b64u = {
  encode: (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (str) => {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  }
};

function signToken(payload, secret) {
  const body = b64u.encode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.lastIndexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  let payload;
  try { payload = JSON.parse(b64u.decode(body).toString('utf8')); }
  catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getUser(request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const cookies = parseCookies(request);
  const payload = verifyToken(cookies.auth, secret);
  return payload ? payload.u : null;
}

function timingSafeStrEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // Hash to equalize length and avoid leaking length info
  const ah = crypto.createHash('sha256').update(ab).digest();
  const bh = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function authCookie(token, maxAgeSec) {
  const parts = [
    `auth=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  return parts.join('; ');
}

// ---------- HELPERS ----------

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
  });

const err = (msg, status = 400) => json({ error: msg }, status);

const PROTECTED = new Set([
  'POST:photo', 'DELETE:photo',
  'POST:info', 'POST:bulk-info',
  'POST:expand', 'POST:shrink'
]);

// ---------- ROUTER ----------

export default async (request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const method = request.method;
  const routeKey = `${method}:${path}`;

  try {
    // Auth routes
    if (path === 'me' && method === 'GET') {
      const user = getUser(request);
      return json({ user });
    }

    if (path === 'login' && method === 'POST') {
      const { ADMIN_USER, ADMIN_PASS, AUTH_SECRET } = process.env;
      if (!ADMIN_USER || !ADMIN_PASS || !AUTH_SECRET) return err('auth not configured', 500);
      const body = await request.json().catch(() => ({}));
      const userOk = timingSafeStrEqual(body.user || '', ADMIN_USER);
      const passOk = timingSafeStrEqual(body.password || '', ADMIN_PASS);
      if (!userOk || !passOk) return err('credenciales inválidas', 401);
      const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
      const token = signToken({ u: ADMIN_USER, exp }, AUTH_SECRET);
      return json({ ok: true, user: ADMIN_USER }, 200, {
        'set-cookie': authCookie(token, SESSION_DAYS * 86400)
      });
    }

    if (path === 'logout' && method === 'POST') {
      return json({ ok: true }, 200, {
        'set-cookie': 'auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
      });
    }

    // Gate write endpoints
    if (PROTECTED.has(routeKey)) {
      const user = getUser(request);
      if (!user) return err('unauthorized', 401);
    }

    // Public reads
    if (path === 'album' && method === 'GET') {
      const curso = url.searchParams.get('curso');
      if (!curso) return err('curso required');
      return json(await loadMeta(curso));
    }

    if (path === 'photo' && method === 'GET') {
      const curso = url.searchParams.get('curso');
      const pos = parseInt(url.searchParams.get('position'));
      if (!curso || Number.isNaN(pos)) return err('curso and position required');
      const { photos } = stores();
      const result = await photos.getWithMetadata(`photo:${curso}:${pos}`, { type: 'arrayBuffer' });
      if (!result) return new Response('not found', { status: 404 });
      return new Response(result.data, {
        status: 200,
        headers: {
          'content-type': result.metadata?.contentType || 'image/jpeg',
          'cache-control': 'private, max-age=30'
        }
      });
    }

    // Protected writes
    if (path === 'photo' && method === 'POST') {
      const form = await request.formData();
      const curso = form.get('curso');
      const pos = parseInt(form.get('position'));
      const file = form.get('file');
      if (!curso || Number.isNaN(pos) || !file) return err('curso, position and file required');

      const buffer = await file.arrayBuffer();
      const contentType = file.type || 'image/jpeg';
      const { photos } = stores();
      await photos.set(`photo:${curso}:${pos}`, buffer, { metadata: { contentType } });

      const meta = await loadMeta(curso);
      ensureSize(meta, pos);
      meta.slots[pos].hasPhoto = true;
      meta.slots[pos].contentType = contentType;
      const fallbackName = String(form.get('fallbackName') || '').trim();
      if (fallbackName && !meta.slots[pos].name) {
        meta.slots[pos].name = fallbackName;
      }
      await saveMeta(curso, meta);
      return json({ ok: true, slot: meta.slots[pos], size: meta.size });
    }

    if (path === 'photo' && method === 'DELETE') {
      const curso = url.searchParams.get('curso');
      const pos = parseInt(url.searchParams.get('position'));
      if (!curso || Number.isNaN(pos)) return err('curso and position required');
      const { photos } = stores();
      await photos.delete(`photo:${curso}:${pos}`);
      const meta = await loadMeta(curso);
      if (meta.slots[pos]) {
        meta.slots[pos].hasPhoto = false;
        meta.slots[pos].contentType = null;
      }
      await saveMeta(curso, meta);
      return json({ ok: true });
    }

    if (path === 'info' && method === 'POST') {
      const body = await request.json();
      const { curso, position, name, rut } = body;
      if (!curso || typeof position !== 'number') return err('curso and position required');
      const meta = await loadMeta(curso);
      ensureSize(meta, position);
      if (name !== undefined) meta.slots[position].name = String(name).trim();
      if (rut !== undefined) meta.slots[position].rut = String(rut).trim();
      await saveMeta(curso, meta);
      return json({ ok: true, slot: meta.slots[position] });
    }

    if (path === 'bulk-info' && method === 'POST') {
      const body = await request.json();
      const { curso, slots } = body;
      if (!curso || !Array.isArray(slots)) return err('curso and slots[] required');
      const meta = await loadMeta(curso);
      for (const s of slots) {
        if (typeof s.position !== 'number') continue;
        ensureSize(meta, s.position);
        if (s.name !== undefined) meta.slots[s.position].name = String(s.name).trim();
        if (s.rut !== undefined) meta.slots[s.position].rut = String(s.rut).trim();
      }
      await saveMeta(curso, meta);
      return json({ ok: true, size: meta.size, slots: meta.slots });
    }

    if (path === 'expand' && method === 'POST') {
      const body = await request.json();
      const { curso } = body;
      if (!curso) return err('curso required');
      const meta = await loadMeta(curso);
      meta.slots.push(emptySlot());
      meta.size = meta.slots.length;
      await saveMeta(curso, meta);
      return json({ ok: true, size: meta.size });
    }

    if (path === 'shrink' && method === 'POST') {
      const body = await request.json();
      const { curso } = body;
      if (!curso) return err('curso required');
      const meta = await loadMeta(curso);
      if (meta.slots.length <= DEFAULT_SIZE) return json({ ok: true, size: meta.size });
      const last = meta.slots.length - 1;
      const slot = meta.slots[last];
      if (slot && slot.hasPhoto) {
        const { photos } = stores();
        await photos.delete(`photo:${curso}:${last}`);
      }
      meta.slots.pop();
      meta.size = meta.slots.length;
      await saveMeta(curso, meta);
      return json({ ok: true, size: meta.size });
    }

    return err('not found', 404);
  } catch (e) {
    console.error(e);
    return err(e.message || 'server error', 500);
  }
};

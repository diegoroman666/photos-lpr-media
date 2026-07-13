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
    '/api/delete-slot',
    '/api/trash',
    '/api/trash-photo',
    '/api/trash-restore',
    '/api/trash-delete',
    '/api/settings',
    '/api/logo',
    '/api/login',
    '/api/logout',
    '/api/me'
  ]
};

const DEFAULT_SIZE = 49;
const META_STORE = 'album-meta';
const PHOTO_STORE = 'album-photos';
const SESSION_DAYS = 7;

const COURSE_SECTIONS = {
  '1A': 'media', '1B': 'media', '1C': 'media',
  '2A': 'media', '2B': 'media', '2C': 'media',
  '3A': 'media', '3B': 'media', '3C': 'media',
  '4A': 'media', '4B': 'media',
  'KINDER': 'basica',
  'B1': 'basica', 'B2': 'basica', 'B3': 'basica', 'B4': 'basica',
  'B5': 'basica', 'B6': 'basica', 'B7': 'basica', 'B8': 'basica'
};

const stores = () => ({
  meta: getStore(META_STORE),
  photos: getStore(PHOTO_STORE)
});

const emptySlot = () => ({ name: '', rut: '', hasPhoto: false, contentType: null, photoUpdatedAt: 0, photoPositionX: 50, photoPositionY: 50, photoScale: 1 });

async function loadMeta(curso) {
  const { meta, photos } = stores();
  const raw = await meta.get(`meta:${curso}`, { type: 'json' });
  const data = (raw && Array.isArray(raw.slots))
    ? raw
    : { size: DEFAULT_SIZE, slots: Array.from({ length: DEFAULT_SIZE }, emptySlot) };

  // Reconciliación: la fuente de verdad de "tiene foto" es el blob store, no el meta.
  // Esto repara cualquier desincronización por race condition en uploads concurrentes
  // (el último saveMeta puede pisar el hasPhoto de un slot anterior, pero el blob queda).
  let modified = false;
  try {
    const list = await photos.list({ prefix: `photo:${curso}:` });
    const existing = new Set();
    for (const b of (list.blobs || [])) {
      const m = b.key.match(new RegExp(`^photo:${curso.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:(\\d+)$`));
      if (m) existing.add(parseInt(m[1], 10));
    }
    // Marcar como hasPhoto=true cualquier slot con blob existente
    for (const pos of existing) {
      while (data.slots.length <= pos) { data.slots.push(emptySlot()); modified = true; }
      if (!data.slots[pos].hasPhoto) {
        data.slots[pos].hasPhoto = true;
        if (!data.slots[pos].photoUpdatedAt) data.slots[pos].photoUpdatedAt = Date.now();
        modified = true;
      }
    }
    // Si meta dice hasPhoto=true pero el blob no existe, corregir
    for (let i = 0; i < data.slots.length; i++) {
      if (data.slots[i].hasPhoto && !existing.has(i)) {
        data.slots[i].hasPhoto = false;
        data.slots[i].contentType = null;
        modified = true;
      }
    }
    data.size = data.slots.length;
  } catch (e) {
    // Si list() falla, devolvemos el meta tal cual; mejor que romper el GET completo.
    console.error('reconcile photos failed:', e?.message);
  }

  if (modified) {
    try { await meta.setJSON(`meta:${curso}`, data); } catch (e) { console.error('persist reconciled meta:', e?.message); }
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

// ---------- TRASH (papelera / historial de restauración) ----------
// Al eliminar una foto o un cuadro completo, guardamos una copia (blob + datos)
// en la papelera para poder restaurarla desde el "Historial". El índice vive en
// el meta store bajo `trash:${curso}` y los blobs bajo `trash:photo:${curso}:${id}`.

const MAX_TRASH = 100;

async function loadTrash(curso) {
  const { meta } = stores();
  const raw = await meta.get(`trash:${curso}`, { type: 'json' }).catch(() => null);
  return (raw && Array.isArray(raw.items)) ? raw : { items: [] };
}

async function saveTrash(curso, data) {
  const { meta } = stores();
  await meta.setJSON(`trash:${curso}`, data);
}

// Archiva un slot (con su foto si tiene) en la papelera. Debe llamarse ANTES de
// borrar el blob original, porque lee la foto desde `photo:${curso}:${position}`.
async function archiveSlot(curso, slot, position, type) {
  const { photos } = stores();
  const id = crypto.randomUUID();
  const entry = {
    id,
    type, // 'photo' (solo se borró la foto) | 'slot' (se borró el cuadro completo)
    deletedAt: Date.now(),
    originalPosition: position,
    name: slot?.name || '',
    rut: slot?.rut || '',
    hasPhoto: false,
    contentType: null,
    photoPositionX: typeof slot?.photoPositionX === 'number' ? slot.photoPositionX : 50,
    photoPositionY: typeof slot?.photoPositionY === 'number' ? slot.photoPositionY : 50,
    photoScale: typeof slot?.photoScale === 'number' ? slot.photoScale : 1
  };

  if (slot?.hasPhoto) {
    try {
      const result = await photos.getWithMetadata(`photo:${curso}:${position}`, { type: 'arrayBuffer' });
      if (result) {
        await photos.set(`trash:photo:${curso}:${id}`, result.data, { metadata: result.metadata });
        entry.hasPhoto = true;
        entry.contentType = result.metadata?.contentType || slot.contentType || 'image/jpeg';
      }
    } catch (e) {
      console.error('archive photo failed:', e?.message);
    }
  }

  const trash = await loadTrash(curso);
  trash.items.unshift(entry);
  // Cap: descartar las entradas más antiguas (y sus blobs) si excedemos el límite.
  while (trash.items.length > MAX_TRASH) {
    const removed = trash.items.pop();
    if (removed?.hasPhoto) {
      try { await photos.delete(`trash:photo:${curso}:${removed.id}`); } catch {}
    }
  }
  await saveTrash(curso, trash);
  return entry;
}

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

function loadUsers() {
  const raw = process.env.AUTH_USERS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(u => u && u.user && u.pass && Array.isArray(u.sections));
  } catch {
    return [];
  }
}

function findUser(username) {
  return loadUsers().find(u => u.user === username) || null;
}

function getUser(request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const cookies = parseCookies(request);
  const payload = verifyToken(cookies.auth, secret);
  if (!payload) return null;
  const u = findUser(payload.u);
  if (!u) return null;
  return { user: u.user, sections: u.sections };
}

function timingSafeStrEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const bh = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

function authCookie(token, maxAgeSec) {
  return [
    `auth=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ].join('; ');
}

function userCanAccessCurso(user, curso) {
  const sec = COURSE_SECTIONS[curso];
  if (!sec) return false;
  return user.sections.includes(sec);
}

// ---------- HELPERS ----------

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
  });

const err = (msg, status = 400) => json({ error: msg }, status);

// ---------- ROUTER ----------

export default async (request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const method = request.method;

  try {
    // --- Public auth-related endpoints ---
    if (path === 'me' && method === 'GET') {
      const user = getUser(request);
      if (!user) return json({ user: null, sections: [] });
      return json({ user: user.user, sections: user.sections });
    }

    if (path === 'login' && method === 'POST') {
      const secret = process.env.AUTH_SECRET;
      if (!secret) return err('auth not configured', 500);
      const body = await request.json().catch(() => ({}));
      const username = String(body.user || '').trim();
      const password = String(body.password || '');
      const u = findUser(username);
      // Always run timingSafeStrEqual on something to keep timing similar
      const passOk = u ? timingSafeStrEqual(password, u.pass) : timingSafeStrEqual(password, 'x');
      if (!u || !passOk) return err('credenciales inválidas', 401);
      const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
      const token = signToken({ u: u.user, exp }, secret);
      return json({ ok: true, user: u.user, sections: u.sections }, 200, {
        'set-cookie': authCookie(token, SESSION_DAYS * 86400)
      });
    }

    if (path === 'logout' && method === 'POST') {
      return json({ ok: true }, 200, {
        'set-cookie': 'auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
      });
    }

    // --- Everything below requires auth ---
    const user = getUser(request);
    if (!user) return err('unauthorized', 401);

    // For curso-related endpoints, check section access
    const cursoFromQuery = url.searchParams.get('curso');
    let cursoFromBody = null;
    let parsedBody = null;
    let parsedForm = null;

    if (path === 'album' && method === 'GET') {
      const curso = cursoFromQuery;
      if (!curso) return err('curso required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      return json(await loadMeta(curso));
    }

    if (path === 'photo' && method === 'GET') {
      const curso = cursoFromQuery;
      const pos = parseInt(url.searchParams.get('position'));
      if (!curso || Number.isNaN(pos)) return err('curso and position required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const { photos } = stores();
      const result = await photos.getWithMetadata(`photo:${curso}:${pos}`, { type: 'arrayBuffer' });
      if (!result) return new Response('not found', { status: 404 });
      return new Response(result.data, {
        status: 200,
        headers: {
          'content-type': result.metadata?.contentType || 'image/jpeg',
          // URL viene versionada con ?v=<photoUpdatedAt>; al cambiar la foto cambia el timestamp y la URL.
          // Esto permite caché agresivo del navegador sin riesgo de servir imágenes viejas.
          'cache-control': 'public, max-age=2592000'
        }
      });
    }

    if (path === 'photo' && method === 'POST') {
      parsedForm = await request.formData();
      const curso = parsedForm.get('curso');
      const pos = parseInt(parsedForm.get('position'));
      const file = parsedForm.get('file');
      if (!curso || Number.isNaN(pos) || !file) return err('curso, position and file required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);

      const buffer = await file.arrayBuffer();
      const contentType = file.type || 'image/jpeg';
      const { photos } = stores();
      await photos.set(`photo:${curso}:${pos}`, buffer, { metadata: { contentType } });

      const meta = await loadMeta(curso);
      ensureSize(meta, pos);
      meta.slots[pos].hasPhoto = true;
      meta.slots[pos].contentType = contentType;
      meta.slots[pos].photoUpdatedAt = Date.now();
      const fallbackName = String(parsedForm.get('fallbackName') || '').trim();
      if (fallbackName && !meta.slots[pos].name) {
        meta.slots[pos].name = fallbackName;
      }
      await saveMeta(curso, meta);
      return json({ ok: true, slot: meta.slots[pos], size: meta.size });
    }

    if (path === 'photo' && method === 'DELETE') {
      const curso = cursoFromQuery;
      const pos = parseInt(url.searchParams.get('position'));
      if (!curso || Number.isNaN(pos)) return err('curso and position required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const meta = await loadMeta(curso);
      // Archivar en la papelera antes de borrar (para poder restaurar).
      if (meta.slots[pos]) await archiveSlot(curso, meta.slots[pos], pos, 'photo');
      const { photos } = stores();
      await photos.delete(`photo:${curso}:${pos}`);
      if (meta.slots[pos]) {
        meta.slots[pos].hasPhoto = false;
        meta.slots[pos].contentType = null;
      }
      await saveMeta(curso, meta);
      return json({ ok: true });
    }

    if (path === 'info' && method === 'POST') {
      parsedBody = await request.json();
      const { curso, position, name, rut } = parsedBody;
      if (!curso || typeof position !== 'number') return err('curso and position required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const meta = await loadMeta(curso);
      ensureSize(meta, position);
      if (name !== undefined) meta.slots[position].name = String(name).trim();
      if (rut !== undefined) meta.slots[position].rut = String(rut).trim();
      if (typeof parsedBody.photoPositionX === 'number') meta.slots[position].photoPositionX = Math.max(0, Math.min(100, parsedBody.photoPositionX));
      if (typeof parsedBody.photoPositionY === 'number') meta.slots[position].photoPositionY = Math.max(0, Math.min(100, parsedBody.photoPositionY));
      if (typeof parsedBody.photoScale === 'number') meta.slots[position].photoScale = Math.max(1, Math.min(3, parsedBody.photoScale));
      await saveMeta(curso, meta);
      return json({ ok: true, slot: meta.slots[position] });
    }

    if (path === 'bulk-info' && method === 'POST') {
      parsedBody = await request.json();
      const { curso, slots } = parsedBody;
      if (!curso || !Array.isArray(slots)) return err('curso and slots[] required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
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
      parsedBody = await request.json();
      const { curso } = parsedBody;
      if (!curso) return err('curso required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const meta = await loadMeta(curso);
      meta.slots.push(emptySlot());
      meta.size = meta.slots.length;
      await saveMeta(curso, meta);
      return json({ ok: true, size: meta.size });
    }

    if (path === 'delete-slot' && method === 'POST') {
      parsedBody = await request.json();
      const { curso, position } = parsedBody;
      if (!curso || typeof position !== 'number') return err('curso and position required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const meta = await loadMeta(curso);
      if (position < 0 || position >= meta.slots.length) return err('invalid position');

      // Archivar el cuadro (con su foto) en la papelera antes de eliminarlo.
      await archiveSlot(curso, meta.slots[position], position, 'slot');

      const { photos } = stores();
      if (meta.slots[position].hasPhoto) {
        try { await photos.delete(`photo:${curso}:${position}`); } catch {}
      }
      // Shift subsequent photo blobs one position back (sequential to avoid race)
      for (let i = position + 1; i < meta.slots.length; i++) {
        if (meta.slots[i].hasPhoto) {
          try {
            const result = await photos.getWithMetadata(`photo:${curso}:${i}`, { type: 'arrayBuffer' });
            if (result) {
              await photos.set(`photo:${curso}:${i - 1}`, result.data, { metadata: result.metadata });
              await photos.delete(`photo:${curso}:${i}`);
            }
          } catch (e) {
            console.error(`move blob ${i}→${i - 1}:`, e?.message);
          }
        }
      }
      meta.slots.splice(position, 1);
      meta.size = meta.slots.length;
      await saveMeta(curso, meta);
      return json({ ok: true, size: meta.size, slots: meta.slots });
    }

    if (path === 'shrink' && method === 'POST') {
      parsedBody = await request.json();
      const { curso } = parsedBody;
      if (!curso) return err('curso required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
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

    if (path === 'trash' && method === 'GET') {
      const curso = cursoFromQuery;
      if (!curso) return err('curso required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const trash = await loadTrash(curso);
      // Solo metadatos; las miniaturas se piden aparte vía /api/trash-photo.
      const items = trash.items.map(it => ({
        id: it.id,
        type: it.type,
        deletedAt: it.deletedAt,
        originalPosition: it.originalPosition,
        name: it.name,
        rut: it.rut,
        hasPhoto: !!it.hasPhoto
      }));
      return json({ items });
    }

    if (path === 'trash-photo' && method === 'GET') {
      const curso = cursoFromQuery;
      const id = url.searchParams.get('id');
      if (!curso || !id) return err('curso and id required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const { photos } = stores();
      const result = await photos.getWithMetadata(`trash:photo:${curso}:${id}`, { type: 'arrayBuffer' }).catch(() => null);
      if (!result) return new Response('not found', { status: 404 });
      return new Response(result.data, {
        status: 200,
        headers: {
          'content-type': result.metadata?.contentType || 'image/jpeg',
          'cache-control': 'public, max-age=2592000'
        }
      });
    }

    if (path === 'trash-restore' && method === 'POST') {
      parsedBody = await request.json();
      const { curso, id } = parsedBody;
      if (!curso || !id) return err('curso and id required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const trash = await loadTrash(curso);
      const idx = trash.items.findIndex(it => it.id === id);
      if (idx === -1) return err('not found', 404);
      const entry = trash.items[idx];

      // Restaurar el cuadro con su nombre, RUT y foto en su POSICIÓN ORIGINAL
      // (inverso de delete-slot). Si la posición ya no existe, se agrega al final.
      const meta = await loadMeta(curso);
      const slot = emptySlot();
      slot.name = entry.name || '';
      slot.rut = entry.rut || '';
      slot.photoPositionX = typeof entry.photoPositionX === 'number' ? entry.photoPositionX : 50;
      slot.photoPositionY = typeof entry.photoPositionY === 'number' ? entry.photoPositionY : 50;
      slot.photoScale = typeof entry.photoScale === 'number' ? entry.photoScale : 1;

      const target = Math.max(0, Math.min(
        typeof entry.originalPosition === 'number' ? entry.originalPosition : meta.slots.length,
        meta.slots.length
      ));

      const { photos } = stores();
      // Hacer espacio: correr las fotos existentes desde el final hasta `target`
      // una posición hacia adelante (de mayor a menor para no pisar).
      for (let i = meta.slots.length - 1; i >= target; i--) {
        if (meta.slots[i].hasPhoto) {
          try {
            const r = await photos.getWithMetadata(`photo:${curso}:${i}`, { type: 'arrayBuffer' });
            if (r) {
              await photos.set(`photo:${curso}:${i + 1}`, r.data, { metadata: r.metadata });
              await photos.delete(`photo:${curso}:${i}`);
            }
          } catch (e) {
            console.error(`restore shift blob ${i}→${i + 1}:`, e?.message);
          }
        }
      }

      // Colocar la foto archivada en la posición destino.
      if (entry.hasPhoto) {
        try {
          const result = await photos.getWithMetadata(`trash:photo:${curso}:${id}`, { type: 'arrayBuffer' });
          if (result) {
            await photos.set(`photo:${curso}:${target}`, result.data, { metadata: result.metadata });
            slot.hasPhoto = true;
            slot.contentType = result.metadata?.contentType || entry.contentType || 'image/jpeg';
            slot.photoUpdatedAt = Date.now();
          }
        } catch (e) {
          console.error('restore photo failed:', e?.message);
        }
      }

      meta.slots.splice(target, 0, slot);
      meta.size = meta.slots.length;
      await saveMeta(curso, meta);

      // Quitar de la papelera y borrar el blob archivado.
      if (entry.hasPhoto) { try { await photos.delete(`trash:photo:${curso}:${id}`); } catch {} }
      trash.items.splice(idx, 1);
      await saveTrash(curso, trash);
      return json({ ok: true, position: target, slot, size: meta.size });
    }

    if (path === 'trash-delete' && method === 'POST') {
      parsedBody = await request.json();
      const { curso, id } = parsedBody;
      if (!curso || !id) return err('curso and id required');
      if (!userCanAccessCurso(user, curso)) return err('forbidden', 403);
      const trash = await loadTrash(curso);
      const idx = trash.items.findIndex(it => it.id === id);
      if (idx === -1) return json({ ok: true }); // ya no existe: idempotente
      const entry = trash.items[idx];
      if (entry.hasPhoto) {
        const { photos } = stores();
        try { await photos.delete(`trash:photo:${curso}:${id}`); } catch {}
      }
      trash.items.splice(idx, 1);
      await saveTrash(curso, trash);
      return json({ ok: true });
    }

    if (path === 'settings' && method === 'GET') {
      const { meta } = stores();
      const raw = await meta.get('meta:settings', { type: 'json' }).catch(() => null);
      return json({ schoolName: raw?.schoolName || '', logoUpdatedAt: raw?.logoUpdatedAt || 0 });
    }

    if (path === 'settings' && method === 'POST') {
      parsedBody = await request.json();
      const { meta } = stores();
      const current = await meta.get('meta:settings', { type: 'json' }).catch(() => ({}));
      const updated = { ...(current || {}), schoolName: String(parsedBody.schoolName || '').trim() };
      await meta.setJSON('meta:settings', updated);
      return json({ ok: true, schoolName: updated.schoolName });
    }

    if (path === 'logo' && method === 'GET') {
      const { photos } = stores();
      const result = await photos.getWithMetadata('logo:school', { type: 'arrayBuffer' }).catch(() => null);
      if (!result) return new Response('not found', { status: 404 });
      return new Response(result.data, {
        status: 200,
        headers: { 'content-type': result.metadata?.contentType || 'image/png', 'cache-control': 'public, max-age=3600' }
      });
    }

    if (path === 'logo' && method === 'POST') {
      parsedForm = await request.formData();
      const file = parsedForm.get('file');
      if (!file) return err('file required');
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > 500 * 1024) return err('Logo demasiado grande (máx 500 KB)');
      const contentType = file.type || 'image/png';
      const { photos, meta } = stores();
      await photos.set('logo:school', buffer, { metadata: { contentType } });
      const current = await meta.get('meta:settings', { type: 'json' }).catch(() => ({}));
      const logoUpdatedAt = Date.now();
      await meta.setJSON('meta:settings', { ...(current || {}), logoUpdatedAt });
      return json({ ok: true, logoUpdatedAt });
    }

    if (path === 'logo' && method === 'DELETE') {
      const { photos, meta } = stores();
      await photos.delete('logo:school').catch(() => {});
      const current = await meta.get('meta:settings', { type: 'json' }).catch(() => ({}));
      await meta.setJSON('meta:settings', { ...(current || {}), logoUpdatedAt: 0 });
      return json({ ok: true });
    }

    return err('not found', 404);
  } catch (e) {
    console.error(e);
    return err(e.message || 'server error', 500);
  }
};

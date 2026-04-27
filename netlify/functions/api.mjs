import { getStore } from '@netlify/blobs';

export const config = {
  path: [
    '/api/album',
    '/api/photo',
    '/api/info',
    '/api/bulk-info',
    '/api/expand',
    '/api/shrink'
  ]
};

const DEFAULT_SIZE = 49;
const META_STORE = 'album-meta';
const PHOTO_STORE = 'album-photos';

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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });

const err = (msg, status = 400) => json({ error: msg }, status);

export default async (request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const method = request.method;

  try {
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

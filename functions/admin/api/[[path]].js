// Admin API. Lives under /admin/, which Cloudflare Access protects with a login.
// Access is NOT trusted blindly: every request must also carry a valid Access
// token (JWT) that is verified here against Cloudflare's public keys.
// If the settings below are missing, every request is refused (fails closed).
//
// Needed in Cloudflare (Pages project -> Settings):
//   KV binding   FA_KV            (the storage)
//   Variable     ACCESS_TEAM      (your Zero Trust team name, e.g. "myteam")
//   Variable     ACCESS_AUD       (the Application Audience tag of the Access app)
//   Variable     ADMIN_EMAILS     (optional, comma list; extra safety check)

const H = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: H });

const MAX_HISTORY = 20;

/* ---------- Access token check ---------- */
let certCache = { at: 0, keys: null, team: '' };

function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const b64uToJson = (s) => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));

async function getKeys(team) {
  const now = Date.now();
  if (certCache.keys && certCache.team === team && now - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('certs');
  const j = await r.json();
  certCache = { at: now, keys: j.keys || [], team };
  return certCache.keys;
}

// returns the signed-in email, or null
async function whoIsThis(request, env) {
  try {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || !env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = b64uToJson(parts[0]);
    const payload = b64uToJson(parts[1]);
    if (header.alg !== 'RS256') return null;
    const keys = await getKeys(env.ACCESS_TEAM);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64uToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1])
    );
    if (!ok) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (payload.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    const email = String(payload.email || '').toLowerCase();
    if (!email) return null;
    if (env.ADMIN_EMAILS) {
      const allow = env.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (allow.length && !allow.includes(email)) return null;
    }
    return email;
  } catch (_) {
    return null;
  }
}

/* ---------- helpers ---------- */
function validConfig(c) {
  return c && typeof c === 'object' && Array.isArray(c.inputs) && Array.isArray(c.outputs) && Array.isArray(c.rules);
}

function trimAssets(assets, keep) {
  const o = {};
  (keep || []).forEach((id) => {
    if (assets && assets[id]) o[id] = assets[id];
  });
  return o;
}

async function readBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error('json only');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new Error('bad origin');
  const text = await request.text();
  if (text.length > 20 * 1024 * 1024) throw new Error('too large');
  return JSON.parse(text);
}

async function histIndex(kv) {
  return (await kv.get('hist-index', 'json')) || [];
}

async function pushHistory(kv, pub, by) {
  await kv.put('hist:' + pub.rev, JSON.stringify(pub));
  let idx = await histIndex(kv);
  idx.unshift({ rev: pub.rev, at: pub.at, by });
  const drop = idx.slice(MAX_HISTORY);
  idx = idx.slice(0, MAX_HISTORY);
  await kv.put('hist-index', JSON.stringify(idx));
  for (const d of drop) await kv.delete('hist:' + d.rev);
}

/* ---------- routes ---------- */
export async function onRequest({ request, env, params }) {
  if (!env.FA_KV) return out({ error: 'Storage (FA_KV) is not set up yet.' }, 503);
  const email = await whoIsThis(request, env);
  if (!email) return out({ error: 'Not signed in as an admin.' }, 401);

  const kv = env.FA_KV;
  const path = '/' + [].concat(params.path || []).join('/');
  const method = request.method;

  try {
    // whole picture for the admin page
    if (path === '/state' && method === 'GET') {
      const [published, draft, history] = await Promise.all([kv.get('published', 'json'), kv.get('draft', 'json'), histIndex(kv)]);
      return out({
        email,
        published: published || null,
        draft: draft || null,
        drev: draft ? draft.drev : 0,
        history,
      });
    }

    // save the DRAFT (nothing visible to visitors yet)
    if (path === '/draft' && method === 'POST') {
      const b = await readBody(request);
      if (!validConfig(b.config)) return out({ error: 'config looks wrong' }, 400);
      const cur = await kv.get('draft', 'json');
      const curRev = cur ? cur.drev : 0;
      if ((b.drev || 0) !== curRev) return out({ error: 'conflict', drev: curRev }, 409);
      // keep assets from the last draft that are still used + the new ones
      const pool = Object.assign({}, cur ? cur.assets : {}, b.assets || {});
      const pub = await kv.get('published', 'json');
      Object.assign(pool, pub && pub.assets && !cur ? pub.assets : {});
      const draft = {
        drev: curRev + 1,
        config: b.config,
        assets: trimAssets(pool, b.keep),
        at: new Date().toISOString(),
        by: email,
      };
      await kv.put('draft', JSON.stringify(draft));
      return out({ ok: true, drev: draft.drev });
    }

    // PUBLISH the draft to everyone
    if (path === '/publish' && method === 'POST') {
      const b = await readBody(request);
      const draft = await kv.get('draft', 'json');
      if (!draft) return out({ error: 'There is no draft to publish.' }, 400);
      if ((b.drev || 0) !== draft.drev) return out({ error: 'conflict', drev: draft.drev }, 409);
      const cur = await kv.get('published', 'json');
      const pub = {
        rev: (cur ? cur.rev : 0) + 1,
        config: draft.config,
        assets: draft.assets || {},
        at: new Date().toISOString(),
        by: email,
      };
      await kv.put('published', JSON.stringify(pub));
      await pushHistory(kv, pub, email);
      return out({ ok: true, rev: pub.rev });
    }

    // put an older published version back into the DRAFT
    if (path === '/restore' && method === 'POST') {
      const b = await readBody(request);
      const old = await kv.get('hist:' + Number(b.rev), 'json');
      if (!old) return out({ error: 'that version is no longer stored' }, 404);
      const cur = await kv.get('draft', 'json');
      const draft = {
        drev: (cur ? cur.drev : 0) + 1,
        config: old.config,
        assets: old.assets || {},
        at: new Date().toISOString(),
        by: email,
      };
      await kv.put('draft', JSON.stringify(draft));
      return out({ ok: true, drev: draft.drev });
    }

    // throw the draft away: start again from what is published
    if (path === '/discard' && method === 'POST') {
      await readBody(request);
      await kv.delete('draft');
      return out({ ok: true });
    }

    return out({ error: 'not found' }, 404);
  } catch (e) {
    return out({ error: String((e && e.message) || e) }, 400);
  }
}

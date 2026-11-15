// Public, read-only address. Everyone can read the PUBLISHED setup.
// Writing is NOT possible here: all changes go through /admin/api/* which is
// protected by Cloudflare Access and re-checked on the server.

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export async function onRequestGet({ env }) {
  if (!env.FA_KV) {
    return new Response(JSON.stringify({ config: null, rev: 0, note: 'storage not set up' }), { headers: JSON_HEADERS });
  }
  const pub = await env.FA_KV.get('published', 'json');
  if (!pub) {
    return new Response(JSON.stringify({ config: null, rev: 0 }), { headers: JSON_HEADERS });
  }
  return new Response(
    JSON.stringify({ rev: pub.rev, config: pub.config, assets: pub.assets || {}, publishedAt: pub.at }),
    { headers: JSON_HEADERS }
  );
}

// Anything else (POST, PUT, DELETE ...) is refused.
export async function onRequest() {
  return new Response(JSON.stringify({ error: 'read only. Use the admin page to publish changes.' }), {
    status: 403,
    headers: JSON_HEADERS,
  });
}

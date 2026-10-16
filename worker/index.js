// Cloudflare Worker: relays the label scanner app to the Notion API.
// Secrets (set with `wrangler secret put`): NOTION_TOKEN, APP_KEY.
// The Notion token never reaches the browser; the app authenticates with APP_KEY.

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_REQUESTS = 40; // stay under the per-invocation subrequest limit

// Blocks whose children may contain to-dos
const CONTAINERS = new Set([
  'to_do', 'toggle', 'heading_1', 'heading_2', 'heading_3', 'column_list', 'column',
  'callout', 'quote', 'bulleted_list_item', 'numbered_list_item', 'synced_block',
]);

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!env.NOTION_TOKEN || !env.APP_KEY) return json({ error: 'server not configured' }, 500);
    if (req.headers.get('X-App-Key') !== env.APP_KEY) return json({ error: 'unauthorized' }, 401);

    const url = new URL(req.url);
    const api = makeApi(env);
    try {
      switch (url.pathname) {
        case '/ping':
          return json({ ok: true });
        case '/pages':
          return json(await searchPages(api, url.searchParams.get('q') || ''));
        case '/todos':
          return json(await listTodos(api, pageId(url.searchParams.get('page'))));
        case '/check': {
          if (req.method !== 'POST') break;
          const { blockId, checked } = await req.json();
          await api(`/blocks/${pageId(blockId)}`, { method: 'PATCH', body: { to_do: { checked: !!checked } } });
          return json({ ok: true });
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, e.status || 500);
    }
  },
};

function makeApi(env) {
  let count = 0;
  return async (path, { method = 'GET', body } = {}) => {
    if (++count > MAX_REQUESTS) throw Object.assign(new Error('page too large'), { status: 413 });
    const res = await fetch(NOTION + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.message || `notion ${res.status}`), { status: res.status });
    return data;
  };
}

// Accept a bare id, a dashed uuid, or a full Notion URL
function pageId(raw) {
  const m = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(String(raw || '').replace(/-/g, ''));
  if (!m) throw Object.assign(new Error('invalid id'), { status: 400 });
  return m[1];
}

const plain = (rich) => (rich || []).map((t) => t.plain_text).join('');

async function searchPages(api, query) {
  const data = await api('/search', {
    method: 'POST',
    body: { query, filter: { property: 'object', value: 'page' }, page_size: 30 },
  });
  return data.results.map((p) => {
    const titleProp = Object.values(p.properties || {}).find((v) => v.type === 'title');
    return { id: p.id, title: plain(titleProp?.title) || '(제목 없음)', edited: p.last_edited_time };
  });
}

async function children(api, id) {
  const out = [];
  let cursor;
  do {
    const q = `?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const data = await api(`/blocks/${id}/children${q}`);
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

// Walk the page in order, keeping the latest heading as the section name
async function listTodos(api, id) {
  const todos = [];
  let section = '';
  async function walk(blockId, depth) {
    for (const b of await children(api, blockId)) {
      if (b.type.startsWith('heading_')) section = plain(b[b.type].rich_text);
      if (b.type === 'to_do') {
        todos.push({ id: b.id, text: plain(b.to_do.rich_text), checked: b.to_do.checked, section });
      }
      if (b.has_children && depth < 3 && CONTAINERS.has(b.type)) await walk(b.id, depth + 1);
    }
  }
  await walk(id, 0);
  return todos;
}

/*
  Louby sync service (Cloudflare Worker + Durable Object), served at louby.com/api/sync.

  Every device POSTs everything it has; the service merges it with what it
  already holds and returns the combined result.
  - Shows merge one by one: the most recently changed copy of each show wins,
    deletions are kept as "tombstones" for 60 days so they reach every device,
    and if two devices add the same show it is folded into a single entry.
  - The wishlist, scratchpad and grocery list merge as whole lists: the most
    recently changed list wins (the same as the old Google Sheet behaviour).

  Requests must carry the household code in the X-Household-Code header.
  The code is stored as the Worker secret HOUSEHOLD_CODE, never in this file.
*/
import { DurableObject } from 'cloudflare:workers';

const LIST_NAMES = ['shop', 'scratch', 'groceries'];
const TOMBSTONE_DAYS = 60;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SHOWS = 3000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function sameCode(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/* The same merge runs in the page (index.html), so devices and the service always agree. */
function showKey(show) {
  return show.tvmazeId ? `tv:${show.tvmazeId}` : `name:${String(show.name || '').trim().toLowerCase()}`;
}

export function mergeShows(a, b) {
  const byId = new Map();
  for (const show of [...(a || []), ...(b || [])]) {
    if (!show || typeof show.id !== 'string') continue;
    const current = byId.get(show.id);
    if (!current || (show.updatedAt || 0) > (current.updatedAt || 0)) byId.set(show.id, show);
  }

  // One entry per show: the earliest-added copy keeps its place, and takes
  // the details of whichever copy was changed most recently.
  const kept = new Map();
  const live = [...byId.values()]
    .filter(s => !s.deleted)
    .sort((x, y) => (x.addedAt || 0) - (y.addedAt || 0) || x.id.localeCompare(y.id));
  for (const show of live) {
    const key = showKey(show);
    const first = kept.get(key);
    if (!first) { kept.set(key, show); continue; }
    if ((show.updatedAt || 0) > (first.updatedAt || 0)) {
      const merged = Object.assign({}, show, { id: first.id, addedAt: first.addedAt });
      kept.set(key, merged);
      byId.set(first.id, merged);
    }
    byId.set(show.id, { id: show.id, deleted: true, updatedAt: Math.max(show.updatedAt || 0, first.updatedAt || 0) + 1 });
  }

  const cutoff = Date.now() - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000;
  return [...byId.values()].filter(s => !s.deleted || (s.updatedAt || 0) > cutoff);
}

export function mergeLists(a, b) {
  const out = Object.assign({}, a);
  for (const name of LIST_NAMES) {
    const list = b && b[name];
    if (!list || !Array.isArray(list.items)) continue;
    if (!out[name] || (list.updatedAt || 0) > (out[name].updatedAt || 0)) {
      out[name] = { items: list.items, updatedAt: list.updatedAt || 0 };
    }
  }
  return out;
}

export class Household extends DurableObject {
  async fetch(request) {
    let state = (await this.ctx.storage.get('state')) || { shows: [], lists: {} };

    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Bad request' }, 400); }
      const shows = Array.isArray(body && body.shows) ? body.shows.slice(0, MAX_SHOWS) : [];
      const next = {
        shows: mergeShows(state.shows, shows),
        lists: mergeLists(state.lists, body && body.lists)
      };
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        state = next;
        await this.ctx.storage.put('state', state);
      }
    } else if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }

    return json(state);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/sync') return json({ error: 'Not found' }, 404);

    if (!env.HOUSEHOLD_CODE || !sameCode(request.headers.get('X-Household-Code'), env.HOUSEHOLD_CODE)) {
      return json({ error: 'Wrong household code' }, 401);
    }
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) {
      return json({ error: 'Too large' }, 413);
    }

    const household = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName('louby'));
    return household.fetch(request);
  }
};

// leaderboard.js: a shared top-10 per game and flight, stored in a Supabase table through its REST API.
// It stays hidden until game/leaderboard-config.js has a project URL and its public "anon" key (see README).
import { LEADERBOARD } from './leaderboard-config.js';

const ON = !!(LEADERBOARD.url && LEADERBOARD.anonKey);
const H = () => ({ apikey: LEADERBOARD.anonKey, Authorization: 'Bearer ' + LEADERBOARD.anonKey, 'Content-Type': 'application/json' });
// a score above these is not from a real run (Murmuration: 25/s in line + fish; Fish Frenzy: generous chain ceiling)
const MAX = { murm: 20000, fish: 60000 };

export const leaderboardOn = ON;

export function cleanName(s) {
  return String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 16);
}

export async function topScores(mode, diff) {
  if (!ON) return [];
  const q = `${LEADERBOARD.url}/rest/v1/${LEADERBOARD.table}?select=name,score,fish,created_at&mode=eq.${mode}&diff=eq.${diff}&order=score.desc&limit=10`;
  const r = await fetch(q, { headers: H() });
  if (!r.ok) throw new Error('leaderboard ' + r.status);
  return r.json();
}

export async function postScore({ name, mode, diff, score, fish, pct }) {
  if (!ON) return false;
  name = cleanName(name);
  if (!name || !(score > 0) || score > MAX[mode]) return false;
  const r = await fetch(`${LEADERBOARD.url}/rest/v1/${LEADERBOARD.table}`, {
    method: 'POST', headers: { ...H(), Prefer: 'return=minimal' },
    body: JSON.stringify({ name, mode, diff, score: Math.round(score), fish: fish | 0, pct: Math.round(pct || 0) }),
  });
  if (!r.ok) throw new Error('leaderboard ' + r.status);
  return true;
}

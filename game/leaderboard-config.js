// Leaderboard switch. Paste your Supabase project URL and its public "anon" key here (Project Settings → API) to turn
// the shared leaderboard on. The anon key is meant to be public; the table's row-level-security policies (README)
// only allow reading and inserting checked rows. Leave both empty to hide the leaderboard.
export const LEADERBOARD = {
  url: '',          // e.g. 'https://abcdefgh.supabase.co'
  anonKey: '',
  table: 'scores',
};

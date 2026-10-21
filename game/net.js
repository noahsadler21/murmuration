// net.js: online Sky Brawl lobbies over WebRTC, using PeerJS and its free public connection broker (0.peerjs.com)
// to find each other. No account or server of our own. The host's browser is the lobby: its peer id is derived from
// a five-letter code, guests connect to it directly, and every message after that goes peer to peer.
// Some networks (strict NATs, some campus or mobile networks) block direct connections; then joining fails.

const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PREFIX = 'onebird-brawl-';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';      // no I or O, to read aloud
export const MAX_HUMANS = 8;

let loading = null;
function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!loading) loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = PEERJS; s.async = true;
    s.onload = () => (window.Peer ? res(window.Peer) : rej(new Error('PeerJS did not load')));
    s.onerror = () => rej(new Error('PeerJS could not be downloaded'));
    document.head.appendChild(s);
  });
  return loading;
}
const code5 = () => Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');

// One lobby, as host or guest. Events (set these): onPlayers(list), onMessage(fromId, msg), onClose(reason), onError(msg)
export class Lobby {
  constructor() { this.peer = null; this.conns = new Map(); this.role = null; this.players = []; this.code = ''; this.myId = ''; }

  async host(name) {
    const Peer = await loadPeer();
    for (let tries = 0; tries < 4; tries++) {
      const code = code5();
      try {
        await this._open(Peer, PREFIX + code);
        this.role = 'host'; this.code = code; this.myId = 'host';
        this.players = [{ id: 'host', name }];
        this.peer.on('connection', (c) => this._guest(c));
        this._emitPlayers();
        return code;
      } catch (e) { if (!/unavailable|taken/i.test(e.message)) throw e; }
    }
    throw new Error('could not reserve a lobby code');
  }

  async join(code, name) {
    const Peer = await loadPeer();
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 5) throw new Error('lobby codes are five letters');
    await this._open(Peer, undefined);
    this.role = 'guest'; this.code = code;
    const c = this.peer.connect(PREFIX + code, { reliable: true, metadata: { name } });
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('no lobby answered with that code')), 9000);
      c.on('open', () => { clearTimeout(to); res(); });
      c.on('error', (e) => { clearTimeout(to); rej(e); });
      this.peer.on('error', (e) => { clearTimeout(to); rej(new Error(e.type === 'peer-unavailable' ? 'no lobby answered with that code' : e.message)); });
    });
    this.myId = 'h:' + this.peer.id;
    this.conns.set('host', c);
    c.on('data', (m) => {
      if (m && m.k === 'lobby') { this.players = m.players; this._emitPlayers(); }
      else if (m && m.k === 'full') { this.close('the lobby is full'); }
      if (this.onMessage) this.onMessage('host', m);
    });
    c.on('close', () => this.close('the host left the lobby'));
    c.send({ k: 'hello', name });
    return code;
  }

  _open(Peer, id) {
    return new Promise((res, rej) => {
      const p = id ? new Peer(id) : new Peer();
      const fail = (e) => { p.destroy(); rej(new Error(e.type === 'unavailable-id' ? 'taken' : e.message || String(e))); };
      p.once('open', () => { p.off('error', fail); this.peer = p; p.on('error', (e) => this.onError && this.onError(e.message || e.type)); res(); });
      p.once('error', fail);
    });
  }

  _guest(c) {
    const id = 'h:' + c.peer;
    c.on('open', () => {
      if (this.players.length >= MAX_HUMANS || this.started) { c.send({ k: 'full' }); setTimeout(() => c.close(), 300); return; }
      this.conns.set(id, c);
    });
    c.on('data', (m) => {
      if (m && m.k === 'hello') {
        const name = String(m.name || 'Guest').slice(0, 16);
        if (!this.players.find((p) => p.id === id)) this.players.push({ id, name });
        this._emitPlayers();
      }
      if (this.onMessage) this.onMessage(id, m);
    });
    c.on('close', () => {
      this.conns.delete(id);
      this.players = this.players.filter((p) => p.id !== id);
      this._emitPlayers();
      if (this.onMessage) this.onMessage(id, { k: 'left' });
    });
  }

  _emitPlayers() {
    if (this.role === 'host') this.broadcast({ k: 'lobby', players: this.players });
    if (this.onPlayers) this.onPlayers(this.players);
  }
  broadcast(m) { for (const c of this.conns.values()) if (c.open) c.send(m); }
  send(m) { const c = this.conns.get('host'); if (c && c.open) c.send(m); }
  close(reason = '') {
    const was = !!this.peer;
    for (const c of this.conns.values()) try { c.close(); } catch (_) { /* gone */ }
    this.conns.clear();
    if (this.peer) try { this.peer.destroy(); } catch (_) { /* gone */ }
    this.peer = null; this.role = null; this.players = []; this.started = false;
    if (was && this.onClose) this.onClose(reason);
  }
}

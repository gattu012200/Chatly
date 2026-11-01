const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- tiny JSON persistence ---------- */
let db = { users: {}, chats: {}, messages: {}, sessions: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(db), (err) => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 200);
}
const uid = () => crypto.randomBytes(8).toString('hex');
const COLORS = ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d', '#a1887f', '#90a4ae'];

/* ---------- auth helpers ---------- */
function hashPw(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}
function normPhone(p) {
  return String(p || '').replace(/[^\d+]/g, '');
}
function publicUser(u) {
  return { id: u.id, phone: u.phone, name: u.name, about: u.about, color: u.color, lastSeen: u.lastSeen, online: online.has(u.id) };
}
function userFromToken(token) {
  const uidv = db.sessions[token];
  return uidv ? db.users[uidv] : null;
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const u = userFromToken(token);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  req.user = u;
  next();
}

/* ---------- presence / sockets ---------- */
const online = new Map(); // userId -> Set<ws>
function sendTo(userId, payload) {
  const set = online.get(userId);
  if (!set) return;
  const s = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(s);
}
function broadcastToChat(chat, payload, exceptUser) {
  for (const m of chat.members) if (m !== exceptUser) sendTo(m, payload);
}
function contactsOf(userId) {
  const s = new Set();
  for (const c of Object.values(db.chats)) if (c.members.includes(userId)) c.members.forEach((m) => m !== userId && s.add(m));
  return s;
}

/* ---------- views ---------- */
function chatView(chat, me) {
  const msgs = db.messages[chat.id] || [];
  const last = msgs[msgs.length - 1] || null;
  const unread = msgs.filter((m) => m.from !== me && !m.deleted && !(m.readBy || []).includes(me)).length;
  let name = chat.name, color = chat.color, other = null;
  if (chat.type === 'dm') {
    const otherId = chat.members.find((m) => m !== me);
    other = db.users[otherId];
    name = other.name; color = other.color;
  }
  return {
    id: chat.id, type: chat.type, name, color, members: chat.members.map((m) => publicUser(db.users[m])),
    other: other ? publicUser(other) : null, createdBy: chat.createdBy, unread,
    last: last ? msgView(last) : null, updatedAt: last ? last.ts : chat.createdAt,
  };
}
function msgView(m) {
  if (m.deleted) return { id: m.id, chatId: m.chatId, from: m.from, ts: m.ts, deleted: true, readBy: m.readBy, deliveredTo: m.deliveredTo };
  return m;
}

/* ---------- tiny http router (no framework needed) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const routes = [];
const app = {};
for (const method of ['get', 'post', 'put']) {
  app[method] = (pattern, ...handlers) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method: method.toUpperCase(), rx, keys, handlers });
  };
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function serveStatic(root, rel, res, extraHeaders) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) { res.statusCode = 403; return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    for (const [k, v] of Object.entries(extraHeaders || {})) res.setHeader(k, v);
    fs.createReadStream(file).pipe(res);
  });
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { res.statusCode = 400; return res.end('Bad request'); }
  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      const m = r.method === req.method && r.rx.exec(pathname);
      if (!m) continue;
      req.params = {}; r.keys.forEach((k, i) => (req.params[k] = m[i + 1]));
      try {
        const raw = req.method === 'GET' ? '' : await readBody(req, 15 * 1024 * 1024);
        try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
      } catch (e) { return res.status(e.code === 413 ? 413 : 400).json({ error: 'Request too large' }); }
      let i = 0;
      const next = () => { const h = r.handlers[i++]; if (h) h(req, res, next); };
      try { return next(); } catch (e) { console.error(e); return res.status(500).json({ error: 'Server error' }); }
    }
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
  if (pathname.startsWith('/uploads/')) return serveStatic(UPLOAD_DIR, pathname.slice(9), res, { 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  return serveStatic(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1), res);
});

app.post('/api/register', (req, res) => {
  const phone = normPhone(req.body.phone);
  const name = String(req.body.name || '').trim().slice(0, 40);
  const password = String(req.body.password || '');
  if (phone.length < 6) return res.status(400).json({ error: 'Enter a valid phone number' });
  if (!name) return res.status(400).json({ error: 'Enter your name' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (Object.values(db.users).some((u) => u.phone === phone)) return res.status(409).json({ error: 'That number is already registered' });
  const salt = crypto.randomBytes(8).toString('hex');
  const user = { id: uid(), phone, name, about: 'Hey there! I am using Chatly.', color: COLORS[Math.floor(Math.random() * COLORS.length)], salt, hash: hashPw(password, salt), lastSeen: Date.now() };
  db.users[user.id] = user;
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = user.id;
  save();
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const phone = normPhone(req.body.phone);
  const u = Object.values(db.users).find((x) => x.phone === phone);
  if (!u || hashPw(String(req.body.password || ''), u.salt) !== u.hash) return res.status(401).json({ error: 'Wrong number or password' });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = u.id;
  save();
  res.json({ token, user: publicUser(u) });
});

app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[(req.headers.authorization || '').replace('Bearer ', '')];
  save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.put('/api/me', auth, (req, res) => {
  if (typeof req.body.name === 'string' && req.body.name.trim()) req.user.name = req.body.name.trim().slice(0, 40);
  if (typeof req.body.about === 'string') req.user.about = req.body.about.trim().slice(0, 140);
  save();
  for (const c of contactsOf(req.user.id)) sendTo(c, { type: 'user', user: publicUser(req.user) });
  res.json({ user: publicUser(req.user) });
});

app.get('/api/chats', auth, (req, res) => {
  const list = Object.values(db.chats).filter((c) => c.members.includes(req.user.id)).map((c) => chatView(c, req.user.id));
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ chats: list });
});

app.post('/api/chats/dm', auth, (req, res) => {
  const phone = normPhone(req.body.phone);
  const other = Object.values(db.users).find((u) => u.phone === phone);
  if (!other) return res.status(404).json({ error: 'No Chatly user with that number' });
  if (other.id === req.user.id) return res.status(400).json({ error: "That's your own number" });
  let chat = Object.values(db.chats).find((c) => c.type === 'dm' && c.members.includes(req.user.id) && c.members.includes(other.id));
  if (!chat) {
    chat = { id: uid(), type: 'dm', members: [req.user.id, other.id], createdBy: req.user.id, createdAt: Date.now() };
    db.chats[chat.id] = chat;
    db.messages[chat.id] = [];
    save();
    sendTo(other.id, { type: 'chat', chat: chatView(chat, other.id) });
  }
  res.json({ chat: chatView(chat, req.user.id) });
});

app.post('/api/chats/group', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const phones = (req.body.phones || []).map(normPhone);
  if (!name) return res.status(400).json({ error: 'Give the group a name' });
  const members = new Set([req.user.id]);
  const missing = [];
  for (const p of phones) {
    const u = Object.values(db.users).find((x) => x.phone === p);
    if (u) members.add(u.id); else if (p) missing.push(p);
  }
  if (members.size < 2) return res.status(400).json({ error: 'Add at least one registered member' + (missing.length ? ' (not found: ' + missing.join(', ') + ')' : '') });
  const chat = { id: uid(), type: 'group', name, color: COLORS[Math.floor(Math.random() * COLORS.length)], members: [...members], createdBy: req.user.id, createdAt: Date.now() };
  db.chats[chat.id] = chat;
  db.messages[chat.id] = [];
  const sys = { id: uid(), chatId: chat.id, from: req.user.id, type: 'system', text: `${req.user.name} created group "${name}"`, ts: Date.now(), deliveredTo: [], readBy: [] };
  db.messages[chat.id].push(sys);
  save();
  for (const m of chat.members) if (m !== req.user.id) sendTo(m, { type: 'chat', chat: chatView(chat, m) });
  res.json({ chat: chatView(chat, req.user.id), missing });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  const msgs = (db.messages[chat.id] || []).slice(-500).map(msgView);
  res.json({ messages: msgs });
});

const SAFE_EXT = /^\.(png|jpe?g|gif|webp|pdf|txt|csv|docx?|xlsx?|pptx?|zip|mp3|m4a|wav|ogg|mp4|webm)$/i;
app.post('/api/upload', auth, (req, res) => {
  const { name, data } = req.body || {};
  if (!name || !data) return res.status(400).json({ error: 'Missing file' });
  let ext = path.extname(String(name)).toLowerCase();
  if (!SAFE_EXT.test(ext)) ext = '.bin';
  const buf = Buffer.from(String(data).split(',').pop(), 'base64');
  if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 10 MB)' });
  const file = uid() + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  res.json({ url: '/uploads/' + file, size: buf.length });
});

/* ---------- websocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws' });

function deliverPending(userId) {
  // mark everything sent to this user while offline as delivered
  for (const chat of Object.values(db.chats)) {
    if (!chat.members.includes(userId)) continue;
    const changed = [];
    for (const m of db.messages[chat.id] || []) {
      if (m.from !== userId && m.type !== 'system' && !(m.deliveredTo || []).includes(userId)) {
        (m.deliveredTo = m.deliveredTo || []).push(userId);
        changed.push(m.id);
      }
    }
    if (changed.length) {
      broadcastToChat(chat, { type: 'status', chatId: chat.id, ids: changed, kind: 'delivered', userId }, userId);
    }
  }
  save();
}

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const user = userFromToken(token);
  if (!user) { ws.close(4001, 'unauthorized'); return; }
  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(ws);
  for (const c of contactsOf(user.id)) sendTo(c, { type: 'presence', userId: user.id, online: true, lastSeen: user.lastSeen });
  deliverPending(user.id);

  ws.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { return; }
    const chat = db.chats[ev.chatId];
    if (ev.type !== 'delete' && (!chat || !chat.members.includes(user.id))) return;

    if (ev.type === 'send') {
      const text = String(ev.text || '').slice(0, 4000);
      const kind = ['text', 'image', 'file', 'audio'].includes(ev.kind) ? ev.kind : 'text';
      if (kind === 'text' && !text.trim()) return;
      if (kind !== 'text' && !String(ev.url || '').startsWith('/uploads/')) return;
      let replyTo = null;
      if (ev.replyTo) {
        const orig = (db.messages[chat.id] || []).find((m) => m.id === ev.replyTo);
        if (orig && !orig.deleted) replyTo = { id: orig.id, from: orig.from, text: orig.text || orig.fileName || orig.kind, kind: orig.kind };
      }
      const msg = {
        id: uid(), chatId: chat.id, from: user.id, kind, text, url: ev.url || null, fileName: ev.fileName || null, size: ev.size || null,
        replyTo, ts: Date.now(), deliveredTo: [], readBy: [],
      };
      for (const m of chat.members) if (m !== user.id && online.has(m)) msg.deliveredTo.push(m);
      (db.messages[chat.id] = db.messages[chat.id] || []).push(msg);
      save();
      sendTo(user.id, { type: 'message', message: msg, tempId: ev.tempId });
      broadcastToChat(chat, { type: 'message', message: msg }, user.id);
    }

    else if (ev.type === 'typing') {
      broadcastToChat(chat, { type: 'typing', chatId: chat.id, userId: user.id, name: user.name }, user.id);
    }

    else if (ev.type === 'read') {
      const changed = [];
      for (const m of db.messages[chat.id] || []) {
        if (m.from !== user.id && m.type !== 'system' && !(m.readBy || []).includes(user.id)) {
          (m.readBy = m.readBy || []).push(user.id);
          if (!(m.deliveredTo || []).includes(user.id)) (m.deliveredTo = m.deliveredTo || []).push(user.id);
          changed.push(m.id);
        }
      }
      if (changed.length) { save(); broadcastToChat(chat, { type: 'status', chatId: chat.id, ids: changed, kind: 'read', userId: user.id }, user.id); }
    }

    else if (ev.type === 'delete') {
      for (const c of Object.values(db.chats)) {
        const m = (db.messages[c.id] || []).find((x) => x.id === ev.msgId);
        if (m && m.from === user.id && c.members.includes(user.id)) {
          m.deleted = true; m.text = ''; m.url = null; m.fileName = null;
          save();
          for (const mem of c.members) sendTo(mem, { type: 'deleted', chatId: c.id, msgId: m.id });
          break;
        }
      }
    }
  });

  ws.on('close', () => {
    const set = online.get(user.id);
    if (set) { set.delete(ws); if (!set.size) {
      online.delete(user.id);
      user.lastSeen = Date.now();
      save();
      for (const c of contactsOf(user.id)) sendTo(c, { type: 'presence', userId: user.id, online: false, lastSeen: user.lastSeen });
    } }
  });
});

server.listen(PORT, () => console.log(`Chatly running on http://localhost:${PORT}`));

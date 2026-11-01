(() => {
  const $ = (id) => document.getElementById(id);
  const state = { token: localStorage.getItem('chatly_token'), me: null, chats: new Map(), msgs: new Map(), active: null, ws: null, reply: null, typing: {}, retry: 0, users: new Map() };
  const EMOJIS = '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😛 😜 🤪 😎 🤩 🥳 😏 😒 😞 😔 😢 😭 😤 😡 🤯 😳 🥺 😱 😴 🤔 🙄 😬 🤗 🤝 👍 👎 👏 🙌 🙏 💪 👋 ✌️ 🤞 👌 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 🔥 ✨ 🎉 🎂 🎁 ☕ 🍕 🍔 🍟 🍺 🌹 🌞 🌙 ⭐ 🚀 ✅ ❌ 💯'.split(' ');

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const timeStr = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function dayLabel(ts) {
    const d = new Date(ts), t = new Date();
    const y = new Date(); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function listTime(ts) {
    const d = new Date(ts), t = new Date();
    if (d.toDateString() === t.toDateString()) return timeStr(ts);
    const y = new Date(); y.setDate(t.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  function lastSeenText(u) {
    if (!u) return '';
    if (u.online) return 'online';
    const d = new Date(u.lastSeen), t = new Date();
    const same = d.toDateString() === t.toDateString();
    return 'last seen ' + (same ? 'today at ' + timeStr(u.lastSeen) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' at ' + timeStr(u.lastSeen));
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token) { logoutLocal(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  function avatarEl(el, name, color) { el.textContent = initials(name); el.style.background = color || '#888'; }

  /* ---------- auth ---------- */
  let registering = false;
  function setAuthMode(reg) {
    registering = reg;
    $('aName').classList.toggle('hidden', !reg);
    $('aSubmit').textContent = reg ? 'Create account' : 'Sign in';
    $('aToggle').textContent = reg ? 'Already have an account? Sign in' : 'New here? Create an account';
    $('aErr').textContent = '';
  }
  $('aToggle').onclick = (e) => { e.preventDefault(); setAuthMode(!registering); };
  $('authForm').onsubmit = async (e) => {
    e.preventDefault();
    $('aErr').textContent = '';
    try {
      const body = { phone: $('aPhone').value, password: $('aPass').value };
      if (registering) body.name = $('aName').value;
      const res = await fetch(registering ? '/api/register' : '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      state.token = data.token; localStorage.setItem('chatly_token', data.token);
      state.me = data.user;
      boot();
    } catch (err) { $('aErr').textContent = err.message; }
  };
  function logoutLocal() {
    localStorage.removeItem('chatly_token');
    state.token = null; state.me = null; state.chats.clear(); state.msgs.clear(); state.active = null;
    if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
    $('app').classList.add('hidden'); $('auth').classList.remove('hidden');
  }
  $('btnLogout').onclick = async () => { try { await api('/api/logout', 'POST'); } catch (e) {} logoutLocal(); };

  /* ---------- boot ---------- */
  async function boot() {
    try {
      if (!state.me) state.me = (await api('/api/me')).user;
    } catch (e) { return showAuth(); }
    $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
    avatarEl($('meAvatar'), state.me.name, state.me.color);
    $('meAvatar').style.cursor = 'pointer';
    const { chats } = await api('/api/chats');
    state.chats.clear();
    chats.forEach((c) => addChat(c));
    renderList();
    connect();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }
  function showAuth() { $('auth').classList.remove('hidden'); $('app').classList.add('hidden'); }

  function addChat(c) {
    state.chats.set(c.id, c);
    (c.members || []).forEach((u) => state.users.set(u.id, u));
  }

  /* ---------- websocket ---------- */
  function connect() {
    if (state.ws) return;
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + state.token);
    state.ws = ws;
    ws.onopen = () => { state.retry = 0; if (state.active) { loadMessages(state.active, true); } };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      state.ws = null;
      if (!state.token) return;
      state.retry++;
      setTimeout(connect, Math.min(1000 * state.retry, 8000));
    };
  }
  function wsSend(o) { if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify(o)); return true; } toast('Reconnecting… try again'); return false; }

  function handle(ev) {
    if (ev.type === 'message') onMessage(ev.message, ev.tempId);
    else if (ev.type === 'chat') { addChat(ev.chat); renderList(); }
    else if (ev.type === 'status') onStatus(ev);
    else if (ev.type === 'typing') onTyping(ev);
    else if (ev.type === 'presence') onPresence(ev);
    else if (ev.type === 'user') { state.users.set(ev.user.id, ev.user); for (const c of state.chats.values()) { c.members = c.members.map((m) => m.id === ev.user.id ? ev.user : m); if (c.type === 'dm' && c.other && c.other.id === ev.user.id) { c.other = ev.user; c.name = ev.user.name; } } renderList(); renderHeader(); }
    else if (ev.type === 'deleted') {
      const list = state.msgs.get(ev.chatId);
      const m = list && list.find((x) => x.id === ev.msgId);
      if (m) { m.deleted = true; m.text = ''; m.url = null; }
      const c = state.chats.get(ev.chatId);
      if (c && c.last && c.last.id === ev.msgId) { c.last = { ...c.last, deleted: true }; }
      renderList(); if (state.active === ev.chatId) renderMessages();
    }
  }

  function onMessage(m, tempId) {
    const chat = state.chats.get(m.chatId);
    if (!chat) { api('/api/chats').then(({ chats }) => { chats.forEach(addChat); renderList(); }); return; }
    const list = state.msgs.get(m.chatId) || (state.msgs.set(m.chatId, []), state.msgs.get(m.chatId));
    if (!list.some((x) => x.id === m.id)) list.push(m);
    chat.last = m; chat.updatedAt = m.ts;
    const mine = m.from === state.me.id;
    if (!mine) {
      if (state.active === m.chatId && document.visibilityState === 'visible') wsSend({ type: 'read', chatId: m.chatId });
      else {
        chat.unread = (chat.unread || 0) + 1;
        if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
          const n = new Notification(chat.name, { body: preview(m) }); setTimeout(() => n.close(), 4000);
        }
      }
    }
    if (state.typing[m.chatId]) delete state.typing[m.chatId];
    renderList();
    if (state.active === m.chatId) { renderMessages(true); renderHeader(); }
  }
  function onStatus(ev) {
    const list = state.msgs.get(ev.chatId); if (!list) return;
    list.forEach((m) => {
      if (ev.ids.includes(m.id)) {
        const arr = ev.kind === 'read' ? (m.readBy = m.readBy || []) : (m.deliveredTo = m.deliveredTo || []);
        if (!arr.includes(ev.userId)) arr.push(ev.userId);
        if (ev.kind === 'read') { m.deliveredTo = m.deliveredTo || []; if (!m.deliveredTo.includes(ev.userId)) m.deliveredTo.push(ev.userId); }
      }
    });
    const c = state.chats.get(ev.chatId); if (c && c.last) { const l = list.find((m) => m.id === c.last.id); if (l) c.last = l; }
    renderList(); if (state.active === ev.chatId) renderMessages();
  }
  function onTyping(ev) {
    state.typing[ev.chatId] = { name: ev.name, until: Date.now() + 3000 };
    renderList(); if (state.active === ev.chatId) renderHeader();
    setTimeout(() => { const t = state.typing[ev.chatId]; if (t && t.until <= Date.now()) { delete state.typing[ev.chatId]; renderList(); if (state.active === ev.chatId) renderHeader(); } }, 3100);
  }
  function onPresence(ev) {
    const u = state.users.get(ev.userId);
    for (const c of state.chats.values()) c.members.forEach((m) => { if (m.id === ev.userId) { m.online = ev.online; m.lastSeen = ev.lastSeen; } });
    if (u) { u.online = ev.online; u.lastSeen = ev.lastSeen; }
    for (const c of state.chats.values()) if (c.other && c.other.id === ev.userId) { c.other.online = ev.online; c.other.lastSeen = ev.lastSeen; }
    renderHeader();
  }

  /* ---------- chat list ---------- */
  function preview(m) {
    if (!m) return '';
    if (m.deleted) return '🚫 This message was deleted';
    if (m.type === 'system') return m.text;
    const who = '';
    if (m.kind === 'image') return who + '📷 Photo' + (m.text ? ' ' + m.text : '');
    if (m.kind === 'file') return who + '📄 ' + (m.fileName || 'File');
    if (m.kind === 'audio') return who + '🎵 Audio';
    return who + m.text;
  }
  function tickFor(m, chat) {
    if (m.from !== state.me.id || m.deleted || m.type === 'system') return '';
    const others = chat.members.filter((u) => u.id !== state.me.id).map((u) => u.id);
    const read = others.length && others.every((id) => (m.readBy || []).includes(id));
    const delivered = others.length && others.every((id) => (m.deliveredTo || []).includes(id));
    if (read) return '<span class="tick read">✓✓</span>';
    if (delivered) return '<span class="tick">✓✓</span>';
    return '<span class="tick">✓</span>';
  }
  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const items = [...state.chats.values()].filter((c) => !q || c.name.toLowerCase().includes(q) || (c.other && c.other.phone.includes(q))).sort((a, b) => b.updatedAt - a.updatedAt);
    const box = $('chatList');
    if (!items.length) { box.innerHTML = `<div class="nores">${q ? 'No chats match.' : 'No chats yet.<br>Tap ✉️ to start one with a phone number.'}</div>`; return; }
    box.innerHTML = '';
    for (const c of items) {
      const t = state.typing[c.id];
      let pv = c.last ? preview(c.last) : '';
      if (c.last && c.type === 'group' && c.last.type !== 'system' && !c.last.deleted) {
        const sender = c.last.from === state.me.id ? 'You' : (c.members.find((m) => m.id === c.last.from) || {}).name;
        pv = (sender ? sender.split(' ')[0] + ': ' : '') + pv;
      }
      const row = document.createElement('div');
      row.className = 'row' + (state.active === c.id ? ' active' : '') + (c.unread ? ' unread' : '');
      row.innerHTML = `<div class="avatar"></div><div class="mid"><div class="top"><div class="nm">${esc(c.name)}</div><div class="tm">${c.last ? listTime(c.last.ts) : ''}</div></div>
        <div class="bot"><div class="pv">${t ? `<span style="color:var(--accent)">${c.type === 'group' ? esc(t.name.split(' ')[0]) + ' is typing…' : 'typing…'}</span>` : (c.last ? tickFor(c.last, c) + ' ' : '') + esc(pv)}</div>${c.unread ? `<div class="badge">${c.unread}</div>` : ''}</div></div>`;
      avatarEl(row.querySelector('.avatar'), c.name, c.color);
      row.onclick = () => openChat(c.id);
      box.appendChild(row);
    }
  }
  $('search').oninput = renderList;

  /* ---------- open chat ---------- */
  async function openChat(id) {
    state.active = id; state.reply = null; $('replyBar').classList.add('hidden');
    $('empty').classList.add('hidden'); $('chatPane').classList.remove('hidden');
    $('app').classList.add('in-chat');
    const c = state.chats.get(id); c.unread = 0;
    renderList(); renderHeader();
    await loadMessages(id);
    $('msgInput').focus({ preventScroll: true });
  }
  async function loadMessages(id, silent) {
    const { messages } = await api(`/api/chats/${id}/messages`);
    state.msgs.set(id, messages);
    if (state.active !== id) return;
    renderMessages(true);
    wsSend({ type: 'read', chatId: id });
    const c = state.chats.get(id); if (c) { c.unread = 0; renderList(); }
  }
  $('btnBack').onclick = () => { $('app').classList.remove('in-chat'); state.active = null; renderList(); };
  function renderHeader() {
    const c = state.chats.get(state.active); if (!c) return;
    avatarEl($('cAvatar'), c.name, c.color);
    $('cTitle').textContent = c.name;
    const t = state.typing[c.id];
    let sub;
    if (t) sub = c.type === 'group' ? t.name + ' is typing…' : 'typing…';
    else if (c.type === 'dm') sub = lastSeenText(c.other);
    else sub = c.members.map((m) => (m.id === state.me.id ? 'You' : m.name.split(' ')[0])).join(', ');
    $('cSub').textContent = sub;
  }

  /* ---------- messages ---------- */
  function renderMessages(stick) {
    const c = state.chats.get(state.active); if (!c) return;
    const box = $('msgs');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = '';
    let lastDay = '';
    const list = state.msgs.get(c.id) || [];
    for (const m of list) {
      const dl = dayLabel(m.ts);
      if (dl !== lastDay) { lastDay = dl; const d = document.createElement('div'); d.className = 'day'; d.textContent = dl; box.appendChild(d); }
      if (m.type === 'system') { const s = document.createElement('div'); s.className = 'sys'; s.textContent = m.text; box.appendChild(s); continue; }
      const mine = m.from === state.me.id;
      const el = document.createElement('div');
      el.className = 'msg ' + (mine ? 'out' : 'in') + (m.deleted ? ' deleted' : '');
      el.dataset.id = m.id;
      let html = '';
      if (c.type === 'group' && !mine) {
        const u = c.members.find((x) => x.id === m.from) || {};
        html += `<div class="who" style="color:${u.color || '#888'}">${esc(u.name || 'Unknown')}</div>`;
      }
      if (m.deleted) html += `<div class="body">🚫 ${mine ? 'You deleted this message' : 'This message was deleted'}</div>`;
      else {
        if (m.replyTo) {
          const ru = m.replyTo.from === state.me.id ? 'You' : (c.members.find((x) => x.id === m.replyTo.from) || {}).name;
          html += `<div class="quote" data-q="${esc(m.replyTo.id)}"><b>${esc(ru || '')}</b><span>${esc(m.replyTo.kind === 'image' ? '📷 Photo' : m.replyTo.text)}</span></div>`;
        }
        if (m.kind === 'image') html += `<img class="pic" src="${esc(m.url)}" alt="photo" loading="lazy">`;
        else if (m.kind === 'audio') html += `<audio controls src="${esc(m.url)}"></audio>`;
        else if (m.kind === 'file') {
          if (/\.(mp4|webm)$/i.test(m.url || '')) html += `<video controls src="${esc(m.url)}"></video>`;
          else html += `<a class="file" href="${esc(m.url)}" download="${esc(m.fileName || 'file')}" target="_blank" rel="noopener"><span style="font-size:26px">📄</span><span>${esc(m.fileName || 'File')}<br><small class="muted">${m.size ? (m.size / 1024).toFixed(0) + ' KB' : ''}</small></span></a>`;
        }
        if (m.text) html += `<div class="body">${linkify(esc(m.text))}</div>`;
      }
      html += `<div class="meta"><span>${timeStr(m.ts)}</span>${tickFor(m, c)}</div><div style="clear:both"></div>`;
      if (!m.deleted) html += `<div class="actions"><button data-act="reply" title="Reply">↩</button>${mine ? '<button data-act="del" title="Delete">🗑</button>' : ''}</div>`;
      el.innerHTML = html;
      box.appendChild(el);
    }
    if (stick || nearBottom) box.scrollTop = box.scrollHeight;
  }
  function linkify(s) { return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#0a7cff">$1</a>'); }

  $('msgs').addEventListener('click', (e) => {
    const img = e.target.closest('img.pic');
    if (img) { $('lbImg').src = img.src; $('lightbox').classList.remove('hidden'); return; }
    const q = e.target.closest('.quote');
    if (q) { const t = document.querySelector(`.msg[data-id="${CSS.escape(q.dataset.q)}"]`); if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1300); } return; }
    const btn = e.target.closest('button[data-act]');
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    if (!btn) { // tap to reveal actions on touch screens
      document.querySelectorAll('.msg.show-actions').forEach((x) => x !== msgEl && x.classList.remove('show-actions'));
      msgEl.classList.toggle('show-actions'); return;
    }
    const id = msgEl.dataset.id;
    const m = (state.msgs.get(state.active) || []).find((x) => x.id === id);
    if (btn.dataset.act === 'reply') setReply(m);
    if (btn.dataset.act === 'del' && confirm('Delete this message for everyone?')) wsSend({ type: 'delete', chatId: state.active, msgId: id });
  });
  $('lightbox').onclick = () => $('lightbox').classList.add('hidden');

  function setReply(m) {
    const c = state.chats.get(state.active);
    state.reply = m.id;
    $('rbWho').textContent = m.from === state.me.id ? 'You' : (c.members.find((x) => x.id === m.from) || {}).name;
    $('rbTxt').textContent = m.kind === 'image' ? '📷 Photo' : (m.text || m.fileName || '');
    $('replyBar').classList.remove('hidden'); $('msgInput').focus();
  }
  $('rbClose').onclick = () => { state.reply = null; $('replyBar').classList.add('hidden'); };

  /* ---------- sending ---------- */
  function send(extra = {}) {
    const text = $('msgInput').value.trim();
    const kind = extra.kind || 'text';
    if (kind === 'text' && !text) return;
    const ok = wsSend({ type: 'send', chatId: state.active, text: kind === 'text' ? text : (extra.text || ''), replyTo: state.reply, tempId: Math.random().toString(36).slice(2), ...extra });
    if (!ok) return;
    $('msgInput').value = ''; state.reply = null; $('replyBar').classList.add('hidden'); $('emojiPanel').classList.add('hidden');
  }
  $('btnSend').onclick = () => send();
  let lastTyping = 0;
  $('msgInput').addEventListener('input', () => { if (Date.now() - lastTyping > 2000 && state.active) { lastTyping = Date.now(); wsSend({ type: 'typing', chatId: state.active }); } });
  $('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  window.addEventListener('focus', () => { if (state.active) { wsSend({ type: 'read', chatId: state.active }); const c = state.chats.get(state.active); if (c && c.unread) { c.unread = 0; renderList(); } } });

  // emoji
  $('emojiPanel').innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join('');
  $('btnEmoji').onclick = (e) => { e.stopPropagation(); $('emojiPanel').classList.toggle('hidden'); };
  $('emojiPanel').onclick = (e) => { if (e.target.tagName === 'BUTTON') { const i = $('msgInput'); i.value += e.target.textContent; i.focus(); } };
  document.addEventListener('click', (e) => { if (!e.target.closest('#emojiPanel') && e.target.id !== 'btnEmoji') $('emojiPanel').classList.add('hidden'); });

  // attachments
  $('btnAttach').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async () => {
    const f = $('fileInput').files[0]; $('fileInput').value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast('File too large (max 10 MB)');
    toast('Uploading…');
    try {
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      const up = await api('/api/upload', 'POST', { name: f.name, data });
      const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audio' : 'file';
      send({ kind, url: up.url, fileName: f.name, size: up.size, text: $('msgInput').value.trim() });
      $('toast').classList.add('hidden');
    } catch (e) { toast(e.message || 'Upload failed'); }
  };
  // paste image
  $('msgInput').addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { const f = item.getAsFile(); const dt = new DataTransfer(); dt.items.add(f); $('fileInput').files = dt.files; $('fileInput').onchange(); }
  });

  /* ---------- modals ---------- */
  function modal(html, onMount) {
    $('modalCard').innerHTML = html; $('modal').classList.remove('hidden');
    $('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
    onMount && onMount();
  }
  function closeModal() { $('modal').classList.add('hidden'); }

  $('btnNewChat').onclick = () => modal(`<h3>New chat</h3><input id="mPhone" placeholder="Phone number" inputmode="tel"><div class="err" id="mErr"></div>
    <div class="acts"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Start chat</button></div>`, () => {
    $('mPhone').focus();
    $('mCancel').onclick = closeModal;
    const go = async () => {
      try { const { chat } = await api('/api/chats/dm', 'POST', { phone: $('mPhone').value }); addChat(chat); closeModal(); renderList(); openChat(chat.id); }
      catch (e) { $('mErr').textContent = e.message; }
    };
    $('mOk').onclick = go; $('mPhone').onkeydown = (e) => e.key === 'Enter' && go();
  });

  $('btnNewGroup').onclick = () => modal(`<h3>New group</h3><input id="gName" placeholder="Group name"><textarea id="gPhones" rows="3" placeholder="Member phone numbers, separated by commas"></textarea><div class="err" id="mErr"></div>
    <div class="acts"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Create</button></div>`, () => {
    $('gName').focus();
    $('mCancel').onclick = closeModal;
    $('mOk').onclick = async () => {
      try {
        const phones = $('gPhones').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        const { chat, missing } = await api('/api/chats/group', 'POST', { name: $('gName').value, phones });
        addChat(chat); closeModal(); renderList(); openChat(chat.id);
        if (missing && missing.length) toast('Not on Chatly: ' + missing.join(', '));
      } catch (e) { $('mErr').textContent = e.message; }
    };
  });

  $('meAvatar').onclick = () => modal(`<h3>Your profile</h3><div class="muted" style="margin-bottom:8px">${esc(state.me.phone)}</div>
    <input id="pName" placeholder="Name" value="${esc(state.me.name)}"><input id="pAbout" placeholder="About" value="${esc(state.me.about || '')}">
    <div class="acts"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Save</button></div>`, () => {
    $('mCancel').onclick = closeModal;
    $('mOk').onclick = async () => {
      const { user } = await api('/api/me', 'PUT', { name: $('pName').value, about: $('pAbout').value });
      state.me = user; avatarEl($('meAvatar'), user.name, user.color); closeModal();
    };
  });

  $('cTitle').parentElement.style.cursor = 'pointer';
  $('cTitle').parentElement.onclick = () => {
    const c = state.chats.get(state.active); if (!c) return;
    if (c.type === 'dm') return modal(`<h3>${esc(c.name)}</h3><div class="muted">${esc(c.other.phone)}</div><p>${esc(c.other.about || '')}</p><div class="acts"><button class="btn" id="mCancel">Close</button></div>`, () => $('mCancel').onclick = closeModal);
    modal(`<h3>${esc(c.name)}</h3><div class="muted">${c.members.length} members</div><div class="memlist">${c.members.map((m) => `<div><div class="avatar" style="width:34px;height:34px;font-size:14px;background:${m.color}">${esc(initials(m.name))}</div><div>${esc(m.id === state.me.id ? 'You' : m.name)}<br><small class="muted">${esc(m.phone)}</small></div></div>`).join('')}</div><div class="acts"><button class="btn" id="mCancel">Close</button></div>`, () => $('mCancel').onclick = closeModal);
  };

  /* ---------- go ---------- */
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); $('lightbox').classList.add('hidden'); } });
  if (state.token) boot(); else showAuth();
})();

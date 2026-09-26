/*
 * ПИ-17 · Расписание — сервер (Node.js, без внешних зависимостей кроме better-sqlite3)
 *
 * Функции:
 *  - статика из ./public
 *  - SQLite-БД (data.db): пользователи, расписание, предложения правок, заметки, задания, объявления
 *  - регистрация/вход (cookie-сессии), все действия подписаны автором
 *  - админка: утверждение/отклонение предложений в расписание, публикация объявлений
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const db = new Database(path.join(__dirname, 'data.db'));

/* ----------------------------- схема БД ----------------------------- */
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',      -- student | admin
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_entries (        -- утверждённое расписание
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week TEXT NOT NULL,          -- upper | lower
  day TEXT NOT NULL,           -- mon..sat
  ord INTEGER NOT NULL,        -- номер пары 1..6
  discipline TEXT NOT NULL,
  kind TEXT DEFAULT '',        -- лекция/семинар/практ/лаб...
  teacher TEXT DEFAULT '',
  room TEXT DEFAULT '',
  note TEXT DEFAULT '',        -- пометка "перенесено/идёт на 4 этаж" и т.п.
  updated_by TEXT DEFAULT 'импорт'
);
CREATE TABLE IF NOT EXISTS schedule_proposals (      -- правки от всех ("Внести правку")
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,          -- add | edit | cancel | note
  target_id INTEGER,           -- id записи при edit/cancel/note
  data TEXT NOT NULL,          -- JSON новой записи
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reviewed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (                   -- личные заметки к парам/дням
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  scope TEXT NOT NULL,         -- entry id или день "mon:upper"
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (                   -- ДЗ и контрольные (скидывают все)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,          -- hw | exam
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,      -- ISO yyyy-mm-dd
  author TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (           -- объявления (админ публикует)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | published
  created_at TEXT NOT NULL
);
`);

/* сид: админ + расписание из оригинальной таблицы Google Sheets */
(function seed() {
  const hasAdmin = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get();
  if (!hasAdmin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('admin123', salt, 64).toString('hex');
    db.prepare(`INSERT INTO users (username, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?)`)
      .run('admin', hash, salt, 'admin', new Date().toISOString());
    console.log('[seed] создан админ: admin / admin123');
  }
  const cnt = db.prepare(`SELECT COUNT(*) c FROM schedule_entries`).get().c;
  if (cnt === 0 && fs.existsSync(path.join(PUB, 'schedule.csv'))) {
    const rows = parseCSV(fs.readFileSync(path.join(PUB, 'schedule.csv'), 'utf8')).slice(1);
    const ins = db.prepare(`INSERT INTO schedule_entries (week,day,ord,discipline,kind,teacher,room) VALUES (?,?,?,?,?,?,?)`);
    const DAYMAP = { 'пн': 'mon', 'вт': 'tue', 'ср': 'wed', 'чт': 'thu', 'пт': 'fri', 'сб': 'sat' };
    for (const r of rows) {
      const w = r[0] === 'верхняя' ? 'upper' : 'lower';
      const d = DAYMAP[(r[1] || '').trim()];
      if (!d || !(r[3] || '').trim()) continue;
      ins.run(w, d, +r[2], r[3].trim(), (r[4] || '').trim(), (r[5] || '').trim(), (r[7] || '').trim() || (r[6] || '').trim());
    }
    console.log('[seed] расписание импортировано из schedule.csv');
  }
})();

function parseCSV(text) {
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

/* ----------------------------- хелперы ----------------------------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const nowISO = () => new Date().toISOString();

function getUser(req) {
  const m = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/);
  if (!m) return null;
  const s = db.prepare(`SELECT user_id FROM sessions WHERE token=?`).get(m[1]);
  if (!s) return null;
  return db.prepare(`SELECT id, username, role FROM users WHERE id=?`).get(s.user_id) || null;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)`).run(token, userId, nowISO());
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
}

function sendJSON(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}

/* ----------------------------- API ----------------------------- */
async function api(req, res, url) {
  const user = getUser(req);
  const p = url.pathname;
  const method = req.method;

  /* --- auth --- */
  if (p === '/api/register' && method === 'POST') {
    const { username, password } = await readBody(req);
    const u = (username || '').trim();
    if (!/^[\wА-Яа-яЁё\-. ]{3,24}$/.test(u)) return sendJSON(res, 400, { error: 'Имя: 3–24 символа, без спецсимволов' });
    if ((password || '').length < 4) return sendJSON(res, 400, { error: 'Пароль минимум 4 символа' });
    if (u.toLowerCase() === 'guest') return sendJSON(res, 400, { error: 'Это имя занято' });
    if (db.prepare(`SELECT id FROM users WHERE lower(username)=lower(?)`).get(u))
      return sendJSON(res, 400, { error: 'Такое имя уже занято' });
    const salt = crypto.randomBytes(16).toString('hex');
    const r = db.prepare(`INSERT INTO users (username,pass_hash,salt,role,created_at) VALUES (?,?,?,?, 'student')`)
      .run(u, hashPw(password, salt), salt, nowISO());
    createSession(res, r.lastInsertRowid);
    return sendJSON(res, 200, { ok: true, user: { id: r.lastInsertRowid, username: u, role: 'student' } });
  }
  if (p === '/api/login' && method === 'POST') {
    const { username, password } = await readBody(req);
    const row = db.prepare(`SELECT * FROM users WHERE lower(username)=lower(?)`).get((username || '').trim());
    if (!row || hashPw(password || '', row.salt) !== row.pass_hash)
      return sendJSON(res, 401, { error: 'Неверное имя или пароль' });
    createSession(res, row.id);
    return sendJSON(res, 200, { ok: true, user: { id: row.id, username: row.username, role: row.role } });
  }
  if (p === '/api/logout' && method === 'POST') {
    const m = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/);
    if (m) db.prepare(`DELETE FROM sessions WHERE token=?`).run(m[1]);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/me') return sendJSON(res, 200, { user });

  /* --- публичные данные (только чтение, GET) --- */
  if (p === '/api/schedule' && method === 'GET') {
    return sendJSON(res, 200, {
      entries: db.prepare(`SELECT * FROM schedule_entries ORDER BY week, day, ord`).all(),
      cancelled: db.prepare(`SELECT target_id FROM schedule_proposals WHERE type='cancel' AND status='approved'`).all().map(r => r.target_id),
    });
  }
  if (p === '/api/tasks' && method === 'GET') return sendJSON(res, 200, { tasks: db.prepare(`SELECT * FROM tasks ORDER BY due_date`).all() });
  if (p === '/api/announcements' && method === 'GET') {
    return sendJSON(res, 200, { items: db.prepare(`SELECT * FROM announcements WHERE status='published' ORDER BY created_at DESC`).all() });
  }
  if (p === '/api/notes' && method === 'GET') {
    if (!user) return sendJSON(res, 200, { notes: [] });
    return sendJSON(res, 200, { notes: db.prepare(`SELECT * FROM notes WHERE user_id=? ORDER BY created_at DESC`).all(user.id) });
  }

  /* всё остальное требует входа */
  if (!user) return sendJSON(res, 401, { error: 'Войдите или зарегистрируйтесь — действие должно быть подписано автором' });
  const isAdmin = user.role === 'admin';

  /* --- заметки --- */
  if (p === '/api/notes' && method === 'POST') {
    const { scope, text } = await readBody(req);
    if (!scope || !String(text || '').trim()) return sendJSON(res, 400, { error: 'Пустая заметка' });
    const r = db.prepare(`INSERT INTO notes (user_id,author,scope,text,created_at) VALUES (?,?,?,?,?)`)
      .run(user.id, user.username, String(scope), String(text).trim().slice(0, 500), nowISO());
    return sendJSON(res, 200, { ok: true, id: r.lastInsertRowid });
  }
  if (p.startsWith('/api/notes/') && method === 'DELETE') {
    const id = +p.split('/')[3];
    db.prepare(`DELETE FROM notes WHERE id=? AND user_id=?`).run(id, user.id);
    return sendJSON(res, 200, { ok: true });
  }

  /* --- задания (ДЗ/контрольные): может скинуть любой вошедший --- */
  if (p === '/api/tasks' && method === 'POST') {
    const { type, subject, title, due_date } = await readBody(req);
    if (!['hw', 'exam'].includes(type)) return sendJSON(res, 400, { error: 'Тип: hw или exam' });
    if (!subject || !title || !/^\d{4}-\d{2}-\d{2}$/.test(due_date || ''))
      return sendJSON(res, 400, { error: 'Заполните предмет, название и дату (гггг-мм-дд)' });
    const r = db.prepare(`INSERT INTO tasks (type,subject,title,due_date,author,created_at) VALUES (?,?,?,?,?,?)`)
      .run(type, String(subject).slice(0, 60), String(title).slice(0, 200), due_date, user.username, nowISO());
    return sendJSON(res, 200, { ok: true, id: r.lastInsertRowid });
  }
  if (p.match(/^\/api\/tasks\/\d+\/done$/) && method === 'POST') {
    const id = +p.split('/')[3];
    const t = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id);
    if (!t) return sendJSON(res, 404, { error: 'Не найдено' });
    const done = t.done ? 0 : 1;
    db.prepare(`UPDATE tasks SET done=?, done_by=? WHERE id=?`).run(done, done ? user.username : null, id);
    return sendJSON(res, 200, { ok: true });
  }
  if (p.match(/^\/api\/tasks\/\d+$/) && method === 'DELETE') {
    const id = +p.split('/')[3];
    const t = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id);
    if (!t) return sendJSON(res, 404, { error: 'Не найдено' });
    if (t.author !== user.username && !isAdmin) return sendJSON(res, 403, { error: 'Может удалить только автор' });
    db.prepare(`DELETE FROM tasks WHERE id=?`).run(id);
    return sendJSON(res, 200, { ok: true });
  }

  /* --- предложения правок расписания: СОЗДАТЬ может любой вошедший --- */
  if (p === '/api/proposals' && method === 'POST') {
    const { type, target_id, data } = await readBody(req);
    if (!['add', 'edit', 'cancel', 'note'].includes(type)) return sendJSON(res, 400, { error: 'Неверный тип правки' });
    if (!data || typeof data !== 'object') return sendJSON(res, 400, { error: 'Нет данных' });
    const r = db.prepare(`INSERT INTO schedule_proposals (type,target_id,data,author,created_at) VALUES (?,?,?,?,?)`)
      .run(type, target_id || null, JSON.stringify(data), user.username, nowISO());
    return sendJSON(res, 200, { ok: true, id: r.lastInsertRowid });
  }
  if (p === '/api/proposals' && method === 'GET') {
    if (!isAdmin) return sendJSON(res, 403, { error: 'Только для админа' });
    return sendJSON(res, 200, { items: db.prepare(`SELECT * FROM schedule_proposals ORDER BY (status='pending') DESC, created_at DESC`).all() });
  }
  if (p.match(/^\/api\/proposals\/\d+\/review$/) && method === 'POST') {
    if (!isAdmin) return sendJSON(res, 403, { error: 'Только для админа' });
    const id = +p.split('/')[3];
    const { decision } = await readBody(req);
    const pr = db.prepare(`SELECT * FROM schedule_proposals WHERE id=?`).get(id);
    if (!pr) return sendJSON(res, 404, { error: 'Не найдено' });
    if (pr.status !== 'pending') return sendJSON(res, 400, { error: 'Уже рассмотрено' });
    if (decision === 'approve') {
      const d = JSON.parse(pr.data);
      if (pr.type === 'add') {
        db.prepare(`INSERT INTO schedule_entries (week,day,ord,discipline,kind,teacher,room,note,updated_by) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(d.week, d.day, +d.ord || 1, d.discipline || '—', d.kind || '', d.teacher || '', d.room || '', d.note || '', user.username);
      } else if (pr.type === 'edit' && pr.target_id) {
        db.prepare(`UPDATE schedule_entries SET week=?,day=?,ord=?,discipline=?,kind=?,teacher=?,room=?,note=?,updated_by=? WHERE id=?`)
          .run(d.week, d.day, +d.ord || 1, d.discipline || '—', d.kind || '', d.teacher || '', d.room || '', d.note || '', user.username, pr.target_id);
      } else if (pr.type === 'note' && pr.target_id) {
        db.prepare(`UPDATE schedule_entries SET note=?, updated_by=? WHERE id=?`).run(String(d.note || '').slice(0, 200), user.username, pr.target_id);
      }
      db.prepare(`UPDATE schedule_proposals SET status='approved', reviewed_by=? WHERE id=?`).run(user.username, id);
    } else {
      db.prepare(`UPDATE schedule_proposals SET status='rejected', reviewed_by=? WHERE id=?`).run(user.username, id);
    }
    return sendJSON(res, 200, { ok: true });
  }
  if (p.match(/^\/api\/proposals\/\d+\/cancel$/) && method === 'POST') {
    // студент может отозвать СВОЁ pending-предложение
    const id = +p.split('/')[3];
    const pr = db.prepare(`SELECT * FROM schedule_proposals WHERE id=?`).get(id);
    if (!pr) return sendJSON(res, 404, { error: 'Не найдено' });
    if (pr.author !== user.username && !isAdmin) return sendJSON(res, 403, { error: 'Только автор' });
    if (pr.status !== 'pending') return sendJSON(res, 400, { error: 'Уже рассмотрено' });
    db.prepare(`UPDATE schedule_proposals SET status='rejected', reviewed_by=? WHERE id=?`).run(user.username + ' (отозвано)', id);
    return sendJSON(res, 200, { ok: true });
  }

  /* --- объявления: создать может любой вошедший, публикует админ --- */
  if (p === '/api/announcements' && method === 'POST') {
    const { title, body } = await readBody(req);
    if (!title || !body) return sendJSON(res, 400, { error: 'Заполните заголовок и текст' });
    const r = db.prepare(`INSERT INTO announcements (title,body,author,status,created_at) VALUES (?,?,?,?,?)`)
      .run(String(title).slice(0, 120), String(body).slice(0, 2000), user.username,
        isAdmin ? 'published' : 'pending', nowISO());
    return sendJSON(res, 200, { ok: true, id: r.lastInsertRowid, pending: !isAdmin });
  }
  if (p === '/api/pending' && method === 'GET') {
    if (!isAdmin) return sendJSON(res, 403, { error: 'Только для админа' });
    return sendJSON(res, 200, {
      announcements: db.prepare(`SELECT * FROM announcements WHERE status='pending' ORDER BY created_at DESC`).all(),
    });
  }
  if (p.match(/^\/api\/announcements\/\d+\/publish$/) && method === 'POST') {
    if (!isAdmin) return sendJSON(res, 403, { error: 'Только для админа' });
    db.prepare(`UPDATE announcements SET status='published' WHERE id=?`).run(+p.split('/')[3]);
    return sendJSON(res, 200, { ok: true });
  }
  if (p.match(/^\/api\/announcements\/\d+$/) && method === 'DELETE') {
    const id = +p.split('/')[3];
    const a = db.prepare(`SELECT * FROM announcements WHERE id=?`).get(id);
    if (!a) return sendJSON(res, 404, { error: 'Не найдено' });
    if (a.author !== user.username && !isAdmin) return sendJSON(res, 403, { error: 'Только автор или админ' });
    db.prepare(`DELETE FROM announcements WHERE id=?`).run(id);
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: 'Нет такого API' });
}

/* ----------------------------- статика ----------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8', '.ico': 'image/x-icon' };
function serveStatic(res, urlPath) {
  let f = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  f = path.normalize(path.join(PUB, f));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => sendJSON(res, 400, { error: 'Некорректный запрос: ' + e.message }));
  } else if (url.pathname === '/admin') {
    serveStatic(res, '/admin.html');
  } else {
    serveStatic(res, url.pathname);
  }
}).listen(PORT, () => console.log(`ПИ-17 schedule: http://localhost:${PORT}  (админ: /admin)`));

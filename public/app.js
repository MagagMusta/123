/* ============ ПИ-17 · клиент ============ */
const $ = s => document.querySelector(s);
const DAYS = ['mon','tue','wed','thu','fri','sat'];
const DAYRU = { mon:'понедельник', tue:'вторник', wed:'среда', thu:'четверг', fri:'пятница', sat:'суббота' };
const TIMES = ['8:00 - 9:35','9:50 - 11:25','11:55 - 13:30','13:45 - 15:20','15:50 - 17:25','17:40 - 19:15'];
// опорное число: понедельник этой недели — верхняя (чётная)
const REF_MON = new Date(2026, 8, 21); // 21.09.2026 — пн, верхняя

let ME = null, SCHED = [], NOTES = [], TASKS = [], ANNS = [];
let weekOffset = 0, hideDone = false;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Ошибка сети');
  return j;
};
function toast(msg, ok = true) {
  const t = $('#toast'); t.textContent = msg; t.className = `glass show ${ok ? 'ok' : 'err'}`;
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), 3200);
}
function mondayOf(offset) {
  const d = new Date(REF_MON); d.setDate(d.getDate() + offset * 7); return d;
}
function fmtDate(d) { return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); }
function fmtShort(iso) {
  const d = new Date(iso + 'T00:00');
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
function isUpperWeek(offset) {
  const weeks = Math.round((mondayOf(offset) - REF_MON) / (7 * 864e5));
  return ((weeks % 2) + 2) % 2 === 0;
}

/* ---------- модалка ---------- */
function openModal(html) { $('#modal').innerHTML = html; $('#modal-bg').classList.add('open'); }
function closeModal() { $('#modal-bg').classList.remove('open'); }
$('#modal-bg').addEventListener('click', e => { if (e.target.id === 'modal-bg') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

async function submitJSON(url, body) {
  try {
    const j = await api(url, { method: 'POST', body: JSON.stringify(body) });
    return j;
  } catch (e) { toast(e.message, false); throw e; }
}

/* ---------- авторизация ---------- */
function renderAuth() {
  const b = $('#authbox');
  if (ME) {
    b.innerHTML = `<span class="author" style="margin-right:8px">👤 <b>${esc(ME.username)}</b>${ME.role === 'admin' ? ' · <a href="/admin" style="color:var(--accent)">админка</a>' : ''}</span>
      <button class="btn small ghost" id="logout">Выйти</button>`;
    $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); ME = null; renderAuth(); loadNotes(); toast('Вы вышли'); };
  } else {
    b.innerHTML = `<button class="btn small primary" id="login-btn">Войти</button>`;
    $('#login-btn').onclick = loginModal;
  }
}
function loginModal(mode = 'login') {
  const reg = mode === 'reg';
  openModal(`
    <h2>${reg ? 'Регистрация' : 'Вход'}</h2>
    <div class="sub">Нужна подпись: кто внёс правку, объявление или задание</div>
    <label>Имя (как вас увидят однокурсники)</label>
    <input id="lg-u" placeholder="например, Иван П." maxlength="24">
    <label>Пароль</label><input id="lg-p" type="password" placeholder="минимум 4 символа">
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn primary" id="lg-go">${reg ? 'Создать аккаунт' : 'Войти'}</button>
      <button class="btn ghost" id="lg-switch">${reg ? 'Уже есть аккаунт' : 'Нет аккаунта — регистрация'}</button>
    </div>`);
  $('#lg-switch').onclick = () => loginModal(reg ? 'login' : 'reg');
  $('#lg-go').onclick = async () => {
    try {
      const j = await api(reg ? '/api/register' : '/api/login', {
        method: 'POST', body: JSON.stringify({ username: $('#lg-u').value, password: $('#lg-p').value })
      });
      ME = j.user; closeModal(); renderAuth(); loadNotes(); toast(`Привет, ${ME.username}!`);
    } catch (e) { /* toast уже показан в api? нет — покажем */ toast(e.message, false); }
  };
}

/* ---------- расписание ---------- */
async function loadSchedule() {
  const j = await api('/api/schedule');
  SCHED = j.entries.map(e => ({ ...e, cancelled: j.cancelled.includes(e.id) }));
}
function entriesFor(dayKey, weekKey) {
  return SCHED.filter(e => e.day === dayKey && e.week === weekKey).sort((a, b) => a.ord - b.ord);
}
function renderSchedule() {
  // дробь недель: сверху активная, снизу другая
  const upper = isUpperWeek(weekOffset);
  $('#fr-top').textContent = 'Верхняя'; $('#fr-bot').textContent = 'Нижняя';
  $('#fr-top').style.opacity = upper ? 1 : .35;
  $('#fr-bot').style.opacity = upper ? .35 : 1;
  $('#fr-num-label')?.remove();

  const mon = mondayOf(weekOffset), sun = new Date(mon); sun.setDate(sun.getDate() + 6);
  $('#week-dates').textContent = `${fmtDate(new Date(mondayOf(weekOffset)))} — ${fmtDate(sun)}`;
  const now = new Date();
  const monStart = new Date(mondayOf(weekOffset)); monStart.setHours(0, 0, 0, 0);
  const inRange = now >= monStart && now < monStart.getTime() + 7 * 864e5;
  $('#today-line').textContent = inRange
    ? `Сегодня: ${now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}, ${upper ? 'верхняя' : 'нижняя'} неделя`
    : '';

  const wk = upper ? 'upper' : 'lower';
  const todayIdx = (now.getDay() + 6) % 7; // 0=пн
  let html = '';
  DAYS.forEach((d, i) => {
    const date = mondayOf(weekOffset); date.setDate(date.getDate() + i);
    const list = entriesFor(d, wk);
    const isToday = inRange && i === todayIdx;
    html += `<div class="day glass card ${isToday ? 'is-today' : ''}" style="animation-delay:${i * 45}ms">
      <div class="day-head"><span class="day-name">${DAYRU[d]}</span><span class="day-date">${date.getDate()}.${String(date.getMonth()+1).padStart(2,'0')}</span>
      ${isToday ? '<span class="kind-tag k-семинар">сегодня</span>' : ''}
      <span class="spacer"></span>
      <button class="icon-btn" title="Заметка о дне" data-daynote="${d}:${wk}:${date.toISOString().slice(0,10)}">📝</button></div>`;
    if (!list.length) html += `<div class="empty-day">пар нет 🎉</div>`;
    for (const e of list) {
      const kindCls = e.kind.startsWith('лекц') ? 'k-лекция' : e.kind.startsWith('сем') ? 'k-семинар' : e.kind.startsWith('практ') ? 'k-практ' : e.kind.startsWith('лаб') ? 'k-лаб' : 'k-семинар';
      const myNotes = NOTES.filter(n => n.scope === 'entry:' + e.id);
      html += `<div class="lesson ${e.cancelled ? 'cancelled' : ''}">
        <div class="ord">${e.ord}</div>
        <div class="time">${TIMES[e.ord - 1] || ''}</div>
        <div class="lesson-main">
          <div class="disc">${esc(e.discipline)}</div>
          <div class="meta">
            ${e.kind ? `<span class="kind-tag ${kindCls}">${esc(e.kind)}</span>` : ''}
            ${e.teacher ? `<span>${esc(e.teacher)}</span>` : ''}
            ${e.room ? `<span class="room">ауд. ${esc(e.room)}</span>` : ''}
            ${e.note ? `<span class="note-chip">📌 ${esc(e.note)}</span>` : ''}
            ${e.updated_by && e.updated_by !== 'импорт' ? `<span class="author">ред.: <b>${esc(e.updated_by)}</b></span>` : ''}
          </div>
          ${myNotes.length ? myNotes.map(n => `<div class="meta"><span class="note-chip">📝 ${esc(n.text)} <span class="author">— ${esc(n.author)}</span>
            <button class="icon-btn" style="width:20px;height:20px;font-size:11px" data-delnote="${n.id}">✕</button></span></div>`).join('') : ''}
        </div>
        ${e.cancelled ? '<span class="badge-cancel">отменена</span>' : ''}
        <div class="lesson-actions">
          <button class="icon-btn" title="Отменить пару (предложить)" data-cancel="${e.id}">✖</button>
          <button class="icon-btn" title="Пометка на паре" data-enote="${e.id}">📝</button>
          <button class="icon-btn" title="Предложить правку пары" data-editp="${e.id}">✏️</button>
        </div>
      </div>`;
    }
    html += `</div>`;
  });
  $('#days').innerHTML = html;
  bindScheduleEvents();
}
function bindScheduleEvents() {
  document.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    if (!requireLogin()) return;
    const id = +b.dataset.cancel;
    if (SCHED.find(e => e.id === id)?.cancelled) return toast('Уже предложено к отмене / отменена', false);
    await submitJSON('/api/proposals', { type: 'cancel', target_id: id, data: {} });
    toast('Предложение об отмене отправлено админу ✅');
  });
  document.querySelectorAll('[data-enote]').forEach(b => b.onclick = () => {
    if (!requireLogin()) return;
    noteModal('entry:' + b.dataset.enote, 'Пометка на паре');
  });
  document.querySelectorAll('[data-daynote]').forEach(b => b.onclick = () => {
    if (!requireLogin()) return;
    noteModal('day:' + b.dataset.daynote, 'Заметка о дне');
  });
  document.querySelectorAll('[data-delnote]').forEach(b => b.onclick = async () => {
    await api('/api/notes/' + b.dataset.delnote, { method: 'DELETE' }); loadNotes(); toast('Заметка удалена');
  });
  document.querySelectorAll('[data-editp]').forEach(b => b.onclick = () => {
    if (!requireLogin()) return;
    proposeEdit(SCHED.find(e => e.id === +b.dataset.editp));
  });
}
function requireLogin() {
  if (ME) return true;
  toast('Сначала войдите — действие должно быть подписано', false); loginModal(); return false;
}

/* ---------- заметки ---------- */
function noteModal(scope, title) {
  const existing = NOTES.filter(n => n.scope === scope);
  openModal(`<h2>📝 ${title}</h2><div class="sub">Личная заметка — видите только вы, подпись обязательна</div>
    ${existing.map(n => `<div class="task glass"><span class="t-title">${esc(n.text)}</span>
      <span class="author">— ${esc(n.author)}</span>
      <button class="icon-btn" onclick="(async()=>{await api('/api/notes/${n.id}',{method:'DELETE'});loadNotes();closeModal();})()">✕</button></div>`).join('')}
    <textarea id="nt" rows="3" placeholder="например: принести ноутбук, сдача работы после пары…"></textarea>
    <div style="margin-top:12px;display:flex;gap:8px"><button class="btn primary" id="nt-save">Сохранить</button>
    <button class="btn ghost" onclick="closeModal()">Закрыть</button></div>`);
  $('#nt-save').onclick = async () => {
    const text = $('#nt').value.trim(); if (!text) return toast('Пусто', false);
    await submitJSON('/api/notes', { scope, text });
    closeModal(); loadNotes(); toast('Заметка сохранена');
  };
}
async function loadNotes() {
  try { NOTES = (await api('/api/notes')).notes; } catch (e) { NOTES = []; }
  renderSchedule();
}

/* ---------- предложения в расписание ---------- */
function weekSelect(sel) { return `<option value="upper" ${sel==='upper'?'selected':''}>Верхняя</option><option value="lower" ${sel==='lower'?'selected':''}>Нижняя</option>`; }
function daySelect(sel) { return DAYS.map(d => `<option value="${d}" ${sel===d?'selected':''}>${DAYRU[d]}</option>`).join(''); }
function ordSelect(sel) { return [1,2,3,4,5,6].map(o => `<option value="${o}" ${sel==o?'selected':''}>${o}-я пара (${TIMES[o-1]})</option>`).join(''); }

function proposeEdit(e) {
  openModal(`<h2>✏️ Предложить правку пары</h2><div class="sub">Автор: <b>${esc(ME.username)}</b> · утвердит админ</div>
    <div class="form-grid">
      <div><label>Неделя</label><select id="pe-week">${weekSelect(e.week)}</select></div>
      <div><label>День</label><select id="pe-day">${daySelect(e.day)}</select></div>
      <div><label>Номер пары</label><select id="pe-ord">${ordSelect(e.ord)}</select></div>
      <div><label>Формат</label><select id="pe-kind"><option value="">—</option>${['лекция','семинар','практ','лаб','консультация']
        .map(k => `<option ${e.kind===k?'selected':''}>${k}</option>`).join('')}</select></div>
    </div>
    <label>Дисциплина</label><input id="pe-disc" value="${esc(e.discipline)}">
    <label>Преподаватель</label><input id="pe-teach" value="${esc(e.teacher)}">
    <label>Аудитория</label><input id="pe-room" value="${esc(e.room)}">
    <label>Пометка (видна всем после одобрения)</label><input id="pe-note" value="${esc(e.note)}" placeholder="перенесена на 4 этаж / каб. занят…">
    <div style="margin-top:14px;display:flex;gap:8px"><button class="btn primary" id="pe-go">Отправить на проверку</button>
    <button class="btn ghost" onclick="closeModal()">Отмена</button></div>`);
  $('#pe-go').onclick = async () => {
    await submitJSON('/api/proposals', { type: 'edit', target_id: e.id, data: {
      week: $('#pe-week').value, day: $('#pe-day').value, ord: +$('#pe-ord').value,
      discipline: $('#pe-disc').value.trim(), kind: $('#pe-kind').value, teacher: $('#pe-teach').value.trim(),
      room: $('#pe-room').value.trim(), note: $('#pe-note').value.trim() } });
    closeModal(); toast('Правка отправлена админу на утверждение ✅');
  };
}
function proposeAdd() {
  openModal(`<h2>➕ Предложить новую пару</h2><div class="sub">Автор: <b>${esc(ME.username)}</b></div>
    <div class="form-grid">
      <div><label>Неделя</label><select id="pa-week">${weekSelect(isUpperWeek(weekOffset)?'upper':'lower')}</select></div>
      <div><label>День</label><select id="pa-day">${daySelect(DAYS[(new Date().getDay()+6)%7]||'mon')}</select></div>
      <div><label>Номер пары</label><select id="pa-ord">${ordSelect(1)}</select></div>
      <div><label>Формат</label><select id="pa-kind"><option value="">—</option>${['лекция','семинар','практ','лаб'].map(k=>`<option>${k}</option>`).join('')}</select></div>
    </div>
    <label>Дисциплина</label><input id="pa-disc" placeholder="напр. Программирование">
    <label>Преподаватель</label><input id="pa-teach"><label>Аудитория</label><input id="pa-room">
    <div style="margin-top:14px;display:flex;gap:8px"><button class="btn primary" id="pa-go">Отправить на проверку</button>
    <button class="btn ghost" onclick="closeModal()">Отмена</button></div>`);
  $('#pa-go').onclick = async () => {
    if (!$('#pa-disc').value.trim()) return toast('Укажите дисциплину', false);
    await submitJSON('/api/proposals', { type: 'add', data: {
      week: $('#pa-week').value, day: $('#pa-day').value, ord: +$('#pa-ord').value,
      discipline: $('#pa-disc').value.trim(), kind: $('#pa-kind').value,
      teacher: $('#pa-teach').value.trim(), room: $('#pa-room').value.trim() } });
    closeModal(); toast('Предложение отправлено ✅');
  };
}

/* ---------- задания ---------- */
async function loadTasks() { TASKS = (await api('/api/tasks')).tasks; renderTasks(); }
function renderTasks() {
  const today = new Date().toISOString().slice(0, 10);
  const mk = t => {
    const overdue = !t.done && t.due_date < today;
    const daysLeft = Math.ceil((new Date(t.due_date) - new Date(today)) / 864e5);
    return `<div class="task glass ${t.done ? 'done' : ''} card" style="margin-bottom:8px">
      <span class="dot ${t.type}"></span>
      <div style="flex:1;min-width:0">
        <div class="t-title" style="font-weight:600">${esc(t.title)}</div>
        <div class="t-subject">${esc(t.subject)} · добавил(а) <b>${esc(t.author)}</b>${t.done ? ` · выполнил(а) ${esc(t.done_by)}` : ''}</div>
      </div>
      <span class="t-due ${overdue ? 'overdue' : ''}">${fmtShort(t.due_date)}${overdue ? ' ⚠ просрочено' : daysLeft >= 0 && daysLeft <= 3 ? ` · через ${daysLeft} дн.` : ''}</span>
      <button class="icon-btn" title="Отметить выполненным" data-done="${t.id}">${t.done ? '↺' : '✓'}</button>
      ${ME && (ME.role === 'admin' || ME.username === t.author) ? `<button class="icon-btn" title="Удалить" data-deltask="${t.id}">🗑</button>` : ''}
    </div>`;
  };
  const filter = ts => ts.filter(t => !(hideDone && t.done));
  const exams = filter(TASKS.filter(t => t.type === 'exam'));
  const hws = filter(TASKS.filter(t => t.type === 'hw'));
  $('#exam-block').innerHTML = (exams.length ? `<h2 style="font-size:17px;margin:14px 0 8px;color:var(--red)">🔴 Контрольные и СР</h2>` + exams.map(mk).join('') : '')
    || (filter(TASKS).length ? '' : '');
  $('#hw-block').innerHTML = (hws.length ? `<h2 style="font-size:17px;margin:18px 0 8px;color:var(--accent)">🔵 Домашние задания</h2>` + hws.map(mk).join('') : '');
  if (!exams.length && !hws.length) $('#hw-block').innerHTML = `<div class="card glass empty-day" style="padding:24px">Пока никто ничего не скинул — будь первым!</div>`;
  document.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => { await submitJSON(`/api/tasks/${b.dataset.done}/done`, {}); loadTasks(); });
  document.querySelectorAll('[data-deltask]').forEach(b => b.onclick = async () => { await api(`/api/tasks/${b.dataset.deltask}`, { method: 'DELETE' }); loadTasks(); toast('Удалено'); });
}
function taskModal(type) {
  if (!requireLogin()) return;
  const subjects = [...new Set(SCHED.map(e => e.discipline))].sort();
  openModal(`<h2>${type === 'exam' ? '🔴 Контрольная / СР' : '🔵 Домашнее задание'}</h2>
    <div class="sub">Подпись автора: <b>${esc(ME.username)}</b></div>
    <label>Предмет</label>
    <input id="tk-subj" list="subj-list" placeholder="выберите или впишите"><datalist id="subj-list">${subjects.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
    <label>Что задали / когда и где</label><input id="tk-title" placeholder="напр.: §12 упр. 3–7 / КР по высшей математике, ауд. 514">
    <label>Дата (сдать / состоится)</label><input id="tk-date" type="date">
    <div style="margin-top:14px;display:flex;gap:8px"><button class="btn primary" id="tk-go">Опубликовать</button>
    <button class="btn ghost" onclick="closeModal()">Отмена</button></div>`);
  $('#tk-go').onclick = async () => {
    const body = { type, subject: $('#tk-subj').value.trim(), title: $('#tk-title').value.trim(), due_date: $('#tk-date').value };
    if (!body.subject || !body.title || !body.due_date) return toast('Заполните все поля', false);
    await submitJSON('/api/tasks', body);
    closeModal(); loadTasks(); toast('Опубликовано ✅');
  };
}

/* ---------- объявления ---------- */
async function loadAnns() { ANNS = (await api('/api/announcements')).items; renderAnns(); }
function renderAnns() {
  $('#ann-list').innerHTML = ANNS.length ? ANNS.map(a => `
    <div class="card glass ann">
      <h3>📣 ${esc(a.title)}</h3><p>${esc(a.body)}</p>
      <div class="date">опубликовано ${new Date(a.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · автор: <b>${esc(a.author)}</b></div>
    </div>`).join('')
    : `<div class="card glass empty-day" style="padding:24px">Объявлений пока нет.</div>`;
}
function annModal() {
  if (!requireLogin()) return;
  openModal(`<h2>📣 Предложить объявление</h2>
    <div class="sub">Автор: <b>${esc(ME.username)}</b> · публикует админ</div>
    <label>Заголовок</label><input id="an-title" placeholder="напр.: Перенос пары в пятницу">
    <label>Текст</label><textarea id="an-body" rows="4" placeholder="Подробности…"></textarea>
    <div style="margin-top:14px;display:flex;gap:8px"><button class="btn primary" id="an-go">Отправить</button>
    <button class="btn ghost" onclick="closeModal()">Отмена</button></div>`);
  $('#an-go').onclick = async () => {
    const title = $('#an-title').value.trim(), body = $('#an-body').value.trim();
    if (!title || !body) return toast('Заполните поля', false);
    const j = await submitJSON('/api/announcements', { title, body });
    closeModal();
    toast(j.pending ? 'Отправлено админу на публикацию ✅' : 'Опубликовано ✅');
    loadAnns();
  };
}

/* ---------- табы, недели, кнопки ---------- */
document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); $('#v-' + b.dataset.v).classList.add('active');
});
$('#prev-w').onclick = () => { weekOffset--; renderSchedule(); };
$('#next-w').onclick = () => { weekOffset++; renderSchedule(); };
$('#today-btn').onclick = () => { weekOffset = 0; renderSchedule(); };
$('#add-hw').onclick = () => taskModal('hw');
$('#add-exam').onclick = () => taskModal('exam');
$('#add-ann').onclick = annModal;
$('#toggle-done-view').onclick = () => { hideDone = !hideDone; $('#toggle-done-view').textContent = hideDone ? 'Показать выполненные' : 'Скрыть выполненные'; renderTasks(); };
$('#edit-schedule-btn').onclick = () => {
  if (!requireLogin()) return;
  openModal(`<h2>✏️ Внести правки в расписание</h2>
    <div class="sub">Выберите пару прямо в расписании (кнопки ✖ / 📝 / ✏️) или добавьте новую — всё уходит админу на утверждение с вашей подписью.</div>
    <div style="margin-top:10px"><button class="btn primary" id="ps-add" style="width:100%">➕ Предложить новую пару</button></div>
    <div style="margin-top:8px"><button class="btn ghost" style="width:100%" onclick="closeModal()">Закрыть</button></div>`);
  $('#ps-add').onclick = proposeAdd;
};

/* старт */
(async () => {
  try { ME = (await api('/api/me')).user; } catch (e) {}
  renderAuth();
  try {
    await loadSchedule(); await loadNotes(); await loadTasks(); await loadAnns();
  } catch (e) { toast('Не удалось загрузить расписание', false); }
})();

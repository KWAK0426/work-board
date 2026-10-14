import {
  URGENCY, URGENCY_RANK, STATUS, ACTIVE_STATUSES, REVIEW_STATE, MANUAL_REVIEW_STATES, CHANNEL,
  SOURCE_TYPE, VISIBILITY, daysBetween, derive, todayKst,
} from './shared.js';

// ---- 안전한 HTML 템플릿 (값은 기본 이스케이프) ---------------------------------
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
function show(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(show).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += show(vals[i]); });
  return raw(out);
}
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = () => $('#main');
let fieldSeq = 0;
// 라벨과 입력칸을 연결해 화면 낭독기·클릭 영역이 동작하게 한다.
function linkLabels(root) {
  for (const field of root.querySelectorAll('.field')) {
    const label = field.querySelector(':scope > label');
    const input = field.querySelector('input, select, textarea');
    if (!label || !input || label.htmlFor) continue;
    if (!input.id) input.id = `f${++fieldSeq}`;
    label.htmlFor = input.id;
  }
}
const mount = (el, tpl) => { el.innerHTML = tpl.s; linkLabels(el); };

// ---- 상태 -------------------------------------------------------------------
const S = {
  me: null,
  today: null,
  tasks: [],
  projects: [],
  filter: { chip: 'all', project: '', q: '', sort: 'code', showClosed: false },
  cand: { currentId: null, skipped: new Set() },
};
const isOwner = () => S.me?.role === 'owner';
const PROFESSOR_DEFAULT = '김원국 교수님';

// GitHub Pages에 올라간 읽기 전용 페이지는 서버 대신 data.json을 읽는다.
const STATIC = document.documentElement.dataset.mode === 'static';
let SITE = null;
async function staticApi(method, url) {
  if (method !== 'GET') throw new Error('읽기 전용 페이지입니다');
  if (!SITE) {
    const res = await fetch('data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('게시된 데이터를 불러오지 못했습니다');
    SITE = await res.json();
  }
  const today = todayKst();
  const dec = ({ reviews, activity, ...t }) => ({ ...t, derived: derive(t, t.latest_review, today) });
  const path = url.split('?')[0];
  if (path === '/api/me') {
    return { user: { display_name: SITE.owner_name, role: 'viewer' }, today, mode: 'static', generated_at: SITE.generated_at };
  }
  if (path === '/api/tasks') return SITE.tasks.map(dec);
  if (path === '/api/projects') return SITE.projects;
  if (path === '/api/activity') return SITE.tasks.flatMap((t) => t.activity).sort((a, b) => b.id - a.id).slice(0, 500);
  const m = path.match(/^\/api\/tasks\/(\d+)$/);
  if (m) {
    const t = SITE.tasks.find((x) => x.id === Number(m[1]));
    if (!t) throw new Error('업무를 찾을 수 없습니다');
    return { ...dec(t), reviews: t.reviews, activity: t.activity };
  }
  throw new Error('없는 데이터');
}

async function api(method, url, body) {
  if (STATIC) return staticApi(method, url);
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-WB': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (res.status === 401 && url !== '/api/login') {
    S.me = null;
    renderLogin();
    throw new Error('로그인이 필요합니다');
  }
  if (!res.ok) throw new Error((isJson && data.error) || `오류 (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (err ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, err ? 5000 : 2000);
}

async function loadAll() {
  const [tasks, projects] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/projects')]);
  S.tasks = tasks;
  S.projects = projects;
}

function stripDetail(d) {
  const { reviews, activity, ...t } = d;
  return t;
}
function upsertTask(d) {
  const t = stripDetail(d);
  const i = S.tasks.findIndex((x) => x.id === t.id);
  if (i >= 0) S.tasks[i] = t; else S.tasks.push(t);
}
async function refreshProjects() { S.projects = await api('GET', '/api/projects'); }

// ---- 표시 도우미 ---------------------------------------------------------------
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00Z');
  const md = `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${WEEK[dt.getUTCDay()]})`;
  return d.slice(0, 4) === S.today.slice(0, 4) ? md : `${d.slice(0, 4)}/${md}`;
}
function dday(d) {
  const n = daysBetween(S.today, d);
  if (n === 0) return 'D-day';
  return n > 0 ? `D-${n}` : `D+${-n}`;
}
function fmtTs(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
}
const fmtReviewedAt = (s) => (s ? s.replace('T', ' ') : '');
function nowKstLocal() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T').slice(0, 16);
}

const urgBadge = (u) => (u ? html`<span class="badge u-${u}">${URGENCY[u]}</span>` : html`<span class="badge u-none">미평가</span>`);
const otherUrgBadge = (u) => (u ? urgBadge(u) : html`<span class="badge u-none">미확인</span>`);
function dateText(d, emptyLabel = '미정') {
  if (!d) return html`<span class="muted">${emptyLabel}</span>`;
  return html`<span class="nowrap">${fmtDate(d)}</span> <span class="sub">${dday(d)}</span>`;
}
const statusBadge = (s) => html`<span class="badge ${s === 'blocked' ? 'b-bad' : s === 'waiting' ? 'b-warn' : s === 'in_progress' ? 'b-info' : s === 'done' ? 'b-ok' : ''}">${STATUS[s]}</span>`;
function reviewBadge(rs) {
  const cls = rs === 'confirmed' ? 'b-ok' : rs === 'recheck' ? 'b-warn' : rs === 'not_needed' ? '' : 'b-info';
  return html`<span class="badge ${cls}">${REVIEW_STATE[rs]}</span>`;
}
function dueDiffText(n) {
  if (n === null || n === undefined) return '';
  if (n === 0) return '기한 같음';
  return n > 0 ? `내 평가가 ${n}일 늦음` : `내 평가가 ${-n}일 빠름`;
}
function cmpBadge(t) {
  const d = t.derived;
  if (d.mismatch) return html`<span class="badge b-bad">판단 불일치</span>`;
  if (d.urgency_cmp === 'unknown' && d.due_cmp === 'unknown') return html`<span class="badge u-none">미확인</span>`;
  if (d.urgency_cmp === 'self_missing' || d.due_cmp === 'self_missing') return html`<span class="badge b-warn">본인 평가 없음</span>`;
  return html`<span class="badge b-ok">일치</span>`;
}
function flags(t) {
  const d = t.derived;
  const out = [];
  if (d.due_flag === 'overdue') out.push(html`<span class="badge b-bad">기한 경과 (${d.effective_due.label})</span>`);
  else if (d.due_flag === 'upcoming') out.push(html`<span class="badge b-warn">임박 ${dday(d.effective_due.date)}</span>`);
  for (const c of d.conflicts) out.push(html`<span class="badge b-bad">일정 충돌: ${c}</span>`);
  for (const m of d.self_missing) out.push(html`<span class="badge b-warn">${m}</span>`);
  if (d.no_next_action) out.push(html`<span class="badge b-warn">다음 행동 없음</span>`);
  return out.length ? html`<div class="flags">${out}</div>` : '';
}
const options = (map, sel, keys = Object.keys(map)) => keys.map((k) => html`<option value="${k}" ${k === sel ? raw('selected') : ''}>${map[k]}</option>`);
const urgencyOptions = (sel, emptyLabel = '미평가') => [html`<option value="">${emptyLabel}</option>`, options(URGENCY, sel ?? '')];
const projectOptions = (sel) => S.projects.map((p) => html`<option value="${p.id}" ${p.id === Number(sel) ? raw('selected') : ''}>${p.code} · ${p.title}</option>`);

// ---- 로그인 -------------------------------------------------------------------
function renderLogin() {
  $('#topbar').hidden = true;
  mount(main(), html`
    <form class="card login" id="login-form">
      <h1>업무 게시판</h1>
      <p class="muted">등록된 계정으로 로그인하세요.</p>
      <div class="field"><label for="email">이메일</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <p class="small b-bad badge" id="login-err" hidden></p>
      <button class="primary" type="submit">로그인</button>
    </form>`);
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/login', { email: f.get('email'), password: f.get('password') });
      await boot();
    } catch (err) {
      const el = $('#login-err');
      el.textContent = err.message;
      el.hidden = false;
    }
  });
}

// ---- 상단 메뉴 -----------------------------------------------------------------
function renderNav(page) {
  const cands = S.tasks.filter((t) => t.status === 'candidate').length;
  const items = isOwner()
    ? [['calendar', '캘린더'], ['today', '오늘 할 일'], ['tasks', '전체 업무'], ['compare', '판단 비교'], ['projects', '프로젝트'], ['history', '변경 이력'], ['candidates', '등록 후보', cands]]
    : [['calendar', '캘린더'], ['today', '현황 요약'], ['tasks', '전체 업무'], ['compare', '판단 비교'], ['projects', '프로젝트'], ['history', '변경 이력']];
  mount($('#nav'), html`${items.map(([k, label, n]) => html`<a href="#/${k}" class="${page === k || (page === 'task' && k === 'tasks') ? 'on' : ''}">${label}${n ? html`<span class="count">${n}</span>` : ''}</a>`)}`);
  if (S.mode === 'static') {
    mount($("#who"), html`${S.me.display_name ? `${S.me.display_name}의 업무 ` : ""}<span class="role-badge">읽기 전용 · ${fmtTs(S.generatedAt)} 게시</span>`);
  } else {
    mount($('#who'), html`${S.me.display_name} <span class="role-badge">${isOwner() ? (S.mode === 'local' ? '내 PC' : '편집') : '열람 전용'}</span>
      ${S.canPublish ? html`<button type="button" class="primary small-btn" id="publish">GitHub에 게시</button>` : ''}`);
    $('#publish')?.addEventListener('click', publishNow);
  }
  $('#logout').hidden = S.mode !== 'server';
  $('#topbar').hidden = false;
}

// ---- 라우터 -------------------------------------------------------------------
function route() {
  if (!S.me) return renderLogin();
  const m = (location.hash || '#/calendar').match(/^#\/([a-z]+)(?:\/(\d+))?/) || [];
  let page = m[1] || 'calendar';
  if (!isOwner() && page === 'candidates') page = 'calendar';
  renderNav(page);
  closeModal();
  window.scrollTo(0, 0);
  const views = { calendar: renderCalendar, today: renderToday, tasks: renderTasks, compare: renderCompare, projects: renderProjects, history: renderHistory, candidates: renderCandidates, task: () => renderTask(m[2]) };
  (views[page] || renderCalendar)();
}
function rerender() {
  const m = (location.hash || '#/calendar').match(/^#\/([a-z]+)/);
  const page = m?.[1] || 'calendar';
  renderNav(page);
  if (page === 'calendar') renderCalendar();
  else if (page === 'tasks') renderTasks();
  else if (page === 'today') renderToday();
  else if (page === 'compare') renderCompare();
  else route();
}

// ---- 캘린더 -------------------------------------------------------------------
S.cal = { month: null, selected: null };
const KIND_LABEL = { mine: '내 마감', other: '확인된 기한', ext: '외부 고정 일정', follow: '대기 재확인' };

function addDaysStr(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1 + n, 1));
  return x.toISOString().slice(0, 7);
}

// 날짜 → 그날 걸린 일정 목록. 내 마감일과 확인된 기한이 다르면 두 날짜에 각각 표시한다.
function calendarEvents() {
  const map = new Map();
  const push = (date, kind, t) => {
    if (!map.has(date)) map.set(date, []);
    map.get(date).push({ date, kind, t, closed: t.status === 'done' });
  };
  for (const t of S.tasks) {
    if (t.status === 'candidate' || t.status === 'dropped') continue;
    if (t.my_due_date) push(t.my_due_date, 'mine', t);
    const od = t.derived.other_due_date;
    if (od && od !== t.my_due_date) push(od, 'other', t);
    if (t.external_deadline && t.external_deadline !== t.my_due_date) push(t.external_deadline, 'ext', t);
    if (t.status === 'waiting' && t.follow_up_date) push(t.follow_up_date, 'follow', t);
  }
  const kr = { mine: 0, other: 1, ext: 2, follow: 3 };
  for (const list of map.values()) {
    list.sort((a, b) => a.closed - b.closed || kr[a.kind] - kr[b.kind]
      || (URGENCY_RANK[a.t.my_urgency] ?? 9) - (URGENCY_RANK[b.t.my_urgency] ?? 9));
  }
  return map;
}

function evLate(e) {
  return !e.closed && ACTIVE_STATUSES.includes(e.t.status) && e.date < S.today && e.kind !== 'follow';
}
function calChip(e) {
  const t = e.t;
  const drag = isOwner() && e.kind === 'mine' && !e.closed;
  const prefix = e.kind === 'other' ? `${t.latest_review?.reviewer_name ?? '확인'} · ` : e.kind === 'ext' ? '⚑ ' : e.kind === 'follow' ? '↻ ' : '';
  const agreed = e.kind === 'mine' && t.derived.due_cmp === 'match';
  return html`<a class="ev k-${e.kind} u-${t.my_urgency ?? 'none'} ${e.closed ? 'closed' : ''} ${evLate(e) ? 'late' : ''}"
      href="#/task/${t.id}" draggable="${drag ? 'true' : 'false'}" data-task="${t.id}"
      title="${KIND_LABEL[e.kind]} · ${t.task_code} ${t.title}">${prefix}${t.title}${agreed ? html`<span class="ev-ok" aria-label="확인된 기한과 같음">✓</span>` : ''}</a>`;
}

function renderCalendar() {
  const owner = isOwner();
  if (!S.cal.month) S.cal.month = S.today.slice(0, 7);
  if (!S.cal.selected) S.cal.selected = S.today;
  const [y, mo] = S.cal.month.split('-').map(Number);
  const first = `${S.cal.month}-01`;
  const firstDow = new Date(first + 'T00:00:00Z').getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const start = addDaysStr(first, -firstDow);
  const cellCount = Math.ceil((firstDow + daysInMonth) / 7) * 7;
  const events = calendarEvents();

  const active = S.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const weekEnd = addDaysStr(S.today, 6 - new Date(S.today + 'T00:00:00Z').getUTCDay());
  const overdueN = active.filter((t) => t.derived.due_flag === 'overdue').length;
  const weekN = active.filter((t) => t.derived.effective_due && t.derived.effective_due.date >= S.today && t.derived.effective_due.date <= weekEnd).length;
  const reviewN = active.filter((t) => t.derived.review_needed).length;
  const undated = active.filter((t) => !t.my_due_date)
    .sort((a, b) => (URGENCY_RANK[a.my_urgency] ?? 9) - (URGENCY_RANK[b.my_urgency] ?? 9));
  const cands = S.tasks.filter((t) => t.status === 'candidate').length;

  const cells = [];
  for (let i = 0; i < cellCount; i++) {
    const d = addDaysStr(start, i);
    const list = events.get(d) ?? [];
    const dow = i % 7;
    cells.push(html`<div class="cal-cell dow-${dow} ${d.slice(0, 7) === S.cal.month ? '' : 'out'} ${d === S.today ? 'today' : ''} ${d === S.cal.selected ? 'sel' : ''}" data-date="${d}">
      <div class="cal-date">
        <button type="button" class="num" data-sel="${d}" aria-label="${fmtDate(d)} 일정 ${list.length}건">${Number(d.slice(8))}</button>
        ${owner ? html`<button type="button" class="cal-add" data-add="${d}" aria-label="${fmtDate(d)}에 업무 추가" title="이 날짜로 새 업무">+</button>` : ''}
      </div>
      <div class="cal-evs">${list.slice(0, 3).map(calChip)}${list.length > 3 ? html`<button type="button" class="more" data-sel="${d}">+${list.length - 3}건 더</button>` : ''}</div>
      <div class="cal-dots" aria-hidden="true">${list.slice(0, 4).map((e) => html`<i class="dot k-${e.kind} u-${e.t.my_urgency ?? 'none'} ${evLate(e) ? 'late' : ''}"></i>`)}</div>
    </div>`);
  }

  const sel = S.cal.selected;
  const selList = events.get(sel) ?? [];
  const dayItem = (e) => {
    const t = e.t;
    return html`<a class="ev-item" href="#/task/${t.id}">
      <div class="ev-item-top"><span class="ev-kind k-${e.kind}">${KIND_LABEL[e.kind]}</span><span class="muted small">${t.task_code}</span>${evLate(e) ? html`<span class="badge b-bad">기한 경과</span>` : ''}</div>
      <div class="ev-item-title ${e.closed ? 'del' : ''}">${t.title}</div>
      <div class="flags">${urgBadge(t.my_urgency)} ${statusBadge(t.status)} ${cmpBadge(t)}</div>
      ${e.kind === 'other' ? html`<div class="small muted">내 마감일: ${t.my_due_date ? fmtDate(t.my_due_date) : '미정'} · ${dueDiffText(t.derived.due_diff_days)}</div>` : ''}
      ${e.kind === 'ext' && t.external_deadline_source ? html`<div class="small muted">출처: ${t.external_deadline_source}</div>` : ''}
      ${t.next_action && !e.closed ? html`<div class="small">→ ${t.next_action}</div>` : ''}
    </a>`;
  };

  mount(main(), html`
    <div class="cal">
      <div class="cal-main">
        <div class="cal-head">
          <div class="cal-title">${y}년 ${mo}월</div>
          <div class="cal-nav">
            <button type="button" data-month="-1" aria-label="이전 달">‹</button>
            <button type="button" data-month="0" class="today-btn">오늘</button>
            <button type="button" data-month="1" aria-label="다음 달">›</button>
          </div>
          <span class="spacer"></span>
          <div class="pills">
            <a class="pill ${overdueN ? 'bad' : ''}" href="#/tasks" data-chip-go="overdue"><b>${overdueN}</b> 기한 경과</a>
            <a class="pill" href="#/today"><b>${weekN}</b> 이번 주 마감</a>
            <a class="pill" href="#/compare"><b>${reviewN}</b> 확인 필요</a>
          </div>
          ${owner ? html`<button class="primary" type="button" data-add="${sel}">+ 새 업무</button>` : ''}
        </div>
        ${owner && cands ? html`<p class="banner slim">검토 안 한 등록 후보 <b>${cands}건</b>은 날짜가 없어 캘린더에 나오지 않습니다. <a href="#/candidates">검토하기 →</a></p>` : ''}
        <div class="cal-board">
          <div class="cal-week">${['일', '월', '화', '수', '목', '금', '토'].map((w, i) => html`<div class="cal-dow dow-${i}">${w}</div>`)}</div>
          <div class="cal-grid">${cells}</div>
        </div>
      </div>
      <aside class="cal-side">
        <section class="side-card">
          <div class="side-day">${Number(sel.slice(5, 7))}월 ${Number(sel.slice(8))}일 (${WEEK[new Date(sel + 'T00:00:00Z').getUTCDay()]}) ${sel === S.today ? html`<span class="badge b-info">오늘</span>` : html`<span class="muted small">${dday(sel)}</span>`}</div>
          ${selList.length ? html`<div class="ev-list">${selList.map(dayItem)}</div>` : html`<p class="muted small">이 날짜에 걸린 업무가 없습니다.</p>`}
          ${owner ? html`<button type="button" class="ghost-add" data-add="${sel}">+ 이 날짜로 업무 추가</button>` : ''}
        </section>
        ${undated.length ? html`<section class="side-card">
          <h3>내 마감일 미정 <span class="muted">${undated.length}</span></h3>
          ${owner ? html`<p class="small muted">달력의 날짜로 끌어다 놓으면 내 마감일이 정해집니다.</p>` : ''}
          <div class="undated">${undated.map((t) => html`<a class="ev k-mine u-${t.my_urgency ?? 'none'}" href="#/task/${t.id}" draggable="${owner ? 'true' : 'false'}" data-task="${t.id}">${t.title}</a>`)}</div>
        </section>` : ''}
        <section class="side-card legend">
          <div><i class="sw u-super"></i>초시급 <i class="sw u-urgent"></i>시급 <i class="sw u-routine"></i>일상 <i class="sw u-none"></i>미평가</div>
          <div><i class="sw k-other"></i>교수님·관계자에게 확인한 기한 (내 마감일과 다를 때)</div>
          <div><i class="sw k-ext"></i>외부 고정 일정 &nbsp; <span class="ev-ok">✓</span> 확인된 기한과 같음</div>
        </section>
      </aside>
    </div>`);

  const root = $('.cal');
  root.addEventListener('click', (e) => {
    const m = e.target.closest('[data-month]');
    if (m) {
      const n = Number(m.dataset.month);
      S.cal.month = n === 0 ? S.today.slice(0, 7) : shiftMonth(S.cal.month, n);
      if (n === 0) S.cal.selected = S.today;
      return renderCalendar();
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      S.cal.selected = add.dataset.add;
      return newTaskModal({ due: add.dataset.add, onDone: () => renderCalendar() });
    }
    if (e.target.closest('a')) {
      const go = e.target.closest('[data-chip-go]');
      if (go) { S.filter.chip = go.dataset.chipGo; S.filter.showClosed = false; }
      return;
    }
    const cell = e.target.closest('[data-sel], .cal-cell');
    if (cell) {
      S.cal.selected = cell.dataset.sel || cell.dataset.date;
      renderCalendar();
    }
  });

  if (!owner) return;
  // 끌어다 놓기로 내 마감일 변경 (변경 이력에 남음)
  root.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-task][draggable="true"]');
    if (!chip) return;
    e.dataTransfer.setData('text/plain', chip.dataset.task);
    e.dataTransfer.effectAllowed = 'move';
    chip.classList.add('dragging');
  });
  root.addEventListener('dragend', () => $$('.dragging, .drop-hover').forEach((el) => el.classList.remove('dragging', 'drop-hover')));
  root.addEventListener('dragover', (e) => {
    const cell = e.target.closest('.cal-cell');
    if (!cell) return;
    e.preventDefault();
    $$('.drop-hover').forEach((el) => el !== cell && el.classList.remove('drop-hover'));
    cell.classList.add('drop-hover');
  });
  root.addEventListener('drop', async (e) => {
    const cell = e.target.closest('.cal-cell');
    if (!cell) return;
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain'));
    const t = S.tasks.find((x) => x.id === id);
    const to = cell.dataset.date;
    if (!t || t.my_due_date === to) return renderCalendar();
    try {
      upsertTask(await api('PATCH', `/api/tasks/${id}`, { my_due_date: to, reason: '캘린더에서 날짜 이동' }));
      toast(`${t.task_code} 내 마감일 ${t.my_due_date ? fmtDate(t.my_due_date) : '미정'} → ${fmtDate(to)}`);
    } catch (err) { toast(err.message, true); }
    S.cal.selected = to;
    renderCalendar();
  });
}

// ---- 오늘 할 일 ----------------------------------------------------------------
function taskLine(t, extra = '') {
  return html`<li>
    <a href="#/task/${t.id}"><span class="muted small">${t.task_code}</span> ${t.title}</a>
    <div class="flags">${urgBadge(t.my_urgency)} ${t.my_due_date ? html`<span class="badge">내 마감 ${fmtDate(t.my_due_date)}</span>` : ''} ${statusBadge(t.status)} ${extra}</div>
  </li>`;
}
function bucket(title, list, render, emptyMsg) {
  return html`<section class="card bucket"><h2>${title} <span class="n">${list.length}건</span></h2>
    ${list.length ? html`<ul>${list.map(render)}</ul>` : html`<p class="muted small">${emptyMsg}</p>`}</section>`;
}
function renderToday() {
  const active = S.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const byDue = (a, b) => (a.derived.effective_due?.date || '9999') < (b.derived.effective_due?.date || '9999') ? -1 : 1;
  const overdue = active.filter((t) => t.derived.due_flag === 'overdue').sort(byDue);
  const upcoming = active.filter((t) => t.derived.due_flag === 'upcoming').sort(byDue);
  const dueExtra = (t) => html`<span class="badge ${t.derived.due_flag === 'overdue' ? 'b-bad' : 'b-warn'}">${t.derived.effective_due.label} ${fmtDate(t.derived.effective_due.date)} · ${dday(t.derived.effective_due.date)}</span>`;
  const cands = S.tasks.filter((t) => t.status === 'candidate').length;

  if (!isOwner()) {
    const mismatch = active.filter((t) => t.derived.mismatch);
    const stuck = active.filter((t) => t.status === 'blocked' || t.status === 'waiting');
    mount(main(), html`
      <div class="page-head"><div><h1>현황 요약</h1><p class="muted">진행 업무 ${active.length}건 · 오늘 ${fmtDate(S.today)} (KST)</p></div>
        <a class="btn" href="#/tasks">전체 업무 표 보기</a></div>
      <p class="banner">이 화면은 열람 전용입니다. 열람만으로 어떤 업무도 '확인'이나 '승인'으로 바뀌지 않습니다.</p>
      <div class="grid2">
        ${bucket('기한 경과', overdue, (t) => taskLine(t, dueExtra(t)), '기한이 지난 업무가 없습니다.')}
        ${bucket('다가오는 기한 (3일 이내)', upcoming, (t) => taskLine(t, dueExtra(t)), '임박한 업무가 없습니다.')}
        ${bucket('본인 판단과 확인된 판단이 다른 업무', mismatch, (t) => taskLine(t, html`<span class="badge b-bad">확인: ${URGENCY[t.derived.other_urgency] ?? '-'} ${t.derived.other_due_date ? fmtDate(t.derived.other_due_date) : ''}</span> <span class="small muted">${dueDiffText(t.derived.due_diff_days)}</span>`), '불일치 항목이 없습니다.')}
        ${bucket('차단·응답 대기', stuck, (t) => taskLine(t, html`<span class="small muted">${t.blocked_reason}</span>`), '대기·차단된 업무가 없습니다.')}
      </div>`);
    return;
  }

  const review = active.filter((t) => t.derived.review_needed);
  const doing = active.filter((t) => t.status === 'in_progress');
  const unrated = active.filter((t) => t.derived.self_missing.length);
  const followUp = active.filter((t) => t.status === 'waiting' && t.follow_up_date && t.follow_up_date <= S.today);
  mount(main(), html`
    <div class="page-head"><div><h1>오늘 할 일</h1><p class="muted">${fmtDate(S.today)} (KST) · 진행 업무 ${active.length}건</p></div>
      <button class="primary" data-action="new-task">+ 새 업무</button></div>
    ${cands ? html`<p class="banner">기획서에서 가져온 <b>등록 후보 ${cands}건</b>이 아직 검토되지 않았습니다. 지금도 필요한 일인지 하나씩 확인하세요. <a href="#/candidates">등록 후보 검토 →</a></p>` : ''}
    ${unrated.length ? html`<p class="banner warn">본인 평가가 빠진 업무 ${unrated.length}건: ${unrated.slice(0, 6).map((t) => html`<a href="#/task/${t.id}">${t.task_code}</a> `)}${unrated.length > 6 ? '…' : ''} — 시급성과 마감일을 먼저 스스로 정하세요.</p>` : ''}
    ${followUp.length ? html`<p class="banner warn">재확인일이 된 대기 업무 ${followUp.length}건: ${followUp.map((t) => html`<a href="#/task/${t.id}">${t.task_code}</a> `)}</p>` : ''}
    <div class="grid2">
      ${bucket('기한 경과', overdue, (t) => taskLine(t, dueExtra(t)), '기한이 지난 업무가 없습니다.')}
      ${bucket('다가오는 기한 (3일 이내)', upcoming, (t) => taskLine(t, dueExtra(t)), '임박한 업무가 없습니다.')}
      ${bucket('판단 확인 필요', review, (t) => taskLine(t, reviewBadge(t.review_state)), '확인이 필요한 업무가 없습니다.')}
      ${bucket('지금 할 일 (진행 중)', doing, (t) => taskLine(t, t.next_action ? html`<span class="small">→ ${t.next_action}</span>` : html`<span class="badge b-warn">다음 행동 없음</span>`), '진행 중인 업무가 없습니다.')}
    </div>`);
}

// ---- 전체 업무 표 ----------------------------------------------------------------
const CHIPS = [
  ['all', '전체', () => true],
  ['super', '초시급', (t) => t.my_urgency === 'super' || t.derived.other_urgency === 'super'],
  ['overdue', '기한 경과', (t) => t.derived.due_flag === 'overdue'],
  ['mismatch', '판단 불일치', (t) => t.derived.mismatch],
  ['review', '확인 필요', (t) => t.derived.review_needed],
  ['in_progress', '진행 중', (t) => t.status === 'in_progress'],
  ['waiting', '대기·차단', (t) => t.status === 'waiting' || t.status === 'blocked'],
  ['unrated', '본인 평가 누락', (t) => t.derived.self_missing.length > 0],
];
// 기본 순서: 프로젝트 등록 순(기획서 순서) → 업무 ID
function byProjectThenCode(a, b) {
  const pa = S.projects.findIndex((p) => p.id === a.project_id);
  const pb = S.projects.findIndex((p) => p.id === b.project_id);
  return pa - pb || a.task_code.localeCompare(b.task_code);
}
const SORTS = {
  code: ['프로젝트·ID 순', byProjectThenCode],
  my_due: ['내 마감일 순', (a, b) => cmpNullLast(a.my_due_date, b.my_due_date)],
  other_due: ['확인된 기한 순', (a, b) => cmpNullLast(a.derived.other_due_date, b.derived.other_due_date)],
  urgency: ['내 시급성 순', (a, b) => (URGENCY_RANK[a.my_urgency] ?? 9) - (URGENCY_RANK[b.my_urgency] ?? 9)],
  updated: ['최근 수정 순', (a, b) => (b.updated_at > a.updated_at ? 1 : -1)],
};
function cmpNullLast(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}
function baseList() {
  const f = S.filter;
  let list = S.tasks.filter((t) => t.status !== 'candidate');
  if (!f.showClosed) list = list.filter((t) => ACTIVE_STATUSES.includes(t.status));
  if (f.project) list = list.filter((t) => String(t.project_id) === f.project);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((t) => `${t.task_code} ${t.title} ${t.next_action ?? ''}`.toLowerCase().includes(q));
  }
  return list;
}

function renderTasks() {
  const f = S.filter;
  const base = baseList();
  const pred = CHIPS.find((c) => c[0] === f.chip)?.[2] ?? (() => true);
  const list = base.filter(pred).sort((a, b) => SORTS[f.sort][1](a, b) || a.task_code.localeCompare(b.task_code));
  const owner = isOwner();
  const cands = S.tasks.filter((t) => t.status === 'candidate').length;

  const row = (t) => {
    const d = t.derived;
    const closed = !ACTIVE_STATUSES.includes(t.status);
    const r = t.latest_review;
    return html`<tr class="${d.due_flag === 'overdue' ? 'overdue' : ''} ${closed ? 'closed' : ''}">
      <td class="code">${t.task_code}</td>
      <td class="nowrap">${t.project_code}</td>
      <td class="title"><a href="#/task/${t.id}">${t.title}</a>
        ${t.next_action && !closed ? html`<span class="sub">→ ${t.next_action}</span>` : ''}
        ${t.status === 'waiting' || t.status === 'blocked' ? html`<span class="sub">${t.status === 'waiting' ? '대기' : '차단'}: ${t.blocked_reason}${t.follow_up_date ? ` · 재확인 ${fmtDate(t.follow_up_date)}` : ''}</span>` : ''}
        ${flags(t)}</td>
      <td class="mine mine-first">${owner && !closed
        ? html`<select class="urg" data-field="my_urgency" data-id="${t.id}" aria-label="내 시급성">${urgencyOptions(t.my_urgency)}</select>`
        : urgBadge(t.my_urgency)}</td>
      <td class="mine nowrap">${owner && !closed
        ? html`<input type="date" data-field="my_due_date" data-id="${t.id}" value="${t.my_due_date ?? ''}" aria-label="내 마감일">${t.my_due_date ? html`<span class="sub">${dday(t.my_due_date)}</span>` : ''}`
        : dateText(t.my_due_date)}</td>
      <td class="other-first">${otherUrgBadge(d.other_urgency)}</td>
      <td class="nowrap">${dateText(d.other_due_date, '미확인')}${r ? html`<span class="sub">${r.reviewer_name} · ${CHANNEL[r.review_channel]}</span>` : ''}</td>
      <td>${cmpBadge(t)}${d.due_diff_days ? html`<span class="sub">${dueDiffText(d.due_diff_days)}</span>` : ''}</td>
      <td>${reviewBadge(t.review_state)}</td>
      <td>${owner
        ? html`<select data-field="status" data-id="${t.id}" aria-label="진행 상태">${options(STATUS, t.status, Object.keys(STATUS).filter((k) => k !== 'candidate'))}</select>`
        : statusBadge(t.status)}</td>
    </tr>`;
  };
  const card = (t) => html`<a class="task-card" href="#/task/${t.id}">
      <div class="small muted">${t.task_code} · ${t.project_code} · ${STATUS[t.status]}</div>
      <div class="t">${t.title}</div>
      <div class="meta">나 ${urgBadge(t.my_urgency)} ${t.my_due_date ? `${fmtDate(t.my_due_date)} ${dday(t.my_due_date)}` : '마감 미정'}
        <span class="muted">│</span> 확인 ${otherUrgBadge(t.derived.other_urgency)} ${t.derived.other_due_date ? fmtDate(t.derived.other_due_date) : ''} ${cmpBadge(t)}</div>
      ${flags(t)}
    </a>`;

  mount(main(), html`
    <div class="page-head">
      <div><h1>전체 업무</h1><p class="muted">왼쪽은 <b>내 판단</b>, 오른쪽은 <b>교수님·관계자에게 확인한 판단</b>입니다. 확인 기록이 없으면 '미확인'으로 표시됩니다.</p></div>
      ${owner ? html`<div class="row"><a class="btn" href="/api/export.csv">CSV 내보내기</a><a class="btn" href="/api/export.json">JSON 백업</a><button class="primary" data-action="new-task">+ 새 업무</button></div>` : ''}
    </div>
    ${owner && cands ? html`<p class="banner">등록 후보 ${cands}건은 이 표에 나오지 않습니다. <a href="#/candidates">등록 후보 검토 →</a></p>` : ''}
    <div class="toolbar">
      ${CHIPS.map(([k, label, p]) => html`<button class="chip ${f.chip === k ? 'on' : ''}" data-chip="${k}">${label} ${base.filter(p).length}</button>`)}
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="ID·업무명·다음 행동 검색" value="${f.q}">
      <select id="fproject" aria-label="프로젝트"><option value="">모든 프로젝트</option>${projectOptions(f.project)}</select>
      <select id="fsort" aria-label="정렬">${Object.entries(SORTS).map(([k, [label]]) => html`<option value="${k}" ${k === f.sort ? raw('selected') : ''}>${label}</option>`)}</select>
      <label class="nowrap"><input type="checkbox" id="fclosed" ${f.showClosed ? raw('checked') : ''} class="inline-check"> 완료·보류 포함</label>
    </div>
    ${list.length ? html`
      <div class="table-wrap"><table class="tasks">
        <thead><tr>
          <th>ID</th><th>프로젝트</th><th>업무명</th>
          <th class="mine-h">내 시급성</th><th>내 마감일</th>
          <th class="other-h">확인 시급성</th><th>확인 기한</th><th>판단 차이</th>
          <th>검토 상태</th><th>진행 상태</th>
        </tr></thead>
        <tbody>${list.map(row)}</tbody>
      </table></div>
      <div class="cards">${list.map(card)}</div>`
    : html`<div class="card empty">${S.tasks.some((t) => t.status !== 'candidate') ? '조건에 맞는 업무가 없습니다.' : owner ? '아직 등록된 업무가 없습니다. "+ 새 업무"로 등록하거나 등록 후보를 검토하세요.' : '게시된 업무가 아직 없습니다.'}</div>`}
  `);

  $$('[data-chip]').forEach((b) => b.addEventListener('click', () => { S.filter.chip = b.dataset.chip; renderTasks(); }));
  $('#q').addEventListener('input', (e) => {
    S.filter.q = e.target.value;
    const pos = e.target.selectionStart;
    renderTasks();
    const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos);
  });
  $('#fproject').addEventListener('change', (e) => { S.filter.project = e.target.value; renderTasks(); });
  $('#fsort').addEventListener('change', (e) => { S.filter.sort = e.target.value; renderTasks(); });
  $('#fclosed').addEventListener('change', (e) => { S.filter.showClosed = e.target.checked; renderTasks(); });
  $$('table.tasks [data-field]').forEach((el) => el.addEventListener('change', () => inlineEdit(el)));
}

async function inlineEdit(el) {
  const id = Number(el.dataset.id);
  const field = el.dataset.field;
  const t = S.tasks.find((x) => x.id === id);
  const body = { [field]: el.value || null };
  if (field === 'status' && (el.value === 'waiting' || el.value === 'blocked')) {
    const extra = await waitingDialog(t, el.value);
    if (!extra) return renderTasks();
    Object.assign(body, extra);
  }
  try {
    upsertTask(await api('PATCH', `/api/tasks/${id}`, body));
    toast(`${t.task_code} 저장됨`);
  } catch (e) {
    toast(e.message, true);
  }
  rerender();
}

// ---- 모달 -------------------------------------------------------------------
function openModal(tpl) {
  mount($('#modal-root'), html`<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">${tpl}</div></div>`);
  const back = $('.modal-back');
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
  const first = $('.modal input, .modal select, .modal textarea');
  if (first) first.focus();
  return $('.modal');
}
function closeModal() {
  const root = $('#modal-root');
  if (root.onclose) { const f = root.onclose; root.onclose = null; f(); }
  root.innerHTML = '';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal(); });

function waitingDialog(t, status) {
  return new Promise((resolve) => {
    const m = openModal(html`
      <h2>${STATUS[status]}로 변경 — ${t.task_code}</h2>
      <form id="wf">
        <div class="field"><label>${status === 'waiting' ? '무엇을 기다리는지 (대기 사유)' : '차단 사유와 해결 방법'} *</label><textarea name="blocked_reason" required>${t.blocked_reason ?? ''}</textarea></div>
        <div class="row">
          <div class="field"><label>대기 대상 (누구에게)</label><input name="waiting_on" value="${t.waiting_on ?? ''}"></div>
          <div class="field"><label>재확인일</label><input type="date" name="follow_up_date" value="${t.follow_up_date ?? ''}"></div>
        </div>
        <div class="actions"><button type="button" data-cancel>취소</button><button class="primary" type="submit">변경</button></div>
      </form>`);
    let done = false;
    $('#modal-root').onclose = () => { if (!done) resolve(null); };
    $('[data-cancel]', m).addEventListener('click', closeModal);
    $('#wf', m).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      done = true;
      resolve({ status, blocked_reason: f.get('blocked_reason'), waiting_on: f.get('waiting_on') || null, follow_up_date: f.get('follow_up_date') || null });
      closeModal();
    });
  });
}

function newTaskModal({ due = null, onDone = null } = {}) {
  if (!S.projects.length) {
    toast('먼저 프로젝트를 만들어 주세요', true);
    location.hash = '#/projects';
    return;
  }
  const defProject = S.filter.project || S.projects[0].id;
  const m = openModal(html`
    <h2>새 업무 등록</h2>
    <form id="nt">
      <div class="field"><label>업무명 (수행할 행동) *</label><input name="title" required maxlength="300" placeholder="예: 이경도 박사님 메일 1차 회신"></div>
      <div class="field"><label>프로젝트 *</label><select name="project_id" required>${projectOptions(defProject)}</select></div>
      <div class="row">
        <div class="field"><label>내 시급성</label><select name="my_urgency">${urgencyOptions(null, '선택…')}</select></div>
        <div class="field"><label>내 마감일</label><input type="date" name="my_due_date" value="${due ?? ''}"></div>
      </div>
      <p class="hint">시급성과 마감일은 교수님께 묻기 전에 <b>내가 먼저</b> 정합니다. 확인 결과는 저장 후 상세 화면에서 따로 기록합니다.</p>
      <div class="field"><label>다음 행동</label><input name="next_action" placeholder="지금 바로 할 수 있는 가장 작은 행동"></div>
      <div class="row">
        <div class="field"><label>현재 상태</label><select name="status">${options(STATUS, 'todo', ACTIVE_STATUSES)}</select></div>
      </div>
      <div class="field" id="nt-reason" hidden><label>대기/차단 사유 *</label><input name="blocked_reason"></div>
      <div class="actions"><button type="button" data-cancel>취소</button><button class="primary" type="submit">등록</button></div>
    </form>`);
  const form = $('#nt', m);
  const syncReason = () => {
    const need = ['waiting', 'blocked'].includes(form.status.value);
    $('#nt-reason', m).hidden = !need;
    form.blocked_reason.required = need;
  };
  form.status.addEventListener('change', syncReason);
  $('[data-cancel]', m).addEventListener('click', closeModal);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    for (const k of Object.keys(f)) if (f[k] === '') f[k] = null;
    f.project_id = Number(f.project_id);
    try {
      const { id } = await api('POST', '/api/tasks', f);
      upsertTask(await api('GET', `/api/tasks/${id}`));
      await refreshProjects();
      closeModal();
      toast('등록됨');
      if (onDone) onDone(id); else location.hash = `#/task/${id}`;
    } catch (err) { toast(err.message, true); }
  });
}

function reviewModal(t) {
  const m = openModal(html`
    <h2>교수님·관계자 판단 기록 — ${t.task_code}</h2>
    <p class="small muted">현재 내 판단: ${URGENCY[t.my_urgency] ?? '미평가'} · ${t.my_due_date ? fmtDate(t.my_due_date) : '마감 미정'}. 이 값은 기록 시점의 스냅샷으로 함께 저장됩니다.</p>
    <form id="rv">
      <div class="row">
        <div class="field"><label>확인된 시급성</label><select name="other_urgency">${urgencyOptions(null, '언급 없음')}</select></div>
        <div class="field"><label>확인된 기한</label><input type="date" name="other_due_date"></div>
      </div>
      <div class="row">
        <div class="field"><label>의견 제공자 *</label><input name="reviewer_name" required value="${PROFESSOR_DEFAULT}"></div>
        <div class="field"><label>확인 경로 *</label><select name="review_channel" required>${options(CHANNEL, 'phone')}</select></div>
      </div>
      <div class="field"><label>확인 일시 (KST) *</label><input type="datetime-local" name="reviewed_at" required value="${nowKstLocal()}"></div>
      <div class="field"><label>들은 내용·근거 (공개 페이지에는 올라가지 않음)</label><textarea name="note" placeholder="예: '그건 일주일 안에 하라는 소리야'"></textarea></div>
      <label class="nowrap"><input type="checkbox" name="needs_recheck" class="inline-check"> 날짜·해석이 불분명함 → '재확인 필요'로 표시</label>
      <p class="hint">이 기록은 <b>${S.me.display_name}이(가) 옮겨 적은 의견</b>으로 표시되며, 교수님이 시스템에서 직접 확인한 것으로 표시되지 않습니다. 기록은 수정·삭제되지 않고 쌓입니다.</p>
      <div class="actions"><button type="button" data-cancel>취소</button><button class="primary" type="submit">기록</button></div>
    </form>`);
  $('[data-cancel]', m).addEventListener('click', closeModal);
  $('#rv', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.needs_recheck = !!f.needs_recheck;
    if (!f.other_urgency && !f.other_due_date) return toast('확인한 시급성 또는 기한 중 하나는 입력하세요', true);
    try {
      upsertTask(await api('POST', `/api/tasks/${t.id}/reviews`, f));
      closeModal();
      toast('확인 기록 추가됨');
      renderTask(t.id);
    } catch (err) { toast(err.message, true); }
  });
}

// ---- 업무 상세 ----------------------------------------------------------------
const FIELD_LABEL = {
  title: '업무명', description: '업무 목적·범위', expected_deliverable: '예상 산출물', done_criteria: '완료 기준',
  due_undecided_reason: '마감일 미정 사유', my_reason: '판단 이유', external_deadline: '외부 고정 일정',
  external_deadline_source: '외부 일정 출처', next_action: '다음 행동', waiting_on: '대기 대상',
  blocked_reason: '대기/차단 사유', follow_up_date: '재확인일', source_note: '출처 메모', project_id: '프로젝트',
  status: '진행 상태', my_urgency: '내 시급성', my_due_date: '내 마감일', review_state: '검토 상태',
  visibility: '공유', source_type: '출처 유형', review: '확인 기록', objective: '목표',
};
const EVENT_LABEL = { create: '생성', initial: '최초 입력', update: '변경', review_added: '판단 확인 기록', import: '기획서에서 가져옴', verified: '현황 확인' };
function fmtValue(field, v) {
  if (v === null || v === undefined || v === '') return '(없음)';
  const maps = { status: STATUS, my_urgency: URGENCY, review_state: REVIEW_STATE, visibility: VISIBILITY, source_type: SOURCE_TYPE };
  if (maps[field]) return maps[field][v] ?? v;
  if (field === 'project_id') return S.projects.find((p) => String(p.id) === String(v))?.code ?? v;
  return v;
}
function activityText(a) {
  if (a.event_type === 'review_added') return html`<b>판단 확인 기록</b> ${a.after}`;
  if (a.event_type === 'import' || a.event_type === 'create') return html`<b>${EVENT_LABEL[a.event_type]}</b> ${a.after ?? ''}`;
  if (a.event_type === 'verified') return html`<b>현황 확인</b>`;
  if (a.event_type === 'initial') return html`<b>${FIELD_LABEL[a.field] ?? a.field}</b> 최초 입력: ${fmtValue(a.field, a.after)}`;
  return html`<b>${FIELD_LABEL[a.field] ?? a.field}</b> <span class="del">${fmtValue(a.field, a.before)}</span><span class="arrow">→</span>${fmtValue(a.field, a.after)}`;
}

async function renderTask(id) {
  let t;
  try { t = await api('GET', `/api/tasks/${id}`); } catch (e) {
    mount(main(), html`<div class="card empty">${e.message} <a href="#/tasks">목록으로</a></div>`);
    return;
  }
  upsertTask(t);
  const d = t.derived;
  const owner = isOwner();
  const r = t.latest_review;
  const ro = (label, v, fmt = (x) => x) => html`<dt>${label}</dt><dd>${v ? fmt(v) : html`<span class="muted">-</span>`}</dd>`;

  const myPanel = owner ? html`
      <div class="row">
        <div class="field"><label>내 시급성</label><select name="my_urgency">${urgencyOptions(t.my_urgency)}</select></div>
        <div class="field"><label>내 마감일</label><input type="date" name="my_due_date" value="${t.my_due_date ?? ''}"></div>
      </div>
      <div class="field"><label>마감일을 정하기 어려운 이유 (반복·상시 업무 등)</label><input name="due_undecided_reason" value="${t.due_undecided_reason ?? ''}"></div>
      <div class="field"><label>이 시급성·기한으로 정한 이유</label><textarea name="my_reason">${t.my_reason ?? ''}</textarea></div>`
    : html`<dl class="kv">${ro('시급성', 1, () => urgBadge(t.my_urgency))}${ro('마감일', t.my_due_date, (x) => html`${fmtDate(x)} ${dday(x)}`)}${ro('판단 이유', t.my_reason)}${ro('마감 미정 사유', t.due_undecided_reason)}</dl>`;

  const otherPanel = html`
    ${r ? html`<dl class="kv">
        <dt>시급성</dt><dd>${otherUrgBadge(r.other_urgency)}</dd>
        <dt>기한</dt><dd>${r.other_due_date ? html`${fmtDate(r.other_due_date)} ${dday(r.other_due_date)}` : html`<span class="muted">언급 없음</span>`}</dd>
        <dt>의견 제공자</dt><dd>${r.reviewer_name}</dd>
        <dt>확인 방법</dt><dd>${CHANNEL[r.review_channel]} · ${fmtReviewedAt(r.reviewed_at)}</dd>
        <dt>기록</dt><dd>${r.recorded_by_name}이(가) 옮겨 적음${r.direct_confirmation ? ' (직접 확인)' : ''}</dd>
        ${r.note ? html`<dt>들은 내용</dt><dd>${r.note}</dd>` : ''}
      </dl>`
    : html`<p class="muted">아직 확인 기록이 없습니다 (<b>미확인</b>). 미확인은 '일치'가 아닙니다.</p>`}
    ${owner ? html`<p><button data-action="add-review">+ 판단 확인 기록 추가</button></p>` : ''}`;

  const compareResult = html`
    ${cmpBadge(t)}
    <span>시급성: ${d.urgency_cmp === 'match' ? '일치' : d.urgency_cmp === 'mismatch' ? html`<b>${URGENCY[t.my_urgency]} ↔ ${URGENCY[d.other_urgency]}</b>` : d.urgency_cmp === 'self_missing' ? '본인 미평가' : '미확인'}</span>
    <span class="muted">│</span>
    <span>기한: ${d.due_cmp === 'mismatch' ? html`<b>${dueDiffText(d.due_diff_days)}</b>` : d.due_cmp === 'match' ? '일치' : d.due_cmp === 'self_missing' ? '본인 마감일 없음' : '미확인'}</span>
    <span class="spacer"></span>
    <span>검토 상태</span>
    ${owner ? html`<select name="review_state" class="inline-select">${options(REVIEW_STATE, t.review_state, t.review_state === 'confirmed' ? ['confirmed', ...MANUAL_REVIEW_STATES] : MANUAL_REVIEW_STATES)}</select>` : reviewBadge(t.review_state)}`;

  const execPanel = owner ? html`
      <div class="row">
        <div class="field"><label>진행 상태</label><select name="status">${options(STATUS, t.status, t.status === 'candidate' ? Object.keys(STATUS) : Object.keys(STATUS).filter((k) => k !== 'candidate'))}</select></div>
        <div class="field"><label>재확인일 (대기 시)</label><input type="date" name="follow_up_date" value="${t.follow_up_date ?? ''}"></div>
      </div>
      <div class="field"><label>다음 행동 (지금 실행할 구체적인 한 단계)</label><input name="next_action" value="${t.next_action ?? ''}"></div>
      <div class="row">
        <div class="field"><label>대기/차단 사유</label><input name="blocked_reason" value="${t.blocked_reason ?? ''}"></div>
        <div class="field"><label>대기 대상</label><input name="waiting_on" value="${t.waiting_on ?? ''}"></div>
      </div>`
    : html`<dl class="kv">${ro('진행 상태', 1, () => statusBadge(t.status))}${ro('다음 행동', t.next_action)}${ro('대기/차단 사유', t.blocked_reason)}${ro('대기 대상', t.waiting_on)}${ro('재확인일', t.follow_up_date, fmtDate)}</dl>`;

  const scopePanel = owner ? html`
      <div class="field"><label>업무명</label><input name="title" value="${t.title}" required></div>
      <div class="field"><label>업무 목적·범위</label><textarea name="description">${t.description ?? ''}</textarea></div>
      <div class="row">
        <div class="field"><label>예상 산출물</label><textarea name="expected_deliverable">${t.expected_deliverable ?? ''}</textarea></div>
        <div class="field"><label>완료 기준</label><textarea name="done_criteria">${t.done_criteria ?? ''}</textarea></div>
      </div>`
    : html`<dl class="kv">${ro('업무 목적·범위', t.description)}${ro('예상 산출물', t.expected_deliverable)}${ro('완료 기준', t.done_criteria)}</dl>`;

  const extPanel = owner ? html`
      <div class="row">
        <div class="field"><label>외부 고정 일정 (학회·제출 마감 등)</label><input type="date" name="external_deadline" value="${t.external_deadline ?? ''}"></div>
        <div class="field"><label>일정 출처</label><input name="external_deadline_source" value="${t.external_deadline_source ?? ''}" placeholder="예: 학회 프로그램 공지"></div>
      </div>
      <p class="hint">외부 일정은 내 마감일이나 교수님 의견으로 덮어쓰지 않습니다. 더 이른 날짜가 기한 판단의 기준이 됩니다.</p>`
    : html`<dl class="kv">${ro('외부 고정 일정', t.external_deadline, fmtDate)}${ro('출처', t.external_deadline_source)}</dl>`;

  const metaPanel = owner ? html`
      <div class="row">
        <div class="field"><label>프로젝트</label><select name="project_id">${projectOptions(t.project_id)}</select></div>
        <div class="field"><label>출처 유형</label><select name="source_type"><option value="">-</option>${options(SOURCE_TYPE, t.source_type ?? '')}</select></div>
      </div>
      <div class="field"><label>출처 메모 · 작업 메모 (GitHub 공개 페이지에 올라가지 않음)</label><textarea name="source_note">${t.source_note ?? ''}</textarea></div>`
    : html`<dl class="kv">${ro('프로젝트', `${t.project_code} · ${t.project_title}`)}</dl>`;

  mount(main(), html`
    <div class="page-head">
      <div>
        <p class="muted small"><a href="#/tasks">← 전체 업무</a> · ${t.project_code} · ${t.project_title}</p>
        <h1>${t.task_code} ${t.title}</h1>
        <div class="flags">${statusBadge(t.status)} ${reviewBadge(t.review_state)} ${t.last_verified_at ? html`<span class="small muted">현황 확인 ${fmtTs(t.last_verified_at)}</span>` : ''}</div>
        ${flags(t)}
      </div>
    </div>
    <form id="tf" class="stack">
      <div class="compare">
        <section><h2>내 판단</h2>${myPanel}</section>
        <section><h2>교수님·관계자 판단</h2>${otherPanel}</section>
        <div class="compare-result">${compareResult}</div>
      </div>
      <div class="grid2">
        <section class="card"><h2>실행</h2>${execPanel}</section>
        <section class="card"><h2>외부 고정 일정</h2>${extPanel}</section>
      </div>
      <section class="card"><h2>업무 내용</h2>${scopePanel}</section>
      <section class="card"><h2>${owner ? '프로젝트·출처' : '프로젝트'}</h2>${metaPanel}
        ${owner ? html`<div class="savebar"><input name="reason" placeholder="변경 이유 (선택) — 예: 교수님 통화 후 앞당김"><button class="primary" type="submit">변경 저장</button></div>` : ''}
      </section>
    </form>
    <div class="grid2">
      <section class="card"><h2>판단 확인 기록 <span class="muted small">${t.reviews.length}건 · 수정·삭제 불가</span></h2>
        ${t.reviews.length ? html`<ul class="timeline">${t.reviews.map((rv) => html`<li>
          <div class="when">${fmtReviewedAt(rv.reviewed_at)} · ${CHANNEL[rv.review_channel]} · ${rv.reviewer_name} (기록: ${rv.recorded_by_name})</div>
          확인: ${otherUrgBadge(rv.other_urgency)} ${rv.other_due_date ? fmtDate(rv.other_due_date) : ''}
          <span class="muted small">│ 당시 내 판단: ${URGENCY[rv.my_urgency_snapshot] ?? '미평가'} ${rv.my_due_date_snapshot ? fmtDate(rv.my_due_date_snapshot) : '마감 미정'}</span>
          ${rv.needs_recheck ? html` <span class="badge b-warn">재확인 필요</span>` : ''}
          ${rv.note ? html`<div class="small">${rv.note}</div>` : ''}</li>`)}</ul>` : html`<p class="muted small">없음</p>`}
      </section>
      <section class="card"><h2>변경 이력 <span class="muted small">${t.activity.length}건</span></h2>
        <ul class="timeline">${t.activity.map((a) => html`<li><div class="when">${fmtTs(a.created_at)} · ${a.actor_name ?? '시스템'}</div>${activityText(a)}${a.reason ? html`<div class="small muted">${a.event_type === 'review_added' ? '들은 내용' : '이유'}: ${a.reason}</div>` : ''}</li>`)}</ul>
      </section>
    </div>`);

  if (!owner) return;
  $('[data-action="add-review"]').addEventListener('click', () => reviewModal(t));
  $('#tf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {};
    for (const el of form.elements) {
      if (!el.name || el.name === 'reason') continue;
      let v = el.value === '' ? null : el.value;
      if (el.name === 'project_id') v = Number(v);
      const cur = t[el.name] ?? null;
      if (v !== cur && !(el.name === 'review_state' && v === 'confirmed')) body[el.name] = v;
    }
    if (!Object.keys(body).length) return toast('바뀐 내용이 없습니다');
    if (['waiting', 'blocked'].includes(body.status ?? t.status) && !(body.blocked_reason ?? t.blocked_reason)) {
      return toast('대기/차단 상태에는 대기/차단 사유가 필요합니다', true);
    }
    body.reason = form.reason.value || null;
    try {
      upsertTask(await api('PATCH', `/api/tasks/${t.id}`, body));
      if ('project_id' in body || 'visibility' in body) await refreshProjects();
      toast('저장됨');
      renderTask(t.id);
    } catch (err) { toast(err.message, true); }
  });
}

// ---- 판단 비교 ----------------------------------------------------------------
function renderCompare() {
  const active = S.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const mismatch = active.filter((t) => t.derived.mismatch);
  const unknown = active.filter((t) => !t.derived.mismatch && t.derived.urgency_cmp === 'unknown' && t.derived.due_cmp === 'unknown' && t.review_state !== 'not_needed');
  const notNeeded = active.filter((t) => !t.latest_review && t.review_state === 'not_needed');
  const matched = active.filter((t) => !t.derived.mismatch && !unknown.includes(t) && !notNeeded.includes(t));
  const item = (t) => {
    const r = t.latest_review;
    return html`<tr>
      <td class="code">${t.task_code}</td>
      <td class="title"><a href="#/task/${t.id}">${t.title}</a></td>
      <td class="mine mine-first">${urgBadge(t.my_urgency)}</td><td class="mine nowrap">${t.my_due_date ? fmtDate(t.my_due_date) : html`<span class="muted">미정</span>`}</td>
      <td class="other-first">${otherUrgBadge(t.derived.other_urgency)}</td><td class="nowrap">${t.derived.other_due_date ? fmtDate(t.derived.other_due_date) : html`<span class="muted">미확인</span>`}</td>
      <td>${t.derived.due_diff_days ? dueDiffText(t.derived.due_diff_days) : ''}</td>
      <td class="small">${r ? `${r.reviewer_name} · ${CHANNEL[r.review_channel]} · ${fmtReviewedAt(r.reviewed_at)}` : reviewBadge(t.review_state)}</td>
    </tr>`;
  };
  const table = (list, emptyMsg) => list.length ? html`<div class="table-wrap"><table class="tasks">
      <thead><tr><th>ID</th><th>업무명</th><th class="mine-h">내 시급성</th><th>내 마감일</th><th class="other-h">확인 시급성</th><th>확인 기한</th><th>기한 차이</th><th>확인 출처</th></tr></thead>
      <tbody>${list.map(item)}</tbody></table></div>
      <div class="cards">${list.map((t) => html`<a class="task-card" href="#/task/${t.id}"><div class="small muted">${t.task_code}</div><div class="t">${t.title}</div>
        <div class="meta">나 ${urgBadge(t.my_urgency)} ${t.my_due_date ? fmtDate(t.my_due_date) : '미정'} │ 확인 ${otherUrgBadge(t.derived.other_urgency)} ${t.derived.other_due_date ? fmtDate(t.derived.other_due_date) : ''}</div>
        <div class="small">${dueDiffText(t.derived.due_diff_days)}</div></a>`)}</div>`
    : html`<p class="muted small">${emptyMsg}</p>`;

  const total = active.length || 1;
  mount(main(), html`
    <div class="page-head"><div><h1>판단 비교</h1>
      <p class="muted">진행 업무 ${active.length}건 중 확인 기록 있음 ${active.filter((t) => t.latest_review).length}건 · 불일치 ${mismatch.length}건 · 미확인 ${unknown.length}건 (${Math.round((unknown.length / total) * 100)}%)</p></div></div>
    <div class="stack">
      <section><h2>판단이 달랐던 업무 ${mismatch.length}</h2>${table(mismatch, '불일치한 업무가 없습니다.')}</section>
      <section><h2>아직 확인하지 않은 업무 ${unknown.length}</h2><p class="small muted">미확인은 '일치'가 아닙니다. 시급·초시급이거나 외부와 얽힌 업무부터 확인하세요.</p>${table(unknown, '모든 업무를 확인했습니다.')}</section>
      <section><h2>판단이 일치한 업무 ${matched.length}</h2>${table(matched, '아직 없습니다.')}</section>
      ${notNeeded.length ? html`<section><h2>확인 불필요로 표시한 업무 ${notNeeded.length}</h2>${table(notNeeded, '')}</section>` : ''}
    </div>`);
}

// ---- 프로젝트 -----------------------------------------------------------------
const PROJECT_STATUS = { active: '진행', hold: '보류', done: '종료' };
function renderProjects() {
  const owner = isOwner();
  mount(main(), html`
    <div class="page-head"><div><h1>프로젝트</h1><p class="muted">프로젝트별 목표와 업무 수</p></div>
      ${owner ? html`<button class="primary" data-action="new-project">+ 새 프로젝트</button>` : ''}</div>
    ${S.projects.length ? html`<div class="projects">${S.projects.map((p) => html`
      <div class="card">
        <h3><span class="badge">${p.code}</span> ${p.title}</h3>
        ${p.objective ? html`<p class="small">목표: ${p.objective}</p>` : ''}
        ${p.description ? html`<p class="small muted dd-pre">${p.description}</p>` : ''}
        <div class="stats"><span>진행 ${p.active_count}</span><span>완료 ${p.done_count}</span>${owner ? html`<span>등록 후보 ${p.candidate_count}</span>` : ''}<span>${PROJECT_STATUS[p.status]}</span></div>
        ${owner ? html`<p class="row"><button data-edit="${p.id}">수정</button><a class="btn" href="#/tasks" data-filter-project="${p.id}">업무 보기</a></p>` : html`<p><a href="#/tasks" data-filter-project="${p.id}">업무 보기 →</a></p>`}
      </div>`)}</div>` : html`<div class="card empty">프로젝트가 없습니다.</div>`}`);
  $$('[data-filter-project]').forEach((a) => a.addEventListener('click', () => { S.filter.project = a.dataset.filterProject; S.filter.chip = 'all'; }));
  if (!owner) return;
  $('[data-action="new-project"]').addEventListener('click', () => projectModal());
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => projectModal(S.projects.find((p) => p.id === Number(b.dataset.edit)))));
}

function projectModal(p) {
  const m = openModal(html`
    <h2>${p ? `프로젝트 수정 — ${p.code}` : '새 프로젝트'}</h2>
    <form id="pf">
      ${p ? '' : html`<div class="row">
        <div class="field"><label>코드 * (영문 대문자)</label><input name="code" required pattern="[A-Za-z0-9-]+" placeholder="예: CONF"></div>
        <div class="field"><label>업무 ID 접두어 (비우면 코드와 같음)</label><input name="task_prefix" pattern="[A-Za-z0-9-]*"></div>
      </div>`}
      <div class="field"><label>프로젝트명 *</label><input name="title" required value="${p?.title ?? ''}"></div>
      <div class="field"><label>목표 (지향점)</label><textarea name="objective">${p?.objective ?? ''}</textarea></div>
      <div class="field"><label>설명·배경·주의사항</label><textarea name="description">${p?.description ?? ''}</textarea></div>
      ${p ? html`<div class="field"><label>상태</label><select name="status">${options(PROJECT_STATUS, p.status)}</select></div>` : ''}
      <div class="actions"><button type="button" data-cancel>취소</button><button class="primary" type="submit">저장</button></div>
    </form>`);
  $('[data-cancel]', m).addEventListener('click', closeModal);
  $('#pf', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (p) await api('PATCH', `/api/projects/${p.id}`, f);
      else await api('POST', '/api/projects', f);
      await loadAll();
      closeModal();
      toast('저장됨');
      renderProjects();
    } catch (err) { toast(err.message, true); }
  });
}

// ---- 변경 이력 ----------------------------------------------------------------
async function renderHistory() {
  const logs = await api('GET', '/api/activity?limit=500');
  mount(main(), html`
    <div class="page-head"><div><h1>변경 이력</h1><p class="muted">최근 ${logs.length}건. 이력은 수정·삭제되지 않습니다.</p></div></div>
    ${logs.length ? html`<div class="table-wrap"><table class="log">
      <thead><tr><th>시각 (KST)</th><th>대상</th><th>변경자</th><th>내용</th><th>이유·메모</th></tr></thead>
      <tbody>${logs.map((a) => html`<tr>
        <td class="nowrap">${fmtTs(a.created_at)}</td>
        <td>${a.entity_type === 'task' ? html`<a href="#/task/${a.entity_id}">${a.task_code}</a> <span class="small muted">${a.task_title}</span>` : html`프로젝트 ${a.project_code}`}</td>
        <td class="nowrap">${a.actor_name ?? '시스템'}</td>
        <td>${activityText(a)}</td>
        <td class="small">${a.reason ?? ''}</td>
      </tr>`)}</tbody></table></div>` : html`<div class="card empty">이력이 없습니다.</div>`}`);
}

// ---- 등록 후보 검토 -------------------------------------------------------------
const DECISIONS = { need: '지금도 필요', done: '이미 완료', drop: '더는 필요 없음', later: '확인 필요 (나중에)' };
const REVIEW_NEED = { not_reviewed: '교수님·관계자 확인 필요', requested: '이미 확인 요청함', not_needed: '확인 불필요' };

function renderCandidates() {
  const cands = S.tasks.filter((t) => t.status === 'candidate').sort(byProjectThenCode);
  const info = html`<details class="card small">
      <summary><b>기획서 6-J·5-1: 업무로 만들지 않은 미확정 항목</b> (확인 후 직접 등록)</summary>
      <ul>
        <li><b>ABS</b>: ABS 발표 15장 PPT 제작 건이 추계학회 발표와 별개인 현재 업무인지 확인</li>
        <li><b>TRIP</b>: 10/14~16 출장의 확정 일정·준비물·수행사항·복귀 후 자료 정리 확인</li>
        <li><b>LAB</b>: BK21 증빙, 외국인 학생 행정, 수업 과제 등 현재 남아 있는 작업만 등록</li>
        <li><b>MEET</b>: 금요일 논문 브리핑(오전 9시)·토요일 프로토타입 점검(오전 11시)은 개인 점검 루틴 후보 — 교수님 지정 마감이 아님. 수·금 확대 언급이 있었으므로 실제 일정 재확인</li>
      </ul>
      <p class="muted">기획서 7-2의 '현황 확인 우선 후보'(EXT-001, CONF-001, CONF-005, CONF-002~004, DEV-001~003, UAV-001~003, EXT-002~006)는 시급성 순위가 아니라 먼저 현황을 확인할 항목입니다. 시급성은 직접 정하세요.</p>
    </details>`;
  if (!cands.length) {
    mount(main(), html`<div class="page-head"><h1>등록 후보 검토</h1></div><div class="card empty">검토할 등록 후보가 없습니다. <a href="#/tasks">전체 업무 보기</a></div>${info}`);
    return;
  }
  const cur = cands.find((t) => t.id === S.cand.currentId) || cands.find((t) => !S.cand.skipped.has(t.id)) || cands[0];
  S.cand.currentId = cur.id;
  const proj = S.projects.find((p) => p.id === cur.project_id);
  const groups = [];
  for (const t of cands) {
    let g = groups.find((x) => x.code === t.project_code);
    if (!g) groups.push(g = { code: t.project_code, title: t.project_title, items: [] });
    g.items.push(t);
  }
  const radios = (name, map, sel) => html`<div class="choices">${Object.entries(map).map(([k, v]) => html`<label><input type="radio" name="${name}" value="${k}" ${k === sel ? raw('checked') : ''}> ${v}</label>`)}</div>`;

  mount(main(), html`
    <div class="page-head"><div><h1>등록 후보 검토</h1>
      <p class="muted">남은 후보 ${cands.length}건. 기획서 대화에 나왔을 뿐, 완료 여부·시급성·마감일은 정해지지 않은 항목입니다. 하나씩 현재 상태를 확인해 활성화하세요.</p></div></div>
    <div class="wizard">
      <nav class="card cand-list" aria-label="후보 목록">${groups.map((g) => html`<h3>${g.code} · ${g.title}</h3>${g.items.map((t) => html`<button type="button" data-cand="${t.id}" class="${t.id === cur.id ? 'on' : ''} ${S.cand.skipped.has(t.id) ? 'skipped' : ''}">${t.task_code} ${t.title}</button>`)}`)}</nav>
      <form class="card" id="cf">
        <p class="small muted">${cur.project_code} · ${cur.project_title}</p>
        <h2>${cur.task_code} ${cur.title}</h2>
        <dl class="kv">
          <dt>완료 기준·산출물</dt><dd>${cur.expected_deliverable ?? '-'}</dd>
          <dt>출처</dt><dd>${cur.source_note ?? '-'}</dd>
          ${proj?.description ? html`<dt>프로젝트 주의</dt><dd>${proj.description}</dd>` : ''}
        </dl>
        <div class="step"><div class="step-title">1. 이 업무가 지금도 필요한가?</div>${radios('decision', DECISIONS, null)}</div>
        <div data-sec="need" hidden>
          <div class="step"><div class="step-title">2. 현재 진행 상태</div>${radios('status', { todo: STATUS.todo, in_progress: STATUS.in_progress, waiting: STATUS.waiting, blocked: STATUS.blocked }, 'todo')}
            <div data-sec="wait" hidden class="row step">
              <div class="field"><label>대기/차단 사유 *</label><input name="blocked_reason"></div>
              <div class="field"><label>대기 대상</label><input name="waiting_on"></div>
              <div class="field"><label>재확인일</label><input type="date" name="follow_up_date"></div>
            </div></div>
          <div class="step"><div class="step-title">3. 내 기준 시급성 *</div>${radios('my_urgency', URGENCY, null)}
            <p class="hint">초시급: 오늘 대응하지 않으면 외부 일정에 영향 · 시급: 수일 내 처리 · 일상: 유연하지만 관리 필요 (운영 정의 제안)</p></div>
          <div class="step"><div class="step-title">4. 언제까지 완료해야 한다고 판단하는가? 이유는?</div>
            <div class="row"><div class="field"><label>내 마감일</label><input type="date" name="my_due_date"></div>
              <div class="field"><label>정하기 어려우면 그 이유</label><input name="due_undecided_reason"></div></div>
            <div class="field"><label>판단 이유</label><input name="my_reason"></div></div>
          <div class="step"><div class="step-title">5. 교수님 또는 다른 사람과 확인해야 하는가?</div>${radios('review_state', REVIEW_NEED, 'not_reviewed')}</div>
          <div class="step"><div class="step-title">6. 지금 바로 할 수 있는 가장 작은 다음 행동</div><input name="next_action" value="${cur.next_action ?? ''}"></div>
        </div>
        <div data-sec="done" hidden class="step"><div class="field"><label>완료 근거 (산출물 위치·완료일 등)</label><input name="done_note"></div></div>
        <div data-sec="drop" hidden class="step"><div class="field"><label>더는 필요 없는 이유</label><input name="drop_note"></div></div>
        <div data-sec="later" hidden class="step"><p class="muted">후보로 남겨 두고 다음 항목으로 넘어갑니다. 현재 상태를 확인한 뒤 다시 검토하세요.</p></div>
        <div class="savebar"><span class="spacer"></span><button class="primary" type="submit">저장하고 다음</button></div>
      </form>
    </div>
    ${info}`);

  const form = $('#cf');
  const sync = () => {
    const dec = form.decision.value;
    for (const k of Object.keys(DECISIONS)) $(`[data-sec="${k}"]`, form).hidden = dec !== k;
    const st = form.status.value;
    $('[data-sec="wait"]', form).hidden = !(st === 'waiting' || st === 'blocked');
  };
  form.addEventListener('change', sync);
  $$('[data-cand]').forEach((b) => b.addEventListener('click', () => { S.cand.currentId = Number(b.dataset.cand); renderCandidates(); }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const goNext = () => {
      const rest = S.tasks.filter((t) => t.status === 'candidate' && !S.cand.skipped.has(t.id) && t.id !== cur.id)
        .sort(byProjectThenCode);
      S.cand.currentId = (rest.find((t) => byProjectThenCode(t, cur) > 0) || rest[0])?.id ?? null;
      renderNav('candidates');
      renderCandidates();
      window.scrollTo(0, 0);
    };
    let body;
    if (!f.decision) return toast('1번 질문에 답하세요', true);
    if (f.decision === 'later') { S.cand.skipped.add(cur.id); return goNext(); }
    if (f.decision === 'done') body = { status: 'done', reason: `등록 후보 검토: 이미 완료${f.done_note ? ` — ${f.done_note}` : ''}` };
    if (f.decision === 'drop') body = { status: 'dropped', reason: `등록 후보 검토: 더는 필요 없음${f.drop_note ? ` — ${f.drop_note}` : ''}` };
    if (f.decision === 'need') {
      if (!f.my_urgency) return toast('3번: 내 기준 시급성을 먼저 정하세요', true);
      if ((f.status === 'waiting' || f.status === 'blocked') && !f.blocked_reason) return toast('대기/차단 사유를 입력하세요', true);
      body = {
        status: f.status, my_urgency: f.my_urgency, my_due_date: f.my_due_date || null,
        due_undecided_reason: f.due_undecided_reason || null, my_reason: f.my_reason || null,
        review_state: f.review_state, next_action: f.next_action || null,
        blocked_reason: f.blocked_reason || null, waiting_on: f.waiting_on || null, follow_up_date: f.follow_up_date || null,
        reason: '등록 후보 검토: 지금도 필요',
      };
    }
    body.mark_verified = true;
    try {
      upsertTask(await api('PATCH', `/api/tasks/${cur.id}`, body));
      await refreshProjects();
      toast(`${cur.task_code} → ${STATUS[body.status]}`);
      goNext();
    } catch (err) { toast(err.message, true); }
  });
}

// ---- GitHub 게시 ----------------------------------------------------------------
async function publishNow() {
  if (!confirm('등록 후보를 뺀 모든 업무가 GitHub Pages에 올라가 인터넷에 공개됩니다.\n(출처·작업 메모와 확인 기록의 "들은 내용"은 올라가지 않습니다)\n\n지금 게시할까요?')) return;
  const btn = $('#publish');
  btn.disabled = true;
  btn.textContent = '게시 중…';
  try {
    const r = await api('POST', '/api/publish');
    const m = openModal(html`<h2>게시 완료</h2>
      <p>${r.changed ? '최신 내용으로 올렸습니다.' : '지난 게시 이후 바뀐 내용이 없습니다.'} 이 주소를 공유하면 로그인 없이 볼 수 있습니다.</p>
      <p><a href="${r.url}" target="_blank" rel="noopener">${r.url}</a></p>
      <p class="hint">처음 게시하면 페이지가 열리기까지 1~2분 걸릴 수 있습니다. 반영 후에는 새로고침하세요.</p>
      <div class="actions"><button type="button" data-copy>주소 복사</button><button class="primary" type="button" data-cancel>닫기</button></div>`);
    $('[data-cancel]', m).addEventListener('click', closeModal);
    $('[data-copy]', m).addEventListener('click', () => navigator.clipboard?.writeText(r.url).then(() => toast('복사됨')));
  } catch (e) {
    toast(`게시 실패: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'GitHub에 게시';
  }
}

// ---- 시작 -------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action="new-task"]');
  if (a && !a.closest('.cal')) newTaskModal();
});
$('#logout').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch { /* 무시 */ }
  S.me = null;
  S.tasks = [];
  location.hash = '';
  renderLogin();
});
window.addEventListener('hashchange', route);

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    S.me = me.user;
    S.today = me.today;
    S.mode = me.mode;
    S.canPublish = !!me.publish;
    S.generatedAt = me.generated_at;
    await loadAll();
    route();
  } catch (e) {
    if (!S.me) renderLogin();
    else toast(e.message, true);
  }
}
boot();

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
// 종류 색처럼 사용자가 정한 색은 data-ec에 두고 그린 뒤 CSS 변수로 넣는다 (CSP: style 속성 금지)
function applyColors(root) { for (const el of root.querySelectorAll('[data-ec]')) el.style.setProperty('--ec', el.dataset.ec); }
const mount = (el, tpl) => { el.innerHTML = tpl.s; linkLabels(el); applyColors(el); };

const store = {
  get(k, d) { try { const v = localStorage.getItem(`wb.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`wb.${k}`, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

// ---- 상태 -------------------------------------------------------------------
const S = {
  me: null, mode: null, canPublish: false, generatedAt: null, today: null,
  tasks: [], projects: [],
  page: 'calendar', pageArg: null,
  view: { chip: 'all', q: '', group: store.get('group', 'due'), showClosed: false },
  collapsed: new Set(store.get('collapsed', [])),
  cal: { month: null, selected: null, mode: 'fortnight', anchor: null },
  dailyPlans: store.get('dailyPlansV1', null),
  cand: { currentId: null, skipped: new Set() },
  peek: null, peekData: null, peekKind: null, replyForm: null,
  events: [], eventTypes: [], calDrag: null, calJustDragged: false,
  mails: [], mailStatus: null, contacts: { categories: [], contacts: [] }, noteOpen: null,
};
const isOwner = () => S.me?.role === 'owner';
const PROFESSOR_DEFAULT = '김원국 교수님';

// ---- 데이터 -------------------------------------------------------------------
// GitHub Pages에 올라간 읽기 전용 페이지는 서버 대신 data.json을 읽는다.
const STATIC = document.documentElement.dataset.mode === 'static';
let SITE = null;
let REMOTE_ON = false; // GitHub 키로 편집 중
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
  if (path === '/api/me') return { user: { display_name: SITE.owner_name, role: 'viewer' }, today, mode: 'static', generated_at: SITE.generated_at };
  if (path === '/api/tasks') return SITE.tasks.map(dec);
  if (path === '/api/projects') return SITE.projects;
  if (path === '/api/activity') return SITE.tasks.flatMap((t) => t.activity).sort((a, b) => b.id - a.id).slice(0, 500);
  if (path === '/api/mails') return SITE.mails ?? [];
  if (path === '/api/events') return SITE.events ?? [];
  if (path === '/api/event-types') return SITE.event_types ?? [];
  const mm = path.match(/^\/api\/mails\/(\d+)$/);
  if (mm) {
    const x = (SITE.mails ?? []).find((y) => y.id === Number(mm[1]));
    if (!x) throw new Error('메일을 찾을 수 없습니다');
    return x;
  }
  const m = path.match(/^\/api\/tasks\/(\d+)$/);
  if (m) {
    const t = SITE.tasks.find((x) => x.id === Number(m[1]));
    if (!t) throw new Error('업무를 찾을 수 없습니다');
    return { ...dec(t), reviews: t.reviews, activity: t.activity };
  }
  throw new Error('없는 데이터');
}

async function api(method, url, body) {
  if (STATIC) return REMOTE_ON ? remoteApi(method, url, body) : staticApi(method, url);
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

async function loadAll() {
  const [tasks, projects, mails, events] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/projects'), api('GET', '/api/mails').catch(() => []), api('GET', '/api/events').catch(() => [])]);
  S.events = events;
  S.eventTypes = await api('GET', '/api/event-types').catch(() => []);
  S.tasks = tasks;
  S.projects = projects;
  S.mails = mails;
  if (isOwner() && S.mode !== 'static') {
    S.mailStatus = await api('GET', '/api/mail/status').catch(() => null);
    S.contacts = await api('GET', '/api/contacts').catch(() => S.contacts);
  }
}
function upsertMail(m) {
  const i = S.mails.findIndex((x) => x.id === m.id);
  if (i >= 0) S.mails[i] = m; else S.mails.unshift(m);
  if (S.peekKind === 'mail' && S.peek === m.id) S.peekData = m;
}
async function reloadTask(id) { if (id) upsertTask(await api('GET', `/api/tasks/${id}`)); }
function upsertTask(d) {
  const { reviews, activity, ...t } = d;
  const i = S.tasks.findIndex((x) => x.id === t.id);
  if (i >= 0) S.tasks[i] = t; else S.tasks.push(t);
}
async function refreshProjects() { S.projects = await api('GET', '/api/projects'); }
async function patchTask(id, body) {
  const d = await api('PATCH', `/api/tasks/${id}`, body);
  upsertTask(d);
  if (S.peekKind === 'task' && S.peek === id) S.peekData = d;
  return d;
}

// ---- 알림 -------------------------------------------------------------------
let toastTimer;
function toast(msg, { err = false, action = null } = {}) {
  const el = $('#toast');
  mount(el, html`<span>${msg}</span>${action ? html`<button type="button" class="toast-act">${action.label}</button>` : ''}`);
  el.className = 'toast' + (err ? ' err' : '');
  el.hidden = false;
  if (action) $('.toast-act', el).addEventListener('click', () => { el.hidden = true; action.fn(); });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, err || action ? 5000 : 2000);
}
const toastErr = (e) => toast(e.message, { err: true });

// ---- 날짜·표시 도우미 -------------------------------------------------------------
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const dowOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
function addDaysStr(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00Z');
  const md = `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${WEEK[dt.getUTCDay()]})`;
  return d.slice(0, 4) === S.today.slice(0, 4) ? md : `${d.slice(0, 4)}/${md}`;
}
function relDate(d) {
  const n = daysBetween(S.today, d);
  if (n === 0) return '오늘';
  if (n === 1) return '내일';
  if (n === -1) return '어제';
  if (n > 1 && n < 7) return `${WEEK[dowOf(d)]}요일`;
  return fmtDate(d);
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
const nowKstLocal = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T').slice(0, 16);
const weekEndOf = (d) => addDaysStr(d, (7 - dowOf(d)) % 7); // 그 주 일요일
function dueDiffText(n) {
  if (n === null || n === undefined) return '';
  if (n === 0) return '기한 같음';
  return n > 0 ? `내 평가가 ${n}일 늦음` : `내 평가가 ${-n}일 빠름`;
}

const urgBadge = (u) => (u ? html`<span class="badge u-${u}">${URGENCY[u]}</span>` : html`<span class="badge u-none">미평가</span>`);
const otherUrgBadge = (u) => (u ? urgBadge(u) : html`<span class="badge u-none">미확인</span>`);
const STATUS_CLS = { in_progress: 'st-prog', waiting: 'st-wait', blocked: 'st-block', done: 'st-done', dropped: 'st-drop', todo: '', candidate: '' };
const statusBadge = (s) => html`<span class="badge ${STATUS_CLS[s]}">${STATUS[s]}</span>`;
function reviewBadge(rs) {
  const cls = rs === 'confirmed' ? 'b-ok' : rs === 'recheck' ? 'b-warn' : rs === 'not_needed' ? '' : 'b-info';
  return html`<span class="badge ${cls}">${REVIEW_STATE[rs]}</span>`;
}
function cmpBadge(t) {
  const d = t.derived;
  if (d.mismatch) return html`<span class="badge b-bad">판단 불일치</span>`;
  if (d.urgency_cmp === 'unknown' && d.due_cmp === 'unknown') return html`<span class="badge u-none">미확인</span>`;
  if (d.urgency_cmp === 'self_missing' || d.due_cmp === 'self_missing') return html`<span class="badge b-warn">본인 평가 없음</span>`;
  return html`<span class="badge b-ok">일치</span>`;
}
const options = (map, sel, keys = Object.keys(map)) => keys.map((k) => html`<option value="${k}" ${k === sel ? raw('selected') : ''}>${map[k]}</option>`);
const urgencyOptions = (sel, emptyLabel = '미평가') => [html`<option value="">${emptyLabel}</option>`, options(URGENCY, sel ?? '')];
const projectOptions = (sel) => S.projects.map((p) => html`<option value="${p.id}" ${p.id === Number(sel) ? raw('selected') : ''}>${p.code} · ${p.title}</option>`);
const projectById = (id) => S.projects.find((p) => p.id === Number(id));
function byProjectThenCode(a, b) {
  const pa = S.projects.findIndex((p) => p.id === a.project_id);
  const pb = S.projects.findIndex((p) => p.id === b.project_id);
  return pa - pb || a.task_code.localeCompare(b.task_code);
}
const effDate = (t) => t.derived.effective_due?.date ?? null;
function byDueThenUrgency(a, b) {
  const da = effDate(a) ?? '9999', db = effDate(b) ?? '9999';
  if (da !== db) return da < db ? -1 : 1;
  return (URGENCY_RANK[a.my_urgency] ?? 9) - (URGENCY_RANK[b.my_urgency] ?? 9) || a.task_code.localeCompare(b.task_code);
}
const activeTasks = () => S.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));

// ---- 로그인 (서버 로그인 모드에서만) ------------------------------------------------
function renderLogin() {
  $('#side').hidden = true;
  $('#tabbar').hidden = true;
  $('#fab').hidden = true;
  $('#mobilebar').hidden = true;
  $('#app').classList.add('bare');
  mount(main(), html`
    <form class="card login" id="login-form">
      <div class="logo"></div>
      <h1>업무 게시판</h1>
      <p class="muted">등록된 계정으로 로그인하세요.</p>
      <div class="field"><label>이메일</label><input name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label>비밀번호</label><input name="password" type="password" autocomplete="current-password" required></div>
      <p class="badge b-bad" id="login-err" hidden></p>
      <button class="primary wide" type="submit">로그인</button>
    </form>`);
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/login', { email: f.get('email'), password: f.get('password') });
      await // 서버가 5분마다 메일을 확인하므로, 화면도 1분마다 새 메일이 있는지 본다.
setInterval(async () => {
  if (!S.me || S.mode === 'static' || !isOwner() || document.hidden) return;
  try {
    const mails = await api('GET', '/api/mails');
    const known = new Set(S.mails.map((m) => m.id));
    const fresh = mails.filter((m) => !known.has(m.id));
    if (!fresh.length) return;
    S.mails = mails;
    S.mailStatus = await api('GET', '/api/mail/status').catch(() => S.mailStatus);
    S.contacts = await api('GET', '/api/contacts').catch(() => S.contacts);
    const busy = main().contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
    if (!busy) refresh(); else renderSide();
    const newPeople = S.contacts.contacts.filter((c) => c.category_id == null).length;
    toast(`🆕 새 메일 ${fresh.length}건 — ${fresh[0].from_name}${newPeople ? ` · 분류 안 된 사람 ${newPeople}명` : ''}`, { action: { label: '열기', fn: () => openMailPeek(fresh[0].id) } });
  } catch { /* 다음에 다시 */ }
}, 60000);

boot();
    } catch (err) {
      const el = $('#login-err');
      el.textContent = err.message;
      el.hidden = false;
    }
  });
}

// ---- 사이드바 -------------------------------------------------------------------
function renderSide() {
  const owner = isOwner();
  const active = activeTasks();
  const todayN = active.filter((t) => effDate(t) && effDate(t) <= S.today).length;
  const mismatchN = active.filter((t) => t.derived.mismatch).length;
  const cands = S.tasks.filter((t) => t.status === 'candidate').length;
  const unseenN = S.mails.filter((m) => !m.seen && !m.hidden).length;
  const item = (page, label, icon, n, cls = '', extra = '', pages = [page]) => html`<a href="#/${page}" class="nav-item ${extra} ${pages.includes(S.page) ? 'on' : ''}">
      <span class="ico ico-${icon}" aria-hidden="true"></span><span class="nav-label">${label}</span>${n ? html`<span class="nav-n ${cls}">${n}</span>` : ''}</a>`;
  mount($('#side'), html`
    <div class="side-head">
      <a class="brand" href="#/calendar"><span class="logo"></span>업무 게시판</a>
    </div>
    ${owner && S.mode !== 'static' ? html`<button type="button" class="add-btn" data-action="create"><span class="plus">+</span>새로 만들기</button>` : ''}
    <nav class="nav">
      ${item('calendar', '캘린더', 'cal')}
      ${item('today', '할 일', 'list', todayN, active.some((t) => t.derived.due_flag === 'overdue') ? 'bad' : '', '', ['today', 'tasks'])}
      ${item('mail', '메일', 'mail', unseenN ? `🆕 ${unseenN}` : 0, 'new', '', ['mail', 'contacts'])}
      ${item('compare', '판단 비교', 'cmp', mismatchN, mismatchN ? 'bad' : '')}
    </nav>
    <div class="side-sec">
      <div class="side-sec-h"><a href="#/projects" class="${S.page === 'projects' ? 'on' : ''}">프로젝트</a>${owner ? html`<button type="button" class="icon-btn sm" data-action="new-project" aria-label="새 프로젝트" title="새 프로젝트">+</button>` : ''}</div>
      ${S.projects.filter((p) => p.status !== 'done').map((p) => html`<a href="#/project/${p.id}" class="nav-item proj ${S.page === 'project' && Number(S.pageArg) === p.id ? 'on' : ''}" title="${p.code} · ${p.title}">
        <span class="proj-dot" aria-hidden="true"></span><span class="nav-label">${p.title}</span>${p.active_count ? html`<span class="nav-n">${p.active_count}</span>` : ''}</a>`)}
    </div>
    <nav class="nav side-bottom">
      ${owner && S.mode !== 'open' ? item('candidates', '등록 후보', 'inbox', cands, cands ? 'warn' : '') : ''}
      ${item('history', '변경 이력', 'hist')}
    </nav>
    <div class="side-foot">
      ${S.mode === 'static'
        ? html`<div class="who"><b>${S.me.display_name || '업무 게시판'}</b><span class="muted small">읽기 전용 · ${fmtTs(S.generatedAt)} 게시</span></div>`
        : html`<div class="who"><b>${S.me.display_name}</b><span class="muted small">${owner ? (S.mode === 'local' ? '내 PC에서 편집' : S.mode === 'remote' ? 'GitHub 페이지에서 편집 중' : '편집') : S.mode === 'open' ? '캘린더는 누구나 수정할 수 있습니다' : '열람 전용'}</span></div>
          ${remoteStatusLine()}
          ${S.mode === 'remote' ? html`<button type="button" class="link small" id="remote-off">이 기기 편집 모드 끄기</button>` : ''}
          ${S.canPublish ? html`<button type="button" class="publish-btn" id="publish">GitHub에 게시</button>` : ''}
          ${S.mode === 'server' ? html`<button type="button" class="link small" id="logout">로그아웃</button>` : ''}`}
    </div>`);
  $('#side').hidden = false;
  $('#mobilebar').hidden = false;
  $('#app').classList.remove('bare');
  mount($('#mobile-title'), html`<a class="brand" href="#/calendar"><span class="logo"></span>업무 게시판</a>`);
  $('#publish')?.addEventListener('click', publishNow);
  $('#remote-off')?.addEventListener('click', remoteDisconnect);
  $('#logout')?.addEventListener('click', logout);
  renderTabbar();
}
// ---- 휴대폰 전용 화면 (폭 760px 미만) ---------------------------------------------
const phoneQuery = matchMedia('(max-width: 760px)');
const isPhone = () => phoneQuery.matches;
function renderTabbar() {
  const tabs = [['calendar', '캘린더', 'cal', ['calendar']], ['today', '할 일', 'list', ['today', 'tasks']], ['mail', '메일', 'mail', ['mail', 'contacts']], ['compare', '비교', 'cmp', ['compare']]];
  const active = activeTasks();
  const badge = { today: active.filter((t) => effDate(t) && effDate(t) <= S.today).length, mail: S.mails.filter((m) => !m.seen && !m.hidden).length, compare: active.filter((t) => t.derived.mismatch).length };
  const inMore = !tabs.some(([, , , pages]) => pages.includes(S.page));
  mount($('#tabbar'), html`${tabs.map(([k, label, icon, pages]) => html`<a href="#/${k}" class="tab ${pages.includes(S.page) ? 'on' : ''}">
      <span class="ico ico-${icon}" aria-hidden="true"></span><span>${label}</span>${badge[k] ? html`<span class="tab-n">${badge[k]}</span>` : ''}</a>`)}
    <button type="button" class="tab ${inMore ? 'on' : ''}" id="tab-more"><span class="ico ico-more" aria-hidden="true"></span><span>더보기</span></button>`);
  $('#tabbar').hidden = false;
  $('#fab').hidden = !isOwner() || S.mode === 'static';
  $('#tab-more').addEventListener('click', openSideMobile);
}
function openSideMobile() { $('#app').classList.add('side-open'); $('#side-backdrop').hidden = false; }
function quickAddSheet() {
  const m = openModal(html`<div class="sheet-h"><h2>업무 추가</h2><button type="button" class="icon-btn" data-cancel aria-label="닫기">✕</button></div>
    ${quickAddBox('in-sheet')}
    <p class="hint">날짜·시급성·프로젝트를 문장 안에 같이 쓰면 자동으로 채워집니다. 자세한 내용은 등록 후 상세에서 입력하세요.</p>`);
  m.classList.add('sheet');
  $('[data-cancel]', m).addEventListener('click', closeModal);
  bindQuickAdd(m, { onAdded: () => closeModal() });
  $('.qa-input', m).focus();
}
phoneQuery.addEventListener('change', () => { if (S.me) refresh(); });

function closeSideMobile() { $('#app').classList.remove('side-open'); $('#side-backdrop').hidden = true; }

// ---- 라우터 -------------------------------------------------------------------
const VIEWS = {
  today: () => renderToday(), mail: () => renderMail(), contacts: () => renderContacts(), calendar: () => renderCalendar(), tasks: () => renderTasks(),
  compare: () => renderCompare(), projects: () => renderProjects(), project: () => renderProject(),
  history: () => renderHistory(), candidates: () => renderCandidates(),
};
function route() {
  if (!S.me) return renderLogin();
  const m = (location.hash || '#/calendar').match(/^#\/([a-z]+)(?:\/(\d+))?/) || [];
  let page = m[1] || 'calendar';
  if (page === 'task') {
    // 예전 주소(#/task/ID)는 전체 업무 위에 상세 패널로 연다.
    history.replaceState(null, '', '#/tasks');
    S.page = 'tasks';
    renderPage();
    openPeek(Number(m[2]));
    return;
  }
  if (!VIEWS[page] || ((!isOwner() || S.mode === 'open') && (page === 'candidates' || page === 'contacts'))) page = 'calendar';
  S.page = page;
  S.pageArg = m[2] ?? null;
  closeModal();
  closeSideMobile();
  window.scrollTo(0, 0);
  renderPage();
}
function renderPage() {
  renderSide();
  VIEWS[S.page]();
  markPeekRow();
}
// 데이터가 바뀐 뒤 현재 화면을 다시 그린다 (스크롤 위치 유지).
function refresh() {
  const y = window.scrollY;
  renderSide();
  VIEWS[S.page]();
  markPeekRow();
  window.scrollTo(0, y);
}

// ---- 빠른 추가 (자연어: 내일 / 금요일 / 10/20 / !초시급 / #EXT) ---------------------------
const URG_WORD = { 초시급: 'super', 1: 'super', 시급: 'urgent', 2: 'urgent', 일상: 'routine', 3: 'routine' };
const DOW_KO = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const SUF = '(?:까지|에|)';
const END = '(?=\\s|$|[,.])';

function ymd(y, m, d) {
  const x = new Date(Date.UTC(y, m - 1, d));
  if (x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) return undefined;
  return x.toISOString().slice(0, 10);
}
function guessYear(m, d) {
  const y = Number(S.today.slice(0, 4));
  const v = ymd(y, m, d);
  if (v && daysBetween(v, S.today) > 60) return ymd(y + 1, m, d);
  return v;
}
const DATE_RULES = [
  [new RegExp(`(^|\\s)(\\d{4})[-./](\\d{1,2})[-./](\\d{1,2})${SUF}${END}`), (m) => ymd(+m[2], +m[3], +m[4])],
  [new RegExp(`(^|\\s)(\\d{1,2})월\\s?(\\d{1,2})일${SUF}${END}`), (m) => guessYear(+m[2], +m[3])],
  [new RegExp(`(^|\\s)(\\d{1,2})/(\\d{1,2})${SUF}${END}`), (m) => guessYear(+m[2], +m[3])],
  [new RegExp(`(^|\\s)(오늘|내일|모레|글피)${SUF}${END}`), (m) => addDaysStr(S.today, { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[2]])],
  [new RegExp(`(^|\\s)(\\d{1,3})일\\s?(?:후|뒤)${SUF}${END}`), (m) => addDaysStr(S.today, +m[2])],
  [new RegExp(`(^|\\s)(?:(이번\\s?주|다음\\s?주|담주|다다음\\s?주)\\s?)?([월화수목금토일])요일${SUF}${END}`), (m) => {
    const target = DOW_KO[m[3]];
    if (!m[2]) return addDaysStr(S.today, (target - dowOf(S.today) + 7) % 7);
    const weeks = /다다음/.test(m[2]) ? 2 : /이번/.test(m[2]) ? 0 : 1;
    const monday = addDaysStr(S.today, -((dowOf(S.today) + 6) % 7));
    return addDaysStr(monday, weeks * 7 + ((target + 6) % 7));
  }],
];

function parseQuick(text) {
  let s = ` ${text} `;
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m) return undefined;
    const v = fn(m);
    if (v === undefined) return undefined;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    return v;
  };
  const urgency = take(/(^|\s)!(초시급|시급|일상|[123])(?=\s|$)/, (m) => URG_WORD[m[2]]) ?? null;
  const project = take(/(^|\s)#([A-Za-z0-9-]+)(?=\s|$)/, (m) => S.projects.find((p) => [p.code, p.task_prefix].some((c) => c.toLowerCase() === m[2].toLowerCase()))) ?? null;
  let due = null;
  for (const [re, fn] of DATE_RULES) {
    const v = take(re, fn);
    if (v) { due = v; break; }
  }
  return { title: s.replace(/\s+/g, ' ').trim(), urgency, project, due };
}
window.__parseQuick = parseQuick; // 브라우저 콘솔 점검용

function defaultProjectId() {
  if (S.page === 'project' && projectById(S.pageArg)) return Number(S.pageArg);
  const last = store.get('lastProject', null);
  if (projectById(last)) return Number(last);
  return S.projects[0]?.id ?? null;
}

function quickAddBox(extra = '') {
  if (!isOwner()) return '';
  return html`<form class="qa ${extra}" autocomplete="off">
    <span class="qa-plus" aria-hidden="true">+</span>
    <input class="qa-input" name="q" placeholder="업무 추가 — 예: 이경도 박사님 메일 1차 회신 내일 !초시급 #EXT" aria-label="빠른 업무 추가" enterkeyhint="done">
    <div class="qa-chips"></div>
  </form>`;
}
function bindQuickAdd(root = main(), { onAdded = null } = {}) {
  const form = $('.qa', root);
  if (!form) return;
  const input = $('.qa-input', form);
  const chips = $('.qa-chips', form);
  const preview = () => {
    const r = parseQuick(input.value);
    const proj = r.project ?? projectById(defaultProjectId());
    form.classList.toggle('typing', input.value.trim().length > 0);
    mount(chips, html`
      <span class="qchip ${r.due ? 'on' : ''}">${r.due ? `마감 ${relDate(r.due)} · ${fmtDate(r.due)}` : '마감 미정'}</span>
      <span class="qchip ${r.urgency ? `on u-${r.urgency}` : ''}">${r.urgency ? URGENCY[r.urgency] : '시급성 미평가'}</span>
      <span class="qchip ${r.project ? 'on' : ''}">${proj ? proj.code : '프로젝트 없음'}${r.project ? '' : ' (기본)'}</span>
      <span class="qa-hint">Enter로 등록 · 날짜: 오늘·내일·금요일·다음주 화요일·10/20 · !초시급 !시급 !일상 · #프로젝트코드</span>`);
  };
  input.addEventListener('input', preview);
  input.addEventListener('focus', preview);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = parseQuick(input.value);
    const proj = r.project ?? projectById(defaultProjectId());
    if (!r.title) return toast('업무명을 입력하세요', { err: true });
    if (!proj) return toast('먼저 프로젝트를 만들어 주세요', { err: true });
    try {
      const { id } = await api('POST', '/api/tasks', { title: r.title, project_id: proj.id, my_urgency: r.urgency, my_due_date: r.due });
      upsertTask(await api('GET', `/api/tasks/${id}`));
      await refreshProjects();
      store.set('lastProject', proj.id);
      refresh();
      if (onAdded) onAdded(id); else $('#main .qa-input')?.focus();
      const t = S.tasks.find((x) => x.id === id);
      toast(`${t.task_code} 등록됨${r.urgency ? '' : ' · 시급성은 직접 정하세요'}`, { action: { label: '열기', fn: () => openPeek(id) } });
    } catch (err) { toastErr(err); }
  });
}

// ---- 업무 행 (목록 공통) -----------------------------------------------------------
function duePill(t) {
  const e = t.derived.effective_due;
  if (!ACTIVE_STATUSES.includes(t.status)) return t.completed_at ? html`<span class="meta muted">${fmtDate(fmtTs(t.completed_at).slice(0, 10))} 완료</span>` : '';
  if (!e) return html`<span class="meta muted">마감 미정</span>`;
  const cls = t.derived.due_flag === 'overdue' ? 'late' : t.derived.due_flag === 'upcoming' ? 'soon' : '';
  const label = e.label === '내 마감일' ? '' : e.label === '확인된 기한' ? '교수님 ' : '외부 ';
  return html`<span class="meta due ${cls}" title="${e.label}: ${e.date}">${label}${relDate(e.date)}</span>`;
}
function judgPill(t) {
  const d = t.derived;
  if (!ACTIVE_STATUSES.includes(t.status)) return '';
  if (d.mismatch) {
    const parts = [];
    if (d.urgency_cmp === 'mismatch') parts.push(URGENCY[d.other_urgency]);
    if (d.due_cmp === 'mismatch') parts.push(fmtDate(d.other_due_date));
    return html`<span class="pill diff" title="교수님·관계자 판단과 다름">≠ 교수님 ${parts.join(' · ')}</span>`;
  }
  if (t.latest_review) return html`<span class="pill ok" title="확인된 판단과 일치">✓ 확인</span>`;
  if (d.review_needed) return html`<span class="pill need">확인 필요</span>`;
  return '';
}
function taskRow(t) {
  const owner = isOwner();
  const closed = !ACTIVE_STATUSES.includes(t.status);
  const d = t.derived;
  const sub = [html`<span class="code">${t.task_code}</span>`];
  if (S.page !== 'project') sub.push(html`<span>${t.project_title}</span>`);
  if ((t.status === 'waiting' || t.status === 'blocked') && t.blocked_reason) sub.push(html`<span class="${t.status === 'blocked' ? 'tx-bad' : 'tx-warn'}">${t.status === 'waiting' ? '대기' : '차단'}: ${t.blocked_reason}</span>`);
  else if (t.next_action && !closed) sub.push(html`<span>→ ${t.next_action}</span>`);
  if (d.self_missing.length) sub.push(html`<span class="tx-warn">${d.self_missing.join(' · ')}</span>`);
  if (d.conflicts.length) sub.push(html`<span class="tx-bad">일정 충돌</span>`);
  return html`<div class="row ${closed ? 'closed' : ''} ${S.peekKind === 'task' && S.peek === t.id ? 'peeked' : ''}" data-peek="${t.id}" tabindex="0" role="button" aria-label="${t.task_code} ${t.title}">
    ${owner && t.status !== 'dropped'
      ? html`<button type="button" class="check u-${t.my_urgency ?? 'none'} ${t.status === 'done' ? 'done' : ''}" data-done="${t.id}" aria-label="${t.status === 'done' ? '완료 취소' : '완료 처리'}" title="${t.status === 'done' ? '완료 취소' : '완료 처리'}"></button>`
      : html`<span class="check static u-${t.my_urgency ?? 'none'} ${t.status === 'done' ? 'done' : ''}" aria-hidden="true"></span>`}
    <div class="row-main">
      <div class="row-title">${t.title}</div>
      <div class="row-sub">${sub}</div>
    </div>
    <div class="row-meta">
      ${t.status === 'in_progress' || t.status === 'waiting' || t.status === 'blocked' ? statusBadge(t.status) : ''}
      ${judgPill(t)}
      ${duePill(t)}
    </div>
  </div>`;
}

// folded: 처음엔 접혀 있고 눌러야 펼쳐지는 묶음 (공개 페이지의 메일 등)
function groupSection(key, label, list, { tone = '', hint = '', folded = false } = {}, rowFn = taskRow) {
  if (!list.length) return '';
  const id = folded ? `${S.page}:${key}:open` : `${S.page}:${key}`;
  const collapsed = folded ? !S.collapsed.has(id) : S.collapsed.has(id);
  return html`<section class="group ${collapsed ? 'collapsed' : ''}">
    <button type="button" class="group-h ${tone}" data-collapse="${id}" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="caret" aria-hidden="true"></span>${label}<span class="group-n">${list.length}</span>${hint ? html`<span class="group-hint">${hint}</span>` : ''}
    </button>
    ${collapsed ? '' : html`<div class="rows">${list.map(rowFn)}</div>`}
  </section>`;
}

function groupBy(list, by) {
  const groups = [];
  const push = (key, label, items, opt) => groups.push({ key, label, items, opt });
  if (by === 'due') {
    const t1 = addDaysStr(S.today, 1);
    const wk = weekEndOf(S.today);
    const nwk = addDaysStr(wk, 7);
    const b = { overdue: [], today: [], tomorrow: [], week: [], next: [], later: [], none: [], closed: [] };
    for (const t of list) {
      const d = effDate(t);
      if (!ACTIVE_STATUSES.includes(t.status)) b.closed.push(t);
      else if (!d) b.none.push(t);
      else if (d < S.today) b.overdue.push(t);
      else if (d === S.today) b.today.push(t);
      else if (d === t1) b.tomorrow.push(t);
      else if (d <= wk) b.week.push(t);
      else if (d <= nwk) b.next.push(t);
      else b.later.push(t);
    }
    push('overdue', '기한 경과', b.overdue, { tone: 'bad' });
    push('today', `오늘 · ${fmtDate(S.today)}`, b.today);
    push('tomorrow', `내일 · ${fmtDate(t1)}`, b.tomorrow);
    push('week', '이번 주', b.week);
    push('next', '다음 주', b.next);
    push('later', '그 이후', b.later);
    push('none', '마감일 미정', b.none, { tone: 'warn', hint: '내 마감일을 먼저 정하세요' });
    push('closed', '완료·보류', b.closed);
  } else if (by === 'project') {
    for (const p of S.projects) push(`p${p.id}`, `${p.code} · ${p.title}`, list.filter((t) => t.project_id === p.id));
  } else if (by === 'urgency') {
    for (const u of ['super', 'urgent', 'routine']) push(u, URGENCY[u], list.filter((t) => t.my_urgency === u));
    push('none', '미평가', list.filter((t) => !t.my_urgency), { tone: 'warn', hint: '시급성을 먼저 정하세요' });
  } else {
    for (const s of Object.keys(STATUS)) push(s, STATUS[s], list.filter((t) => t.status === s));
  }
  for (const g of groups) g.items.sort(byDueThenUrgency);
  return groups;
}

// ---- 페이지 안 탭 (할 일: 오늘/전체, 메일: 받은 메일/보낸 사람) ----------------------------
function pageTabs(tabs, activeHref) {
  return html`<nav class="ptabs" aria-label="보기 전환">${tabs.map(([href, label, n, cls]) => html`<a href="${href}" class="ptab ${activeHref === href ? 'on' : ''}">${label}${n ? html`<span class="ptab-n ${cls ?? ''}">${n}</span>` : ''}</a>`)}</nav>`;
}
function taskTabs(activeHref) {
  const active = activeTasks();
  return pageTabs([['#/today', '오늘', active.filter((t) => effDate(t) && effDate(t) <= S.today).length, active.some((t) => t.derived.due_flag === 'overdue') ? 'bad' : ''], ['#/tasks', '전체', active.length]], activeHref);
}
function mailTabs(activeHref) {
  const tabs = [['#/mail', '받은 메일', S.mails.filter((m) => !m.seen && !m.hidden).length, 'new']];
  if (isOwner() && S.mode !== 'static' && S.mode !== 'open') tabs.push(['#/contacts', '보낸 사람 우선순위', S.contacts.contacts.filter((c) => c.category_id == null).length, 'warn']);
  return pageTabs(tabs, activeHref);
}
function eventRow(e) {
  return html`<div class="row ev-row" data-event="${e.id}" tabindex="0" role="button" aria-label="일정 ${e.title}">
    <span class="ev-dot" data-ec="${typeOf(e).color}" aria-hidden="true"></span>
    <div class="row-main"><div class="row-title">${e.title}</div>
      <div class="row-sub"><span>${typeOf(e).name}</span><span>${eventWhen(e)}</span>${e.location ? html`<span>${e.location}</span>` : ''}</div></div>
  </div>`;
}

// ---- 오늘 -------------------------------------------------------------------
function renderToday() {
  const active = activeTasks();
  const used = new Set();
  const pick = (pred) => {
    const out = active.filter((t) => !used.has(t.id) && pred(t)).sort(byDueThenUrgency);
    out.forEach((t) => used.add(t.id));
    return out;
  };
  const overdue = pick((t) => t.derived.due_flag === 'overdue');
  const today = pick((t) => effDate(t) === S.today);
  const followUp = pick((t) => t.status === 'waiting' && t.follow_up_date && t.follow_up_date <= S.today);
  const doing = pick((t) => t.status === 'in_progress');
  const soon = pick((t) => t.derived.due_flag === 'upcoming');
  const review = pick((t) => t.derived.review_needed && (t.my_urgency === 'super' || t.my_urgency === 'urgent'));
  const unrated = pick((t) => t.derived.self_missing.length > 0);
  const cands = S.tasks.filter((t) => t.status === 'candidate').length;
  const newMails = S.mails.filter((m) => !m.seen && !m.hidden).sort(byPriority);
  const todayEvents = eventsOn(S.today);
  const soonEvents = S.events.filter((e) => e.start_date > S.today && e.start_date <= addDaysStr(S.today, 7));
  const empty = !used.size && !newMails.length && !todayEvents.length && !soonEvents.length;

  mount(main(), html`
    <div class="page">
      <header class="page-h"><div><h1>할 일</h1><p class="muted">${fmtDate(S.today)} · 진행 업무 ${active.length}건</p></div></header>
      ${taskTabs('#/today')}
      ${quickAddBox()}
      ${isOwner() && cands ? html`<a class="notice" href="#/candidates"><b>등록 후보 ${cands}건</b>이 아직 검토되지 않았습니다. 지금도 필요한 일인지 하나씩 확인하세요 →</a>` : ''}
      ${!isOwner() ? html`<p class="notice subtle">열람 전용입니다. 열람만으로 어떤 업무도 '확인'이나 '승인'으로 바뀌지 않습니다.</p>` : ''}
      ${groupSection('evtoday', '오늘 일정', todayEvents, { tone: 'info' }, eventRow)}
      ${groupSection('newmail', '새 메일', newMails, { tone: 'info', hint: '열어서 회신이 필요한지 정하세요' }, mailRow)}
      ${groupSection('overdue', '기한 경과', overdue, { tone: 'bad' })}
      ${groupSection('today', '오늘 마감', today)}
      ${groupSection('follow', '재확인할 날이 된 대기 업무', followUp, { tone: 'warn' })}
      ${groupSection('doing', '진행 중', doing)}
      ${groupSection('soon', '곧 마감 (3일 이내)', soon)}
      ${groupSection('review', '교수님·관계자 확인이 필요한 시급 업무', review, { hint: '내 판단이 맞는지 먼저 확인' })}
      ${groupSection('unrated', '본인 평가가 빠진 업무', unrated, { tone: 'warn', hint: '시급성·마감일을 먼저 스스로 정하세요' })}
      ${groupSection('evsoon', '다가오는 일정 (7일)', soonEvents, {}, eventRow)}
      ${empty ? html`<div class="empty-state"><div class="empty-ico" aria-hidden="true">✓</div><b>오늘 챙길 업무가 없습니다</b><p class="muted">${active.length ? '다가오는 일정은 예정(캘린더)에서 확인하세요.' : isOwner() ? '위 입력칸에 업무를 추가하거나 등록 후보를 검토하세요.' : '게시된 업무가 아직 없습니다.'}</p></div>` : ''}
    </div>`);
  bindQuickAdd();
}

// ---- 전체 업무 ----------------------------------------------------------------
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
const GROUPS = { due: '기한별', project: '프로젝트별', urgency: '시급성별', status: '상태별' };

function filteredList(base) {
  const f = S.view;
  let list = base.filter((t) => t.status !== 'candidate');
  if (!f.showClosed) list = list.filter((t) => ACTIVE_STATUSES.includes(t.status));
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((t) => `${t.task_code} ${t.title} ${t.next_action ?? ''} ${t.project_title}`.toLowerCase().includes(q));
  }
  return list;
}
function listToolbar(base) {
  const f = S.view;
  const list = filteredList(base);
  return html`<div class="toolbar">
    <div class="chips">${CHIPS.map(([k, label, p]) => {
      const n = list.filter(p).length;
      return k === 'all' || n || f.chip === k ? html`<button type="button" class="chip ${f.chip === k ? 'on' : ''}" data-chip="${k}">${label}<span>${n}</span></button>` : '';
    })}</div>
    <div class="tools">
      <input type="search" id="q" placeholder="검색" value="${f.q}" aria-label="업무 검색">
      <select id="fgroup" aria-label="묶기">${Object.entries(GROUPS).map(([k, v]) => html`<option value="${k}" ${k === f.group ? raw('selected') : ''}>${v}</option>`)}</select>
      <label class="toggle"><input type="checkbox" id="fclosed" ${f.showClosed ? raw('checked') : ''}> 완료 포함</label>
      ${isOwner() && (S.mode === 'local' || S.mode === 'server') ? html`<details class="menu"><summary aria-label="더보기" title="내보내기">⋯</summary><div class="menu-pop"><a href="/api/export.csv">CSV 내보내기</a><a href="/api/export.json">JSON 백업</a></div></details>` : ''}
    </div>
  </div>`;
}
function bindToolbar(rerender) {
  $$('[data-chip]').forEach((b) => b.addEventListener('click', () => { S.view.chip = b.dataset.chip; rerender(); }));
  $('#q')?.addEventListener('input', (e) => {
    S.view.q = e.target.value;
    const pos = e.target.selectionStart;
    rerender();
    const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos);
  });
  $('#fgroup')?.addEventListener('change', (e) => { S.view.group = e.target.value; store.set('group', S.view.group); rerender(); });
  $('#fclosed')?.addEventListener('change', (e) => { S.view.showClosed = e.target.checked; rerender(); });
}
function listBody(base) {
  const list = filteredList(base).filter(CHIPS.find((c) => c[0] === S.view.chip)?.[2] ?? (() => true));
  if (!list.length) {
    const any = base.some((t) => t.status !== 'candidate');
    return html`<div class="empty-state"><b>${any ? '조건에 맞는 업무가 없습니다' : isOwner() ? '아직 등록된 업무가 없습니다' : '게시된 업무가 아직 없습니다'}</b>
      <p class="muted">${any ? '필터를 바꿔 보세요.' : isOwner() ? '위 입력칸에 바로 적거나, 등록 후보를 검토해 활성화하세요.' : ''}</p></div>`;
  }
  return html`${groupBy(list, S.view.group).map((g) => groupSection(g.key, g.label, g.items, g.opt))}`;
}

function renderTasks() {
  const cands = S.tasks.filter((t) => t.status === 'candidate').length;
  mount(main(), html`
    <div class="page">
      <header class="page-h"><div><h1>할 일</h1><p class="muted">동그라미 색 = 내 시급성 · 오른쪽 = 교수님 확인 상태와 가장 이른 기한</p></div></header>
      ${taskTabs('#/tasks')}
      ${quickAddBox()}
      ${listToolbar(S.tasks)}
      ${listBody(S.tasks)}
      ${isOwner() && cands ? html`<a class="notice subtle" href="#/candidates">등록 후보 ${cands}건은 검토 전이라 여기 나오지 않습니다 →</a>` : ''}
    </div>`);
  bindQuickAdd();
  bindToolbar(renderTasks);
}

const PROJECT_STATUS = { active: '진행', hold: '보류', done: '종료' };
function renderProject() {
  const p = projectById(S.pageArg);
  if (!p) { location.hash = '#/projects'; return; }
  const base = S.tasks.filter((t) => t.project_id === p.id);
  const cands = base.filter((t) => t.status === 'candidate').length;
  mount(main(), html`
    <div class="page">
      <header class="page-h"><div>
        <p class="eyebrow">${p.code}${p.status !== 'active' ? ` · ${PROJECT_STATUS[p.status]}` : ''}</p>
        <h1>${p.title}</h1>
        ${p.objective ? html`<p class="muted">${p.objective}</p>` : ''}
      </div>${isOwner() ? html`<button type="button" class="ghost" data-edit-project="${p.id}">프로젝트 수정</button>` : ''}</header>
      ${p.description ? html`<details class="desc"><summary>배경·주의사항</summary><p>${p.description}</p></details>` : ''}
      ${quickAddBox()}
      ${listToolbar(base)}
      ${listBody(base)}
      ${isOwner() && cands ? html`<a class="notice subtle" href="#/candidates">이 프로젝트의 등록 후보 ${cands}건 검토하기 →</a>` : ''}
    </div>`);
  bindQuickAdd();
  bindToolbar(renderProject);
}

// ---- 상세 패널 (오른쪽) ------------------------------------------------------------
async function openPeek(id) {
  if (S.peekKind !== 'task') S.peekData = null;
  S.peek = id;
  S.peekKind = 'task';
  markPeekRow();
  const panel = $('#peek');
  panel.hidden = false;
  $('#app').classList.add('peek-open');
  if (!S.peekData || S.peekData.id !== id) mount(panel, html`<p class="muted pad">불러오는 중…</p>`);
  try {
    const d = await api('GET', `/api/tasks/${id}`);
    if (S.peek !== id) return;
    S.peekData = d;
    upsertTask(d);
    renderPeek();
  } catch (e) { toastErr(e); closePeek(); }
}
function closePeek() {
  S.peek = null;
  S.peekData = null;
  S.peekKind = null;
  S.replyForm = null;
  $('#peek').hidden = true;
  $('#app').classList.remove('peek-open');
  markPeekRow();
}
function markPeekRow() {
  $$('.row.peeked').forEach((el) => el.classList.remove('peeked'));
  if (S.peek) $$(`.row[${S.peekKind === 'mail' ? 'data-mail' : 'data-peek'}="${S.peek}"]`).forEach((el) => el.classList.add('peeked'));
}

const FIELD_LABEL = {
  title: '업무명', description: '업무 목적·범위', expected_deliverable: '예상 산출물', done_criteria: '완료 기준',
  due_undecided_reason: '마감일 미정 사유', my_reason: '판단 이유', external_deadline: '외부 고정 일정',
  external_deadline_source: '외부 일정 출처', next_action: '다음 행동', waiting_on: '대기 대상',
  mail_told_professor: '교수님께 말씀드림', mail_reply_plan: '회신 내용',
  blocked_reason: '대기/차단 사유', follow_up_date: '재확인일', source_note: '메모', project_id: '프로젝트',
  status: '진행 상태', my_urgency: '내 시급성', my_due_date: '내 마감일', review_state: '검토 상태',
  visibility: '공유', source_type: '출처 유형', review: '확인 기록', objective: '목표',
};
const EVENT_LABEL = { create: '생성', initial: '최초 입력', update: '변경', review_added: '판단 확인 기록', import: '기획서에서 가져옴', verified: '현황 확인' };
function fmtValue(field, v) {
  if (v === null || v === undefined || v === '') return '(없음)';
  const maps = { status: STATUS, my_urgency: URGENCY, review_state: REVIEW_STATE, visibility: VISIBILITY, source_type: SOURCE_TYPE };
  if (maps[field]) return maps[field][v] ?? v;
  if (field === 'project_id') return projectById(v)?.code ?? v;
  return v;
}
function activityText(a) {
  if (a.event_type === 'review_added') return html`<b>판단 확인 기록</b> ${a.after}`;
  if (a.event_type === 'import' || a.event_type === 'create') return html`<b>${EVENT_LABEL[a.event_type]}</b> ${a.after ?? ''}`;
  if (a.event_type === 'verified') return html`<b>현황 확인</b>`;
  if (a.event_type === 'initial') return html`<b>${FIELD_LABEL[a.field] ?? a.field}</b> 최초 입력: ${fmtValue(a.field, a.after)}`;
  return html`<b>${FIELD_LABEL[a.field] ?? a.field}</b> <span class="del">${fmtValue(a.field, a.before)}</span><span class="arrow">→</span>${fmtValue(a.field, a.after)}`;
}

function renderPeek() {
  if (S.peekKind === 'mail') return renderMailPeek();
  const t = S.peekData;
  if (!t) return;
  const panel = $('#peek');
  const owner = isOwner();
  const d = t.derived;
  const r = t.latest_review;
  const active = document.activeElement;
  const focusName = panel.contains(active) ? active.dataset.f : null;
  const openSecs = new Set($$('details[data-sec]', panel).filter((x) => x.open).map((x) => x.dataset.sec));
  const val = (v) => v ?? '';
  const prop = (label, body) => html`<div class="prop"><div class="prop-k">${label}</div><div class="prop-v">${body}</div></div>`;
  const textIn = (f, placeholder = '') => html`<input class="inline" data-f="${f}" value="${val(t[f])}" placeholder="${placeholder}" aria-label="${FIELD_LABEL[f]}">`;
  const dateIn = (f) => html`<input type="date" class="inline" data-f="${f}" value="${val(t[f])}" aria-label="${FIELD_LABEL[f]}">`;
  const area = (f, placeholder = '') => html`<textarea class="inline" data-f="${f}" rows="2" placeholder="${placeholder}" aria-label="${FIELD_LABEL[f]}">${val(t[f])}</textarea>`;
  const ro = (v, fmt = (x) => x) => (v ? fmt(v) : html`<span class="muted">-</span>`);
  const sec = (key, label, body, openDefault = false) => html`<details class="more-sec" data-sec="${key}" ${openSecs.has(key) || (openDefault && !openSecs.size) ? raw('open') : ''}><summary>${label}</summary>${body}</details>`;

  const urgSeg = owner
    ? html`<div class="seg" role="group" aria-label="내 시급성">${Object.entries(URGENCY).map(([k, v]) => html`<button type="button" class="seg-b u-${k} ${t.my_urgency === k ? 'on' : ''}" data-urg="${k}" aria-pressed="${t.my_urgency === k ? 'true' : 'false'}">${v}</button>`)}</div>`
    : urgBadge(t.my_urgency);

  mount(panel, html`
    <div class="peek-head">
      <span class="muted small">${t.task_code} · ${t.project_title}</span>
      <span class="spacer"></span>
      <button type="button" class="icon-btn" data-close-peek aria-label="닫기 (Esc)" title="닫기 (Esc)">✕</button>
    </div>
    <div class="peek-body">
      ${owner ? html`<textarea class="title-in" data-f="title" rows="1" aria-label="업무명">${t.title}</textarea>` : html`<h2 class="peek-title">${t.title}</h2>`}
      <div class="flags">${d.due_flag === 'overdue' ? html`<span class="badge b-bad">기한 경과 · ${d.effective_due.label}</span>` : ''}
        ${d.conflicts.map((c) => html`<span class="badge b-bad">일정 충돌: ${c}</span>`)}
        ${d.self_missing.map((m) => html`<span class="badge b-warn">${m}</span>`)}</div>

      <div class="props">
        ${prop('상태', owner ? html`<select class="inline" data-f="status" aria-label="진행 상태">${options(STATUS, t.status, t.status === 'candidate' ? Object.keys(STATUS) : Object.keys(STATUS).filter((k) => k !== 'candidate'))}</select>` : statusBadge(t.status))}
        ${prop('프로젝트', owner ? html`<select class="inline" data-f="project_id" aria-label="프로젝트">${projectOptions(t.project_id)}</select>` : t.project_title)}
        ${prop('다음 행동', owner ? textIn('next_action', '지금 바로 할 가장 작은 행동') : ro(t.next_action))}
        ${t.status === 'waiting' || t.status === 'blocked' || t.blocked_reason ? html`
          ${prop('대기/차단 사유', owner ? textIn('blocked_reason') : ro(t.blocked_reason))}
          ${prop('대기 대상', owner ? textIn('waiting_on', '누구에게') : ro(t.waiting_on))}
          ${prop('재확인일', owner ? dateIn('follow_up_date') : ro(t.follow_up_date, fmtDate))}` : ''}
      </div>

      <div class="judge">
        <section class="judge-col">
          <h3>내 판단</h3>
          <div class="jf"><span class="jk">시급성</span>${urgSeg}</div>
          <div class="jf"><span class="jk">마감일</span>${owner ? dateIn('my_due_date') : ro(t.my_due_date, (x) => html`${fmtDate(x)} <span class="muted">${dday(x)}</span>`)}</div>
          ${owner ? html`<div class="jf col"><span class="jk">이유</span>${area('my_reason', '이 시급성·기한으로 정한 이유')}</div>
            ${!t.my_due_date ? html`<div class="jf col"><span class="jk">마감일을 정하기 어려운 이유</span>${textIn('due_undecided_reason', '반복·상시 업무 등')}</div>` : ''}`
          : html`${t.my_reason ? html`<p class="small">${t.my_reason}</p>` : ''}`}
        </section>
        <section class="judge-col prof">
          <h3>교수님·관계자 판단</h3>
          ${r ? html`
            <div class="jf"><span class="jk">시급성</span>${otherUrgBadge(r.other_urgency)}</div>
            <div class="jf"><span class="jk">기한</span>${r.other_due_date ? html`${fmtDate(r.other_due_date)} <span class="muted">${dday(r.other_due_date)}</span>` : html`<span class="muted">언급 없음</span>`}</div>
            <p class="small muted">${r.reviewer_name} · ${CHANNEL[r.review_channel]} · ${fmtReviewedAt(r.reviewed_at)}<br>${r.recorded_by_name}이(가) 옮겨 적음</p>
            ${r.note ? html`<p class="small quote">${r.note}</p>` : ''}`
          : html`<p class="muted small">아직 확인 기록이 없습니다.<br><b>미확인은 '일치'가 아닙니다.</b></p>`}
          ${owner ? html`<button type="button" class="ghost sm" data-add-review>+ 확인 기록 추가</button>` : ''}
        </section>
      </div>
      <div class="cmp-line ${d.mismatch ? 'diff' : ''}">
        ${cmpBadge(t)}
        <span>시급성 ${d.urgency_cmp === 'match' ? '일치' : d.urgency_cmp === 'mismatch' ? html`<b>${URGENCY[t.my_urgency]} ↔ ${URGENCY[d.other_urgency]}</b>` : d.urgency_cmp === 'self_missing' ? '본인 미평가' : '미확인'}</span>
        <span>기한 ${d.due_cmp === 'mismatch' ? html`<b>${dueDiffText(d.due_diff_days)}</b>` : d.due_cmp === 'match' ? '일치' : d.due_cmp === 'self_missing' ? '본인 마감일 없음' : '미확인'}</span>
      </div>
      <div class="props">
        ${prop('검토 상태', owner ? html`<select class="inline" data-f="review_state" aria-label="검토 상태">${options(REVIEW_STATE, t.review_state, t.review_state === 'confirmed' ? ['confirmed', ...MANUAL_REVIEW_STATES] : MANUAL_REVIEW_STATES)}</select>` : reviewBadge(t.review_state))}
        ${prop('외부 고정 일정', owner ? html`<div class="pair">${dateIn('external_deadline')}${textIn('external_deadline_source', '출처 (예: 학회 공지)')}</div>` : html`${ro(t.external_deadline, fmtDate)} <span class="muted small">${t.external_deadline_source ?? ''}</span>`)}
      </div>

      ${t.mail ? mailLinkBlock(t.mail) : ''}
      ${sec('content', '업무 내용', html`<div class="props">
          ${prop('목적·범위', owner ? area('description') : ro(t.description))}
          ${prop('예상 산출물', owner ? area('expected_deliverable') : ro(t.expected_deliverable))}
          ${prop('완료 기준', owner ? area('done_criteria') : ro(t.done_criteria))}
          ${owner ? html`${prop('출처 유형', html`<select class="inline" data-f="source_type" aria-label="출처 유형"><option value="">-</option>${options(SOURCE_TYPE, t.source_type ?? '')}</select>`)}
            ${prop('메모', html`${area('source_note')}<span class="hint">GitHub 공개 페이지에는 올라가지 않음</span>`)}` : ''}
        </div>`, !!(t.description || t.expected_deliverable || t.done_criteria))}
      ${sec('reviews', `확인 기록 ${t.reviews.length}건`, t.reviews.length ? html`<ul class="timeline">${t.reviews.map((rv) => html`<li>
          <div class="when">${fmtReviewedAt(rv.reviewed_at)} · ${CHANNEL[rv.review_channel]} · ${rv.reviewer_name}</div>
          확인: ${otherUrgBadge(rv.other_urgency)} ${rv.other_due_date ? fmtDate(rv.other_due_date) : ''}
          <span class="muted small">│ 당시 내 판단: ${URGENCY[rv.my_urgency_snapshot] ?? '미평가'} ${rv.my_due_date_snapshot ? fmtDate(rv.my_due_date_snapshot) : '마감 미정'}</span>
          ${rv.needs_recheck ? html` <span class="badge b-warn">재확인 필요</span>` : ''}
          ${rv.note ? html`<div class="small quote">${rv.note}</div>` : ''}</li>`)}</ul>` : html`<p class="muted small">없음</p>`)}
      ${sec('activity', `변경 이력 ${t.activity.length}건`, html`<ul class="timeline">${t.activity.map((a) => html`<li><div class="when">${fmtTs(a.created_at)} · ${a.actor_name ?? '시스템'}</div>${activityText(a)}${a.reason ? html`<div class="small muted">${a.event_type === 'review_added' ? '들은 내용' : '이유'}: ${a.reason}</div>` : ''}</li>`)}</ul>`)}
    </div>`);

  const title = $('.title-in', panel);
  if (title) {
    const fit = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
    fit();
    title.addEventListener('input', fit);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  }
  if (focusName) $(`[data-f="${focusName}"]`, panel)?.focus();
}

async function savePeekField(field, value) {
  const t = S.peekData;
  if (!t) return;
  let v = typeof value === 'string' ? value.trim() : value;
  if (v === '') v = null;
  if (field === 'project_id') v = Number(v);
  if (field === 'title' && !v) return renderPeek();
  if (v === (t[field] ?? null)) return;
  const body = { [field]: v };
  if (field === 'status' && (v === 'waiting' || v === 'blocked') && !t.blocked_reason) {
    const extra = await waitingDialog(t, v);
    if (!extra) return renderPeek();
    Object.assign(body, extra);
  }
  try {
    await patchTask(t.id, body);
    if (field === 'project_id' || field === 'status') await refreshProjects();
    renderPeek();
    refresh();
    toast('저장됨');
  } catch (e) { toastErr(e); renderPeek(); }
}

// 상세 패널의 입력은 바뀌는 즉시 저장한다 (저장 버튼 없음).
$('#peek').addEventListener('change', (e) => {
  const el = e.target.closest('[data-f]');
  if (el && isOwner()) savePeekField(el.dataset.f, el.value);
});
$('#peek').addEventListener('click', (e) => {
  if (e.target.closest('[data-close-peek]')) return closePeek();
  const u = e.target.closest('[data-urg]');
  if (u && isOwner()) return savePeekField('my_urgency', S.peekData.my_urgency === u.dataset.urg ? '' : u.dataset.urg);
  if (e.target.closest('[data-add-review]')) return reviewModal(S.peekData);
});

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

function waitingDialog(t, status) {
  return new Promise((resolve) => {
    const m = openModal(html`
      <h2>${STATUS[status]}로 변경</h2>
      <p class="muted small">${t.task_code} ${t.title}</p>
      <form id="wf">
        <div class="field"><label>${status === 'waiting' ? '무엇을 기다리는지 *' : '차단 사유와 해결 방법 *'}</label><textarea name="blocked_reason" required>${t.blocked_reason ?? ''}</textarea></div>
        <div class="row2">
          <div class="field"><label>대기 대상 (누구에게)</label><input name="waiting_on" value="${t.waiting_on ?? ''}"></div>
          <div class="field"><label>재확인일</label><input type="date" name="follow_up_date" value="${t.follow_up_date ?? ''}"></div>
        </div>
        <div class="actions"><button type="button" class="ghost" data-cancel>취소</button><button class="primary" type="submit">변경</button></div>
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

function newTaskModal({ due = null } = {}) {
  if (!S.projects.length) { toast('먼저 프로젝트를 만들어 주세요', { err: true }); return projectModal(); }
  const m = openModal(html`
    <h2>새 업무</h2>
    <form id="nt">
      <div class="field"><label>업무명 (수행할 행동) *</label><input name="title" required maxlength="300" placeholder="예: 이경도 박사님 메일 1차 회신"></div>
      <div class="field"><label>프로젝트 *</label><select name="project_id" required>${projectOptions(defaultProjectId())}</select></div>
      <div class="row2">
        <div class="field"><label>내 시급성</label><select name="my_urgency">${urgencyOptions(null, '선택…')}</select></div>
        <div class="field"><label>내 마감일</label><input type="date" name="my_due_date" value="${due ?? ''}"></div>
      </div>
      <p class="hint">시급성과 마감일은 교수님께 묻기 전에 <b>내가 먼저</b> 정합니다.</p>
      <div class="field"><label>다음 행동</label><input name="next_action" placeholder="지금 바로 할 수 있는 가장 작은 행동"></div>
      <div class="actions"><button type="button" class="ghost" data-cancel>취소</button><button class="primary" type="submit">등록</button></div>
    </form>`);
  const form = $('#nt', m);
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
      store.set('lastProject', f.project_id);
      closeModal();
      refresh();
      toast('등록됨', { action: { label: '열기', fn: () => openPeek(id) } });
    } catch (err) { toastErr(err); }
  });
}

function reviewModal(t) {
  const m = openModal(html`
    <h2>교수님·관계자 판단 기록</h2>
    <p class="muted small">${t.task_code} ${t.title}<br>지금 내 판단: <b>${URGENCY[t.my_urgency] ?? '미평가'} · ${t.my_due_date ? fmtDate(t.my_due_date) : '마감 미정'}</b> (함께 저장됩니다)</p>
    <form id="rv">
      <div class="row2">
        <div class="field"><label>확인된 시급성</label><select name="other_urgency">${urgencyOptions(null, '언급 없음')}</select></div>
        <div class="field"><label>확인된 기한</label><input type="date" name="other_due_date"></div>
      </div>
      <div class="row2">
        <div class="field"><label>의견 제공자 *</label><input name="reviewer_name" required value="${PROFESSOR_DEFAULT}"></div>
        <div class="field"><label>확인 경로 *</label><select name="review_channel" required>${options(CHANNEL, 'phone')}</select></div>
      </div>
      <div class="field"><label>확인 일시 (KST) *</label><input type="datetime-local" name="reviewed_at" required value="${nowKstLocal()}"></div>
      <div class="field"><label>들은 내용 (공개 페이지에는 올라가지 않음)</label><textarea name="note" placeholder="예: '그건 일주일 안에 하라는 소리야'"></textarea></div>
      <label class="toggle"><input type="checkbox" name="needs_recheck"> 날짜·해석이 불분명함 → '재확인 필요'로 표시</label>
      <p class="hint">'${S.me.display_name}이(가) 옮겨 적은 의견'으로 표시되며, 기록은 수정·삭제되지 않고 쌓입니다.</p>
      <div class="actions"><button type="button" class="ghost" data-cancel>취소</button><button class="primary" type="submit">기록</button></div>
    </form>`);
  $('[data-cancel]', m).addEventListener('click', closeModal);
  $('#rv', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.needs_recheck = !!f.needs_recheck;
    if (!f.other_urgency && !f.other_due_date) return toast('확인한 시급성 또는 기한 중 하나는 입력하세요', { err: true });
    try {
      const d = await api('POST', `/api/tasks/${t.id}/reviews`, f);
      upsertTask(d);
      closeModal();
      toast('확인 기록 추가됨');
      if (S.peekKind === 'task' && S.peek === t.id) { S.peekData = d; renderPeek(); }
      refresh();
    } catch (err) { toastErr(err); }
  });
}

// ---- 캘린더 (예정) -------------------------------------------------------------
const KIND_LABEL = { mine: '내 마감', other: '확인된 기한', ext: '외부 고정 일정', follow: '대기 재확인' };
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
// 날짜 → 그날 걸린 업무. 내 마감일과 확인된 기한이 다르면 두 날짜에 각각 표시한다.
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
    list.sort((a, b) => a.closed - b.closed || kr[a.kind] - kr[b.kind] || (URGENCY_RANK[a.t.my_urgency] ?? 9) - (URGENCY_RANK[b.t.my_urgency] ?? 9));
  }
  return map;
}
const evLate = (e) => !e.closed && ACTIVE_STATUSES.includes(e.t.status) && e.date < S.today && e.kind !== 'follow';
function calChip(e) {
  const t = e.t;
  const drag = isOwner() && e.kind === 'mine' && !e.closed;
  const prefix = e.kind === 'other' ? '교수님 · ' : e.kind === 'ext' ? '⚑ ' : e.kind === 'follow' ? '↻ ' : '';
  const agreed = e.kind === 'mine' && t.derived.due_cmp === 'match';
  return html`<a class="ev k-${e.kind} u-${t.my_urgency ?? 'none'} ${e.closed ? 'closed' : ''} ${evLate(e) ? 'late' : ''}"
      href="#" data-peek="${t.id}" draggable="${drag ? 'true' : 'false'}" data-task="${t.id}"
      title="${KIND_LABEL[e.kind]} · ${t.task_code} ${t.title}">${prefix}${t.title}${agreed ? html`<span class="ev-ok" aria-label="확인된 기한과 같음">✓</span>` : ''}</a>`;
}

// ---- 메일 점: 그날 받은 메일의 보낸 사람 1차 분류마다 점 하나 (같은 분류 여러 통이어도 하나) ----
function mailLevel(m) {
  if (!S.contacts.categories.length) return 's';
  const c = S.contacts.contacts.find((x) => x.address === String(m.from_addr ?? '').toLowerCase());
  if (!c || c.category_id == null) return 'u';
  const i = S.contacts.categories.findIndex((k) => k.id === c.category_id);
  return i < 0 ? 'u' : Math.min(i + 1, 6);
}
const levelOrder = (l) => (typeof l === 'number' ? l : 99);
function mailsByDate() {
  const map = new Map();
  for (const m of S.mails) {
    if (!map.has(m.received_date)) map.set(m.received_date, []);
    map.get(m.received_date).push(m);
  }
  return map;
}
function mailDots(d, byDate) {
  const list = byDate.get(d) ?? [];
  if (!list.length) return '';
  const levels = [...new Set(list.map(mailLevel))].sort((a, b) => levelOrder(a) - levelOrder(b));
  const unseen = list.some((m) => !m.seen && !m.hidden);
  const names = levels.map((l) => (l === 'u' ? '미분류' : l === 's' ? '메일' : S.contacts.categories[l - 1]?.name)).join(', ');
  return html`<span class="mdots" title="메일 ${list.length}건 (${names})${unseen ? ' · 새 메일 있음' : ''}">${levels.map((l) => html`<i class="md p${l}"></i>`)}${unseen ? html`<span class="new-emo">🆕</span>` : ''}</span>`;
}

// ---- 일정 ----
const eventsOn = (d) => S.events.filter((e) => e.start_date <= d && e.end_date >= d);
function eventWhen(e) {
  const days = e.start_date === e.end_date ? fmtDate(e.start_date) : `${fmtDate(e.start_date)} ~ ${fmtDate(e.end_date)}`;
  return e.all_day ? days : `${days} ${e.start_time}${e.end_time ? `~${e.end_time}` : ''}`;
}
// 한 주 안에서 일정 막대가 겹치지 않게 줄(lane)을 나눈다
function weekLayout(weekStart) {
  const weekEnd = addDaysStr(weekStart, 6);
  const evs = S.events.filter((e) => e.start_date <= weekEnd && e.end_date >= weekStart)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || b.end_date.localeCompare(a.end_date) || (a.start_time ?? '').localeCompare(b.start_time ?? ''));
  const lanes = [];
  return evs.map((e) => {
    const s = Math.max(0, daysBetween(weekStart, e.start_date));
    const t = Math.min(6, daysBetween(weekStart, e.end_date));
    let lane = lanes.findIndex((l) => l.every(([a, b]) => t < a || s > b));
    if (lane === -1) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push([s, t]);
    return { e, s, t, lane, contL: e.start_date < weekStart, contR: e.end_date > weekEnd };
  });
}
const MAX_LANES = 3;

// 일일 할 일은 마감 업무·일정과 별개이며 이 브라우저에만 저장한다.
const DAILY_PLAN_KEY = 'wb.dailyPlansV1';
const DAILY_PLAN_SEED = {
  '2026-10-26': [
    { id: '20261026-1', text: '주재정 과장님(엠지아이티)께 드론 엔터프라이즈 등록 가능 여부 확인', done: false },
    { id: '20261026-2', text: '날짜별 모자이크 영상 생성 및 HTML 완성', done: false },
    { id: '20261026-3', text: '이번 주 교수님 미팅에 가져갈 자료 정리', done: false },
    { id: '20261026-4', text: '10월 28일 제출 과제 마무리', done: false },
  ],
};
function dailyPlan(date) {
  const rows = S.dailyPlans?.[date] ?? DAILY_PLAN_SEED[date] ?? [];
  return Array.isArray(rows) ? rows.filter((t) => t && typeof t.id === 'string' && typeof t.text === 'string') : [];
}
function saveDailyPlan(date, rows) {
  const plans = { ...(S.dailyPlans ?? DAILY_PLAN_SEED), [date]: rows };
  try {
    localStorage.setItem(DAILY_PLAN_KEY, JSON.stringify(plans));
    S.dailyPlans = plans;
    return true;
  } catch {
    toast('할 일을 저장하지 못했습니다. 브라우저 저장 공간·권한을 확인하세요.', { err: true });
    return false;
  }
}
function calendarRange(mode, month, anchor) {
  if (mode === 'month') {
    const [y, m] = month.split('-').map(Number);
    const first = month + '-01';
    const offset = dowOf(first);
    return { start: addDaysStr(first, -offset), weeks: Math.ceil((offset + new Date(Date.UTC(y, m, 0)).getUTCDate()) / 7) };
  }
  return { start: addDaysStr(anchor, -dowOf(anchor)), weeks: 2 };
}
function dailyPlanBox(date) {
  const rows = dailyPlan(date);
  const done = rows.filter((t) => t.done).length;
  return html`<section class="daily-plan" aria-labelledby="daily-plan-title">
    <header class="daily-plan-head">
      <div><h2 id="daily-plan-title">${fmtDate(date)} · ${date === S.today ? '오늘 할 일' : '할 일'}</h2>
        <p class="small muted">이 브라우저에 저장 · 다른 기기와 동기화되지 않음</p></div>
      <span class="daily-count" role="status" aria-live="polite">완료 ${done} / ${rows.length}</span>
    </header>
    <ul class="daily-plan-list">${rows.map((t) => html`<li>
      <label class="daily-plan-label"><input type="checkbox" data-daily-toggle="${t.id}" ${t.done ? raw('checked') : ''}>
        <span class="${t.done ? 'del' : ''}">${t.text}</span></label>
      <button type="button" class="icon-btn" data-daily-delete="${t.id}" aria-label="${t.text} 삭제" title="할 일 삭제">×</button>
    </li>`)}</ul>
    ${rows.length ? '' : html`<p class="small muted">등록된 할 일이 없습니다.</p>`}
    <form class="daily-plan-add" data-daily-form>
      <label class="sr-only" for="daily-plan-input">선택한 날짜의 새 할 일</label>
      <input id="daily-plan-input" name="text" maxlength="200" required autocomplete="off" placeholder="할 일 추가">
      <button type="submit" class="primary">추가</button>
    </form>
  </section>`;
}
function bindDailyPlan(root, date) {
  root.querySelector('[data-daily-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = e.target.elements.text.value.trim();
    if (!text) return;
    const id = crypto.randomUUID();
    if (saveDailyPlan(date, [...dailyPlan(date), { id, text, done: false }])) {
      renderCalendar();
      document.querySelector('#daily-plan-input')?.focus();
    }
  });
  root.querySelector('.daily-plan').addEventListener('change', (e) => {
    const input = e.target.closest('[data-daily-toggle]');
    if (!input) return;
    const rows = dailyPlan(date).map((t) => t.id === input.dataset.dailyToggle ? { ...t, done: input.checked } : t);
    if (saveDailyPlan(date, rows)) {
      renderCalendar();
      [...document.querySelectorAll('[data-daily-toggle]')].find((el) => el.dataset.dailyToggle === input.dataset.dailyToggle)?.focus();
    } else input.checked = !input.checked;
  });
  root.querySelector('.daily-plan').addEventListener('click', (e) => {
    const button = e.target.closest('[data-daily-delete]');
    if (!button) return;
    if (confirm('이 할 일을 삭제할까요? 완료 표시만 하려면 체크박스를 사용하세요.')) {
      if (saveDailyPlan(date, dailyPlan(date).filter((t) => t.id !== button.dataset.dailyDelete))) renderCalendar();
    }
  });
}


function renderCalendar() {
  const owner = isOwner() && S.mode !== 'static';
  // 공개 페이지에서도 일정 '추가'·'수정'은 누구나
  const editable = calEdit() || (S.mode === 'static' && !!(SITE?.relay_url || SITE?.data_repo));
  if (!S.cal.month) S.cal.month = S.today.slice(0, 7);
  if (!S.cal.selected) S.cal.selected = S.today;
  const [y, mo] = S.cal.month.split('-').map(Number);
  S.cal.anchor ??= S.today;
  const { start, weeks } = calendarRange(S.cal.mode, S.cal.month, S.cal.anchor);
  const end = addDaysStr(start, weeks * 7 - 1);
  const taskMap = calendarEvents();
  const byDate = mailsByDate();
  const undated = activeTasks().filter((t) => !t.my_due_date).sort((a, b) => (URGENCY_RANK[a.my_urgency] ?? 9) - (URGENCY_RANK[b.my_urgency] ?? 9));

  const weekRows = [];
  for (let w = 0; w < weeks; w++) {
    const ws = addDaysStr(start, w * 7);
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDaysStr(ws, i));
    const placed = weekLayout(ws);
    const hidden = days.map((_, i) => placed.filter((p) => p.lane >= MAX_LANES && p.s <= i && p.t >= i).length);
    const cls = (d, i) => `c${i + 1} dow-${dowOf(d)} ${S.cal.mode !== 'month' || d.slice(0, 7) === S.cal.month ? '' : 'out'} ${d === S.today ? 'today' : ''} ${d === S.cal.selected ? 'sel' : ''}`;
    weekRows.push(html`<div class="wk">
      ${days.map((d, i) => html`<div class="cal-bg ${cls(d, i)}" data-date="${d}"></div>`)}
      ${days.map((d, i) => html`<div class="cal-dh ${cls(d, i)}" data-date="${d}">
        <button type="button" class="num" data-sel="${d}" aria-label="${fmtDate(d)}" aria-pressed="${d === S.cal.selected}">${Number(d.slice(8))}</button>${dailyPlan(d).length ? html`<span class="daily-day-count" title="할 일 완료 ${dailyPlan(d).filter((t) => t.done).length}/${dailyPlan(d).length}">${dailyPlan(d).filter((t) => t.done).length}/${dailyPlan(d).length}</span>` : ''}${mailDots(d, byDate)}
        ${editable && d === S.cal.selected ? html`<button type="button" class="sel-add" data-new-event="${d}" title="${fmtDate(d)}에 일정 추가">+ 추가</button>` : ''}</div>`)}
      ${placed.filter((p) => p.lane < MAX_LANES).map((p) => html`<a href="#" class="ev-bar c${p.s + 1} s${p.t - p.s + 1} l${p.lane + 1} ${p.contL ? 'cont-l' : ''} ${p.contR ? 'cont-r' : ''}"
          data-event="${p.e.id}" data-ec="${typeOf(p.e).color}" title="${typeOf(p.e).name} · ${p.e.title} · ${eventWhen(p.e)}${p.e.location ? ` · ${p.e.location}` : ''}">${p.e.title}</a>`)}
      ${days.map((d, i) => {
        const list = taskMap.get(d) ?? [];
        const more = Math.max(0, list.length - 3) + hidden[i];
        return html`<div class="cal-evs c${i + 1}" data-date="${d}">${list.slice(0, 3).map(calChip)}${more ? html`<button type="button" class="more" data-sel="${d}">+${more}건 더</button>` : ''}</div>`;
      })}
      ${days.map((d, i) => html`<div class="cal-dots c${i + 1}" data-date="${d}" aria-hidden="true">${(taskMap.get(d) ?? []).slice(0, 4).map((e) => html`<i class="dot k-${e.kind} u-${e.t.my_urgency ?? 'none'}"></i>`)}</div>`)}
    </div>`);
  }

  const sel = S.cal.selected;
  const selEvents = eventsOn(sel);
  const selAll = byDate.get(sel) ?? [];
  const selMails = selAll.filter((m) => !m.hidden).sort(byPriority);
  const selHidden = selAll.length - selMails.length;
  const selTasks = taskMap.get(sel) ?? [];
  const taskItem = (e) => {
    const t = e.t;
    return html`<a class="day-item" href="#" data-peek="${t.id}">
      <div class="day-item-top"><span class="ev-kind k-${e.kind}">${KIND_LABEL[e.kind]}</span><span class="muted small">${t.task_code}</span>${evLate(e) ? html`<span class="badge b-bad">기한 경과</span>` : ''}</div>
      <div class="day-item-title ${e.closed ? 'del' : ''}">${t.title}</div>
      <div class="flags">${urgBadge(t.my_urgency)} ${judgPill(t)}</div>
      ${e.kind === 'other' ? html`<div class="small muted">내 마감일 ${t.my_due_date ? fmtDate(t.my_due_date) : '미정'} · ${dueDiffText(t.derived.due_diff_days)}</div>` : ''}
    </a>`;
  };
  const eventItem = (e) => html`<a class="day-item" href="#" data-event="${e.id}" title="${editable ? '눌러서 수정·삭제' : '눌러서 자세히 보기'}">
      <div class="day-item-top"><span class="ev-kind etype" data-ec="${typeOf(e).color}">${typeOf(e).name}</span><span class="muted small">${eventWhen(e)}</span>${editable ? html`<span class="ev-edit">✎ 수정</span>` : ''}</div>
      <div class="day-item-title">${e.title}</div>${e.location ? html`<div class="small muted">${e.location}</div>` : ''}
      ${e.note ? html`<div class="small ev-note">${e.note}</div>` : ''}</a>`;
  const mailItem = (m) => html`<a class="day-item" href="#" data-mail-note="${m.id}">
      <div class="day-item-top"><span class="md-inline"><i class="md p${mailLevel(m)}"></i></span><span class="ev-kind k-mail">받은 메일</span>${m.priority ? urgBadge(m.priority) : ''}${m.seen ? '' : html`<span class="new-emo">🆕</span>`}</div>
      <div class="day-item-title">${m.subject}</div>
      <div class="small muted">${displaySender(m)} ${senderTag(m)}</div>
      ${m.summary ? html`<div class="small mn-sum">${m.summary}</div>` : ''}
      <div class="flags">${mailStatusPills(m)}${todoProgress(m)}</div></a>`;
  const legendLevels = S.contacts.categories.length
    ? html`${S.contacts.categories.slice(0, 6).map((k, i) => html`<span><i class="md p${i + 1}"></i>${k.name}</span>`)}<span><i class="md pu"></i>미분류</span>`
    : html`<span><i class="md ps"></i>메일 온 날</span>`;

  mount(main(), html`
    <div class="page wide">
      <header class="page-h cal-h">
        <h1>${S.cal.mode === 'month' ? `${y}년 ${mo}월` : `${fmtDate(start)} ~ ${fmtDate(end)}`}</h1>
        <div class="cal-view-toggle" role="group" aria-label="달력 보기">
          <button type="button" class="ghost ${S.cal.mode === 'fortnight' ? 'on' : ''}" data-cal-view="fortnight" aria-pressed="${S.cal.mode === 'fortnight'}">2주 보기</button>
          <button type="button" class="ghost ${S.cal.mode === 'month' ? 'on' : ''}" data-cal-view="month" aria-pressed="${S.cal.mode === 'month'}">월별 보기</button>
        </div>
        <div class="cal-nav">
          <button type="button" class="ghost" data-month="-1" aria-label="${S.cal.mode === 'month' ? '이전 달' : '이전 2주'}">‹</button>
          <button type="button" class="ghost" data-month="0">오늘</button>
          <button type="button" class="ghost" data-month="1" aria-label="${S.cal.mode === 'month' ? '다음 달' : '다음 2주'}">›</button>
        </div>
        <span class="spacer"></span>
        ${owner ? html`<button type="button" class="primary" data-new-event="${sel}">+ 일정</button>` : ''}
      </header>
      ${owner ? eventQuickBox() : ''}
      <div class="legend">
        <span class="lg-h">업무</span><span><i class="sw u-super"></i>초시급</span><span><i class="sw u-urgent"></i>시급</span><span><i class="sw u-routine"></i>일상</span><span><i class="sw k-other"></i>교수님 확인 기한</span>
        <span class="lg-h">일정</span>${S.eventTypes.map((t) => html`<span><i class="sw etype-sw" data-ec="${t.color}"></i>${t.name}</span>`)}
        ${owner ? html`<button type="button" class="link small" data-types-edit>종류·색 편집</button>` : ''}
        <span class="lg-h">메일</span>${legendLevels}
      </div>
      <div class="cal">
        <div class="cal-board">
          <div class="cal-week">${[0, 1, 2, 3, 4, 5, 6].map((i) => html`<div class="cal-dow dow-${i}">${WEEK[i]}</div>`)}</div>
          <div class="cal-weeks">${weekRows}</div>
        </div>
        <aside class="cal-side">
          <section class="side-card">
            <div class="side-day">${Number(sel.slice(5, 7))}월 ${Number(sel.slice(8))}일 ${WEEK[dowOf(sel)]}요일 <span class="muted small">${sel === S.today ? '오늘' : dday(sel)}</span>
              ${editable ? html`<button type="button" class="primary sm side-add" data-new-event="${sel}">+ 일정 추가</button>` : ''}</div>
            ${selEvents.length ? html`<h4 class="day-sec">일정</h4><div class="day-list">${selEvents.map(eventItem)}</div>` : ''}
            ${selTasks.length ? html`<h4 class="day-sec">업무</h4><div class="day-list">${selTasks.map(taskItem)}</div>` : ''}
            ${selMails.length || selHidden ? html`<h4 class="day-sec">받은 메일</h4><div class="day-list">${selMails.map(mailItem)}</div>
              ${selHidden ? html`<p class="small muted hidden-mails">${selMails.length ? '그 외 ' : ''}메일 ${selHidden}건 — 제목·발신인 비공개</p>` : ''}` : ''}
            ${!selEvents.length && !selTasks.length && !selAll.length ? html`<p class="muted small">이 날짜에는 일정·업무·메일이 없습니다.</p>` : ''}
            ${editable ? html`<div class="day-adds"><button type="button" class="dash-btn" data-new-event="${sel}">+ 일정</button>${owner ? html`<button type="button" class="dash-btn" data-new-task="${sel}">+ 업무</button>` : ''}</div>` : ''}
          </section>
          ${undated.length ? html`<section class="side-card">
            <h3>마감일 미정 <span class="muted">${undated.length}</span></h3>
            ${owner ? html`<p class="small muted">달력 날짜로 끌어다 놓으면 내 마감일이 정해집니다.</p>` : ''}
            <div class="undated">${undated.map((t) => html`<a class="ev k-mine u-${t.my_urgency ?? 'none'}" href="#" data-peek="${t.id}" draggable="${owner ? 'true' : 'false'}" data-task="${t.id}">${t.title}</a>`)}</div>
          </section>` : ''}
        </aside>
      </div>
      ${dailyPlanBox(sel)}
    </div>`);

  const root = $('#main .page');
  bindDailyPlan(root, sel);
  root.addEventListener('click', (e) => {
    if (S.calJustDragged) { S.calJustDragged = false; return; }
    const view = e.target.closest('[data-cal-view]');
    if (view) {
      S.cal.mode = view.dataset.calView;
      S.cal.month = S.cal.selected.slice(0, 7);
      S.cal.anchor = S.cal.selected;
      return renderCalendar();
    }
    const m = e.target.closest('[data-month]');
    if (m) {
      const n = Number(m.dataset.month);
      if (n === 0) {
        S.cal.month = S.today.slice(0, 7);
        S.cal.anchor = S.today;
        S.cal.selected = S.today;
      } else if (S.cal.mode === 'month') {
        S.cal.month = shiftMonth(S.cal.month, n);
        S.cal.selected = S.cal.month + '-01';
        S.cal.anchor = S.cal.selected;
      } else {
        S.cal.anchor = addDaysStr(start, n * 14);
        S.cal.selected = S.cal.anchor;
        S.cal.month = S.cal.selected.slice(0, 7);
      }
      return renderCalendar();
    }
    const ne = e.target.closest('[data-new-event]');
    if (ne) return requireEdit(() => eventModal(null, { start: ne.dataset.newEvent }));
    const nt = e.target.closest('[data-new-task]');
    if (nt) return requireEdit(() => newTaskModal({ due: nt.dataset.newTask }));
    const mn = e.target.closest('[data-mail-note]');
    if (mn) { e.preventDefault(); return mailNoteModal(mn.dataset.mailNote); }
    const add = e.target.closest('[data-add]');
    if (add) { S.cal.selected = add.dataset.add; return createChooser({ date: add.dataset.add }); }
    if (e.target.closest('[data-peek], [data-event], [data-mail]')) return;
    if (e.target.closest('[data-types-edit]')) return typeManager();
    const cell = e.target.closest('[data-sel], [data-date]');
    if (cell) {
      const d = cell.dataset.sel || cell.dataset.date;
      S.cal.selected = d;
      renderCalendar();
      if (isPhone()) $('.daily-plan')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  if (!owner) return;
  bindEventQuick(root);
  // 여러 날을 끌어서 선택 → 그 기간으로 새 일정
  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('a, button, input, .ev, .ev-bar')) return;
    const el = e.target.closest('.cal-weeks [data-date]');
    if (!el) return;
    S.calDrag = { a: el.dataset.date, b: el.dataset.date };
    e.preventDefault();
  });
  root.addEventListener('mouseover', (e) => {
    if (!S.calDrag) return;
    const el = e.target.closest('.cal-weeks [data-date]');
    if (!el || el.dataset.date === S.calDrag.b) return;
    S.calDrag.b = el.dataset.date;
    const [a, b] = [S.calDrag.a, S.calDrag.b].sort();
    $$('.cal-bg').forEach((bg) => bg.classList.toggle('in-range', bg.dataset.date >= a && bg.dataset.date <= b));
  });
  // 업무 칩 끌어다 놓기로 내 마감일 변경 (변경 이력에 남음)
  root.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-task][draggable="true"]');
    if (!chip) return;
    e.dataTransfer.setData('text/plain', chip.dataset.task);
    e.dataTransfer.effectAllowed = 'move';
    chip.classList.add('dragging');
  });
  root.addEventListener('dragend', () => $$('.dragging, .drop-hover').forEach((el) => el.classList.remove('dragging', 'drop-hover')));
  root.addEventListener('dragover', (e) => {
    const el = e.target.closest('.cal-weeks [data-date]');
    if (!el) return;
    e.preventDefault();
    $$('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
    $(`.cal-bg[data-date="${el.dataset.date}"]`)?.classList.add('drop-hover');
  });
  root.addEventListener('drop', async (e) => {
    const el = e.target.closest('.cal-weeks [data-date]');
    if (!el) return;
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain'));
    const t = S.tasks.find((x) => x.id === id);
    const to = el.dataset.date;
    S.cal.selected = to;
    if (!t || t.my_due_date === to) return renderCalendar();
    const from = t.my_due_date;
    try {
      await patchTask(id, { my_due_date: to, reason: '캘린더에서 날짜 이동' });
      refresh();
      if (S.peek === id) renderPeek();
      toast(`${t.task_code} 내 마감일 ${from ? fmtDate(from) : '미정'} → ${fmtDate(to)}`, {
        action: { label: '되돌리기', fn: async () => { await patchTask(id, { my_due_date: from, reason: '캘린더 이동 되돌림' }); refresh(); if (S.peek === id) renderPeek(); } },
      });
    } catch (err) { toastErr(err); renderCalendar(); }
  });
}
document.addEventListener('mouseup', () => {
  const d = S.calDrag;
  if (!d) return;
  S.calDrag = null;
  $$('.cal-bg.in-range').forEach((bg) => bg.classList.remove('in-range'));
  if (d.a === d.b) return;
  const [a, b] = [d.a, d.b].sort();
  S.calJustDragged = true;
  setTimeout(() => { S.calJustDragged = false; }, 50);
  eventModal(null, { start: a, end: b });
});


// ---- 일정 종류 (이름·색은 사용자가 정함) ----------------------------------------------
const NO_TYPE = { id: null, name: '종류 없음', color: '#8b90a0' };
const typeOf = (e) => S.eventTypes.find((t) => t.id === e.type_id) ?? NO_TYPE;
const TYPE_PALETTE = ['#e5484d', '#f08c00', '#e2b600', '#2b9a5a', '#0f9488', '#2f6fdb', '#5b5bd6', '#8e4ec6', '#c2417a', '#64748b', '#8b90a0'];
async function reloadEventTypes() { S.eventTypes = await api('GET', '/api/event-types'); }
// 일정 이름의 낱말로 종류를 짐작 (해당 이름의 종류가 있을 때만)
const TYPE_WORDS = [
  [/제출|마감|투고|접수|신청|기한/, ['제출']],
  [/발표(?!회)|구두|포스터|디펜스|프레젠테이션|PT/i, ['발표']],
  [/학회|세미나|워크숍|워크샵|심포지엄|포럼|행사|컨퍼런스|발표회|박람회/, ['학회', '행사']],
  [/출장|현장|답사|관측|캠페인/, ['출장']],
  [/회의|미팅|면담|상담|브리핑|랩미팅|zoom|줌/i, ['회의']],
];
function guessType(title) {
  for (const [re, names] of TYPE_WORDS) {
    if (!re.test(title)) continue;
    const t = S.eventTypes.find((x) => names.some((n) => x.name.includes(n)));
    if (t) return t.id;
  }
  return null;
}

// ---- 캘린더 일정 바로 추가 (한 줄: 제목 + 날짜/기간 + 시간 + @장소) ----
const pad2 = (n) => String(n).padStart(2, '0');
function hour24(ap, h) {
  h = Number(h);
  if (ap === '오후' && h < 12) h += 12;
  if (ap === '오전' && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 7) h += 12; // '3시 미팅'은 보통 오후
  return h;
}
function parseEventQuick(text, baseDate) {
  let s = ` ${text} `;
  const out = { start_date: null, end_date: null, start_time: null, end_time: null, location: null };
  const cut = (m) => { s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); };
  let m = s.match(/\s@\s?([^@]+?)\s*$/);
  if (m) { out.location = m[1].trim(); cut(m); }
  m = s.match(/(^|\s)(\d{1,2})[/.](\d{1,2})\s*[~\-–]\s*(?:(\d{1,2})[/.])?(\d{1,2})(?:까지)?(?=\s|$)/)
    || s.match(/(^|\s)(\d{1,2})월\s?(\d{1,2})일\s*[~\-–]\s*(?:(\d{1,2})월\s?)?(\d{1,2})일(?:까지)?(?=\s|$)/);
  if (m) {
    const st = guessYear(+m[2], +m[3]);
    if (st) {
      const y = Number(st.slice(0, 4));
      let en = ymd(y, m[4] ? +m[4] : +m[2], +m[5]);
      if (en && en < st) en = ymd(y + 1, m[4] ? +m[4] : +m[2], +m[5]);
      if (en) { out.start_date = st; out.end_date = en; cut(m); }
    }
  }
  if (!out.start_date) {
    for (const [re, fn] of DATE_RULES) {
      const mm = s.match(re);
      const v = mm && fn(mm);
      if (v) { out.start_date = v; cut(mm); break; }
    }
  }
  m = s.match(/(^|\s)([01]?\d|2[0-3]):([0-5]\d)(?:\s*[~\-–]\s*([01]?\d|2[0-3]):([0-5]\d))?(?:부터|까지)?(?=\s|$)/);
  if (m) {
    out.start_time = `${pad2(m[2])}:${m[3]}`;
    if (m[4]) out.end_time = `${pad2(m[4])}:${m[5]}`;
    cut(m);
  } else {
    m = s.match(/(^|\s)(오전|오후)?\s?(\d{1,2})시(?:\s?(\d{1,2})분|\s?반)?(?:\s*[~\-–]\s*(오전|오후)?\s?(\d{1,2})시(?:\s?(\d{1,2})분|\s?반)?)?(?:부터|까지|에)?(?=\s|$)/);
    if (m && +m[3] <= 24) {
      const h1 = hour24(m[2], m[3]);
      const min1 = /반/.test(m[0].split(/[~\-–]/)[0]) ? 30 : +(m[4] ?? 0);
      out.start_time = `${pad2(h1)}:${pad2(min1)}`;
      if (m[6]) {
        const h2 = hour24(m[5] ?? (h1 >= 12 && +m[6] < 12 ? '오후' : m[2]), m[6]);
        const min2 = /반/.test(m[0].split(/[~\-–]/)[1] ?? '') ? 30 : +(m[7] ?? 0);
        out.end_time = `${pad2(h2)}:${pad2(min2)}`;
      }
      cut(m);
    }
  }
  const title = s.replace(/\s+/g, ' ').trim();
  out.start_date ??= baseDate;
  if (!out.end_date || out.end_date < out.start_date) out.end_date = out.start_date;
  if (out.end_time && out.start_date === out.end_date && out.end_time < out.start_time) out.end_time = null;
  return { title, type_id: guessType(title), ...out, all_day: !out.start_time };
}
window.__parseEventQuick = parseEventQuick; // 브라우저 콘솔 점검용

function eventQuickBox() {
  return html`<form class="qa ev-qa" autocomplete="off">
    <span class="qa-plus" aria-hidden="true">+</span>
    <input class="ev-qa-input" name="q" placeholder="일정 한 줄로 바로 추가 — 예: 추계 원격탐사학회 10/21~10/22 · 논문 제출 마감 11/30 · 교수님 면담 금요일 14:00" aria-label="일정 바로 추가" enterkeyhint="done">
    <div class="qa-chips"></div>
  </form>`;
}
function bindEventQuick(root) {
  const form = $('.ev-qa', root);
  if (!form) return;
  const input = $('.ev-qa-input', form);
  const chips = $('.qa-chips', form);
  const parse = () => parseEventQuick(input.value, S.cal.selected ?? S.today);
  const preview = () => {
    const r = parse();
    const ty = S.eventTypes.find((t) => t.id === r.type_id) ?? NO_TYPE;
    form.classList.toggle('typing', input.value.trim().length > 0);
    mount(chips, html`
      <span class="qchip on ek">${r.start_date === r.end_date ? fmtDate(r.start_date) : `${fmtDate(r.start_date)} ~ ${fmtDate(r.end_date)}`}</span>
      <span class="qchip ${r.all_day ? '' : 'on ek'}">${r.all_day ? '하루 종일' : `${r.start_time}${r.end_time ? `~${r.end_time}` : ''}`}</span>
      <span class="qchip etype" data-ec="${ty.color}">${ty.name}</span>
      ${r.location ? html`<span class="qchip on ek">@ ${r.location}</span>` : ''}
      <span class="qa-hint">Enter로 추가 · 날짜가 없으면 선택한 날(${fmtDate(S.cal.selected ?? S.today)}) · 메모는 추가 후 막대를 눌러 적기</span>`);
  };
  input.addEventListener('input', preview);
  input.addEventListener('focus', preview);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = parse();
    if (!r.title) return toast('일정 제목을 입력하세요', { err: true });
    try {
      const { id } = await api('POST', '/api/events', r);
      await reloadEvents();
      S.cal.selected = r.start_date;
      S.cal.month = r.start_date.slice(0, 7);
      refresh();
      $('#main .ev-qa-input')?.focus();
      const created = S.events.find((x) => x.id === id);
      toast(`일정 추가됨 · ${r.title} · ${eventWhen(created)}`, { action: { label: '메모·수정', fn: () => eventModal(created) } });
    } catch (err) { toastErr(err); }
  });
}

// ---- 일정 추가·수정 창: 종류 → 핵심 제목 → 기간 → 시간 → 메모 ----
async function reloadEvents() { S.events = await api('GET', '/api/events'); }
function eventModal(ev = null, { start = S.today, end = null, draft = null } = {}) {
  const owner = calEdit();
  if (ev && !owner) {
    const ty = typeOf(ev);
    const m = openModal(html`<h2>${ev.title}</h2>
      <div class="props">
        <div class="prop"><div class="prop-k">종류</div><div class="prop-v"><span class="ev-kind etype" data-ec="${ty.color}">${ty.name}</span></div></div>
        <div class="prop"><div class="prop-k">일시</div><div class="prop-v">${eventWhen(ev)}</div></div>
        ${ev.location ? html`<div class="prop"><div class="prop-k">장소</div><div class="prop-v">${ev.location}</div></div>` : ''}
      ${ev.note ? html`<p class="small ev-note">${ev.note}</p>` : ''}
      </div><div class="actions"><button type="button" class="ghost" data-cancel>닫기</button>
        ${SITE?.relay_url || SITE?.data_repo ? html`<button type="button" class="primary" data-edit>✎ 수정</button>` : ''}</div>`);
    $('[data-cancel]', m).addEventListener('click', closeModal);
    // 공개 페이지가 창구에 연결 못 한 채 열렸을 때: 다시 연결해 보고 수정 화면
    $('[data-edit]', m)?.addEventListener('click', () => { closeModal(); requireEdit(() => eventModal(S.events.find((x) => x.id === ev.id) ?? ev)); });
    return;
  }
  if (!owner) return;
  const e = draft ?? ev ?? { title: '', type_id: null, start_date: start, end_date: end ?? start, all_day: 1, start_time: null, end_time: null, location: '', note: '' };
  const m = openModal(html`<h2>${ev ? '일정 수정' : '일정 추가'} <span class="muted small">${fmtDate(e.start_date)}${e.end_date !== e.start_date ? ` ~ ${fmtDate(e.end_date)}` : ''}</span></h2>
    <form id="evf" autocomplete="off">
      <div class="field"><label>종류 ${S.mode !== 'open' ? html`<button type="button" class="link small" data-types>종류·색 편집</button>` : ''}</label>
        <div class="choices type-choices">
          ${S.eventTypes.map((t) => html`<label class="choice"><input type="radio" name="type_id" value="${t.id}" ${t.id === e.type_id ? raw('checked') : ''}><span class="tchip" data-ec="${t.color}"><i class="tdot"></i>${t.name}</span></label>`)}
        </div></div>
      <div class="field"><label>제목 * <span class="muted">— 캘린더에는 이것만 보여요</span></label><input name="title" required maxlength="200" value="${e.title}" placeholder="예: 추계 원격탐사학회, KJRS 논문 제출 마감"></div>
      <div class="row2">
        <div class="field"><label>시작 날짜</label><input type="date" name="start_date" required value="${e.start_date}"></div>
        <div class="field"><label>종료 날짜 (기간)</label><input type="date" name="end_date" value="${e.end_date}"></div>
      </div>
      <div class="time-line">
        <label class="toggle"><input type="checkbox" name="all_day" ${e.all_day ? raw('checked') : ''}> 하루 종일</label>
        <span class="ev-times" ${e.all_day ? raw('hidden') : ''}><input type="time" name="start_time" step="300" value="${e.start_time ?? ''}" aria-label="시작 시간"> ~ <input type="time" name="end_time" step="300" value="${e.end_time ?? ''}" aria-label="종료 시간"></span>
      </div>
      <div class="field"><label>메모 <span class="muted">— 무엇에 대한 일정인지, 준비할 것·링크 등 ${S.mode === 'open' ? '(이 페이지를 여는 누구나 볼 수 있음)' : '(공개 페이지에는 안 보임)'}</span></label><textarea name="note" rows="4" placeholder="예: 구두발표 15분, 세션 B-2. 발표자료 10/18까지 교수님 검토">${e.note ?? ''}</textarea></div>
      ${e.location ? html`<div class="field"><label>장소</label><input name="location" maxlength="200" value="${e.location}"></div>` : html`<input type="hidden" name="location" value="">`}
      <div class="actions">${ev ? html`<button type="button" class="ghost danger" data-del>삭제</button><span class="spacer"></span>` : ''}
        <button type="button" class="ghost" data-cancel>취소</button><button class="primary" type="submit">${ev ? '저장' : '추가'}</button></div>
    </form>`);
  const form = $('#evf', m);
  form.title.focus();
  const typeChecked = () => form.querySelector('input[name="type_id"]:checked');
  let typeTouched = !!(ev || draft) && !!e.type_id;
  $$('input[name="type_id"]', form).forEach((r) => r.addEventListener('change', () => { typeTouched = true; }));
  form.title.addEventListener('input', () => {
    if (typeTouched) return;
    const id = guessType(form.title.value);
    $$('input[name="type_id"]', form).forEach((r) => { r.checked = id !== null && Number(r.value) === id; });
  });
  form.all_day.addEventListener('change', () => {
    $('.ev-times', form).hidden = form.all_day.checked;
    if (!form.all_day.checked && !form.start_time.value) { form.start_time.value = '09:00'; form.end_time.value = '10:00'; }
  });
  form.start_date.addEventListener('change', () => { if (!form.end_date.value || form.end_date.value < form.start_date.value) form.end_date.value = form.start_date.value; });
  const collect = () => {
    const f = Object.fromEntries(new FormData(form));
    return { ...f, type_id: typeChecked() ? Number(typeChecked().value) : null, all_day: !!f.all_day, end_date: f.end_date || f.start_date };
  };
  $('[data-types]', m)?.addEventListener('click', () => {
    const d = { ...collect(), all_day: form.all_day.checked ? 1 : 0 };
    closeModal();
    typeManager({ onClose: () => eventModal(ev, { draft: d }) });
  });
  $('[data-cancel]', m).addEventListener('click', closeModal);
  $('[data-del]', m)?.addEventListener('click', async () => {
    if (!confirm(`'${ev.title}' 일정을 지울까요?`)) return;
    try { await api('DELETE', `/api/events/${ev.id}`); await reloadEvents(); closeModal(); refresh(); toast('일정 삭제됨'); } catch (err) { toastErr(err); }
  });
  form.addEventListener('submit', async (ev2) => {
    ev2.preventDefault();
    const body = collect();
    try {
      if (ev) await api('PATCH', `/api/events/${ev.id}`, body);
      else await api('POST', '/api/events', body);
      await reloadEvents();
      closeModal();
      if (S.page === 'calendar') { S.cal.selected = body.start_date; S.cal.month = body.start_date.slice(0, 7); }
      refresh();
      toast(ev ? '일정 저장됨' : `일정 추가됨 · ${body.title}`);
    } catch (err) { toastErr(err); }
  });
}

// ---- 일정 종류·색 편집 ----
function typeManager({ onClose = null } = {}) {
  const render = () => {
    const used = new Set(S.eventTypes.map((t) => t.color));
    const m = openModal(html`<h2>일정 종류·색</h2>
      <p class="muted small">캘린더 막대 색이 종류별로 바뀝니다. 이름을 고치면 바로 저장됩니다.</p>
      <div class="type-list">${S.eventTypes.map((t) => html`<div class="type-row" data-type="${t.id}">
        <span class="tdot big" data-ec="${t.color}"></span>
        <input class="inline" data-tname="${t.id}" value="${t.name}" aria-label="종류 이름" maxlength="30">
        <div class="swatches">${TYPE_PALETTE.map((c) => html`<button type="button" class="swatch ${c === t.color ? 'on' : ''}" data-ec="${c}" data-pick="${t.id}" data-color="${c}" aria-label="색 ${c}"></button>`)}</div>
        <button type="button" class="icon-btn sm" data-tdel="${t.id}" aria-label="${t.name} 삭제" title="삭제">✕</button>
      </div>`)}</div>
      <form class="type-new" id="tnf"><input name="name" maxlength="30" placeholder="새 종류 이름 (예: 심사, 발표, 수업)" required><button class="primary" type="submit">추가</button></form>
      <div class="actions"><button type="button" class="primary" data-done>완료</button></div>`);
    const nextColor = TYPE_PALETTE.find((c) => !used.has(c)) ?? TYPE_PALETTE[0];
    const act = async (fn, msg) => { try { await fn(); await reloadEventTypes(); render(); refresh(); if (msg) toast(msg); } catch (err) { toastErr(err); } };
    m.addEventListener('click', (e) => {
      const pk = e.target.closest('[data-pick]');
      if (pk) return act(() => api('PATCH', `/api/event-types/${pk.dataset.pick}`, { color: pk.dataset.color }));
      const del = e.target.closest('[data-tdel]');
      if (del) {
        const t = S.eventTypes.find((x) => x.id === Number(del.dataset.tdel));
        if (confirm(`'${t.name}' 종류를 지울까요? 이 종류의 일정은 지워지지 않고 '종류 없음'(회색)이 됩니다.`)) act(() => api('DELETE', `/api/event-types/${t.id}`), '종류 삭제됨');
        return;
      }
      if (e.target.closest('[data-done]')) { closeModal(); if (onClose) onClose(); }
    });
    m.addEventListener('change', (e) => {
      const nm = e.target.closest('[data-tname]');
      if (nm) act(() => api('PATCH', `/api/event-types/${nm.dataset.tname}`, { name: nm.value }), '이름 저장됨');
    });
    $('#tnf', m).addEventListener('submit', (e) => {
      e.preventDefault();
      act(() => api('POST', '/api/event-types', { name: e.target.name.value, color: nextColor }), '종류 추가됨');
    });
  };
  render();
}

// ---- 새로 만들기: 일정 / 업무 ----
function createChooser({ date = null } = {}) {
  if (!isOwner() || S.mode === 'static') return;
  closeSideMobile();
  const m = openModal(html`<div class="sheet-h"><h2>새로 만들기${date ? html` <span class="muted small">${fmtDate(date)}</span>` : ''}</h2><button type="button" class="icon-btn" data-cancel aria-label="닫기">✕</button></div>
    <div class="chooser">
      <button type="button" class="choose-card" data-make="event"><span class="ico ico-cal" aria-hidden="true"></span><b>일정</b><span>출장·학회·회의처럼 날짜·기간·시간이 정해진 일</span><kbd>E</kbd></button>
      <button type="button" class="choose-card" data-make="task"><span class="ico ico-list" aria-hidden="true"></span><b>업무</b><span>해야 할 일 — 내 시급성·마감일을 먼저 정하고 교수님 판단과 비교</span><kbd>N</kbd></button>
    </div>`);
  m.classList.add('sheet');
  $('[data-cancel]', m).addEventListener('click', closeModal);
  $$('[data-make]', m).forEach((b) => b.addEventListener('click', () => {
    closeModal();
    if (b.dataset.make === 'event') return eventModal(null, { start: date ?? S.today });
    if (date) return newTaskModal({ due: date });
    if (isPhone()) return quickAddSheet();
    const qa = $('#main .qa-input');
    if (qa) { qa.focus(); qa.scrollIntoView({ block: 'center' }); } else newTaskModal();
  }));
}

// ---- 판단 비교 ----------------------------------------------------------------
function renderCompare() {
  const active = activeTasks();
  const mismatch = active.filter((t) => t.derived.mismatch).sort(byDueThenUrgency);
  const unknown = active.filter((t) => !t.latest_review && t.review_state !== 'not_needed').sort(byDueThenUrgency);
  const notNeeded = active.filter((t) => !t.latest_review && t.review_state === 'not_needed');
  const matched = active.filter((t) => t.latest_review && !t.derived.mismatch).sort(byDueThenUrgency);
  const reviewed = active.filter((t) => t.latest_review).length;
  const pct = (n) => (active.length ? Math.round((n / active.length) * 100) : 0);
  const cmpRow = (t) => {
    const d = t.derived;
    const r = t.latest_review;
    return html`<div class="row cmp ${S.peekKind === 'task' && S.peek === t.id ? 'peeked' : ''}" data-peek="${t.id}" tabindex="0" role="button" aria-label="${t.task_code} ${t.title}">
      <div class="row-main"><div class="row-title">${t.title}</div><div class="row-sub"><span class="code">${t.task_code}</span><span>${t.project_title}</span>${r ? html`<span>${r.reviewer_name} · ${CHANNEL[r.review_channel]} · ${fmtReviewedAt(r.reviewed_at).slice(5)}</span>` : ''}</div></div>
      <div class="pair-cols">
        <div class="pc"><span class="pc-k">나</span>${urgBadge(t.my_urgency)}<span class="pc-d">${t.my_due_date ? fmtDate(t.my_due_date) : '미정'}</span></div>
        <div class="pc prof"><span class="pc-k">교수님</span>${otherUrgBadge(d.other_urgency)}<span class="pc-d">${d.other_due_date ? fmtDate(d.other_due_date) : '-'}</span></div>
        <div class="pc-diff ${d.mismatch ? 'tx-bad' : ''}">${d.due_diff_days ? dueDiffText(d.due_diff_days) : d.urgency_cmp === 'mismatch' ? '시급성 다름' : ''}</div>
      </div>
    </div>`;
  };
  mount(main(), html`
    <div class="page">
      <header class="page-h"><div><h1>판단 비교</h1><p class="muted">내가 먼저 정한 시급성·마감일과 교수님·관계자에게 확인한 판단</p></div></header>
      <div class="stats">
        <div class="stat"><b>${active.length}</b><span>진행 업무</span></div>
        <div class="stat"><b>${reviewed}</b><span>확인함 · ${pct(reviewed)}%</span></div>
        <div class="stat ${mismatch.length ? 'bad' : ''}"><b>${mismatch.length}</b><span>판단이 달랐음</span></div>
        <div class="stat"><b>${unknown.length}</b><span>아직 미확인</span></div>
      </div>
      ${groupSection('mismatch', '판단이 달랐던 업무', mismatch, { tone: 'bad', hint: '차이를 다음 판단에 반영하세요' }, cmpRow)}
      ${groupSection('unknown', '아직 확인하지 않은 업무', unknown, { tone: 'warn', hint: "미확인은 '일치'가 아닙니다" }, cmpRow)}
      ${groupSection('matched', '판단이 일치한 업무', matched, { tone: 'ok' }, cmpRow)}
      ${groupSection('notneeded', '확인 불필요로 표시한 업무', notNeeded, {}, cmpRow)}
      ${!active.length ? html`<div class="empty-state"><b>진행 업무가 없습니다</b></div>` : ''}
    </div>`);
}

// ---- 프로젝트 -----------------------------------------------------------------
function renderProjects() {
  const owner = isOwner();
  mount(main(), html`
    <div class="page">
      <header class="page-h"><div><h1>프로젝트</h1><p class="muted">상위 목표별로 업무를 묶어 봅니다</p></div>
        ${owner ? html`<button type="button" class="primary" data-action="new-project">+ 새 프로젝트</button>` : ''}</header>
      ${S.projects.length ? html`<div class="proj-list">${S.projects.map((p) => html`
        <a class="proj-card" href="#/project/${p.id}">
          <div class="proj-top"><span class="code">${p.code}</span>${p.status !== 'active' ? html`<span class="badge">${PROJECT_STATUS[p.status]}</span>` : ''}</div>
          <div class="proj-title">${p.title}</div>
          ${p.objective ? html`<p class="small muted">${p.objective}</p>` : ''}
          <div class="proj-stats"><span><b>${p.active_count}</b> 진행</span><span><b>${p.done_count}</b> 완료</span>${owner && p.candidate_count ? html`<span class="tx-warn"><b>${p.candidate_count}</b> 등록 후보</span>` : ''}</div>
        </a>`)}</div>` : html`<div class="empty-state"><b>프로젝트가 없습니다</b></div>`}
    </div>`);
}

function projectModal(p) {
  const m = openModal(html`
    <h2>${p ? `프로젝트 수정 — ${p.code}` : '새 프로젝트'}</h2>
    <form id="pf">
      ${p ? '' : html`<div class="row2">
        <div class="field"><label>코드 * (영문)</label><input name="code" required pattern="[A-Za-z0-9-]+" placeholder="예: CONF"></div>
        <div class="field"><label>업무 ID 접두어 (비우면 코드와 같음)</label><input name="task_prefix" pattern="[A-Za-z0-9-]*"></div>
      </div>`}
      <div class="field"><label>프로젝트명 *</label><input name="title" required value="${p?.title ?? ''}"></div>
      <div class="field"><label>목표 (지향점)</label><textarea name="objective">${p?.objective ?? ''}</textarea></div>
      <div class="field"><label>배경·주의사항</label><textarea name="description">${p?.description ?? ''}</textarea></div>
      ${p ? html`<div class="field"><label>상태</label><select name="status">${options(PROJECT_STATUS, p.status)}</select></div>` : ''}
      <div class="actions"><button type="button" class="ghost" data-cancel>취소</button><button class="primary" type="submit">저장</button></div>
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
      refresh();
    } catch (err) { toastErr(err); }
  });
}

// ---- 변경 이력 ----------------------------------------------------------------
async function renderHistory() {
  const logs = await api('GET', '/api/activity?limit=500');
  if (S.page !== 'history') return;
  const byDay = new Map();
  for (const a of logs) {
    const day = fmtTs(a.created_at).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(a);
  }
  mount(main(), html`
    <div class="page">
      <header class="page-h"><div><h1>변경 이력</h1><p class="muted">최근 ${logs.length}건 · 이력은 수정·삭제되지 않습니다</p></div></header>
      ${logs.length ? [...byDay].map(([day, list]) => html`<section class="group">
        <div class="group-h static">${fmtDate(day)}<span class="group-n">${list.length}</span></div>
        <ul class="log">${list.map((a) => html`<li>
          <span class="log-time">${fmtTs(a.created_at).slice(11)}</span>
          <div class="log-main">
            ${a.entity_type === 'task' ? html`<a href="#" data-peek="${a.entity_id}" class="log-target"><span class="code">${a.task_code}</span> ${a.task_title}</a>` : html`<span class="log-target">프로젝트 ${a.project_code}</span>`}
            <div>${activityText(a)}</div>
            ${a.reason ? html`<div class="small muted">${a.event_type === 'review_added' ? '들은 내용' : '이유'}: ${a.reason}</div>` : ''}
          </div>
          <span class="log-who muted small">${a.actor_name ?? '시스템'}</span>
        </li>`)}</ul></section>`) : html`<div class="empty-state"><b>이력이 없습니다</b></div>`}
    </div>`);
}

// ---- 등록 후보 검토 -------------------------------------------------------------
const DECISIONS = { need: '지금도 필요', done: '이미 완료', drop: '더는 필요 없음', later: '나중에 확인' };
const REVIEW_NEED = { not_reviewed: '교수님·관계자 확인 필요', requested: '이미 확인 요청함', not_needed: '확인 불필요' };

function renderCandidates() {
  const cands = S.tasks.filter((t) => t.status === 'candidate').sort(byProjectThenCode);
  const total = Math.max(S.tasks.filter((t) => t.origin === 'seed').length, cands.length);
  const info = html`<details class="desc">
      <summary>업무로 만들지 않은 미확정 항목 (기획서 6-J) — 확인 후 직접 추가</summary>
      <ul class="small">
        <li><b>ABS</b>: ABS 발표 15장 PPT 제작 건이 추계학회 발표와 별개인 현재 업무인지 확인</li>
        <li><b>TRIP</b>: 10/14~16 출장의 확정 일정·준비물·수행사항·복귀 후 자료 정리 확인</li>
        <li><b>LAB</b>: BK21 증빙, 외국인 학생 행정, 수업 과제 등 현재 남아 있는 작업만 등록</li>
        <li><b>MEET</b>: 금요일 논문 브리핑·토요일 프로토타입 점검은 개인 점검 루틴 후보 — 교수님 지정 마감이 아님</li>
      </ul>
      <p class="small muted">기획서 7-2의 '현황 확인 우선 후보'(EXT-001, CONF-001·005, CONF-002~004, DEV-001~003, UAV-001~003, EXT-002~006)는 시급성 순위가 아니라 먼저 현황을 확인할 항목입니다.</p>
    </details>`;
  if (!cands.length) {
    mount(main(), html`<div class="page"><header class="page-h"><h1>등록 후보</h1></header><div class="empty-state"><div class="empty-ico">✓</div><b>모든 등록 후보를 검토했습니다</b></div>${info}</div>`);
    return;
  }
  const cur = cands.find((t) => t.id === S.cand.currentId) || cands.find((t) => !S.cand.skipped.has(t.id)) || cands[0];
  S.cand.currentId = cur.id;
  const proj = projectById(cur.project_id);
  const done = total - cands.length;
  const groups = [];
  for (const t of cands) {
    let g = groups.find((x) => x.code === t.project_code);
    if (!g) groups.push(g = { code: t.project_code, title: t.project_title, items: [] });
    g.items.push(t);
  }
  const radios = (name, map, sel) => html`<div class="choices">${Object.entries(map).map(([k, v]) => html`<label class="choice"><input type="radio" name="${name}" value="${k}" ${k === sel ? raw('checked') : ''}><span>${v}</span></label>`)}</div>`;

  mount(main(), html`
    <div class="page wide">
      <header class="page-h"><div><h1>등록 후보 검토</h1>
        <p class="muted">기획서 대화에 나왔을 뿐 완료 여부·시급성·마감일이 정해지지 않은 항목입니다. 하나씩 현재 상태를 확인하세요.</p></div></header>
      <div class="progress"><progress max="${total}" value="${done}" aria-label="검토 진행률"></progress><span>${done} / ${total} 검토</span></div>
      <div class="wizard">
        <nav class="cand-list" aria-label="후보 목록">${groups.map((g) => html`<h3>${g.code} · ${g.title}</h3>${g.items.map((t) => html`<button type="button" data-cand="${t.id}" class="${t.id === cur.id ? 'on' : ''} ${S.cand.skipped.has(t.id) ? 'skipped' : ''}"><span class="code">${t.task_code}</span> ${t.title}</button>`)}`)}</nav>
        <form class="cand-form" id="cf">
          <p class="eyebrow">${cur.task_code} · ${cur.project_title}</p>
          <h2>${cur.title}</h2>
          <div class="props">
            <div class="prop"><div class="prop-k">완료 기준·산출물</div><div class="prop-v">${cur.expected_deliverable ?? '-'}</div></div>
            <div class="prop"><div class="prop-k">출처</div><div class="prop-v small muted">${cur.source_note ?? '-'}</div></div>
            ${proj?.description ? html`<div class="prop"><div class="prop-k">프로젝트 주의</div><div class="prop-v small">${proj.description}</div></div>` : ''}
          </div>
          <div class="step"><div class="step-title"><span class="step-n">1</span>이 업무가 지금도 필요한가?</div>${radios('decision', DECISIONS, null)}</div>
          <div data-sec="need" hidden>
            <div class="step"><div class="step-title"><span class="step-n">2</span>현재 진행 상태</div>${radios('status', { todo: STATUS.todo, in_progress: STATUS.in_progress, waiting: STATUS.waiting, blocked: STATUS.blocked }, 'todo')}
              <div data-sec="wait" hidden class="row2 sub-step">
                <div class="field"><label>대기/차단 사유 *</label><input name="blocked_reason"></div>
                <div class="field"><label>대기 대상</label><input name="waiting_on"></div>
                <div class="field"><label>재확인일</label><input type="date" name="follow_up_date"></div>
              </div></div>
            <div class="step"><div class="step-title"><span class="step-n">3</span>내 기준 시급성 *</div>${radios('my_urgency', URGENCY, null)}
              <p class="hint">초시급: 오늘 대응하지 않으면 외부 일정에 영향 · 시급: 수일 내 처리 · 일상: 유연하지만 관리 필요</p></div>
            <div class="step"><div class="step-title"><span class="step-n">4</span>언제까지 끝내야 한다고 판단하나? 이유는?</div>
              <div class="row2"><div class="field"><label>내 마감일</label><input type="date" name="my_due_date"></div>
                <div class="field"><label>정하기 어려우면 그 이유</label><input name="due_undecided_reason"></div></div>
              <div class="field"><label>판단 이유</label><input name="my_reason"></div></div>
            <div class="step"><div class="step-title"><span class="step-n">5</span>교수님 또는 다른 사람과 확인해야 하나?</div>${radios('review_state', REVIEW_NEED, 'not_reviewed')}</div>
            <div class="step"><div class="step-title"><span class="step-n">6</span>지금 바로 할 수 있는 가장 작은 다음 행동</div><input name="next_action" value="${cur.next_action ?? ''}" aria-label="다음 행동"></div>
          </div>
          <div data-sec="done" hidden class="step"><div class="field"><label>완료 근거 (산출물 위치·완료일 등)</label><input name="done_note"></div></div>
          <div data-sec="drop" hidden class="step"><div class="field"><label>더는 필요 없는 이유</label><input name="drop_note"></div></div>
          <div data-sec="later" hidden class="step"><p class="muted small">후보로 남겨 두고 다음 항목으로 넘어갑니다.</p></div>
          <div class="form-foot"><span class="muted small">저장하면 다음 후보로 넘어갑니다</span><button class="primary" type="submit">저장하고 다음 →</button></div>
        </form>
      </div>
      ${info}
    </div>`);

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
      const rest = S.tasks.filter((t) => t.status === 'candidate' && !S.cand.skipped.has(t.id) && t.id !== cur.id).sort(byProjectThenCode);
      S.cand.currentId = (rest.find((t) => byProjectThenCode(t, cur) > 0) || rest[0])?.id ?? null;
      refresh();
      window.scrollTo(0, 0);
    };
    let body;
    if (!f.decision) return toast('1번 질문에 답하세요', { err: true });
    if (f.decision === 'later') { S.cand.skipped.add(cur.id); return goNext(); }
    if (f.decision === 'done') body = { status: 'done', reason: `등록 후보 검토: 이미 완료${f.done_note ? ` — ${f.done_note}` : ''}` };
    if (f.decision === 'drop') body = { status: 'dropped', reason: `등록 후보 검토: 더는 필요 없음${f.drop_note ? ` — ${f.drop_note}` : ''}` };
    if (f.decision === 'need') {
      if (!f.my_urgency) return toast('3번: 내 기준 시급성을 먼저 정하세요', { err: true });
      if ((f.status === 'waiting' || f.status === 'blocked') && !f.blocked_reason) return toast('대기/차단 사유를 입력하세요', { err: true });
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
      await patchTask(cur.id, body);
      await refreshProjects();
      toast(`${cur.task_code} → ${STATUS[body.status]}`);
      goNext();
    } catch (err) { toastErr(err); }
  });
}

// ---- 메일 -----------------------------------------------------------------------
function mailState(m) {
  if (!m.seen) return 'new';
  if (m.decision === 'reply') return m.replied_at ? 'replied' : 'reply';
  if (m.decision === 'no_reply') return 'noreply';
  return 'unsorted';
}
function mailStatusPills(m) {
  const st = mailState(m);
  const late = st === 'reply' && m.reply_due && m.reply_due < S.today;
  return html`
    ${st === 'reply' ? html`<span class="meta due ${late ? 'late' : ''}">회신 ${m.reply_due ? relDate(m.reply_due) : '날짜 미정'}</span>` : ''}
    ${st === 'reply' || st === 'replied' ? html`<span class="pill ${m.told_professor ? 'ok' : 'need'}">${m.told_professor ? '교수님께 말씀드림' : '교수님 미보고'}</span>` : ''}
    ${st === 'replied' ? html`<span class="pill ok">회신 완료 ${fmtDate(m.replied_at)}</span>` : ''}
    ${st === 'unsorted' ? html`<span class="pill need">회신 여부 미정</span>` : ''}
    ${st === 'noreply' ? html`<span class="meta muted">회신 불필요</span>` : ''}`;
}
// Drive에 아직 안 올라간 파일은 이 PC의 게시판에서만 열린다
const mailFileUrl = (m, file, url) => url || (S.mode === 'remote' ? (m.drive_folder_url ?? '#') : `/api/mails/${m.id}/file?name=${encodeURIComponent(file)}`);

function mailRow(m) {
  const st = mailState(m);
  const atts = Array.isArray(m.attachments) ? m.attachments.length : 0;
  return html`<div class="row mail-row ${st === 'new' ? 'unread' : ''} ${S.peekKind === 'mail' && S.peek === m.id ? 'peeked' : ''}" data-mail="${m.id}" tabindex="0" role="button" aria-label="메일 ${m.from_name} ${m.subject}">
    <span class="mail-ico" aria-hidden="true">${st === 'new' ? html`<span class="new-emo">🆕</span>` : html`<span class="ico ico-mail"></span>`}</span>
    <div class="row-main">
      <div class="row-title">${m.subject}</div>
      <div class="row-sub"><span>${displaySender(m)}</span>${senderTag(m)}<span>${fmtDate(m.received_date)} 수신</span>${atts ? html`<span>첨부 ${atts}</span>` : ''}</div>
    </div>
    <div class="row-meta">${m.priority ? urgBadge(m.priority) : ''}${todoProgress(m)}${mailStatusPills(m)}</div>
  </div>`;
}

function mailSetup(st) {
  if (!st) return '';
  const err = st.last_sync?.error;
  if (st.naver && (st.google || st.drive_desktop)) {
    return html`${err ? html`<p class="notice bad">마지막 확인 실패: ${err}</p>` : ''}
      ${st.pending_uploads ? html`<p class="notice subtle">Drive에 아직 올라가지 않은 메일 ${st.pending_uploads}건 — 다음 확인 때 다시 올립니다.</p>` : ''}`;
  }
  return html`<section class="setup">
    <h3>메일 연결 설정</h3>
    <ol>
      <li class="${st.naver ? 'done' : ''}"><b>네이버 메일</b> ${st.naver ? html`<span class="tx-ok">✓ ${st.naver.user} · '${st.naver.folder}'</span>` : html`— 아래 순서대로 하세요`}
        ${st.naver ? '' : naverConnectForm()}</li>
      <li class="${st.google || st.drive_desktop ? 'done' : ''}"><b>Google Drive</b> ${st.drive_desktop && !st.google ? html`<span class="tx-ok">✓ Drive 데스크톱 앱 사용 — ${st.drive_desktop} › 업무게시판 메일</span>` : st.google ? html`<span class="tx-ok">✓ 연결됨</span>` : st.google_client ? html`— <code>npm run connect-google</code> 실행 후 브라우저에서 허용` : html`— Google Cloud에서 받은 OAuth 클라이언트 JSON을 <code>secrets/google-oauth-client.json</code>으로 저장 → <code>npm run connect-google</code>`}</li>
    </ol>
    <p class="hint">연결하면 게시판 서버가 켜져 있는 동안 5분마다 '연구실' 편지함을 확인합니다. Drive를 연결하지 않아도 메일 PDF·첨부는 이 PC에 저장되고 여기서 열 수 있으며, 나중에 연결하면 한꺼번에 올라갑니다.</p>
    ${err && st.naver ? html`<p class="notice bad">마지막 확인 실패: ${err}</p>` : ''}
  </section>`;
}

function naverConnectForm() {
  if (S.mode !== 'local') return html`<p class="hint">이 PC에서 실행 중인 게시판에서만 연결할 수 있습니다.</p>`;
  return html`<div class="naver-steps">
    <p class="small">① <a href="https://mail.naver.com/" target="_blank" rel="noopener">네이버 메일</a> › 환경설정 › <b>POP3/IMAP 설정</b> › IMAP/SMTP 사용 <b>사용함</b>
      <br>② <a href="https://nid.naver.com/" target="_blank" rel="noopener">네이버 내정보</a> › 보안설정 › 2단계 인증 › <b>애플리케이션 비밀번호 관리</b>에서 새 비밀번호 생성 (종류: 메일)
      <br>③ 아래에 입력 — <b>네이버 로그인 비밀번호는 넣지 마세요</b></p>
    <form class="naver-form" id="naver-form" autocomplete="off">
      <div class="row3">
        <div class="field"><label>네이버 ID</label><input name="user" placeholder="abc 또는 abc@naver.com" autocomplete="off" required></div>
        <div class="field"><label>애플리케이션 비밀번호</label><input name="pass" type="password" autocomplete="new-password" required></div>
        <div class="field"><label>편지함</label><input name="folder" value="연구실"></div>
      </div>
      <button type="submit" class="primary">로그인 시험 후 저장</button>
      <span class="hint">비밀번호는 이 PC의 Windows 계정으로 암호화해 저장하며, 게시판은 '연구실' 편지함을 읽기만 합니다.</span>
    </form></div>`;
}

function renderMailPublic() {
  const shown = S.mails.filter((m) => !m.hidden).sort((a, b) => (a.received_date < b.received_date ? 1 : -1));
  const hiddenN = S.mails.length - shown.length;
  mount(main(), html`<div class="page">
    <header class="page-h"><div><h1>메일</h1>
      <p class="muted">연구실 편지함 · 주요 발신인의 메일만 제목과 발신인을 공개합니다</p></div></header>
    ${mailTabs('#/mail')}
    ${groupSection('pub', '주요 메일', shown, { tone: 'info', folded: true, hint: '눌러서 펼치기' }, mailRow)}
    ${hiddenN ? html`<p class="notice subtle">그 외 메일 ${hiddenN}건 — 제목·발신인 비공개</p>` : ''}
    ${!S.mails.length ? html`<div class="empty-state"><b>받은 메일이 없습니다</b></div>` : ''}
  </div>`);
}

function renderMail() {
  if (!isOwner() || S.mode === 'static' || S.mode === 'open') return renderMailPublic();
  const owner = isOwner() && S.mode !== 'static';
  const st = S.mailStatus;
  const by = (k) => S.mails.filter((m) => mailState(m) === k);
  const reply = by('reply').sort((a, b) => ((a.reply_due ?? '9999') < (b.reply_due ?? '9999') ? -1 : 1));
  const last = st?.last_sync;
  mount(main(), html`<div class="page">
    <header class="page-h"><div><h1>메일</h1>
      <p class="muted">네이버 ${st?.naver ? `'${st.naver.folder}'` : "'연구실'"} 편지함${last ? ` · 마지막 확인 ${fmtTs(last.at).slice(5)}` : ''}${S.mode === 'static' ? ' · 제목·보낸 사람·회신 상태만 공개' : ''}</p></div>
      ${owner && st?.naver ? html`<div class="row-btns"><button type="button" class="ghost" id="mail-sync">지금 확인</button>${S.mode === 'local' ? html`<button type="button" class="link small" id="naver-off">연결 해제</button>` : ''}</div>` : ''}</header>
    ${mailTabs('#/mail')}
    ${owner ? mailSetup(st) : ''}
    ${groupSection('new', '새 메일', by('new').sort(byPriority), { tone: 'info', hint: '보낸 사람 우선순위 순' }, mailRow)}
    ${groupSection('reply', '회신할 메일', reply, { tone: 'warn' }, mailRow)}
    ${groupSection('unsorted', '회신 여부를 정하지 않은 메일', by('unsorted').sort(byPriority), { hint: '보낸 사람 우선순위 순' }, mailRow)}
    ${groupSection('replied', '회신 완료', by('replied'), { tone: 'ok' }, mailRow)}
    ${groupSection('noreply', '회신 불필요', by('noreply'), {}, mailRow)}
    ${!S.mails.length ? html`<div class="empty-state"><b>가져온 메일이 없습니다</b><p class="muted">${owner && !st?.naver ? '위 설정을 마치면 연구실 편지함의 메일이 여기 나타납니다.' : "'연구실' 편지함에 새 메일이 오면 여기 나타납니다."}</p></div>` : ''}
  </div>`);
  $('#mail-sync')?.addEventListener('click', syncMailNow);
  $('#naver-off')?.addEventListener('click', async () => {
    if (!confirm('네이버 메일 연결을 해제할까요? 저장된 암호화 비밀번호가 이 PC에서 삭제됩니다. 이미 가져온 메일은 그대로 남습니다.')) return;
    try { await api('DELETE', '/api/mail/naver'); S.mailStatus = await api('GET', '/api/mail/status'); refresh(); toast('연결 해제됨'); } catch (e) { toastErr(e); }
  });
  $('#naver-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = '로그인 시험 중…';
    const body = { user: form.user.value, pass: form.pass.value, folder: form.folder.value };
    form.pass.value = '';
    try {
      const r = await api('POST', '/api/mail/naver', body);
      S.mailStatus = await api('GET', '/api/mail/status');
      refresh();
      toast(`연결 완료: ${r.user} · '${r.folder}' — 메일을 가져오는 중입니다`);
      setTimeout(async () => { try { S.mails = await api('GET', '/api/mails'); S.mailStatus = await api('GET', '/api/mail/status'); refresh(); } catch { /* 다음에 */ } }, 15000);
    } catch (err) {
      toastErr(err);
      btn.disabled = false;
      btn.textContent = '로그인 시험 후 저장';
    }
  });
}

async function syncMailNow() {
  const btn = $('#mail-sync');
  if (btn) { btn.disabled = true; btn.textContent = '확인 중…'; }
  try {
    const r = await api('POST', '/api/mail/sync');
    S.mails = await api('GET', '/api/mails');
    S.mailStatus = await api('GET', '/api/mail/status');
    S.contacts = await api('GET', '/api/contacts');
    refresh();
    if (r.new_contacts) setTimeout(() => toast(`새로 메일을 보낸 사람 ${r.new_contacts}명 — 우선순위를 정해 주세요`, { action: { label: '정하기', fn: () => { location.hash = '#/contacts'; } } }), 2200);
    toast(r.error ? `확인 실패: ${r.error}` : r.added ? `🆕 새 메일 ${r.added}건` : '새 메일 없음', { err: !!r.error });
  } catch (e) { toastErr(e); refresh(); }
}

async function openMailPeek(id) {
  if (S.mode === 'open') return mailNoteModal(id);
  if (S.peekKind !== 'mail' || S.peek !== id) S.replyForm = null;
  S.peek = id;
  S.peekKind = 'mail';
  const panel = $('#peek');
  panel.hidden = false;
  $('#app').classList.add('peek-open');
  try {
    let m = S.mails.find((x) => x.id === id) ?? await api('GET', `/api/mails/${id}`);
    if (isOwner() && S.mode !== 'static' && !m.seen) m = await api('POST', `/api/mails/${id}/seen`);
    if (S.peek !== id) return;
    upsertMail(m);
    S.peekData = m;
    renderMailPeek();
    refresh();
  } catch (e) { toastErr(e); closePeek(); }
}

function mailLinkBlock(m) {
  const owner = isOwner() && S.mode !== 'static';
  return html`<div class="mail-link">
    <div class="mail-link-h"><span class="ico ico-mail" aria-hidden="true"></span><b>연결된 메일</b><span class="muted small">${fmtDate(m.received_date)} 수신</span></div>
    <a href="#" data-mail="${m.id}" class="mail-link-t">${m.subject}</a>
    <div class="muted small">${m.from_name}</div>
    <div class="flags">${mailStatusPills(m)}
      ${owner && m.pdf_file ? html`<a class="pill file-pill" href="${mailFileUrl(m, m.pdf_file, m.pdf_url)}" target="_blank" rel="noopener">PDF 보기</a>` : ''}</div>
  </div>`;
}

function renderMailPeek() {
  const m = S.peekData;
  if (!m) return;
  const panel = $('#peek');
  const owner = isOwner() && S.mode !== 'static';
  const st = mailState(m);
  const task = m.task_id ? S.tasks.find((t) => t.id === m.task_id) : null;
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  const where = (url) => (url ? 'Drive' : '내 PC');
  const fileLink = (name, url, kind) => html`<a class="file-link" href="${mailFileUrl(m, name, url)}" target="_blank" rel="noopener">
      <span class="file-kind">${kind}</span><span class="file-name">${name}</span><span class="file-where ${url ? 'drive' : ''}">${where(url)}</span></a>`;
  const prop = (label, body) => html`<div class="prop"><div class="prop-k">${label}</div><div class="prop-v">${body}</div></div>`;
  const choice = (name, map, sel) => html`<div class="choices">${Object.entries(map).map(([k, v]) => html`<label class="choice"><input type="radio" name="${name}" value="${k}" ${k === sel ? raw('checked') : ''}><span>${v}</span></label>`)}</div>`;

  let decision = '';
  if (!owner) {
    decision = html`<div class="flags">${mailStatusPills(m)}</div>`;
  } else if (st === 'reply' || st === 'replied') {
    decision = html`<div class="props">
      ${prop('회신할 날짜', html`<input type="date" class="inline" data-mf="reply_due" value="${m.reply_due ?? ''}" aria-label="회신할 날짜">`)}
      ${prop('회신 내용', html`<textarea class="inline" data-mf="reply_plan" rows="3" placeholder="무엇을 답할지" aria-label="회신 내용">${m.reply_plan ?? ''}</textarea>`)}
      ${prop('교수님께', html`<label class="toggle"><input type="checkbox" data-mf="told_professor" ${m.told_professor ? raw('checked') : ''}> 말씀드렸음</label>
        ${m.told_professor ? html`<input type="date" class="inline date-sm" data-mf="told_professor_at" value="${m.told_professor_at ?? ''}" aria-label="말씀드린 날짜">` : ''}`)}
      ${prop('회신', m.replied_at
        ? html`<span class="pill ok">회신 완료 ${fmtDate(m.replied_at)}</span> <button type="button" class="link small" data-mail-act="unreplied">취소</button>`
        : html`<button type="button" class="primary sm" data-mail-act="replied">오늘 회신함</button> <a class="small" href="https://mail.naver.com/" target="_blank" rel="noopener">네이버 메일에서 답장 →</a>`)}
      ${task ? prop('업무', html`<a href="#" data-peek="${task.id}"><span class="code">${task.task_code}</span> ${task.title} →</a>`) : ''}
    </div>`;
  } else if (st === 'noreply') {
    decision = html`<p class="muted">회신이 필요 없는 메일로 표시했습니다. <button type="button" class="link" data-mail-act="undo">되돌리기</button></p>`;
  } else if (S.replyForm === m.id) {
    decision = html`<form class="reply-form" id="rf">
      <div class="field"><label>내 시급성 *</label>${choice('my_urgency', URGENCY, null)}</div>
      <div class="row2">
        <div class="field"><label>회신할 날짜 (내 판단)</label><input type="date" name="reply_due"></div>
        <div class="field"><label>프로젝트</label><select name="project_id">${projectOptions(defaultProjectId())}</select></div>
      </div>
      <div class="field"><label>회신 내용 (무엇을 답할지)</label><textarea name="reply_plan" rows="3"></textarea></div>
      <div class="field"><label>교수님께 말씀드렸나요?</label>${choice('told', { no: '아직', yes: '말씀드렸음' }, 'no')}</div>
      <p class="hint">PI·외부 연구자 메일은 보통 당일 1차 회신, 오래 걸리면 처리 일정을 먼저 알립니다. 회신 날짜는 내가 먼저 정하고 교수님께 확인하세요.</p>
      <div class="actions"><button type="button" class="ghost" data-mail-act="cancel">취소</button><button type="submit" class="primary">회신 업무로 등록</button></div>
    </form>`;
  } else {
    decision = html`<div class="decide"><p><b>회신이 필요한 메일인가요?</b></p>
      <div class="decide-btns"><button type="button" class="primary" data-mail-act="need">회신 필요</button><button type="button" class="ghost" data-mail-act="noreply">회신 불필요</button></div></div>`;
  }

  mount(panel, html`
    <div class="peek-head">
      <span class="muted small">메일 · ${fmtDate(m.received_date)} 수신</span>
      <span class="spacer"></span>
      <button type="button" class="icon-btn" data-close-peek aria-label="닫기 (Esc)" title="닫기 (Esc)">✕</button>
    </div>
    <div class="peek-body">
      <h2 class="peek-title">${m.subject}</h2>
      <div class="mail-from"><b>${displaySender(m)}</b>${owner ? senderTag(m) : ''}${owner && m.from_addr ? html` <span class="muted">&lt;${m.from_addr}&gt;</span>` : ''}
        ${owner && m.received_at ? html`<span class="muted small">${fmtTs(m.received_at)}</span>` : ''}</div>
      ${owner ? senderNote(m) : ''}
      ${owner && m.cc_addrs ? html`<div class="small muted">참조: ${m.cc_addrs}</div>` : ''}
      ${owner ? html`<div class="mail-files">
        ${m.pdf_file ? fileLink(m.pdf_file, m.pdf_url, 'PDF') : html`<p class="small tx-warn">${m.upload_error ?? 'PDF 없음'}</p>`}
        ${atts.map((a) => fileLink(a.name, a.url, '첨부'))}
        ${m.drive_folder_url ? html`<a class="small" href="${m.drive_folder_url}" target="_blank" rel="noopener">Drive 폴더 열기 →</a>` : m.upload_state !== 'done' ? html`<span class="hint">Drive 업로드 대기 — 지금은 이 PC의 파일로 열립니다${m.upload_state === 'error' && m.upload_error ? ` (${m.upload_error})` : ''}</span>` : ''}
      </div>` : ''}
      <section class="decision mn-box"><h3>핵심 내용·할 일 ${owner ? html`<button type="button" class="link small" data-mail-note="${m.id}">편집</button>` : ''}</h3>
        ${m.priority ? urgBadge(m.priority) : ''}
        ${m.summary ? html`<p class="small mn-sum">${m.summary}</p>` : html`<p class="small muted">아직 적은 내용이 없습니다.</p>`}
        ${Array.isArray(m.todos) && m.todos.length ? html`<ul class="todo-list ro">${m.todos.map((t) => html`<li class="${t.done ? 'del' : ''}">${t.done ? '☑' : '☐'} ${t.text}</li>`)}</ul>` : ''}</section>
      <section class="decision"><h3>회신 관리</h3>${decision}</section>
      ${owner && m.snippet ? html`<details class="more-sec" open><summary>본문 미리보기</summary><p class="snippet">${m.snippet}</p></details>` : ''}
    </div>`);

  $('#rf', panel)?.addEventListener('submit', submitReplyTask);
}

async function submitReplyTask(e) {
  e.preventDefault();
  const m = S.peekData;
  const f = Object.fromEntries(new FormData(e.target));
  if (!f.my_urgency) return toast('내 시급성을 먼저 정하세요', { err: true });
  try {
    const r = await api('POST', `/api/mails/${m.id}/reply-task`, {
      project_id: Number(f.project_id), my_urgency: f.my_urgency, reply_due: f.reply_due || null, reply_plan: f.reply_plan || null,
      told_professor: f.told === 'yes', told_professor_at: f.told === 'yes' ? S.today : null,
    });
    store.set('lastProject', Number(f.project_id));
    S.replyForm = null;
    upsertMail(r.mail);
    await reloadTask(r.task_id);
    await refreshProjects();
    renderMailPeek();
    refresh();
    const t = S.tasks.find((x) => x.id === r.task_id);
    toast(`회신 업무 ${t?.task_code ?? ''} 등록됨`, { action: { label: '업무 열기', fn: () => openPeek(r.task_id) } });
  } catch (err) { toastErr(err); }
}

async function patchMail(body) {
  const m = S.peekData;
  try {
    const d = await api('PATCH', `/api/mails/${m.id}`, body);
    upsertMail(d);
    if (d.task_id) await reloadTask(d.task_id);
    renderMailPeek();
    refresh();
    toast('저장됨');
  } catch (err) { toastErr(err); renderMailPeek(); }
}

$('#peek').addEventListener('change', (e) => {
  const el = e.target.closest('[data-mf]');
  if (!el || S.peekKind !== 'mail' || !isOwner()) return;
  const f = el.dataset.mf;
  const m = S.peekData;
  if (f === 'told_professor') return patchMail({ told_professor: el.checked, told_professor_at: el.checked ? (m.told_professor_at ?? S.today) : null });
  const v = el.value.trim() || null;
  if (v !== (m[f] ?? null)) patchMail({ [f]: v });
});
$('#peek').addEventListener('click', (e) => {
  const a = e.target.closest('[data-mail-act]');
  if (!a || S.peekKind !== 'mail') return;
  const act = a.dataset.mailAct;
  if (act === 'need') { S.replyForm = S.peekData.id; renderMailPeek(); $('#peek input[name="my_urgency"]')?.focus(); }
  else if (act === 'cancel') { S.replyForm = null; renderMailPeek(); }
  else if (act === 'noreply') patchMail({ decision: 'no_reply' });
  else if (act === 'undo') patchMail({ decision: null });
  else if (act === 'replied') patchMail({ replied_at: S.today });
  else if (act === 'unreplied') patchMail({ replied_at: null });
});

// ---- 보낸 사람 우선순위 ----------------------------------------------------------
// 1차: 분류 순서(위일수록 우선) → 2차: 분류 안의 사람 순서. 사용자가 정한 값만 쓴다.
function contactsInCat(catId) {
  return S.contacts.contacts.filter((c) => c.category_id === catId).sort((a, b) => a.rank - b.rank);
}
function senderInfo(addr) {
  const c = S.contacts.contacts.find((x) => x.address === String(addr ?? '').toLowerCase());
  if (!c) return null;
  if (c.category_id == null) return { label: '새 사람 · 분류 필요', cls: 'new', key: [999, 999] };
  const ci = S.contacts.categories.findIndex((k) => k.id === c.category_id);
  const pos = contactsInCat(c.category_id).findIndex((x) => x.id === c.id) + 1;
  return { label: `${S.contacts.categories[ci]?.name ?? ''} · ${pos}순위`, cls: ci === 0 ? 'top' : '', key: [ci, pos] };
}
function byPriority(a, b) {
  const ka = senderInfo(a.from_addr)?.key ?? [998, 998];
  const kb = senderInfo(b.from_addr)?.key ?? [998, 998];
  return ka[0] - kb[0] || ka[1] - kb[1] || (a.received_at < b.received_at ? 1 : -1);
}
// 보낸 사람 우선순위 화면에서 정한 표시 이름 (없으면 메일에 적힌 이름)
function displaySender(m) {
  const c = S.contacts.contacts.find((x) => x.address === String(m.from_addr ?? '').toLowerCase());
  return c?.name || m.from_name;
}
function senderNote(m) {
  const c = S.contacts.contacts.find((x) => x.address === String(m.from_addr ?? '').toLowerCase());
  if (!c) return '';
  return html`<div class="sender-note">${c.note ? html`<span class="sn-label">보낸 사람 메모</span><span class="sn-text">${c.note}</span>` : html`<span class="muted small">이 사람에 대한 메모가 없습니다.</span>`}
    <a href="#/contacts" class="small" data-open-note="${c.id}">${c.note ? '수정' : '+ 메모 쓰기'}</a>
    <span class="small ${c.public_title ? 'tx-ok' : 'muted'}">${c.public_title ? '🔓 공개 페이지에 제목·발신인 표시' : '🔒 공개 페이지에는 비공개'}</span></div>`;
}
const senderTag = (m) => {
  const s = senderInfo(m.from_addr);
  return s ? html`<span class="stag ${s.cls}">${s.label}</span>` : '';
};

async function contactsApi(method, url, body) {
  try {
    S.contacts = await api(method, url, body);
    refresh();
  } catch (e) { toastErr(e); refresh(); }
}
const placeIn = (catId, ids) => contactsApi('POST', '/api/contacts/place', { category_id: catId, ids });

function renderContacts() {
  const { categories, contacts } = S.contacts;
  const unc = contacts.filter((c) => c.category_id == null).sort((a, b) => ((b.last_mail ?? '') > (a.last_mail ?? '') ? 1 : -1));
  const catOptions = (sel) => [html`<option value="" ${sel == null ? raw('selected') : ''}>미분류</option>`,
    categories.map((k) => html`<option value="${k.id}" ${k.id === sel ? raw('selected') : ''}>${k.name}</option>`)];
  const editing = (c) => S.noteOpen === c.id;
  const person = (c, idx, inCat) => html`<div class="person ${editing(c) ? 'editing' : ''}" draggable="${editing(c) ? 'false' : 'true'}" data-contact="${c.id}">
      ${inCat ? html`<span class="p-rank" title="분류 안 순서">${idx + 1}</span>` : html`<span class="p-new">NEW</span>`}
      <div class="p-main"><div class="p-name">${c.name || c.address}
          <button type="button" class="link small p-note-btn" data-pnote="${c.id}">${editing(c) ? '닫기' : c.note ? '메모 수정' : '+ 메모'}</button></div>
        <div class="p-sub">${c.address} · 메일 ${c.mail_count}건${c.last_mail ? ` · 최근 ${fmtDate(c.last_mail)}` : ''}</div>
        ${c.note && !editing(c) ? html`<div class="p-note">${c.note}</div>` : ''}
        ${editing(c) ? html`<div class="p-edit">
          <div class="field"><label>표시 이름</label><input data-pname="${c.id}" value="${c.name ?? ''}" placeholder="${c.address}"></div>
          <div class="field"><label>메모·설명 (이 PC에만 저장, 공개 안 됨)</label><textarea data-pnote-text="${c.id}" rows="3" placeholder="예: 농과원 BRDF 과제 담당 PI. 메일은 당일 1차 회신, 자료 요청은 교수님께 먼저 보고">${c.note ?? ''}</textarea></div>
          <span class="hint">입력칸을 벗어나면 저장됩니다.</span></div>` : ''}</div>
      <div class="p-act">
        ${inCat ? html`<button type="button" class="icon-btn sm" data-pmove="-1" data-id="${c.id}" aria-label="위로" title="위로">↑</button><button type="button" class="icon-btn sm" data-pmove="1" data-id="${c.id}" aria-label="아래로" title="아래로">↓</button>` : ''}
        <button type="button" class="pub-toggle ${c.public_title ? 'on' : ''}" data-ppub="${c.id}" aria-pressed="${c.public_title ? 'true' : 'false'}"
          title="공개 페이지에 이 사람 메일의 제목·발신인을 ${c.public_title ? '보이는 중 (누르면 숨김)' : '숨기는 중 (누르면 공개)'}">${c.public_title ? '🔓 공개' : '🔒 비공개'}</button>
        <select data-cat-of="${c.id}" aria-label="${c.name || c.address} 분류">${catOptions(c.category_id)}</select>
      </div>
    </div>`;
  mount(main(), html`<div class="page">
    <header class="page-h"><div><h1>메일</h1>
      <p class="muted"><b>🔓 공개</b>로 둔 사람의 메일만 공개 페이지에 제목·발신인이 보입니다(나머지는 개수만). 보낸 사람 우선순위 — 1차는 <b>분류 순서</b>(위일수록 우선), 2차는 <b>분류 안의 순서</b>입니다. 끌어다 놓거나 ↑↓로 바꾸세요. 처음 메일을 보낸 사람은 '새로 들어온 사람'에 자동으로 추가됩니다.</p></div>
      <button type="button" class="primary" id="cat-add">+ 분류 추가</button></header>
    ${mailTabs('#/contacts')}
    ${unc.length ? html`<section class="cat-box new" data-cat="">
      <div class="cat-h"><b>새로 들어온 사람</b><span class="group-n">${unc.length}명</span><span class="group-hint">분류를 정하면 메일 우선순위에 반영됩니다</span></div>
      ${unc.map((c) => person(c, 0, false))}</section>` : ''}
    ${categories.map((k, i) => {
      const list = contactsInCat(k.id);
      return html`<section class="cat-box" data-cat="${k.id}">
        <div class="cat-h"><span class="cat-rank" title="1차 우선순위">${i + 1}</span>
          <input class="inline cat-name" data-cat-name="${k.id}" value="${k.name}" aria-label="분류 이름">
          <span class="group-n">${list.length}명</span><span class="spacer"></span>
          <button type="button" class="icon-btn sm" data-cmove="-1" data-id="${k.id}" aria-label="분류 위로" title="분류 위로">↑</button>
          <button type="button" class="icon-btn sm" data-cmove="1" data-id="${k.id}" aria-label="분류 아래로" title="분류 아래로">↓</button>
          <button type="button" class="icon-btn sm" data-cdel="${k.id}" aria-label="분류 삭제" title="분류 삭제">✕</button></div>
        ${list.length ? list.map((c, j) => person(c, j, true)) : html`<p class="drop-hint">여기로 끌어다 놓거나, 사람 옆 분류 선택에서 '${k.name}'을 고르세요</p>`}
      </section>`;
    })}
  </div>`);

  const root = $('#main .page');
  $('#cat-add').addEventListener('click', () => {
    const m = openModal(html`<h2>분류 추가</h2><form id="caf"><div class="field"><label>분류 이름</label><input name="name" required placeholder="예: 정부기관, 해외 공동연구"></div>
      <div class="actions"><button type="button" class="ghost" data-cancel>취소</button><button class="primary" type="submit">추가</button></div></form>`);
    $('[data-cancel]', m).addEventListener('click', closeModal);
    $('#caf', m).addEventListener('submit', async (e) => { e.preventDefault(); const name = e.target.name.value; closeModal(); await contactsApi('POST', '/api/contact-categories', { name }); });
  });
  root.addEventListener('change', (e) => {
    const pn = e.target.closest('[data-pname]');
    if (pn) return contactsApi('PATCH', `/api/contacts/${pn.dataset.pname}`, { name: pn.value });
    const pt = e.target.closest('[data-pnote-text]');
    if (pt) return contactsApi('PATCH', `/api/contacts/${pt.dataset.pnoteText}`, { note: pt.value }).then(() => toast('메모 저장됨'));
    const sel = e.target.closest('[data-cat-of]');
    if (sel) {
      const id = Number(sel.dataset.catOf);
      const to = sel.value === '' ? null : Number(sel.value);
      return placeIn(to, to === null ? [id] : [...contactsInCat(to).map((c) => c.id).filter((x) => x !== id), id]);
    }
    const nm = e.target.closest('[data-cat-name]');
    if (nm) contactsApi('PATCH', `/api/contact-categories/${nm.dataset.catName}`, { name: nm.value });
  });
  root.addEventListener('click', (e) => {
    const pb = e.target.closest('[data-ppub]');
    if (pb) {
      const c = contacts.find((x) => x.id === Number(pb.dataset.ppub));
      return contactsApi('PATCH', `/api/contacts/${c.id}`, { public_title: !c.public_title })
        .then(() => toast(`${c.name || c.address}: 공개 페이지에서 메일 제목·발신인 ${c.public_title ? '숨김' : '공개'}`));
    }
    const nb = e.target.closest('[data-pnote]');
    if (nb) {
      const id = Number(nb.dataset.pnote);
      S.noteOpen = S.noteOpen === id ? null : id;
      refresh();
      if (S.noteOpen) $(`[data-pnote-text="${id}"]`)?.focus();
      return;
    }
    const pm = e.target.closest('[data-pmove]');
    if (pm) {
      const c = contacts.find((x) => x.id === Number(pm.dataset.id));
      const ids = contactsInCat(c.category_id).map((x) => x.id);
      const i = ids.indexOf(c.id);
      const j = i + Number(pm.dataset.pmove);
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return placeIn(c.category_id, ids);
    }
    const cm = e.target.closest('[data-cmove]');
    if (cm) {
      const ids = categories.map((k) => k.id);
      const i = ids.indexOf(Number(cm.dataset.id));
      const j = i + Number(cm.dataset.cmove);
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return contactsApi('POST', '/api/contact-categories/order', { ids });
    }
    const cd = e.target.closest('[data-cdel]');
    if (cd) {
      const k = categories.find((x) => x.id === Number(cd.dataset.cdel));
      if (confirm(`'${k.name}' 분류를 지울까요? 안에 있는 사람은 '새로 들어온 사람'으로 돌아갑니다. (메일은 지워지지 않음)`)) contactsApi('DELETE', `/api/contact-categories/${k.id}`);
    }
  });
  // 끌어다 놓기: 사람 위에 놓으면 그 앞에, 분류 상자에 놓으면 맨 뒤에
  root.addEventListener('dragstart', (e) => {
    const p = e.target.closest('.person');
    if (!p) return;
    e.dataTransfer.setData('text/plain', p.dataset.contact);
    e.dataTransfer.effectAllowed = 'move';
    p.classList.add('dragging');
  });
  root.addEventListener('dragend', () => $$('.dragging, .drop-hover, .drop-before').forEach((el) => el.classList.remove('dragging', 'drop-hover', 'drop-before')));
  root.addEventListener('dragover', (e) => {
    const box = e.target.closest('.cat-box');
    if (!box) return;
    e.preventDefault();
    $$('.drop-hover, .drop-before').forEach((el) => el.classList.remove('drop-hover', 'drop-before'));
    box.classList.add('drop-hover');
    e.target.closest('.person')?.classList.add('drop-before');
  });
  root.addEventListener('drop', (e) => {
    const box = e.target.closest('.cat-box');
    if (!box) return;
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain'));
    const to = box.dataset.cat === '' ? null : Number(box.dataset.cat);
    if (to === null) return placeIn(null, [id]);
    const ids = contactsInCat(to).map((c) => c.id).filter((x) => x !== id);
    const before = e.target.closest('.person');
    const at = before ? ids.indexOf(Number(before.dataset.contact)) : -1;
    ids.splice(at >= 0 ? at : ids.length, 0, id);
    placeIn(to, ids);
  });
}

// ---- 원격 편집 (방법 A) -------------------------------------------------------------
// GitHub 페이지에서 고친 내용은 비공개 저장소(work-board-data)의 queue/에 요청 파일로 올라가고,
// 이 PC가 켜져 있으면 1분 안에 그대로 실행한다. 화면에는 바로 반영해서 보여 준다(반영 대기 표시).
// 키는 이 기기 브라우저(localStorage)에만 저장한다.
const GH_API = store.get('ghApi', 'https://api.github.com');
const ghToken = () => store.get('ghToken', null);
let REMOTE = null; // { repo, full, ops: [{ name, op }], base }
let remoteChain = Promise.resolve();
const REMOTE_BLOCKED = [/^\/api\/mail\/naver/, /^\/api\/publish/, /^\/api\/export/, /^\/api\/login/, /^\/api\/logout/];

async function gh(method, part, { body, raw = false, repo = REMOTE?.repo ?? SITE?.data_repo, token = ghToken() } = {}) {
  const res = await fetch(`${GH_API}/repos/${repo}/${part}`, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) {
    if (res.status === 401) throw new Error('GitHub 키가 맞지 않거나 만료됐습니다');
    if (res.status === 403 || res.status === 404) throw new Error('GitHub 키에 work-board-data 저장소 권한(Contents 읽기·쓰기)이 없습니다');
    throw new Error(`GitHub 오류 (${res.status})`);
  }
  return raw ? res.text() : res.json();
}
const toB64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function loadRemote({ token = ghToken() } = {}) {
  const repo = SITE.data_repo;
  const [fullText, list] = await Promise.all([
    gh('GET', 'contents/full.json?ref=main', { raw: true, repo, token }),
    gh('GET', 'contents/queue?ref=main', { repo, token }),
  ]);
  if (!fullText) throw new Error('아직 PC에서 첫 동기화가 되지 않았습니다. PC의 게시판을 켜 두고 1~2분 뒤 다시 시도하세요');
  const files = (Array.isArray(list) ? list : []).filter((f) => f.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
  const ops = [];
  for (const f of files) {
    const t = await gh('GET', `contents/queue/${encodeURIComponent(f.name)}?ref=main`, { raw: true, repo, token }).catch(() => null);
    if (t) { try { ops.push({ name: f.name, op: JSON.parse(t) }); } catch { /* 깨진 파일은 PC가 정리 */ } }
  }
  REMOTE = { repo, full: JSON.parse(fullText), ops, base: null };
  rebuildRemote();
}

function rebuildRemote() {
  const base = JSON.parse(JSON.stringify(REMOTE.full));
  const today = todayKst();
  for (const t of base.tasks) t.derived = derive(t, t.latest_review, today);
  for (const { op } of REMOTE.ops) { try { reduceRemote(base, op); } catch { /* 화면 반영 실패는 PC 반영에 영향 없음 */ } }
  REMOTE.base = base;
}

// PC가 이미 만든 항목은 임시 id → 실제 id로
function remapRemote(op) {
  const map = REMOTE.full.id_map ?? {};
  const r = (v) => (typeof v === 'number' && v < 0 && map[v] != null ? map[v] : v);
  const path = String(op.path).replace(/\/(-\d+)(?=\/|\?|$)/g, (m, id) => (map[id] != null ? `/${map[id]}` : m));
  const body = op.body && typeof op.body === 'object' && !Array.isArray(op.body)
    ? Object.fromEntries(Object.entries(op.body).map(([k, v]) => [k, k === 'ids' && Array.isArray(v) ? v.map(r) : r(v)]))
    : op.body;
  return { ...op, path, body };
}

// 화면에 바로 보이도록 요청을 데이터에 미리 적용 (실제 검증·이력은 PC가 실행할 때)
function reduceRemote(B, rawOp) {
  const op = remapRemote(rawOp);
  const p = op.path.split('?')[0];
  const body = op.body ?? {};
  const now = new Date().toISOString();
  const today = todayKst();
  const fin = (t) => { t.derived = derive(t, t.latest_review, today); t.pending = true; return t; };
  const task = (id) => B.tasks.find((t) => t.id === Number(id));
  const proj = (id) => B.projects.find((x) => x.id === Number(id)) ?? {};
  const newTask = (id, f) => fin({
    id, task_code: '새 업무', project_id: Number(f.project_id), project_code: proj(f.project_id).code, project_title: proj(f.project_id).title,
    title: f.title, description: null, expected_deliverable: null, done_criteria: null, status: f.status ?? 'todo',
    my_urgency: f.my_urgency ?? null, my_due_date: f.my_due_date ?? null, due_undecided_reason: null, my_reason: f.my_reason ?? null,
    review_state: 'not_reviewed', external_deadline: null, external_deadline_source: null, next_action: f.next_action ?? null,
    waiting_on: null, blocked_reason: f.blocked_reason ?? null, follow_up_date: null, visibility: 'private',
    source_type: f.source_type ?? null, source_note: f.source_note ?? null, origin: 'manual', created_at: now, updated_at: now,
    completed_at: null, reviews: [], activity: [], latest_review: null, mail: null,
  });
  let m;
  if (op.method === 'POST' && p === '/api/tasks') { B.tasks.push(newTask(op.temp_id, body)); return { id: op.temp_id }; }
  if ((m = p.match(/^\/api\/tasks\/(-?\d+)$/)) && op.method === 'PATCH') {
    const t = task(m[1]);
    if (!t) return null;
    for (const [k, v] of Object.entries(body)) if (!['reason', 'mark_verified'].includes(k)) t[k] = v === '' ? null : v;
    if (body.status === 'done') t.completed_at = now;
    if (body.project_id) { t.project_code = proj(body.project_id).code; t.project_title = proj(body.project_id).title; }
    t.updated_at = now;
    return fin(t);
  }
  if ((m = p.match(/^\/api\/tasks\/(-?\d+)\/reviews$/)) && op.method === 'POST') {
    const t = task(m[1]);
    if (!t) return null;
    const r = { id: -Date.now(), task_id: t.id, ...body, needs_recheck: body.needs_recheck ? 1 : 0, direct_confirmation: 0,
      recorded_by_name: B.owner_name, my_urgency_snapshot: t.my_urgency, my_due_date_snapshot: t.my_due_date, created_at: now };
    t.reviews.unshift(r);
    t.latest_review = r;
    t.review_state = r.needs_recheck ? 'recheck' : 'confirmed';
    return fin(t);
  }
  if (op.method === 'POST' && p === '/api/projects') {
    B.projects.push({ id: op.temp_id, code: String(body.code ?? '').toUpperCase(), task_prefix: String(body.task_prefix || body.code || '').toUpperCase(), title: body.title, objective: body.objective ?? null, description: body.description ?? null, status: 'active', active_count: 0, done_count: 0, candidate_count: 0 });
    return { id: op.temp_id };
  }
  if ((m = p.match(/^\/api\/projects\/(-?\d+)$/)) && op.method === 'PATCH') { Object.assign(proj(m[1]), body); return { id: Number(m[1]) }; }
  // 일정·종류
  if (op.method === 'POST' && p === '/api/events') {
    B.events.push({ id: op.temp_id, ...body, all_day: body.all_day ? 1 : 0, end_date: body.end_date || body.start_date, start_time: body.all_day ? null : body.start_time ?? null, end_time: body.all_day ? null : body.end_time ?? null });
    return { id: op.temp_id };
  }
  if ((m = p.match(/^\/api\/events\/(-?\d+)$/))) {
    const i = B.events.findIndex((e) => e.id === Number(m[1]));
    if (i < 0) return { ok: true };
    if (op.method === 'DELETE') { B.events.splice(i, 1); return { ok: true }; }
    const e = Object.assign(B.events[i], body);
    if (body.all_day !== undefined) e.all_day = body.all_day ? 1 : 0;
    if (e.all_day) { e.start_time = null; e.end_time = null; }
    return { ok: true };
  }
  if (p === '/api/event-types' && op.method === 'POST') {
    B.event_types.push({ id: op.temp_id, name: body.name, color: body.color, rank: B.event_types.length + 1 });
    return B.event_types;
  }
  if ((m = p.match(/^\/api\/event-types\/(-?\d+)$/))) {
    const id = Number(m[1]);
    if (op.method === 'DELETE') { B.event_types = B.event_types.filter((t) => t.id !== id); B.events.forEach((e) => { if (e.type_id === id) e.type_id = null; }); }
    else Object.assign(B.event_types.find((t) => t.id === id) ?? {}, body);
    return B.event_types;
  }
  // 보낸 사람 우선순위
  const C = B.contacts ?? { categories: [], contacts: [] };
  if (p === '/api/contacts/place') {
    const cat = body.category_id ?? null;
    (body.ids ?? []).forEach((id, i) => { const c = C.contacts.find((x) => x.id === Number(id)); if (c) { c.category_id = cat; c.rank = cat === null ? null : i + 1; } });
    return C;
  }
  if ((m = p.match(/^\/api\/contacts\/(-?\d+)$/))) { Object.assign(C.contacts.find((x) => x.id === Number(m[1])) ?? {}, body); return C; }
  if (p === '/api/contact-categories' && op.method === 'POST') { C.categories.push({ id: op.temp_id, name: body.name, rank: C.categories.length + 1 }); return C; }
  if (p === '/api/contact-categories/order') { (body.ids ?? []).forEach((id, i) => { const k = C.categories.find((x) => x.id === Number(id)); if (k) k.rank = i + 1; }); C.categories.sort((a, b) => a.rank - b.rank); return C; }
  if ((m = p.match(/^\/api\/contact-categories\/(-?\d+)$/))) {
    const id = Number(m[1]);
    if (op.method === 'DELETE') { C.categories = C.categories.filter((k) => k.id !== id); C.contacts.forEach((c) => { if (c.category_id === id) { c.category_id = null; c.rank = null; } }); }
    else Object.assign(C.categories.find((k) => k.id === id) ?? {}, body);
    return C;
  }
  // 메일
  if ((m = p.match(/^\/api\/mails\/(-?\d+)\/seen$/))) { const x = B.mails.find((y) => y.id === Number(m[1])); if (x) { x.seen = true; x.seen_at ??= now; } return x; }
  if ((m = p.match(/^\/api\/mails\/(-?\d+)$/)) && op.method === 'PATCH') {
    const x = B.mails.find((y) => y.id === Number(m[1]));
    if (!x) return null;
    Object.assign(x, body);
    if (body.told_professor !== undefined) x.told_professor = body.told_professor ? 1 : 0;
    const t = x.task_id ? task(x.task_id) : null;
    if (t && body.reply_due !== undefined) { t.my_due_date = body.reply_due; fin(t); }
    if (t && body.replied_at) { t.status = 'done'; t.completed_at = now; fin(t); }
    if (t) t.mail = { ...x };
    return x;
  }
  if ((m = p.match(/^\/api\/mails\/(-?\d+)\/reply-task$/))) {
    const x = B.mails.find((y) => y.id === Number(m[1]));
    if (!x) return null;
    const t = newTask(op.temp_id, { project_id: body.project_id, title: `${x.from_name} 메일 회신: ${x.subject}`, my_urgency: body.my_urgency, my_due_date: body.reply_due, next_action: '회신 보내기', source_type: 'email' });
    Object.assign(x, { decision: 'reply', task_id: op.temp_id, reply_due: body.reply_due ?? null, reply_plan: body.reply_plan ?? null, told_professor: body.told_professor ? 1 : 0, told_professor_at: body.told_professor_at ?? null, seen: true });
    t.mail = { ...x };
    B.tasks.push(t);
    return { mail: x, task_id: op.temp_id };
  }
  if (p === '/api/mail/sync') return { added: 0, queued: true };
  return { ok: true };
}

function remoteGet(path) {
  const B = REMOTE.base;
  const detail = (t) => (t ? { ...t } : null);
  if (path === '/api/me') return { user: { display_name: B.owner_name, role: REMOTE.open ? 'viewer' : 'owner' }, today: todayKst(), mode: REMOTE.open ? 'open' : 'remote', generated_at: REMOTE.full.generated_at, publish: false };
  if (path === '/api/tasks') return B.tasks.map(({ reviews, activity, ...t }) => t);
  if (path === '/api/projects') return B.projects;
  if (path === '/api/mails') return B.mails;
  if (path === '/api/events') return B.events;
  if (path === '/api/event-types') return B.event_types;
  if (path === '/api/contacts') return B.contacts ?? { categories: [], contacts: [] };
  if (path === '/api/mail/status') return B.mail_status ?? null;
  if (path === '/api/backups') return { last: B.backup };
  if (path === '/api/activity') {
    return B.tasks.flatMap((t) => (t.activity ?? []).map((a) => ({ ...a, task_code: t.task_code, task_title: t.title }))).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 500);
  }
  let m = path.match(/^\/api\/tasks\/(-?\d+)$/);
  if (m) { const t = B.tasks.find((x) => x.id === Number(m[1])); if (!t) throw new Error('업무를 찾을 수 없습니다'); return detail(t); }
  m = path.match(/^\/api\/mails\/(-?\d+)$/);
  if (m) { const x = B.mails.find((y) => y.id === Number(m[1])); if (!x) throw new Error('메일을 찾을 수 없습니다'); return x; }
  throw new Error('없는 데이터');
}

async function remoteApi(method, url, body) {
  const path = url.split('?')[0];
  if (method === 'GET') return remoteGet(path);
  if (REMOTE_BLOCKED.some((re) => re.test(path)) || (REMOTE.open && OPEN_BLOCKED.some((re) => re.test(path)))) throw new Error('이 기능은 PC의 게시판에서만 할 수 있습니다');
  const creates = method === 'POST' && (/^\/api\/(tasks|events|projects|event-types|contact-categories)$/.test(path) || /\/reply-task$/.test(path));
  const op = { method, path, body, temp_id: creates ? -(Date.now() * 10 + Math.floor(Math.random() * 10)) : undefined, created_at: new Date().toISOString() };
  if (REMOTE.open) {
    const r = await relayCall('POST', { action: 'op', op });
    REMOTE.ops.push({ name: r.qid, op });
    return reduceRemote(REMOTE.base, op) ?? { ok: true };
  }
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  // 같은 저장소에 동시에 쓰면 충돌하므로 한 번에 하나씩
  const put = remoteChain.then(() => gh('PUT', `contents/queue/${name}`, { body: { message: `원격 편집: ${method} ${path}`, content: toB64(JSON.stringify(op)), branch: 'main' } }));
  remoteChain = put.catch(() => {});
  await put;
  REMOTE.ops.push({ name, op });
  return reduceRemote(REMOTE.base, op) ?? { ok: true };
}

function remoteStatusLine() {
  if ((S.mode !== 'remote' && S.mode !== 'open') || !REMOTE) return '';
  const n = REMOTE.ops.length;
  const errs = (REMOTE.full.remote_errors ?? []).filter((e) => e.at > new Date(Date.now() - 86400000).toISOString());
  return html`<div class="remote-st"><span class="${n ? 'tx-warn' : 'tx-ok'}">${n ? `PC 반영 대기 ${n}건` : '모두 반영됨'}</span>
    <span class="muted small">PC 동기화 ${fmtTs(REMOTE.full.generated_at)}</span>
    ${errs.length ? html`<span class="tx-bad small" title="${errs.map((e) => `${e.path}: ${e.error}`).join('\n')}">반영 실패 ${errs.length}건</span>` : ''}</div>`;
}

function remoteConnectModal({ then = null } = {}) {
  const m = openModal(html`<h2>처음 한 번만: 저장 키 연결</h2>
    <p class="small">이 기기에서 처음 저장할 때만 필요합니다. 한 번 붙여 넣으면 이 기기에서는 다시 묻지 않습니다. 고친 내용은 비공개 저장소에 저장되고, PC가 켜져 있으면 1분 안에 게시판에 반영됩니다.</p>
    <ol class="small steps">
      <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub 키 만들기 페이지</a>를 엽니다 (GitHub 로그인).</li>
      <li><b>Token name</b>: 업무게시판 · <b>Expiration</b>: 원하는 기간 (예: 1년)</li>
      <li><b>Repository access</b> → <b>Only select repositories</b> → <b>${SITE.data_repo}</b></li>
      <li><b>Permissions</b> → Repository permissions → <b>Contents</b>: <b>Read and write</b></li>
      <li><b>Generate token</b> → 나온 키(<code>github_pat_…</code>)를 복사해 아래에 붙여 넣기</li>
    </ol>
    <form id="ghf" autocomplete="off">
      <div class="field"><label>GitHub 키</label><input name="token" type="password" required placeholder="github_pat_…" autocomplete="off"></div>
      <p class="hint">키는 이 기기의 브라우저에만 저장됩니다. 공용 PC에서는 쓰지 마세요. 이 키로는 ${SITE.data_repo} 저장소만 읽고 쓸 수 있습니다.</p>
      <div class="actions"><button type="button" class="ghost" data-cancel>취소</button><button class="primary" type="submit">연결</button></div>
    </form>`);
  $('[data-cancel]', m).addEventListener('click', closeModal);
  $('#ghf', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = e.target.token.value.trim();
    e.target.token.value = '';
    const btn = $('button[type=submit]', m);
    btn.disabled = true;
    btn.textContent = '확인 중…';
    try {
      await loadRemote({ token });
      store.set('ghToken', token);
      closeModal();
      await bootRemote();
      toast('연결됨 — 이제 이 기기에서 바로 저장됩니다');
      if (then) then();
    } catch (err) {
      toastErr(err);
      btn.disabled = false;
      btn.textContent = '연결';
    }
  });
}
// ---- 누구나 캘린더 수정 (로그인·키 없음) ------------------------------------------------
// 공개 페이지에서는 캘린더의 일정 추가·수정·삭제와 메일 메모(핵심 내용·우선순위·할 일)만 누구나 할 수 있다.
// 저장하면 요청이 Apps Script 저장 창구(Drive 폴더)에 쌓이고, PC가 1분마다 실행한 뒤 최신 데이터를 그 폴더에 다시 쓴다.
// 업무·프로젝트·보낸 사람 등 나머지는 PC에서만 (창구와 PC 양쪽에서 막는다).
const OPEN_BLOCKED = [/^\/api\/(?!events|mails\/\d+$)/];
async function relayCall(method, body) {
  const url = SITE.relay_url;
  const res = await fetch(method === 'GET' ? `${url}?action=${body}` : url, {
    method, cache: 'no-store', redirect: 'follow',
    // text/plain: 브라우저의 사전 확인(CORS preflight) 없이 바로 보낸다
    headers: method === 'POST' ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { throw new Error('저장 창구에 연결하지 못했습니다'); }
  if (data && data.ok === false) throw new Error(data.error || '저장하지 못했습니다');
  return data;
}
async function loadRelay() {
  const r = await relayCall('GET', 'load');
  let snap = null;
  try { snap = JSON.parse(r.snapshot || '{}'); } catch { snap = null; }
  // PC가 아직 한 번도 올리지 않았으면 공개 데이터(data.json)에서 시작
  const full = snap && Array.isArray(snap.tasks) ? snap : { ...SITE, id_map: {}, remote_errors: [] };
  REMOTE = { open: true, full, ops: (Array.isArray(r.ops) ? r.ops : []).map((op) => ({ name: op.qid, op })), base: null };
  rebuildRemote();
}
// 공개 페이지가 창구에 연결 못 한 채 열렸을 때: 저장하려 하면 다시 연결해 보고 이어서
async function connectAndEdit(fn) {
  try {
    await loadRelay();
    await bootRemote();
    if (fn) fn();
  } catch (e) {
    toast(`저장 창구에 연결하지 못했습니다 (${e.message}). 잠시 후 새로고침하세요`, { err: true });
  }
}
// 캘린더 수정 가능: 이 PC의 게시판이거나, 공개 페이지(누구나)
const calEdit = () => (isOwner() && S.mode !== 'static') || S.mode === 'open';

async function bootRemote() {
  REMOTE_ON = true;
  const me = await api('GET', '/api/me');
  S.me = me.user;
  S.today = me.today;
  S.mode = me.mode;
  S.canPublish = false;
  S.generatedAt = me.generated_at;
  await loadAll();
  route();
}
function remoteDisconnect() {
  if (!confirm('이 기기에서 편집 모드를 끌까요? 저장된 GitHub 키가 이 브라우저에서 지워집니다.')) return;
  store.set('ghToken', null);
  location.reload();
}
// 다른 기기·PC에서 바뀐 내용을 1분마다 가져온다
setInterval(async () => {
  if ((S.mode !== 'remote' && S.mode !== 'open') || document.hidden || $('#modal-root').innerHTML) return;
  if (main().contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return;
  try { await (S.mode === 'open' ? loadRelay() : loadRemote()); await loadAll(); refresh(); if (S.peek && S.peekKind === 'task') openPeek(S.peek); } catch { /* 다음에 다시 */ }
}, 60000);

// ---- 메일 상세 창: 핵심 내용·우선순위·할 일 목록 (캘린더·메일 목록에서 열기) --------------------
function todoProgress(m) {
  const list = Array.isArray(m.todos) ? m.todos : [];
  if (!list.length) return '';
  const done = list.filter((t) => t.done).length;
  return html`<span class="meta ${done === list.length ? 'tx-ok' : ''}">할 일 ${done}/${list.length}</span>`;
}
function mailNoteModal(id) {
  let m = S.mails.find((x) => x.id === Number(id));
  if (!m) return;
  const draft = { summary: m.summary ?? '', priority: m.priority ?? null, todos: (Array.isArray(m.todos) ? m.todos : []).map((t) => ({ ...t })) };
  const owner = isOwner() && S.mode !== 'static';
  // 처음 연 메일은 '읽음' 처리 (🆕 사라짐)
  if (owner && S.mode !== 'open' && !m.seen) api('POST', `/api/mails/${m.id}/seen`).then((x) => { upsertMail(x); refresh(); }).catch(() => {});
  const render = () => {
    const pdf = owner && S.mode !== 'open' && m.pdf_file ? mailFileUrl(m, m.pdf_file, m.pdf_url) : null;
    const box = openModal(html`<div class="sheet-h"><h2 class="mn-title">${m.subject}</h2><button type="button" class="icon-btn" data-cancel aria-label="닫기">✕</button></div>
      <p class="small muted mn-meta">${displaySender(m)} · ${fmtDate(m.received_date)} 수신 ${senderTag(m)}
        ${pdf ? html` · <a href="${pdf}" target="_blank" rel="noopener">PDF 보기</a>` : ''}</p>
      <form id="mnf" autocomplete="off">
        <div class="field"><label>우선순위</label>
          <div class="seg" role="group" aria-label="메일 우선순위">${Object.entries(URGENCY).map(([k, v]) => html`<button type="button" class="seg-b u-${k} ${draft.priority === k ? 'on' : ''}" data-mprio="${k}" aria-pressed="${draft.priority === k ? 'true' : 'false'}">${v}</button>`)}</div></div>
        <div class="field"><label>핵심 내용</label><textarea name="summary" rows="3" placeholder="이 메일의 요점 — 무엇을 요청했는지, 언제까지인지 등">${draft.summary}</textarea></div>
        <div class="field"><label>할 일</label>
          ${draft.todos.length ? html`<ul class="todo-list">${draft.todos.map((t, i) => html`<li>
            <label class="toggle"><input type="checkbox" data-todo-done="${i}" ${t.done ? raw('checked') : ''}><span class="${t.done ? 'del' : ''}">${t.text}</span></label>
            <button type="button" class="icon-btn sm" data-todo-del="${i}" aria-label="할 일 삭제">✕</button></li>`)}</ul>` : ''}
          <div class="todo-add"><input name="todo" maxlength="200" placeholder="할 일을 적고 Enter (예: 원영상 폴더 확인)"><button type="button" class="ghost" data-todo-add>추가</button></div>
        </div>
        <div class="actions">${(owner || S.mode === 'remote') && S.mode !== 'open' ? html`<a href="#" class="small" data-open-mailpeek="${m.id}">회신 관리 · 본문 →</a>` : ''}<span class="spacer"></span>
          <button type="button" class="ghost" data-cancel>닫기</button><button class="primary" type="submit">저장</button></div>
      </form>`);
    box.classList.add('mail-note');
    const form = $('#mnf', box);
    const keep = () => { draft.summary = form.summary.value; };
    const addTodo = () => {
      const v = form.todo.value.trim();
      if (!v) return;
      keep();
      draft.todos.push({ text: v, done: false });
      render();
      $('#mnf input[name="todo"]')?.focus();
    };
    $$('[data-cancel]', box).forEach((b) => b.addEventListener('click', closeModal));
    form.todo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTodo(); } });
    $('[data-todo-add]', box).addEventListener('click', addTodo);
    box.addEventListener('click', (e) => {
      const pr = e.target.closest('[data-mprio]');
      if (pr) { keep(); draft.priority = draft.priority === pr.dataset.mprio ? null : pr.dataset.mprio; return render(); }
      const del = e.target.closest('[data-todo-del]');
      if (del) { keep(); draft.todos.splice(Number(del.dataset.todoDel), 1); return render(); }
      const mp = e.target.closest('[data-open-mailpeek]');
      if (mp) { e.preventDefault(); closeModal(); openMailPeek(m.id); }
    });
    box.addEventListener('change', (e) => {
      const d = e.target.closest('[data-todo-done]');
      if (d) { keep(); draft.todos[Number(d.dataset.todoDone)].done = d.checked; render(); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      keep();
      const body = { summary: draft.summary, priority: draft.priority, todos: draft.todos };
      requireEdit(async () => {
        try {
          const x = await api('PATCH', `/api/mails/${m.id}`, body);
          upsertMail(x);
          closeModal();
          refresh();
          toast('메일 메모 저장됨');
        } catch (err) { toastErr(err); }
      });
    });
  };
  render();
}

// 공개 페이지: 캘린더 수정은 누구나 바로 저장 (창구에 연결 못 했으면 다시 연결해 보고 이어서)
function requireEdit(fn) {
  if (S.mode !== 'static') return fn();
  if (SITE?.relay_url) return connectAndEdit(fn);
  if (!SITE?.data_repo) return toast('아직 저장 연결 전이라 지금은 보기만 됩니다', { err: true });
  remoteConnectModal({ then: fn });
}

// ---- GitHub 게시 ----------------------------------------------------------------
async function publishNow() {
  if (!confirm('등록 후보를 뺀 모든 업무가 GitHub Pages에 올라가 인터넷에 공개됩니다.\n(메모와 확인 기록의 "들은 내용"은 올라가지 않습니다)\n\n지금 게시할까요?')) return;
  const btn = $('#publish');
  btn.disabled = true;
  btn.textContent = '게시 중…';
  try {
    const r = await api('POST', '/api/publish');
    const m = openModal(html`<h2>게시 완료</h2>
      <p>${r.changed ? '최신 내용으로 올렸습니다.' : '지난 게시 이후 바뀐 내용이 없습니다.'} 이 주소를 공유하면 로그인 없이 볼 수 있습니다.</p>
      <p class="url-box"><a href="${r.url}" target="_blank" rel="noopener">${r.url}</a></p>
      <p class="hint">GitHub에 반영되기까지 1~2분 걸릴 수 있습니다.</p>
      <div class="actions"><button type="button" class="ghost" data-copy>주소 복사</button><button class="primary" type="button" data-cancel>닫기</button></div>`);
    $('[data-cancel]', m).addEventListener('click', closeModal);
    $('[data-copy]', m).addEventListener('click', () => navigator.clipboard?.writeText(r.url).then(() => toast('복사됨')));
  } catch (e) {
    toast(`게시 실패: ${e.message}`, { err: true });
  } finally {
    const b = $('#publish');
    if (b) { b.disabled = false; b.textContent = 'GitHub에 게시'; }
  }
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch { /* 무시 */ }
  S.me = null;
  S.tasks = [];
  closePeek();
  location.hash = '';
  renderLogin();
}

// ---- 전역 이벤트 ----------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const doneBtn = e.target.closest('[data-done]');
  if (doneBtn) {
    e.stopPropagation();
    const id = Number(doneBtn.dataset.done);
    const t = S.tasks.find((x) => x.id === id);
    const prev = t.status;
    const to = prev === 'done' ? 'todo' : 'done';
    try {
      await patchTask(id, { status: to });
      await refreshProjects();
      refresh();
      if (S.peek === id) renderPeek();
      toast(to === 'done' ? `${t.task_code} 완료` : `${t.task_code} 완료 취소`, to === 'done' ? {
        action: { label: '되돌리기', fn: async () => { await patchTask(id, { status: prev }); await refreshProjects(); refresh(); if (S.peek === id) renderPeek(); } },
      } : {});
    } catch (err) { toastErr(err); }
    return;
  }
  const noteEl = e.target.closest('[data-mail-note]');
  if (noteEl && !e.target.closest('#main .page.wide')) { e.preventDefault(); return mailNoteModal(noteEl.dataset.mailNote); }
  const evEl = e.target.closest('[data-event]');
  if (evEl && !e.target.closest('.modal')) {
    e.preventDefault();
    return eventModal(S.events.find((x) => x.id === Number(evEl.dataset.event)));
  }
  if (e.target.closest('[data-action="create"]')) return createChooser();
  const mailEl = e.target.closest('[data-mail]');
  if (mailEl) {
    e.preventDefault();
    const id = Number(mailEl.dataset.mail);
    return S.peekKind === 'mail' && S.peek === id && mailEl.classList.contains('row') ? closePeek() : openMailPeek(id);
  }
  const peek = e.target.closest('[data-peek]');
  if (peek) {
    e.preventDefault();
    const id = Number(peek.dataset.peek);
    return S.peekKind === 'task' && S.peek === id && peek.classList.contains('row') ? closePeek() : openPeek(id);
  }
  const col = e.target.closest('[data-collapse]');
  if (col) {
    const k = col.dataset.collapse;
    if (S.collapsed.has(k)) S.collapsed.delete(k); else S.collapsed.add(k);
    store.set('collapsed', [...S.collapsed]);
    return refresh();
  }
  const on = e.target.closest('[data-open-note]');
  if (on) { S.noteOpen = Number(on.dataset.openNote); closePeek(); return; }
  if (e.target.closest('[data-action="quick-add"]')) return focusQuickAdd();
  if (e.target.closest('[data-action="new-project"]')) return projectModal();
  const ep = e.target.closest('[data-edit-project]');
  if (ep) return projectModal(projectById(ep.dataset.editProject));
});

function focusQuickAdd() {
  closeSideMobile();
  if (isPhone()) return quickAddSheet();
  const qa = $('#main .qa-input');
  if (qa) { qa.focus(); qa.scrollIntoView({ block: 'center' }); } else newTaskModal();
}

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape') {
    if ($('#modal-root').innerHTML) return closeModal();
    if (typing) return e.target.blur();
    if (S.peek) return closePeek();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $('#modal-root').innerHTML) return;
  if ((e.key === 'n' || e.key === 'N') && isOwner() && S.mode !== 'static') { e.preventDefault(); return focusQuickAdd(); }
  if ((e.key === 'e' || e.key === 'E') && isOwner() && S.mode !== 'static') { e.preventDefault(); return eventModal(null, { start: S.page === 'calendar' ? S.cal.selected ?? S.today : S.today }); }
  const rows = $$('#main .row[data-peek], #main .row[data-mail], #main .row[data-event]');
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement);
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(i + 1, rows.length - 1)].focus(); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(i - 1, 0)].focus(); }
  else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); openRow(rows[i]); }
});
const openRow = (row) => (row.dataset.event ? eventModal(S.events.find((x) => x.id === Number(row.dataset.event)))
  : row.dataset.mail ? openMailPeek(Number(row.dataset.mail)) : openPeek(Number(row.dataset.peek)));
// 상세 패널이 열린 채로 목록을 위아래로 옮기면 패널도 따라간다 (Linear의 peek처럼).
document.addEventListener('focusin', (e) => {
  const row = e.target.closest?.('#main .row[data-peek], #main .row[data-mail]');
  if (!row || !S.peek || row.dataset.event) return;
  const kind = row.dataset.mail ? 'mail' : 'task';
  const id = Number(row.dataset.mail || row.dataset.peek);
  if (kind !== S.peekKind || id !== S.peek) openRow(row);
});

$('#menu-btn').addEventListener('click', openSideMobile);
$('#fab').addEventListener('click', () => createChooser());
$('#side-backdrop').addEventListener('click', closeSideMobile);
window.addEventListener('hashchange', route);

async function boot() {
  if (STATIC) {
    try {
      await staticApi('GET', '/api/me');
      if (SITE.relay_url) { await loadRelay(); return await bootRemote(); }
    } catch (e) {
      REMOTE_ON = false;
      setTimeout(() => toast(`저장 창구 연결 실패: ${e.message} — 보기 모드로 엽니다`, { err: true }), 800);
    }
  }
  if (STATIC && ghToken() && !SITE?.relay_url) {
    try {
      await staticApi('GET', '/api/me');
      if (SITE.data_repo) { await loadRemote(); return await bootRemote(); }
    } catch (e) {
      REMOTE_ON = false;
      setTimeout(() => toast(`편집 모드 연결 실패: ${e.message} — 보기 모드로 엽니다`, { err: true }), 800);
    }
  }
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
    else toastErr(e);
  }
}
boot();

// 서버와 브라우저가 함께 쓰는 값 정의와 계산 규칙.
// 날짜는 항상 'YYYY-MM-DD' 문자열로 다뤄 시간대에 따른 하루 차이를 막는다.

export const URGENCY = { super: '초시급', urgent: '시급', routine: '일상' };
export const URGENCY_RANK = { super: 0, urgent: 1, routine: 2 };

export const STATUS = {
  candidate: '등록 후보',
  todo: '할 일',
  in_progress: '진행 중',
  waiting: '확인/응답 대기',
  blocked: '차단',
  done: '완료',
  dropped: '보류/취소',
};
export const ACTIVE_STATUSES = ['todo', 'in_progress', 'waiting', 'blocked'];

export const REVIEW_STATE = {
  not_needed: '확인 불필요',
  not_reviewed: '확인 전',
  requested: '확인 요청함',
  confirmed: '확인됨',
  recheck: '재확인 필요',
};
// 'confirmed'는 확인 기록을 추가할 때만 서버가 설정한다.
export const MANUAL_REVIEW_STATES = ['not_needed', 'not_reviewed', 'requested', 'recheck'];
export const REVIEW_NEEDED_STATES = ['not_reviewed', 'requested', 'recheck'];

export const CHANNEL = {
  phone: '전화',
  in_person: '대면',
  meeting: '회의',
  email: '이메일',
  messenger: '메신저',
};

export const SOURCE_TYPE = {
  professor: '교수님 지시',
  meeting: '회의',
  email: '메일',
  conversation: '대화',
  self: '본인 발견',
};

export const VISIBILITY = { private: '개인용', shared: '교수님 공유' };

export const UPCOMING_DAYS = 3;

export function todayKst(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// task: tasks 행, latest: 최신 확인 기록(없으면 null), today: 'YYYY-MM-DD'
export function derive(task, latest, today) {
  const active = ACTIVE_STATUSES.includes(task.status);
  const otherUrgency = latest?.other_urgency ?? null;
  const otherDue = latest?.other_due_date ?? null;

  let urgencyCmp;
  if (!otherUrgency) urgencyCmp = 'unknown';
  else if (!task.my_urgency) urgencyCmp = 'self_missing';
  else urgencyCmp = otherUrgency === task.my_urgency ? 'match' : 'mismatch';

  let dueCmp = 'unknown';
  let dueDiffDays = null; // 양수 = 내 평가가 늦음
  if (otherDue && task.my_due_date) {
    dueDiffDays = daysBetween(otherDue, task.my_due_date);
    dueCmp = dueDiffDays === 0 ? 'match' : 'mismatch';
  } else if (otherDue) {
    dueCmp = 'self_missing';
  }

  const dates = [
    ['내 마감일', task.my_due_date],
    ['확인된 기한', otherDue],
    ['외부 일정', task.external_deadline],
  ].filter(([, d]) => d);
  dates.sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const effective = dates[0] ?? null;

  let dueFlag = null;
  if (active && effective) {
    const left = daysBetween(today, effective[1]);
    if (left < 0) dueFlag = 'overdue';
    else if (left <= UPCOMING_DAYS) dueFlag = 'upcoming';
  }

  const conflicts = [];
  if (task.external_deadline) {
    if (otherDue && otherDue > task.external_deadline) conflicts.push('확인된 기한이 외부 일정보다 늦음');
    if (task.my_due_date && task.my_due_date > task.external_deadline) conflicts.push('내 마감일이 외부 일정보다 늦음');
  }

  const selfMissing = [];
  if (active) {
    if (!task.my_urgency) selfMissing.push('시급성 미평가');
    if (!task.my_due_date && !task.due_undecided_reason) selfMissing.push('본인 마감일 미설정');
  }

  return {
    other_urgency: otherUrgency,
    other_due_date: otherDue,
    urgency_cmp: urgencyCmp,
    due_cmp: dueCmp,
    due_diff_days: dueDiffDays,
    mismatch: urgencyCmp === 'mismatch' || dueCmp === 'mismatch',
    review_needed: active && REVIEW_NEEDED_STATES.includes(task.review_state),
    effective_due: effective ? { label: effective[0], date: effective[1] } : null,
    due_flag: dueFlag,
    conflicts,
    self_missing: selfMissing,
    no_next_action: task.status === 'in_progress' && !task.next_action,
  };
}

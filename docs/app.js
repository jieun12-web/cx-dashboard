/* CX 대시보드 — 클라이언트. data.json 로드 → 상태 기반 렌더링.
   상위탭(채팅/콜/민원) × 하위탭(전체/스쿼드/상담사/VOC) × 두 기간 비교.
   상담사별 채팅은 상담사태그 날짜 기준 + 중앙값(채널톡 일치).
   응답률 v2 (2026-05-26): 1인당 표준 시도 기준 정규화. */

const state = {
  data: null,
  type: 'chat',
  view: 'all',
  agent: null,     // 상담사별 뷰 — 특정 상담사 필터(null=전체)
  vocChannel: 'all', // VOC 탭 채널 토글: 'all' | 'chat' | 'call'
  mode: 'single',  // 'single' = 퍼포먼스 확인 / 'compare' = 기간별 비교
  periodA: { start: '', end: '' },
  periodB: { start: '', end: '' },
  expandedSquads: new Set(), // 스쿼드별 뷰 — 클릭으로 펼친 스쿼드 이름
  showInsights: true,  // 지표 패널 표시 (모든 view 상단 토글)
  insightSquad: 'all', // 지표 패널 스쿼드 필터 ('all' | 'CX 1' | 'CX 2' | '교육')
};

let trendChart = null;
let respRateChart = null;
let complaintTypeChart = null, complaintRewardChart = null;
let fpA = null, fpB = null;  // flatpickr 인스턴스
const SQUAD_CHIP = { 'CX 1': 'squad-cx1', 'CX 2': 'squad-cx2', '교육': 'squad-edu', '기타': 'squad-etc' };

// 그 날 콜 포지션이었던 상담사 식별 임계값 (수신연결 ≥ N) — spec 2026-05-26
const CALL_ACTIVE_THRESHOLD = 35;
const CHAT_ACTIVE_THRESHOLD = 40;

// ── 로드 ──────────────────────────────────────────────────────
async function load() {
  try {
    const r = await fetch('data.json?t=' + Date.now());
    state.data = await r.json();
    document.getElementById('generated').textContent =
      '데이터 갱신: ' + new Date(state.data.generated_at).toLocaleString('ko-KR');
    initDefaults();
    bindEvents();
    render();
  } catch (e) {
    document.getElementById('content').innerHTML =
      `<div class="empty">데이터를 불러오지 못했어요: ${e.message}</div>`;
  }
}

function initDefaults() {
  // 마지막 모드 복원 (없으면 'single' 기본)
  state.mode = localStorage.getItem('cx-mode') || 'single';
  document.body.dataset.mode = state.mode;
  document.getElementById('pa-label').textContent =
    state.mode === 'compare' ? '1번 기간' : '기간';
  document.querySelectorAll('#mode-tabs .mode-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
  });

  if (state.mode === 'single') {
    // 마지막 사용 기간 복원, 없으면 어제
    const saved = JSON.parse(localStorage.getItem('cx-period-single') || 'null');
    if (saved && saved.start && saved.end) {
      state.periodA = saved;
    } else {
      const y = new Date(); y.setDate(y.getDate() - 1);
      state.periodA = { start: ymd(y), end: ymd(y) };
    }
    state.periodB = { start: '', end: '' };
  } else {
    setPreset('7d');
  }
}

function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  localStorage.setItem('cx-mode', mode);
  document.body.dataset.mode = mode;
  document.getElementById('pa-label').textContent =
    mode === 'compare' ? '1번 기간' : '기간';
  document.querySelectorAll('#mode-tabs .mode-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  if (mode === 'single') {
    const saved = JSON.parse(localStorage.getItem('cx-period-single') || 'null');
    if (saved && saved.start && saved.end) {
      state.periodA = saved;
    } else {
      const y = new Date(); y.setDate(y.getDate() - 1);
      state.periodA = { start: ymd(y), end: ymd(y) };
    }
    state.periodB = { start: '', end: '' };
    if (fpA) fpA.setDate([state.periodA.start, state.periodA.end], false);
  } else {
    setPreset('7d');
  }
  render();
}

function setPresetSingle(p) {
  const today = new Date();
  let start, end;
  if (p === 'today') { start = end = new Date(today); }
  else if (p === 'yesterday') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    start = end = y;
  } else if (p === '7d') {
    end = new Date(today);
    start = new Date(today); start.setDate(start.getDate() - 6);
  } else if (p === 'thisMonth') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today);
  }
  state.periodA = { start: ymd(start), end: ymd(end) };
  localStorage.setItem('cx-period-single', JSON.stringify(state.periodA));
  if (fpA) fpA.setDate([state.periodA.start, state.periodA.end], false);
}

const ymd = d => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
};

// 'YYYY-MM-DD' → '2026년05월 25일(일요일)'
const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
function fmtDateKo(s) {
  if (!s) return '';
  const [y, m, dy] = s.split('-');
  const w = WEEKDAYS_KO[new Date(s).getDay()];
  return `${y}년${m}월 ${dy}일(${w}요일)`;
}
// 단일일이면 한 날짜, 여러 날이면 시작~끝
function periodLabelKo(p) {
  if (!p.start || !p.end) return '';
  return p.start === p.end ? fmtDateKo(p.start) : `${fmtDateKo(p.start)} ~ ${fmtDateKo(p.end)}`;
}
// 짧은 표기 '05/25(일)' — 표 셀·차트축·매트릭스 헤더용
function fmtDateShort(s) {
  if (!s) return '';
  const [, m, dy] = s.split('-');
  const w = WEEKDAYS_KO[new Date(s).getDay()];
  return `${m}/${dy}(${w})`;
}

function setPreset(p) {
  const today = new Date();
  if (p === '7d' || p === '14d') {
    const n = p === '7d' ? 7 : 14;
    const aEnd = new Date(today);
    const aStart = new Date(aEnd); aStart.setDate(aStart.getDate() - (n - 1));
    const bEnd = new Date(aStart); bEnd.setDate(bEnd.getDate() - 1);
    const bStart = new Date(bEnd); bStart.setDate(bStart.getDate() - (n - 1));
    state.periodA = { start: ymd(aStart), end: ymd(aEnd) };
    state.periodB = { start: ymd(bStart), end: ymd(bEnd) };
  } else if (p === 'thisMonth') {
    const m = today.getMonth(), y = today.getFullYear();
    const aStart = new Date(y, m, 1), aEnd = new Date(today);
    const bStart = new Date(y, m - 1, 1), bEnd = new Date(y, m, 0);
    state.periodA = { start: ymd(aStart), end: ymd(aEnd) };
    state.periodB = { start: ymd(bStart), end: ymd(bEnd) };
  }
  // flatpickr 인스턴스가 있으면 동기화
  if (fpA) fpA.setDate([state.periodA.start, state.periodA.end], false);
  if (fpB) fpB.setDate([state.periodB.start, state.periodB.end], false);
}

// "지금 수집" 패널 — GitHub workflow_dispatch 호출
function bindNowCollect() {
  const btn = document.getElementById('now-collect');
  const panel = document.getElementById('now-panel');
  const patIn = document.getElementById('gh-pat');
  const msg = document.getElementById('now-msg');
  if (!btn || !panel) return;
  // 저장된 PAT 복원
  const saved = localStorage.getItem('gh-pat');
  if (saved) patIn.value = saved;
  btn.onclick = () => { panel.hidden = !panel.hidden; };
  panel.querySelectorAll('button[data-wf]').forEach(b => {
    b.onclick = async () => {
      const pat = patIn.value.trim();
      if (!pat) { msg.textContent = '❌ PAT 입력 필요'; msg.className = 'now-msg err'; return; }
      localStorage.setItem('gh-pat', pat);
      msg.textContent = '⏳ 트리거 중…'; msg.className = 'now-msg';
      try {
        const r = await fetch(
          `https://api.github.com/repos/ishopcare-cx/cx-dashboard/actions/workflows/${b.dataset.wf}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ ref: 'main' }),
        });
        if (r.status === 204) {
          const wait = b.dataset.call ? '3~5분 (PC가 켜져 있어야 함)'
            : b.dataset.wf === 'collect-chat.yml' ? '5~10분'
            : '1~2분';
          msg.innerHTML = `✅ 트리거 완료 — ${wait} 후 페이지 새로고침 (Ctrl+Shift+R). ` +
            `<a href="https://github.com/ishopcare-cx/cx-dashboard/actions" target="_blank">진행 확인 ↗</a>`;
          msg.className = 'now-msg ok';
        } else {
          const err = await r.text();
          msg.textContent = `❌ ${r.status}: ${err.slice(0, 200)}`;
          msg.className = 'now-msg err';
        }
      } catch (e) {
        msg.textContent = `❌ ${e.message}`;
        msg.className = 'now-msg err';
      }
    };
  });
}

function bindEvents() {
  bindNowCollect();
  // flatpickr range — 채널톡 풍 듀얼 캘린더
  const fpOpts = (key) => ({
    mode: 'range',
    showMonths: 2,
    locale: 'ko',
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'Y년 m월 d일 (l)',
    defaultDate: [state[key].start, state[key].end],
    onChange: (dates) => {
      if (dates.length === 2) {
        state[key].start = ymd(dates[0]);
        state[key].end = ymd(dates[1]);
        if (state.mode === 'single' && key === 'periodA') {
          localStorage.setItem('cx-period-single', JSON.stringify(state.periodA));
        }
        render();
      }
    },
    onClose: (dates, _str, instance) => {
      if (dates.length === 1) {
        instance.setDate([dates[0], dates[0]], false);
        state[key].start = ymd(dates[0]);
        state[key].end = ymd(dates[0]);
        if (state.mode === 'single' && key === 'periodA') {
          localStorage.setItem('cx-period-single', JSON.stringify(state.periodA));
        }
        render();
      }
    },
  });
  fpA = flatpickr('#pa-range', fpOpts('periodA'));
  fpB = flatpickr('#pb-range', fpOpts('periodB'));
  document.querySelectorAll('.type-tabs .tab').forEach(b => {
    b.onclick = () => {
      if (b.disabled) return;
      state.type = b.dataset.type;
      state.agent = null;
      state.expandedSquads.clear();
      state.insightSquad = 'all';
      setActive('.type-tabs .tab', b);
      render();
    };
  });
  document.querySelectorAll('.view-tabs .tab').forEach(b => {
    b.onclick = () => {
      state.view = b.dataset.view;
      state.agent = null;
      state.expandedSquads.clear();
      state.insightSquad = 'all';
      setActive('.view-tabs .tab', b);
      render();
    };
  });
  document.querySelectorAll('.presets button[data-preset]').forEach(b => {
    b.onclick = () => { setPreset(b.dataset.preset); render(); };
  });
  document.querySelectorAll('.presets button[data-preset-single]').forEach(b => {
    b.onclick = () => { setPresetSingle(b.dataset.presetSingle); render(); };
  });
  document.querySelectorAll('#mode-tabs .mode-tab').forEach(b => {
    b.onclick = () => setMode(b.dataset.mode);
  });
}

function setActive(sel, target) {
  document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b === target));
}

// ── 포맷 ──────────────────────────────────────────────────────
const fmtNum = n => (n == null || isNaN(n)) ? '-' : Number(n).toLocaleString('ko-KR');
const fmtPct = (p, dec = 1) => p == null ? '-' : p.toFixed(dec) + '%';
// "142 (22.3%)" 형태 — 표 셀에서 건수와 비중을 한눈에
function fmtCntPct(cnt, total) {
  if (!cnt && !total) return '-';
  const pct = total > 0 ? (cnt / total * 100).toFixed(1) : '0.0';
  return `${fmtNum(cnt)} <span class="pct">(${pct}%)</span>`;
}
function fmtSec(s) {
  if (s == null || isNaN(s)) return '-';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtDelta(d, isPp = false, invert = false) {
  if (d == null || isNaN(d)) return '<span class="delta">-</span>';
  // invert: 작아지는 게 좋은 지표(시간·포기)의 색을 반전
  const good = invert ? d < 0 : d >= 0;
  const cls = good ? 'up' : 'down';
  const sign = d >= 0 ? '▲' : '▼';
  const unit = isPp ? 'pp' : '%';
  return `<span class="delta ${cls}">${sign}${Math.abs(d).toFixed(1)}${unit}</span>`;
}

// ── 통계 ──────────────────────────────────────────────────────
const inRange = (d, p) => p.start && p.end && d >= p.start && d <= p.end;
const delta = (a, b) => (a == null || b == null || b === 0) ? null : ((a - b) / b * 100);
const deltaPp = (a, b) => (a == null || b == null) ? null : (a - b);

function median(arr) {
  const vals = arr.filter(v => v != null && !isNaN(v));
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 채팅 팀 — by_date(sum/n) 합산해서 평균 산출
function aggChatTeam(rows, p) {
  let 인입 = 0, 응대 = 0, fs = 0, fn = 0, as = 0, an = 0, rs = 0, rn = 0;
  for (const r of rows) {
    if (!inRange(r.date, p)) continue;
    인입 += r['인입'] || 0;
    응대 += r['응대'] || 0;
    fs += r['첫응대_sum'] || 0; fn += r['첫응대_n'] || 0;
    as += r['응답_sum'] || 0; an += r['응답_n'] || 0;
    rs += r['처리_sum'] || 0; rn += r['처리_n'] || 0;
  }
  return {
    인입, 응대,
    응답률: 인입 ? (응대 / 인입 * 100) : null,
    첫응대: fn ? (fs / fn) : null,    // 팀은 평균
    응답: an ? (as / an) : null,
    처리: rn ? (rs / rn) : null,
  };
}

// 채팅 상담사 귀속 — agent_chats 평탄화에서 중앙값 산출
function aggChatAgent(rows, p, filter = {}) {
  const sel = rows.filter(r => {
    if (!inRange(r.date, p)) return false;
    if (filter.agent && r.agent !== filter.agent) return false;
    if (filter.squad && r.squad !== filter.squad) return false;
    return true;
  });
  return {
    응대: sel.length,
    첫응대: median(sel.map(r => r.fw)),
    응답: median(sel.map(r => r.ar)),
    처리: median(sel.map(r => r.res)),
  };
}

// 콜 팀
function aggCallTeam(rows, p) {
  let 인입 = 0, 시도 = 0, 성공 = 0, 포기 = 0, 실패 = 0;
  let 대기_s = 0, 대기_w = 0, 통화_s = 0, 통화_w = 0;
  for (const r of rows) {
    if (!inRange(r.date, p)) continue;
    인입 += r['총인입'] || 0;
    시도 += r['연결시도'] || 0;
    성공 += r['연결성공'] || 0;
    포기 += r['연결포기'] || 0;
    실패 += r['연결실패'] || 0;
    if (r['평균대기_초'] != null && r['연결시도']) {
      대기_s += r['평균대기_초'] * r['연결시도']; 대기_w += r['연결시도'];
    }
    if (r['평균통화_초'] != null && r['연결성공']) {
      통화_s += r['평균통화_초'] * r['연결성공']; 통화_w += r['연결성공'];
    }
  }
  return {
    총인입: 인입, 연결시도: 시도, 연결성공: 성공, 연결포기: 포기, 연결실패: 실패,
    응답률: 시도 ? (성공 / 시도 * 100) : null,
    평균대기: 대기_w ? (대기_s / 대기_w) : null,
    평균통화: 통화_w ? (통화_s / 통화_w) : null,
  };
}

// 콜 상담사·스쿼드 (call_daily — 이미 일집계됨)
function aggCallAgentRow(rows, p, filter = {}) {
  let cnt = 0, tot = 0, out_try = 0, out_ans = 0;
  for (const r of rows) {
    if (!inRange(r.date, p)) continue;
    if (filter.agent && r.agent !== filter.agent) continue;
    if (filter.squad && r.squad !== filter.squad) continue;
    cnt += r['수신연결'] || 0;
    tot += r['총통화_초'] || 0;
    out_try += r['발신시도'] || 0;
    out_ans += r['발신연결'] || 0;
  }
  return {
    수신연결: cnt,
    총통화: tot,
    평균통화: cnt ? (tot / cnt) : null,
    발신시도: out_try, 발신연결: out_ans,
  };
}

// 기간 합산 팀 시도 — 스쿼드/활성자 응답률 분모
function sumTeamAttempts(teamRows, p) {
  let s = 0;
  for (const r of teamRows) {
    if (!inRange(r.date, p)) continue;
    s += r['연결시도'] || 0;
  }
  return s;
}

// 활성자만 합산 (single 모드 카드 — 그 날 활성자 한정 합)
function aggActiveAgents(agentRows, p, filter = {}) {
  let n = 0, recv = 0, tot = 0, out = 0;
  for (const r of agentRows) {
    if (!inRange(r.date, p)) continue;
    if (filter.squad && r.squad !== filter.squad) continue;
    if ((r['수신연결'] || 0) < CALL_ACTIVE_THRESHOLD) continue;
    n += 1;
    recv += r['수신연결'] || 0;
    tot += r['총통화_초'] || 0;
    out += r['발신연결'] || 0;
  }
  return { n, 수신연결: recv, 총통화: tot, 발신연결: out,
           평균통화: recv ? (tot / recv) : null };
}

// 채팅: 그 기간 하루라도 (date,agent) 채팅 수 ≥ CHAT_ACTIVE_THRESHOLD 인 상담사
// agentChats는 chat × agent_tag 평탄화. (date, agent) 기준으로 그룹해서 카운트.
function _chatDailyCount(agentChats, p, filter = {}) {
  const cnt = {};   // 'date|agent' -> count
  const squadOf = {};
  for (const r of agentChats) {
    if (!inRange(r.date, p)) continue;
    if (filter.squad && r.squad !== filter.squad) continue;
    if (filter.agent && r.agent !== filter.agent) continue;
    if (!r.agent) continue;
    const k = `${r.date}|${r.agent}`;
    cnt[k] = (cnt[k] || 0) + 1;
    squadOf[r.agent] = r.squad || '기타';
  }
  return { cnt, squadOf };
}

function listActiveAgentsChat(agentChats, p, filter = {}) {
  const { cnt } = _chatDailyCount(agentChats, p, filter);
  const names = new Set();
  for (const [k, c] of Object.entries(cnt)) {
    if (c >= CHAT_ACTIVE_THRESHOLD) names.add(k.split('|')[1]);
  }
  return Array.from(names).sort();
}

function countActiveAvgChat(agentChats, p, filter = {}) {
  const { cnt } = _chatDailyCount(agentChats, p, filter);
  const byDate = {};         // date -> 활성자 수
  const teamDays = new Set(); // 그 스쿼드에 한 건이라도 있는 날
  for (const [k, c] of Object.entries(cnt)) {
    const [date] = k.split('|');
    teamDays.add(date);
    if (c >= CHAT_ACTIVE_THRESHOLD) {
      byDate[date] = (byDate[date] || 0) + 1;
    }
  }
  const days = teamDays.size || 1;
  const sum = Object.values(byDate).reduce((a, b) => a + b, 0);
  return sum / days;
}

// 그 기간 하루라도 수신연결 ≥ THRESHOLD를 채운 상담사 이름 목록
function listActiveAgents(agentRows, p, filter = {}) {
  const names = new Set();
  for (const r of agentRows) {
    if (!inRange(r.date, p)) continue;
    if (filter.squad && r.squad !== filter.squad) continue;
    if ((r['수신연결'] || 0) < CALL_ACTIVE_THRESHOLD) continue;
    if (r.agent) names.add(r.agent);
  }
  return Array.from(names).sort();
}

// 활성 상담사 평균 인원 — 매일 수신연결≥CALL_ACTIVE_THRESHOLD인 상담사 수의 일평균
// filter.squad 주면 그 스쿼드 한정
function countActiveAvg(agentRows, p, filter = {}) {
  const byDate = {};
  for (const r of agentRows) {
    if (!inRange(r.date, p)) continue;
    if (filter.squad && r.squad !== filter.squad) continue;
    if ((r['수신연결'] || 0) < CALL_ACTIVE_THRESHOLD) continue;
    byDate[r.date] = (byDate[r.date] || 0) + 1;
  }
  // 기간 안에서 데이터가 있는 날(=수신연결>0인 날) 기준 평균
  const teamDays = new Set();
  for (const r of agentRows) {
    if (!inRange(r.date, p)) continue;
    if (filter.squad && r.squad !== filter.squad) continue;
    if ((r['수신연결'] || 0) > 0) teamDays.add(r.date);
  }
  const days = teamDays.size || 1;
  const sum = Object.values(byDate).reduce((a, b) => a + b, 0);
  return sum / days;
}

// ── 렌더 진입 ──────────────────────────────────────────────────
function render() {
  const main = document.getElementById('content');
  main.innerHTML = '';
  if (!state.data) return;

  // VOC·민원 탭일 때 하위탭은 의미 없음 → 비활성
  document.querySelectorAll('.view-tabs .tab').forEach(b => {
    const dim = (state.type === 'vocstat' || state.type === 'complaint');
    b.disabled = dim;
    b.style.opacity = dim ? '0.4' : '';
  });

  if (!state.periodA.start || !state.periodA.end) {
    main.innerHTML = `<div class="empty">기간을 선택해주세요.</div>`;
    return;
  }

  if (state.type === 'chat') renderChat(main);
  else if (state.type === 'call') renderCall(main);
  else if (state.type === 'vocstat') renderVoc(main);
  else if (state.type === 'complaint') renderComplaint(main);

  // 지표(인사이트)는 모든 뷰 공통으로 제일 하단에 배치
  appendInsights(main);
}

// 지표 토글 + 패널 + (스쿼드 뷰) 개인별 매트릭스 — 본문 맨 아래에 붙인다
function appendInsights(main) {
  const A = state.periodA;
  const t = state.type;
  // 개인 상세(상담사 선택) 화면과 콜/채팅 VOC 서브탭은 지표 없음
  if ((t === 'chat' || t === 'call') && state.view === 'voc') return;
  if ((t === 'chat' || t === 'call') && state.view === 'agent' && state.agent) return;

  main.appendChild(insightsToggle());
  if (!state.showInsights) return;

  if (t === 'chat' || t === 'call') {
    main.appendChild(insightsPanel(t, state.view, A));
    if (state.view === 'squad') {
      const mxWrap = document.createElement('div');
      const targetSquads = state.insightSquad === 'all' ? state.data.squads : [state.insightSquad];
      for (const s of targetSquads) {
        const html = squadAgentMatrix(s, A, t);
        if (html) mxWrap.insertAdjacentHTML('beforeend', html);
      }
      if (mxWrap.children.length) main.appendChild(mxWrap);
    }
  } else if (t === 'vocstat') {
    main.appendChild(insightsPanel('vocstat', '', A));
  } else if (t === 'complaint') {
    main.appendChild(insightsPanel('complaint', '', A));
  }
}

// === 채팅 렌더 ===
function renderChat(main) {
  const d = state.data.chat;
  const A = state.periodA, B = state.periodB;

  if (state.view === 'voc') {
    main.appendChild(vocPanel(d.voc_by_date, A, B, 30));
    return;
  }

  if (state.view === 'all') {
    const a = aggChatTeam(d.by_date, A);
    const b = aggChatTeam(d.by_date, B);
    main.appendChild(notePanel('💡 채팅은 <strong>당일 운영시간(09~12시) 인입을 100% 처리</strong>하므로 인입=응대. 응대량만 표시합니다. 시간 지표는 생성일 기준 평균, 상담사별·스쿼드별은 상담사태그 날짜+중앙값.'));
    main.appendChild(cardsChat(a, b, /*median=*/false));
    main.appendChild(trendPanel(d.by_date, '채팅 일별 응대', ['응대'], A, B));
    main.appendChild(dailyChatTable(d.by_date, A, B));
    return;
  }

  if (state.view === 'squad') {
    const squads = state.data.squads;
    const rows = [];
    for (const s of squads) {
      const ma = aggChatAgent(d.agent_chats, A, { squad: s });
      const mb = aggChatAgent(d.agent_chats, B, { squad: s });
      if (ma.응대 === 0 && mb.응대 === 0) continue;
      const activeA = countActiveAvgChat(d.agent_chats, A, { squad: s });
      const namesA = listActiveAgentsChat(d.agent_chats, A, { squad: s });
      const throughputA = activeA ? (ma.응대 / activeA) : null;
      const expanded = state.expandedSquads.has(s);
      rows.push(rowChatGroup(s, ma, mb, activeA, namesA, throughputA, expanded));
      if (expanded) {
        rows.push(...rowsChatAgentsInSquad(d.agent_chats, A, B, s));
      }
    }
    const panel = tablePanel(
      `스쿼드별 채팅 — 처리량 = 응대 ÷ 활성 N명 (활성 기준: 하루 태그 ${CHAT_ACTIVE_THRESHOLD}개 이상). 스쿼드 행 클릭 → 상담사별 펼침.`,
      ['스쿼드', '응대(A)', '활성 N명', '처리량', '첫응대', '응답', '처리'],
      rows,
    );
    bindSquadToggle(panel);
    main.appendChild(panel);
    return;
  }

  if (state.view === 'agent') {
    main.appendChild(agentSelector('chat'));
    if (state.agent) {
      // 단일 상담사 상세
      const ma = aggChatAgent(d.agent_chats, A, { agent: state.agent });
      const mb = aggChatAgent(d.agent_chats, B, { agent: state.agent });
      main.appendChild(cardsChat({
        인입: null, 응대: ma.응대, 응답률: null,
        첫응대: ma.첫응대, 응답: ma.응답, 처리: ma.처리,
      }, {
        인입: null, 응대: mb.응대, 응답률: null,
        첫응대: mb.첫응대, 응답: mb.응답, 처리: mb.처리,
      }, /*median=*/true, /*singleAgent=*/true));
      // 일별 추이 (해당 상담사)
      const trend = aggAgentChatTrend(d.agent_chats, A, B, state.agent);
      main.appendChild(trendPanel(trend, `${state.agent} 일별 응대 추이`, ['응대'], A, B));
      return;
    }
    // 전체 상담사 표
    const agents = collectAgentChatRows(d.agent_chats, A, B);
    main.appendChild(tablePanel(
      '상담사별 채팅 (상담사태그 날짜 기준, 시간 = 중앙값)',
      ['상담사', '스쿼드', '응대(A)', '응대(B)', '변화', '첫응대', '응답', '처리'],
      agents,
    ));
    return;
  }
}

// === 콜 렌더 ===
function renderCall(main) {
  const d = state.data.call;
  const A = state.periodA, B = state.periodB;

  if (state.view === 'voc') {
    main.innerHTML = '<div class="empty">콜 VOC는 콜라비 상담유형(대/중/소) 추가 수집 후 활성화됩니다.</div>';
    return;
  }

  if (state.view === 'all') {
    const a = aggCallTeam(d.team_by_date, A);
    const b = aggCallTeam(d.team_by_date, B);
    main.appendChild(cardsCall(a, b));
    main.appendChild(respRatePanel(d.team_by_date, A, B));
    main.appendChild(trendPanel(d.team_by_date.map(r => ({
      date: r.date, 인입: r['총인입'], 응대: r['연결성공'],
    })), '콜 일별 인입·응대', ['인입', '응대'], A, B));
    main.appendChild(dailyCallTable(d.team_by_date, A, B));
    return;
  }

  if (state.view === 'squad') {
    const squads = state.data.squads;
    const attemptsA = sumTeamAttempts(d.team_by_date, A);
    const attemptsB = sumTeamAttempts(d.team_by_date, B);
    const totalActiveA = countActiveAvg(d.agent_by_date, A);
    const totalActiveB = countActiveAvg(d.agent_by_date, B);
    // 1인당 표준 시도 = 팀 시도 / 전체 활성자 N
    const stdA = totalActiveA ? attemptsA / totalActiveA : null;
    const stdB = totalActiveB ? attemptsB / totalActiveB : null;
    const rows = [];
    for (const s of squads) {
      const ma = aggCallAgentRow(d.agent_by_date, A, { squad: s });
      const mb = aggCallAgentRow(d.agent_by_date, B, { squad: s });
      if (ma.수신연결 === 0 && mb.수신연결 === 0) continue;
      const activeA = countActiveAvg(d.agent_by_date, A, { squad: s });
      const activeB = countActiveAvg(d.agent_by_date, B, { squad: s });
      const namesA = listActiveAgents(d.agent_by_date, A, { squad: s });
      // 스쿼드 응답률 = (스쿼드 1인당 수신) / (전체 1인당 시도) × 100
      const rateA = (stdA && activeA) ? (ma.수신연결 / activeA) / stdA * 100 : null;
      const rateB = (stdB && activeB) ? (mb.수신연결 / activeB) / stdB * 100 : null;
      const expanded = state.expandedSquads.has(s);
      rows.push(rowCallGroup(s, ma, mb, rateA, rateB, activeA, activeB, namesA, expanded));
      if (expanded) {
        rows.push(...rowsCallAgentsInSquad(d.agent_by_date, A, B, s, stdA));
      }
    }
    const stdNote = stdA ? ` · 1인당 표준 시도 ≈ ${stdA.toFixed(1)}건` : '';
    const title = `스쿼드별 콜 — 응답률 = 스쿼드 1인당 수신 ÷ 전체 1인당 시도${stdNote}. 스쿼드 행 클릭 → 상담사별 펼침.`;
    const panel = tablePanel(
      title,
      ['스쿼드', '활성 N명', '수신연결', '응답률', '평균통화', '발신연결'],
      rows,
    );
    bindSquadToggle(panel);
    main.appendChild(panel);   // 스쿼드별 응답률 표 — 지표는 render()가 하단에 붙임
    return;
  }

  if (state.view === 'agent') {
    main.appendChild(agentSelector('call'));
    // 1인당 표준 시도 (개인 응답률 분모)
    const attemptsA = sumTeamAttempts(d.team_by_date, A);
    const totalActiveA = countActiveAvg(d.agent_by_date, A);
    const stdA = totalActiveA ? attemptsA / totalActiveA : null;
    if (state.agent) {
      const ma = aggCallAgentRow(d.agent_by_date, A, { agent: state.agent });
      const mb = aggCallAgentRow(d.agent_by_date, B, { agent: state.agent });
      const attemptsB = sumTeamAttempts(d.team_by_date, B);
      const totalActiveB = countActiveAvg(d.agent_by_date, B);
      const stdB = totalActiveB ? attemptsB / totalActiveB : null;
      // 활성자(≥THRESHOLD)인 경우만 응답률 산출
      const rateA = (stdA && ma.수신연결 >= CALL_ACTIVE_THRESHOLD) ? (ma.수신연결 / stdA * 100) : null;
      const rateB = (stdB && mb.수신연결 >= CALL_ACTIVE_THRESHOLD) ? (mb.수신연결 / stdB * 100) : null;
      const cards = [
        { label: '수신연결(응대)', value: fmtNum(ma.수신연결), prev: fmtNum(mb.수신연결), d: delta(ma.수신연결, mb.수신연결) },
        { label: '개인 응답률', value: fmtPct(rateA), prev: fmtPct(rateB), d: deltaPp(rateA, rateB), pp: true },
        { label: '총통화시간', value: fmtSec(ma.총통화), prev: fmtSec(mb.총통화), d: delta(ma.총통화, mb.총통화) },
        { label: '평균통화', value: fmtSec(ma.평균통화), prev: fmtSec(mb.평균통화), d: delta(ma.평균통화, mb.평균통화) },
        { label: '발신연결', value: fmtNum(ma.발신연결), prev: fmtNum(mb.발신연결), d: delta(ma.발신연결, mb.발신연결) },
      ];
      main.appendChild(makeCardGrid(cards));
      return;
    }
    // 전체 표 — single 모드에선 활성자 카드 한 줄 먼저
    if (state.mode === 'single') {
      const act = aggActiveAgents(d.agent_by_date, A);
      const rate = (stdA && act.n) ? (act.수신연결 / act.n) / stdA * 100 : null;
      main.appendChild(notePanel(
        `🎯 활성 콜 상담사 = 그 날 <strong>수신연결 ${CALL_ACTIVE_THRESHOLD}건 이상</strong>인 상담사 ` +
        `(콜 포지션 자동 식별 · 휴무·채팅 포지션 제외). ` +
        (stdA ? `1인당 표준 시도 ≈ <strong>${stdA.toFixed(1)}건</strong>` : '')));
      main.appendChild(makeCardGrid([
        { label: '활성 인원', value: fmtNum(act.n), prev: '', d: null },
        { label: '활성자 평균 응답률', value: fmtPct(rate), prev: '', d: null },
        { label: '활성자 평균통화', value: fmtSec(act.평균통화), prev: '', d: null },
        { label: '활성자 발신연결 합', value: fmtNum(act.발신연결), prev: '', d: null },
      ]));
    }
    const agents = collectCallAgentRows(d.agent_by_date, A, B, stdA);
    main.appendChild(tablePanel(
      '상담사별 콜 (1번 기간) — 응답률은 활성자(≥' + CALL_ACTIVE_THRESHOLD + ')만',
      ['상담사', '스쿼드', '수신연결(A)', '수신연결(B)', '변화', '응답률', '평균통화'],
      agents,
    ));
    return;
  }
}

// ── 컴포넌트 ──────────────────────────────────────────────────
function notePanel(html) {
  const div = document.createElement('div');
  div.className = 'warn-banner';
  div.innerHTML = html;
  return div;
}

function makeCardGrid(cards) {
  const div = document.createElement('div');
  div.className = 'cards';
  for (const c of cards) {
    const dHtml = fmtDelta(c.d, c.pp, c.invert);
    div.insertAdjacentHTML('beforeend', `
      <div class="card">
        <div class="card-label">${c.label}</div>
        <div class="card-value num">${c.value}</div>
        <div class="card-foot">
          <span class="card-prev num">${c.prev}</span>
          ${dHtml}
        </div>
      </div>
    `);
  }
  return div;
}

function cardsChat(a, b, isMedian, singleAgent) {
  const cards = [];
  if (!singleAgent) {
    cards.push({ label: '응대량', value: fmtNum(a.응대), prev: fmtNum(b.응대), d: delta(a.응대, b.응대) });
  } else {
    cards.push({ label: '응대건수', value: fmtNum(a.응대), prev: fmtNum(b.응대), d: delta(a.응대, b.응대) });
  }
  const singleDay = state.periodA.start && state.periodA.start === state.periodA.end;
  const tLabel = isMedian ? ' (중앙값)' : (singleDay ? '' : ' (평균)');
  cards.push({ label: '첫응대' + tLabel, value: fmtSec(a.첫응대), prev: fmtSec(b.첫응대), d: delta(a.첫응대, b.첫응대), invert: true });
  cards.push({ label: '응답시간' + tLabel, value: fmtSec(a.응답), prev: fmtSec(b.응답), d: delta(a.응답, b.응답), invert: true });
  cards.push({ label: '처리시간' + tLabel, value: fmtSec(a.처리), prev: fmtSec(b.처리), d: delta(a.처리, b.처리), invert: true });
  return makeCardGrid(cards);
}

function cardsCall(a, b) {
  return makeCardGrid([
    { label: '총 인입', value: fmtNum(a.총인입), prev: fmtNum(b.총인입), d: delta(a.총인입, b.총인입) },
    { label: '연결시도', value: fmtNum(a.연결시도), prev: fmtNum(b.연결시도), d: delta(a.연결시도, b.연결시도) },
    { label: '응대(연결성공)', value: fmtNum(a.연결성공), prev: fmtNum(b.연결성공), d: delta(a.연결성공, b.연결성공) },
    { label: '응답률', value: fmtPct(a.응답률), prev: fmtPct(b.응답률), d: deltaPp(a.응답률, b.응답률), pp: true },
    { label: '포기', value: fmtNum(a.연결포기), prev: fmtNum(b.연결포기), d: delta(a.연결포기, b.연결포기), invert: true },
    { label: '평균 대기', value: fmtSec(a.평균대기), prev: fmtSec(b.평균대기), d: delta(a.평균대기, b.평균대기), invert: true },
    { label: '평균 통화', value: fmtSec(a.평균통화), prev: fmtSec(b.평균통화), d: delta(a.평균통화, b.평균통화) },
  ]);
}

function tablePanel(title, headers, rowsHtml) {
  const div = document.createElement('div');
  div.className = 'panel';
  div.innerHTML = `
    <h2>${title}</h2>
    <table>
      <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml.join('') || `<tr><td colspan="${headers.length}" style="text-align:center;color:var(--muted)">데이터 없음</td></tr>`}</tbody>
    </table>`;
  return div;
}

// 상담사별 표 — 채팅
function collectAgentChatRows(allRows, A, B) {
  const agentsA = {};
  const agentsB = {};
  for (const r of allRows) {
    const ina = inRange(r.date, A), inb = inRange(r.date, B);
    if (!ina && !inb) continue;
    const tgt = ina ? agentsA : agentsB;
    if (!tgt[r.agent]) tgt[r.agent] = { rows: [], squad: r.squad };
    tgt[r.agent].rows.push(r);
    if (inb && !agentsB[r.agent]) agentsB[r.agent] = { rows: [], squad: r.squad };
    if (inb) agentsB[r.agent].rows.push(r);
  }
  // 1번기간 기준 응대 desc 정렬
  const names = Array.from(new Set([...Object.keys(agentsA), ...Object.keys(agentsB)]));
  names.sort((x, y) => (agentsA[y]?.rows.length || 0) - (agentsA[x]?.rows.length || 0));
  const rowsHtml = [];
  for (const name of names) {
    const a = agentsA[name] || { rows: [], squad: '기타' };
    const b = agentsB[name] || { rows: [], squad: '기타' };
    const aR = a.rows, bR = b.rows;
    const squad = a.squad || b.squad || '기타';
    const cntA = aR.length, cntB = bR.length;
    const fA = median(aR.map(r => r.fw));
    const aRdy = median(aR.map(r => r.ar));
    const rA = median(aR.map(r => r.res));
    rowsHtml.push(`<tr>
      <td>${name}</td>
      <td><span class="chip ${SQUAD_CHIP[squad]||''}">${squad}</span></td>
      <td class="num">${fmtNum(cntA)}</td>
      <td class="num">${fmtNum(cntB)}</td>
      <td class="num">${fmtDelta(delta(cntA, cntB))}</td>
      <td class="num">${fmtSec(fA)}</td>
      <td class="num">${fmtSec(aRdy)}</td>
      <td class="num">${fmtSec(rA)}</td>
    </tr>`);
  }
  return rowsHtml;
}

function rowChatGroup(squad, a, b, activeA, namesA, throughputA, expanded) {
  const fmtActive = n => (n == null || isNaN(n)) ? '-'
    : (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(1));
  // 활성자 명단을 tooltip 대신 항상 보이게 인라인 표기
  const namesLine = (namesA && namesA.length)
    ? `<br><span style="font-size:.8em;color:var(--muted);font-weight:400">${namesA.join(', ')}</span>`
    : '';
  const caret = `<span class="caret">${expanded ? '▼' : '▶'}</span>`;
  const label = `${caret} <span class="chip ${SQUAD_CHIP[squad]||''}">${squad}</span>`;
  return `<tr class="squad-row${expanded ? ' expanded' : ''}" data-squad="${squad}">
    <td>${label}</td>
    <td class="num">${fmtNum(a.응대)} ${fmtDelta(delta(a.응대, b.응대))}</td>
    <td class="num">${fmtActive(activeA)}${namesLine}</td>
    <td class="num">${throughputA == null ? '-' : throughputA.toFixed(1)}</td>
    <td class="num">${fmtSec(a.첫응대)}</td>
    <td class="num">${fmtSec(a.응답)}</td>
    <td class="num">${fmtSec(a.처리)}</td>
  </tr>`;
}

function rowCallGroup(squad, a, b, rateA, rateB, activeA, activeB, namesA, expanded) {
  const fmtActive = n => (n == null || isNaN(n)) ? '-'
    : (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(1));
  const namesLine = (namesA && namesA.length)
    ? `<br><span style="font-size:.8em;color:var(--muted);font-weight:400">${namesA.join(', ')}</span>`
    : '';
  const caret = `<span class="caret">${expanded ? '▼' : '▶'}</span>`;
  const label = `${caret} <span class="chip ${SQUAD_CHIP[squad]||''}">${squad}</span>`;
  return `<tr class="squad-row${expanded ? ' expanded' : ''}" data-squad="${squad}">
    <td>${label}</td>
    <td class="num">${fmtActive(activeA)}${namesLine}</td>
    <td class="num">${fmtNum(a.수신연결)} ${fmtDelta(delta(a.수신연결, b.수신연결))}</td>
    <td class="num">${fmtPct(rateA)} ${fmtDelta(deltaPp(rateA, rateB), true)}</td>
    <td class="num">${fmtSec(a.평균통화)}</td>
    <td class="num">${fmtNum(a.발신연결)}</td>
  </tr>`;
}

// 스쿼드 토글 — panel 내부 squad-row 클릭 → expandedSquads 토글 + 재렌더
function bindSquadToggle(panel) {
  setTimeout(() => {
    panel.querySelectorAll('tr.squad-row').forEach(tr => {
      tr.style.cursor = 'pointer';
      tr.onclick = () => {
        const s = tr.dataset.squad;
        if (!s) return;
        if (state.expandedSquads.has(s)) state.expandedSquads.delete(s);
        else state.expandedSquads.add(s);
        render();
      };
    });
  }, 0);
}

// 스쿼드 펼침 sub-rows — 채팅 (해당 스쿼드 상담사별)
function rowsChatAgentsInSquad(allRows, A, B, squad) {
  const agentsA = {}, agentsB = {};
  for (const r of allRows) {
    if (r.squad !== squad) continue;
    if (!r.agent) continue;
    if (inRange(r.date, A)) {
      if (!agentsA[r.agent]) agentsA[r.agent] = [];
      agentsA[r.agent].push(r);
    }
    if (inRange(r.date, B)) {
      if (!agentsB[r.agent]) agentsB[r.agent] = [];
      agentsB[r.agent].push(r);
    }
  }
  const names = Array.from(new Set([...Object.keys(agentsA), ...Object.keys(agentsB)]));
  names.sort((x, y) => (agentsA[y]?.length || 0) - (agentsA[x]?.length || 0));
  return names.map(name => {
    const aR = agentsA[name] || [], bR = agentsB[name] || [];
    const cntA = aR.length, cntB = bR.length;
    const fA = median(aR.map(r => r.fw));
    const arA = median(aR.map(r => r.ar));
    const rA = median(aR.map(r => r.res));
    const active = cntA >= CHAT_ACTIVE_THRESHOLD;
    const badge = active ? ' <span class="badge-active">●활성</span>' : '';
    return `<tr class="sub-row">
      <td class="sub-name">↳ ${name}${badge}</td>
      <td class="num">${fmtNum(cntA)} ${fmtDelta(delta(cntA, cntB))}</td>
      <td class="num">-</td>
      <td class="num">-</td>
      <td class="num">${fmtSec(fA)}</td>
      <td class="num">${fmtSec(arA)}</td>
      <td class="num">${fmtSec(rA)}</td>
    </tr>`;
  });
}

// 스쿼드 펼침 sub-rows — 콜 (해당 스쿼드 상담사별)
function rowsCallAgentsInSquad(allRows, A, B, squad, stdA) {
  const a = {}, b = {};
  for (const r of allRows) {
    if (r.squad !== squad) continue;
    if (!r.agent) continue;
    if (inRange(r.date, A)) { if (!a[r.agent]) a[r.agent] = []; a[r.agent].push(r); }
    if (inRange(r.date, B)) { if (!b[r.agent]) b[r.agent] = []; b[r.agent].push(r); }
  }
  const names = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
  names.sort((x, y) => sum(a[y] || [], '수신연결') - sum(a[x] || [], '수신연결'));
  return names.map(name => {
    const aR = a[name] || [], bR = b[name] || [];
    const aCnt = sum(aR, '수신연결'), bCnt = sum(bR, '수신연결');
    const tot = sum(aR, '총통화_초');
    const avg = aCnt ? (tot / aCnt) : null;
    const outConn = sum(aR, '발신연결');
    const active = aCnt >= CALL_ACTIVE_THRESHOLD;
    const badge = active ? ' <span class="badge-active">●활성</span>' : '';
    const rate = (active && stdA) ? (aCnt / stdA * 100) : null;
    return `<tr class="sub-row">
      <td class="sub-name">↳ ${name}${badge}</td>
      <td class="num">-</td>
      <td class="num">${fmtNum(aCnt)} ${fmtDelta(delta(aCnt, bCnt))}</td>
      <td class="num">${fmtPct(rate)}</td>
      <td class="num">${fmtSec(avg)}</td>
      <td class="num">${fmtNum(outConn)}</td>
    </tr>`;
  });
}

function collectCallAgentRows(allRows, A, B, stdA) {
  const a = {}, b = {}, squadOf = {};
  for (const r of allRows) {
    const ia = inRange(r.date, A), ib = inRange(r.date, B);
    if (!ia && !ib) continue;
    squadOf[r.agent] = r.squad || '기타';
    if (ia) { if (!a[r.agent]) a[r.agent] = []; a[r.agent].push(r); }
    if (ib) { if (!b[r.agent]) b[r.agent] = []; b[r.agent].push(r); }
  }
  const names = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
  names.sort((x, y) => sum(a[y] || [], '수신연결') - sum(a[x] || [], '수신연결'));
  const rows = [];
  for (const name of names) {
    const aR = a[name] || [], bR = b[name] || [];
    const aCnt = sum(aR, '수신연결'), bCnt = sum(bR, '수신연결');
    const tot = sum(aR, '총통화_초');
    const avg = aCnt ? (tot / aCnt) : null;
    // 활성 배지 — 1번 기간 누적 수신연결 ≥ THRESHOLD
    const active = aCnt >= CALL_ACTIVE_THRESHOLD;
    const badge = active ? ' <span class="badge-active">●활성</span>' : '';
    // 개인 응답률 — 활성자만 (비활성자는 콜 포지션 아니라 의미 없음)
    const rate = (active && stdA) ? (aCnt / stdA * 100) : null;
    rows.push(`<tr>
      <td>${name}${badge}</td>
      <td><span class="chip ${SQUAD_CHIP[squadOf[name]]||''}">${squadOf[name]||'기타'}</span></td>
      <td class="num">${fmtNum(aCnt)}</td>
      <td class="num">${fmtNum(bCnt)}</td>
      <td class="num">${fmtDelta(delta(aCnt, bCnt))}</td>
      <td class="num">${fmtPct(rate)}</td>
      <td class="num">${fmtSec(avg)}</td>
    </tr>`);
  }
  return rows;
}

// 상담사 드롭다운
function agentSelector(type) {
  const div = document.createElement('div');
  div.className = 'panel';
  const agents = state.data.agents || [];
  const opts = ['<option value="">전체 (표)</option>',
    ...agents.map(a => `<option value="${a}"${state.agent === a ? ' selected' : ''}>${a}</option>`)];
  div.innerHTML = `<label style="display:flex;gap:10px;align-items:center;">
    <span style="font-weight:600">상담사 선택:</span>
    <select id="agent-select" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;font:inherit;min-width:160px;">${opts.join('')}</select>
    ${state.agent ? '<span class="chip" style="margin-left:8px;">개인 상세 보기</span>' : ''}
  </label>`;
  setTimeout(() => {
    const sel = document.getElementById('agent-select');
    if (sel) sel.onchange = e => { state.agent = e.target.value || null; render(); };
  }, 0);
  return div;
}

// 일자별 표 — 채팅 전체
function dailyChatTable(rows, A, B) {
  const inA = rows.filter(r => inRange(r.date, A));
  inA.sort((x, y) => x.date.localeCompare(y.date));
  const html = inA.map(r => {
    const f = r['첫응대_n'] ? r['첫응대_sum'] / r['첫응대_n'] : null;
    const a = r['응답_n'] ? r['응답_sum'] / r['응답_n'] : null;
    const p = r['처리_n'] ? r['처리_sum'] / r['처리_n'] : null;
    return `<tr>
      <td>${fmtDateShort(r.date)}</td>
      <td class="num">${fmtNum(r['응대'])}</td>
      <td class="num">${fmtSec(f)}</td>
      <td class="num">${fmtSec(a)}</td>
      <td class="num">${fmtSec(p)}</td>
    </tr>`;
  });
  return tablePanel(`${periodLabelKo(A)} — 일자별 채팅 (팀 전체, 시간=평균)`,
    ['일자', '응대', '첫응대', '응답', '처리'], html);
}

// 일자별 표 — 콜 전체
function dailyCallTable(rows, A, B) {
  const inA = rows.filter(r => inRange(r.date, A));
  inA.sort((x, y) => x.date.localeCompare(y.date));
  const html = inA.map(r => `<tr>
    <td>${fmtDateShort(r.date)}</td>
    <td class="num">${fmtNum(r['총인입'])}</td>
    <td class="num">${fmtNum(r['연결시도'])}</td>
    <td class="num">${fmtNum(r['연결성공'])}</td>
    <td class="num">${fmtNum(r['연결포기'])}</td>
    <td class="num">${fmtPct(r['성공률_퍼센트'])}</td>
    <td class="num">${fmtSec(r['평균대기_초'])}</td>
    <td class="num">${fmtSec(r['평균통화_초'])}</td>
  </tr>`);
  return tablePanel(`${periodLabelKo(A)} — 일자별 콜 (팀 전체)`,
    ['일자', '총인입', '연결시도', '연결성공', '연결포기', '성공률', '평균대기', '평균통화'], html);
}

// 상담사별 일별 추이
function aggAgentChatTrend(rows, A, B, agent) {
  const minD = A.start < B.start ? A.start : B.start;
  const maxD = A.end > B.end ? A.end : B.end;
  const byDate = {};
  for (const r of rows) {
    if (r.agent !== agent) continue;
    if (r.date < minD || r.date > maxD) continue;
    byDate[r.date] = (byDate[r.date] || 0) + 1;
  }
  return Object.keys(byDate).sort().map(d => ({ date: d, 응대: byDate[d] }));
}

// === 민원 탭 (complaint) — 주차별 카테고리 → 파이 2종 ===
function renderComplaint(main) {
  const rows = (state.data.complaint) || [];
  const A = state.periodA, B = state.periodB;
  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = "민원 데이터 없음 — 시트 '2026년 민원데이터' 비어있거나 권한 없음.";
    main.appendChild(e);
    return;
  }
  const aggA = aggComplaint(rows, A);
  const aggB = aggComplaint(rows, B);
  const totA = sumObj(aggA.type), totB = sumObj(aggB.type);

  main.appendChild(notePanel(
    `📌 민원은 <strong>작성날짜 기준</strong>으로 집계됩니다 (소스: cx-민원공유 raw). ` +
    `1번 기간: <strong>${aggA.dayCount}일</strong> / 2번 기간: <strong>${aggB.dayCount}일</strong> 매칭.`));

  main.appendChild(makeCardGrid([
    { label: '민원 총건수 (1번)', value: fmtNum(totA), prev: fmtNum(totB), d: delta(totA, totB) },
    { label: '주요 유형 (1번)', value: topKey(aggA.type), prev: topKey(aggB.type), d: null },
    { label: '주요 보상 (1번)', value: topKey(aggA.reward), prev: topKey(aggB.reward), d: null },
  ]));

  // 파이 2종 — 한 줄에 나란히
  const wrap = document.createElement('div');
  wrap.className = 'pie-wrap';
  wrap.innerHTML = `
    <div class="panel" style="flex:1;min-width:380px;">
      <h2>1번 기간 — 민원유형 분포</h2>
      <div class="chart-wrap" style="height:340px;"><canvas id="pie-type"></canvas></div>
    </div>
    <div class="panel" style="flex:1;min-width:380px;">
      <h2>1번 기간 — 보상 진행 분포</h2>
      <div class="chart-wrap" style="height:340px;"><canvas id="pie-reward"></canvas></div>
    </div>`;
  main.appendChild(wrap);
  setTimeout(() => {
    drawPie('pie-type', aggA.type, 'complaintTypeChart');
    drawPie('pie-reward', aggA.reward, 'complaintRewardChart');
  }, 0);

  // 카테고리별 비교 표 (1번 vs 2번)
  main.appendChild(complaintTable('민원유형 비교', aggA.type, aggB.type));
  main.appendChild(complaintTable('보상 진행 비교', aggA.reward, aggB.reward));
}

function aggComplaint(rows, p) {
  const type = {}, reward = {};
  const days = new Set();
  for (const r of rows) {
    if (!inRange(r.date, p)) continue;
    days.add(r.date);
    const tgt = r.kind === 'reward' ? reward : type;
    tgt[r.category] = (tgt[r.category] || 0) + (r.count || 0);
  }
  return { type, reward, dayCount: days.size };
}

function sumObj(o) { return Object.values(o).reduce((s, v) => s + v, 0); }
function topKey(o) {
  const k = Object.keys(o).sort((x, y) => o[y] - o[x])[0];
  if (!k) return '-';
  const total = sumObj(o);
  const pct = total > 0 ? (o[k] / total * 100).toFixed(1) : '0.0';
  return `${k} (${o[k]}건 · ${pct}%)`;
}

const PIE_COLORS = [
  '#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#a855f7', '#3b82f6',
  '#eab308', '#22d3ee',
];

function drawPie(canvasId, dataObj, chartVar) {
  const entries = Object.entries(dataObj).sort((a, b) => b[1] - a[1]);
  const labels = entries.map(e => e[0]);
  const data = entries.map(e => e[1]);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (window[chartVar]) window[chartVar].destroy();
  window[chartVar] = new Chart(ctx, {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data, backgroundColor: PIE_COLORS, borderWidth: 1, borderColor: '#fff' }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const total = c.dataset.data.reduce((s, v) => s + v, 0);
              const pct = total ? (c.parsed / total * 100).toFixed(1) : 0;
              return `${c.label}: ${c.parsed}건 (${pct}%)`;
            },
          },
        },
        datalabels: {
          color: '#fff',
          font: { weight: 'bold', size: 12 },
          textStrokeColor: 'rgba(0,0,0,0.5)',
          textStrokeWidth: 3,
          textShadowBlur: 4,
          textShadowColor: 'rgba(0,0,0,0.4)',
          formatter: (value, ctx) => {
            const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
            const pct = total > 0 ? (value / total * 100) : 0;
            // 5% 미만은 라벨 겹침 방지로 숨김
            if (pct < 5) return '';
            return `${value}건\n${pct.toFixed(1)}%`;
          },
          textAlign: 'center',
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}

function complaintTable(title, aMap, bMap) {
  const keys = Array.from(new Set([...Object.keys(aMap), ...Object.keys(bMap)]));
  keys.sort((x, y) => (aMap[y] || 0) - (aMap[x] || 0));
  const totA = sumObj(aMap), totB = sumObj(bMap);
  const html = keys.map(k => {
    const av = aMap[k] || 0, bv = bMap[k] || 0;
    return `<tr>
      <td>${k}</td>
      <td class="num">${fmtCntPct(av, totA)}</td>
      <td class="num">${fmtCntPct(bv, totB)}</td>
      <td class="num">${fmtDelta(delta(av, bv))}</td>
    </tr>`;
  });
  return tablePanel(title, ['카테고리', '1번 기간', '2번 기간', '변화'], html);
}

// === VOC 상위탭 (vocstat) — 채널 토글 + 통합 표 ===
function renderVoc(main) {
  const voc = state.data.voc || { chat: [], call: [] };
  const A = state.periodA, B = state.periodB;

  // 채널 토글
  main.appendChild(vocChannelToggle());

  // 데이터셋 선택
  let rows;
  if (state.vocChannel === 'chat') rows = voc.chat;
  else if (state.vocChannel === 'call') rows = voc.call;
  else rows = [...voc.chat, ...voc.call];  // 전체 = 합산

  // (cat1, cat2) 키별 1·2번 기간 카운트
  const aggA = aggVoc(rows, A);
  const aggB = aggVoc(rows, B);
  const keys = Array.from(new Set([...Object.keys(aggA), ...Object.keys(aggB)]));
  keys.sort((x, y) => (aggA[y] || 0) - (aggA[x] || 0));

  const totalA = Object.values(aggA).reduce((s, v) => s + v, 0);
  const totalB = Object.values(aggB).reduce((s, v) => s + v, 0);
  const topName = keys[0] ? keys[0].split('​').join(' > ') : null;
  const topCnt = topName ? aggA[keys[0]] : 0;
  const topPct = totalA > 0 ? (topCnt / totalA * 100).toFixed(1) : '0.0';
  const topLabel = topName ? `${topName} (${topCnt}건 · ${topPct}%)` : '-';

  const chLabel = state.vocChannel === 'chat' ? '채팅' :
                  state.vocChannel === 'call' ? '콜' : '전체';

  // 카드
  main.appendChild(makeCardGrid([
    { label: `VOC 총건수 (${chLabel})`, value: fmtNum(totalA), prev: fmtNum(totalB), d: delta(totalA, totalB) },
    { label: '상위 카테고리', value: topLabel, prev: '', d: null },
  ]));

  // 표 — 위클리 리포트 형식 (순위 | 대 | 중 | 1번 (건수%) | 2번 (건수%) | 변화%)
  const rowsHtml = keys.slice(0, 30).map((k, i) => {
    const [c1, c2] = k.split('​');
    const av = aggA[k] || 0, bv = aggB[k] || 0;
    return `<tr>
      <td class="num">${i + 1}</td>
      <td>${c1}</td>
      <td>${c2}</td>
      <td class="num">${fmtCntPct(av, totalA)}</td>
      <td class="num">${fmtCntPct(bv, totalB)}</td>
      <td class="num">${fmtDelta(delta(av, bv))}</td>
    </tr>`;
  });
  main.appendChild(tablePanel(
    `VOC 상위 30 — ${chLabel} (1번 기간 기준 정렬)`,
    ['순위', '대분류', '중분류', '1번 기간', '2번 기간', '변화'],
    rowsHtml,
  ));
}

function aggVoc(rows, p) {
  const out = {};
  for (const r of rows) {
    if (!inRange(r.date, p)) continue;
    const k = r.cat1 + '​' + r.cat2;  // zero-width separator
    out[k] = (out[k] || 0) + (r.count || 0);
  }
  return out;
}

function vocChannelToggle() {
  const div = document.createElement('div');
  div.className = 'panel';
  const opts = [
    ['all', '전체 (채팅+콜)'],
    ['chat', '채팅만'],
    ['call', '콜만'],
  ];
  div.innerHTML = `<div class="tab-group">${
    opts.map(([k, l]) => `<button class="tab${state.vocChannel === k ? ' active' : ''}" data-ch="${k}">${l}</button>`).join('')
  }</div>`;
  setTimeout(() => {
    div.querySelectorAll('button[data-ch]').forEach(b => {
      b.onclick = () => { state.vocChannel = b.dataset.ch; render(); };
    });
  }, 0);
  return div;
}

// VOC 패널 (단독 서브탭 — chat>VOC, 옛 voc_by_date용 호환)
function vocPanel(rows, A, B, topN = 30) {
  const a = {}, b = {};
  for (const r of rows) {
    if (inRange(r.date, A)) a[r.voc] = (a[r.voc] || 0) + r.count;
    if (inRange(r.date, B)) b[r.voc] = (b[r.voc] || 0) + r.count;
  }
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  keys.sort((x, y) => (a[y] || 0) - (a[x] || 0));
  const sliced = keys.slice(0, topN);
  const html = sliced.map(k => {
    const av = a[k] || 0, bv = b[k] || 0;
    return `<tr>
      <td>${k}</td>
      <td class="num">${fmtNum(av)}</td>
      <td class="num">${fmtNum(bv)}</td>
      <td class="num">${fmtDelta(delta(av, bv))}</td>
    </tr>`;
  });
  return tablePanel(`VOC 상위 ${topN} (1번 기간 기준)`,
    ['VOC 태그', '1번 기간', '2번 기간', '변화'], html);
}

// 응답률 일별 라인 — hover시 그날 응답률만 표시
function respRatePanel(rows, A, B) {
  const div = document.createElement('div');
  div.className = 'panel';
  div.innerHTML = `<h2>콜 일별 응답률</h2><div class="chart-wrap"><canvas id="resp-rate"></canvas></div>`;
  setTimeout(() => drawRespRate(rows, A, B), 0);
  return div;
}

function drawRespRate(rows, A, B) {
  const inA = rows.filter(r => inRange(r.date, A))
    .sort((x, y) => x.date.localeCompare(y.date));
  const labels = inA.map(r => fmtDateShort(r.date));
  const inH = inA.map(r => r['총인입'] || 0);
  const ans = inA.map(r => r['연결성공'] || 0);
  const rate = inA.map(r => r['연결시도'] ? (r['연결성공'] / r['연결시도'] * 100) : null);

  if (respRateChart) respRateChart.destroy();
  const ctx = document.getElementById('resp-rate');
  if (!ctx) return;
  respRateChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: '인입호', data: inH, backgroundColor: '#4f46e5', yAxisID: 'y' },
        { type: 'bar', label: '응대호', data: ans, backgroundColor: '#5eead4', yAxisID: 'y' },
        { type: 'line', label: '응답률', data: rate, borderColor: '#f97316', backgroundColor: '#f97316',
          yAxisID: 'y1', tension: 0.25, pointRadius: 4, borderWidth: 2 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          filter: (ctx) => ctx.dataset.label === '응답률',
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              return `응답률: ${v == null ? '-' : v.toFixed(1) + '%'}`;
            },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: '건수' } },
        y1: { beginAtZero: true, max: 100, position: 'right', grid: { drawOnChartArea: false },
              ticks: { callback: v => v + '%' }, title: { display: true, text: '응답률' } },
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
      },
    },
  });
}

// 추이 차트 (라인)
function trendPanel(rows, title, metrics, A, B) {
  const div = document.createElement('div');
  div.className = 'panel';
  div.innerHTML = `<h2>${title}</h2><div class="chart-wrap"><canvas id="trend"></canvas></div>`;
  setTimeout(() => drawTrend(rows, metrics, A, B), 0);
  return div;
}

function drawTrend(rows, metrics, A, B) {
  const minD = (A.start < B.start ? A.start : B.start);
  const maxD = (A.end > B.end ? A.end : B.end);
  const dates = rows.filter(r => r.date >= minD && r.date <= maxD)
    .map(r => r.date).sort();
  const ds = [...new Set(dates)];

  const colorA = '#4f46e5', colorB = '#94a3b8';
  const datasets = [];
  for (const m of metrics) {
    datasets.push({
      label: m,
      data: ds.map(d => {
        const r = rows.find(x => x.date === d);
        return r ? (r[m] || 0) : 0;
      }),
      borderColor: m === '인입' ? colorA : colorB,
      backgroundColor: m === '인입' ? colorA : colorB,
      borderWidth: 2,
      tension: 0.25,
      pointRadius: 3,
    });
  }
  if (trendChart) trendChart.destroy();
  const ctx = document.getElementById('trend');
  if (!ctx) return;
  trendChart = new Chart(ctx, {
    type: 'line',
    data: { labels: ds.map(fmtDateShort), datasets },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
      },
    },
  });
}

// ── 지표(인사이트) 패널 ────────────────────────────────────────
// 모든 view 상단에 토글 버튼 + KPI 카드 + (스쿼드별/상담사별일 때) 일자별 매트릭스

function insightsToggle() {
  const div = document.createElement('div');
  div.className = 'insights-toggle';
  const open = state.showInsights;
  div.innerHTML = `<button class="ins-btn${open ? ' active' : ''}">${open ? '🚀 지표 숨기기' : '🚀 지표 보기'}</button>`;
  setTimeout(() => {
    div.querySelector('button').onclick = () => {
      state.showInsights = !state.showInsights;
      render();
    };
  }, 0);
  return div;
}

// 스쿼드 필터 버튼 그룹 — 인사이트 패널 안에 표시 (squad/agent view용)
function insightsSquadTabs() {
  const div = document.createElement('div');
  div.className = 'ins-squad-tabs';
  const opts = [['all', '전체'], ['CX 1', 'CX 1'], ['CX 2', 'CX 2'], ['교육', '교육']];
  div.innerHTML = opts.map(([k, l]) =>
    `<button class="ins-sqbtn${state.insightSquad === k ? ' active' : ''}" data-sq="${k}">${l}</button>`
  ).join('');
  setTimeout(() => {
    div.querySelectorAll('button[data-sq]').forEach(b => {
      b.onclick = () => {
        state.insightSquad = b.dataset.sq;
        render();
      };
    });
  }, 0);
  return div;
}

// 자료별 KPI 패널 — type×view×데이터로 분기. squad 필터 ('all'|'CX 1'...)
function insightsPanel(type, view, A) {
  const d = state.data;
  const wrap = document.createElement('div');
  wrap.className = 'insights-panel';
  const sq = state.insightSquad || 'all';
  const isSquadOnly = sq !== 'all';
  const sqLabel = isSquadOnly ? sq : '';

  let title = '';
  const lines = [];   // [{html, status}]

  // 기간 일수
  const dayCount = (() => {
    if (!A.start || !A.end) return 0;
    const s = new Date(A.start), e = new Date(A.end);
    return Math.round((e - s) / 86400000) + 1;
  })();
  const single = dayCount === 1;          // 단일일 선택
  const periodTerm = single ? '당일' : '기간';
  const periodLabel = periodLabelKo(A);

  // 스쿼드 탭 (squad/agent view에서만 표시)
  if (view === 'squad' || view === 'agent') {
    wrap.appendChild(insightsSquadTabs());
  }

  if (type === 'chat') {
    const teamA = aggChatTeam(d.chat.by_date, A);
    if (view === 'all') {
      title = '채팅 전체 지표';
      lines.push({ html: `${periodTerm} 총 응대 건수: <b>${fmtNum(teamA.응대)}</b> (${periodLabel})` });
      lines.push({ html: `${single ? '' : '평균 '}첫응대 / 응답 / 처리 (팀${single ? '' : ' 평균'}): <b>${fmtSec(teamA.첫응대)}</b> / <b>${fmtSec(teamA.응답)}</b> / <b>${fmtSec(teamA.처리)}</b>` });
      // 가장 바쁜 날은 여러 날 선택 시에만 의미 있음 (단일일 제외)
      if (!single) {
        const inA = d.chat.by_date.filter(r => inRange(r.date, A));
        if (inA.length) {
          const busiest = inA.reduce((m, r) => (r['응대'] || 0) > (m['응대'] || 0) ? r : m, inA[0]);
          lines.push({ html: `가장 바쁜 날: <b>${fmtDateKo(busiest.date)}</b> (${fmtNum(busiest['응대'])}건)` });
        }
      }
    } else if (view === 'squad') {
      title = isSquadOnly ? `${sqLabel} 채팅 지표` : '스쿼드별 채팅 지표';
      if (isSquadOnly) {
        const m = aggChatAgent(d.chat.agent_chats, A, { squad: sq });
        const active = countActiveAvgChat(d.chat.agent_chats, A, { squad: sq });
        const throughput = active ? (m.응대 / active) : null;
        lines.push({ html: `<b>${sqLabel}</b> ${periodTerm} 총 응대: <b>${fmtNum(m.응대)}</b>건 (${periodLabel})` });
        lines.push({ html: `활성 상담사 평균: <b>${active ? active.toFixed(1) : '0'}명</b>/일 · 처리량: <b>${throughput == null ? '-' : throughput.toFixed(1)}</b>건/명` });
        lines.push({ html: `시간 지표 (중앙값) — 첫응대: <b>${fmtSec(m.첫응대)}</b> · 응답: <b>${fmtSec(m.응답)}</b> · 처리: <b>${fmtSec(m.처리)}</b>` });
        // 상담사별 편차 — 활성자(태그 ≥THRESHOLD/일 누적)만
        const inSq = collectAgentChatCounts(d.chat.agent_chats, A)
          .filter(r => r.squad === sq && r.cnt >= CHAT_ACTIVE_THRESHOLD);
        if (inSq.length >= 2) {
          inSq.sort((a, b) => b.cnt - a.cnt);
          const top = inSq[0], bot = inSq[inSq.length - 1];
          const diff = top.cnt - bot.cnt;
          lines.push({ html: `최상위 <b class="ins-good">${top.name} ${fmtNum(top.cnt)}건</b> ↔ 최하위 <b class="ins-warn">${bot.name} ${fmtNum(bot.cnt)}건</b> (편차 <b>${fmtNum(diff)}건</b>)` });
        }
      } else {
        const rows = squadAggChatRows(A);
        const total = rows.reduce((s, r) => s + r.응대, 0);
        lines.push({ html: `${periodTerm} 총 응대 건수: <b>${fmtNum(total)}</b> (${periodLabel})` });
        if (rows.length) {
          const top = rows[0], bot = rows[rows.length - 1];
          const topPct = total ? (top.응대 / total * 100) : 0;
          lines.push({ html: `스쿼드별 처리량 (응대÷활성 N명): <b class="ins-good">${top.squad} ${top.throughput == null ? '-' : top.throughput.toFixed(1)}</b> ↔ <b class="ins-warn">${bot.squad} ${bot.throughput == null ? '-' : bot.throughput.toFixed(1)}</b>` });
          lines.push({ html: `상위 스쿼드 비중: <b>${top.squad} ${topPct.toFixed(1)}%</b>` });
        }
      }
    } else if (view === 'agent') {
      title = isSquadOnly ? `${sqLabel} 상담사 지표` : '상담사별 채팅 지표';
      let agentsA = collectAgentChatCounts(d.chat.agent_chats, A);
      if (isSquadOnly) agentsA = agentsA.filter(r => r.squad === sq);
      const total = agentsA.reduce((s, r) => s + r.cnt, 0);
      const active = agentsA.filter(r => r.cnt >= CHAT_ACTIVE_THRESHOLD);
      lines.push({ html: `${isSquadOnly ? `<b>${sqLabel}</b> ` : ''}${periodTerm} 총 응대: <b>${fmtNum(total)}</b> (${periodLabel}) · 활성 상담사(≥${CHAT_ACTIVE_THRESHOLD}/일 누적) <b>${active.length}명</b>` });
      // 상담사별 편차 — 활성자만
      if (active.length >= 2) {
        const sorted = [...active].sort((a, b) => b.cnt - a.cnt);
        const top = sorted[0], bot = sorted[sorted.length - 1];
        const diff = top.cnt - bot.cnt;
        lines.push({
          html: `최상위 <b class="ins-good">${top.name} ${fmtNum(top.cnt)}건</b> ↔ 최하위 <b class="ins-warn">${bot.name} ${fmtNum(bot.cnt)}건</b> (편차 <b>${fmtNum(diff)}건</b>)`,
          status: diff > top.cnt * 0.5 ? 'warn' : 'good',
        });
      }
    }
  } else if (type === 'call') {
    if (view === 'all') {
      title = '콜 전체 지표';
      const t = aggCallTeam(d.call.team_by_date, A);
      lines.push({ html: `${periodTerm} 총 인입: <b>${fmtNum(t.총인입)}</b> / 총 연결시도: <b>${fmtNum(t.연결시도)}</b> / 응대(연결성공): <b>${fmtNum(t.연결성공)}</b> (${periodLabel})` });
      lines.push({ html: `평균 응답률: <b class="${rateColorClass(t.응답률)}">${fmtPct(t.응답률)}</b> ${rateBadge(t.응답률)}`, status: rateStatus(t.응답률) });
      lines.push({ html: `평균 대기: <b>${fmtSec(t.평균대기)}</b> · 평균 통화: <b>${fmtSec(t.평균통화)}</b>` });
      lines.push({ html: `포기 호수: <b class="ins-warn">${fmtNum(t.연결포기)}</b>` });
    } else if (view === 'squad') {
      title = isSquadOnly ? `${sqLabel} 콜 지표` : '스쿼드별 콜 지표';
      const teamSums = aggCallTeam(d.call.team_by_date, A);
      const attemptsA = sumTeamAttempts(d.call.team_by_date, A);
      const totalActiveA = countActiveAvg(d.call.agent_by_date, A);
      const stdA = totalActiveA ? attemptsA / totalActiveA : null;

      if (isSquadOnly) {
        const m = aggCallAgentRow(d.call.agent_by_date, A, { squad: sq });
        const active = countActiveAvg(d.call.agent_by_date, A, { squad: sq });
        const rate = (stdA && active) ? (m.수신연결 / active) / stdA * 100 : null;
        lines.push({ html: `${periodTerm} 총 인입(팀): <b>${fmtNum(teamSums.총인입)}</b> · <b>${sqLabel}</b> 총 수신연결: <b>${fmtNum(m.수신연결)}</b> (${periodLabel})` });
        lines.push({ html: `<b>${sqLabel}</b> 평균 응답률: <b class="${rateColorClass(rate)}">${fmtPct(rate)}</b> ${rateBadge(rate)}`, status: rateStatus(rate) });
        lines.push({ html: `활성 상담사 평균: <b>${active ? active.toFixed(1) : '0'}명</b>/일 · 평균통화: <b>${fmtSec(m.평균통화)}</b> · 발신연결: <b>${fmtNum(m.발신연결)}</b>` });
        // 상담사별 편차 — 활성자(수신연결 ≥THRESHOLD)만
        const inSq = collectCallAgentDetail(d.call.agent_by_date, A, stdA)
          .filter(r => r.squad === sq && r.active);
        if (inSq.length >= 2) {
          inSq.sort((a, b) => (b.응답률 ?? -1) - (a.응답률 ?? -1));
          const top = inSq[0], bot = inSq[inSq.length - 1];
          if (top.응답률 != null && bot.응답률 != null) {
            const gap = top.응답률 - bot.응답률;
            lines.push({
              html: `최상위 <b class="ins-good">${top.name} ${top.응답률.toFixed(1)}%</b> ↔ 최하위 <b class="ins-warn">${bot.name} ${bot.응답률.toFixed(1)}%</b> (편차 <b>${gap.toFixed(1)}%p</b>) ${gap > 15 ? '⚠️' : ''}`,
              status: gap > 15 ? 'warn' : 'good',
            });
          }
        }
      } else {
        const squads = squadAggCallRows(A, stdA);
        lines.push({ html: `${periodTerm} 총 인입: <b>${fmtNum(teamSums.총인입)}</b> · 총 수신연결: <b>${fmtNum(teamSums.연결성공)}</b> (${periodLabel})` });
        if (squads.length) {
          const validRates = squads.filter(s => s.응답률 != null).map(s => s.응답률);
          const avgRate = validRates.length ? validRates.reduce((a, b) => a + b, 0) / validRates.length : null;
          lines.push({ html: `스쿼드 평균 응답률: <b class="${rateColorClass(avgRate)}">${fmtPct(avgRate)}</b> ${rateBadge(avgRate)}`, status: rateStatus(avgRate) });
          squads.sort((a, b) => (b.응답률 ?? -1) - (a.응답률 ?? -1));
          const top = squads[0], bot = squads[squads.length - 1];
          if (top.응답률 != null && bot.응답률 != null) {
            const gap = top.응답률 - bot.응답률;
            lines.push({
              html: `상위/하위 스쿼드 편차: <b>${gap.toFixed(1)}%p</b> ${gap > 10 ? '⚠️' : ''} (<b class="ins-good">${top.squad} ${top.응답률.toFixed(1)}%</b> ↔ <b class="ins-warn">${bot.squad} ${bot.응답률.toFixed(1)}%</b>)`,
              status: gap > 10 ? 'warn' : 'good',
            });
          }
        }
      }
    } else if (view === 'agent') {
      title = isSquadOnly ? `${sqLabel} 상담사 지표` : '상담사별 콜 지표';
      const t = aggCallTeam(d.call.team_by_date, A);
      const attemptsA = sumTeamAttempts(d.call.team_by_date, A);
      const totalActiveA = countActiveAvg(d.call.agent_by_date, A);
      const stdA = totalActiveA ? attemptsA / totalActiveA : null;
      const sqActive = isSquadOnly ? countActiveAvg(d.call.agent_by_date, A, { squad: sq }) : totalActiveA;
      lines.push({ html: `${isSquadOnly ? `<b>${sqLabel}</b> ` : ''}${periodTerm} 총 인입: <b>${fmtNum(t.총인입)}</b> · 총 수신연결: <b>${fmtNum(t.연결성공)}</b> · 활성 상담사 평균 <b>${sqActive.toFixed(1)}명</b>/일` });
      if (stdA) lines.push({ html: `1인당 표준 시도: <b>${stdA.toFixed(1)}건</b>` });
      // 상담사별 편차 — 활성자(수신연결 ≥THRESHOLD)만
      let rows = collectCallAgentDetail(d.call.agent_by_date, A, stdA);
      if (isSquadOnly) rows = rows.filter(r => r.squad === sq);
      const active = rows.filter(r => r.active);
      if (active.length >= 2) {
        active.sort((a, b) => (b.응답률 ?? -1) - (a.응답률 ?? -1));
        const top = active[0], bot = active[active.length - 1];
        if (top.응답률 != null && bot.응답률 != null) {
          const gap = top.응답률 - bot.응답률;
          lines.push({
            html: `최상위 <b class="ins-good">${top.name} ${top.응답률.toFixed(1)}%</b> ↔ 최하위 <b class="ins-warn">${bot.name} ${bot.응답률.toFixed(1)}%</b> (편차 <b>${gap.toFixed(1)}%p</b>) ${gap > 15 ? '⚠️' : ''}`,
            status: gap > 15 ? 'warn' : 'good',
          });
        }
      }
    }
  } else if (type === 'vocstat') {
    title = 'VOC 지표';
    const voc = d.voc || { chat: [], call: [] };
    let rows;
    if (state.vocChannel === 'chat') rows = voc.chat;
    else if (state.vocChannel === 'call') rows = voc.call;
    else rows = [...voc.chat, ...voc.call];
    const agg = aggVoc(rows, A);
    const total = Object.values(agg).reduce((s, v) => s + v, 0);
    const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
    const chatCnt = Object.values(aggVoc(voc.chat, A)).reduce((s, v) => s + v, 0);
    const callCnt = Object.values(aggVoc(voc.call, A)).reduce((s, v) => s + v, 0);
    lines.push({ html: `${periodTerm} 총 VOC: <b>${fmtNum(total)}</b>건 (${periodLabel})` });
    lines.push({ html: `채널 비중: 채팅 <b>${fmtNum(chatCnt)}</b> / 콜 <b>${fmtNum(callCnt)}</b>` });
    if (sorted.length) {
      const [topKey, topCnt] = sorted[0];
      const [c1, c2] = topKey.split('​');
      const pct = total ? (topCnt / total * 100) : 0;
      lines.push({ html: `상위 카테고리: <b class="ins-good">${c1} > ${c2}</b> ${topCnt}건 (${pct.toFixed(1)}%)` });
      if (sorted.length > 1) {
        const [k2, c2cnt] = sorted[1];
        const [c1b, c2b] = k2.split('​');
        const pct2 = total ? (c2cnt / total * 100) : 0;
        lines.push({ html: `2위: ${c1b} > ${c2b} ${c2cnt}건 (${pct2.toFixed(1)}%)` });
      }
    }
  } else if (type === 'complaint') {
    title = '민원 지표';
    const rows = (d.complaint) || [];
    const agg = aggComplaint(rows, A);
    const totType = sumObj(agg.type);
    if (!rows.length || totType === 0) {
      lines.push({ html: '<i>민원 데이터 없음</i>' });
    } else {
      lines.push({ html: `${periodTerm} 민원 건수: <b>${fmtNum(totType)}</b> · <b>${agg.dayCount}일</b> 매칭` });
      const topT = topKey(agg.type);
      lines.push({ html: `주요 유형: <b class="ins-warn">${topT}</b>` });
      const topR = topKey(agg.reward);
      lines.push({ html: `주요 보상 진행: <b>${topR}</b>` });
    }
  }

  wrap.insertAdjacentHTML('beforeend', `
    <h3>🚀 ${title}${periodLabel ? ` <span style="font-weight:500;color:var(--muted)">· ${periodLabel}</span>` : ''}</h3>
    <ul>${lines.map(l => `<li${l.status ? ` class="ins-${l.status}"` : ''}>${l.html}</li>`).join('')}</ul>
  `);
  return wrap;
}

// 응답률 색상/상태
function rateColorClass(p) {
  if (p == null) return '';
  if (p >= 70) return 'ins-good';
  if (p >= 50) return 'ins-mid';
  return 'ins-warn';
}
function rateBadge(p) {
  if (p == null) return '';
  if (p >= 70) return '🟢';
  if (p >= 50) return '🟡 (권장 기준 50%↑)';
  return '🔴 (개선 필요)';
}
function rateStatus(p) {
  if (p == null) return '';
  if (p >= 70) return 'good';
  if (p >= 50) return 'mid';
  return 'warn';
}

// 스쿼드별 채팅 집계 (지표용)
function squadAggChatRows(A) {
  const d = state.data;
  const out = [];
  for (const s of d.squads) {
    const m = aggChatAgent(d.chat.agent_chats, A, { squad: s });
    if (m.응대 === 0) continue;
    const active = countActiveAvgChat(d.chat.agent_chats, A, { squad: s });
    const throughput = active ? m.응대 / active : null;
    out.push({ squad: s, 응대: m.응대, active, throughput });
  }
  out.sort((a, b) => (b.throughput ?? -1) - (a.throughput ?? -1));
  return out;
}

// 스쿼드별 콜 집계 (지표용)
function squadAggCallRows(A, stdA) {
  const d = state.data;
  const out = [];
  for (const s of d.squads) {
    const m = aggCallAgentRow(d.call.agent_by_date, A, { squad: s });
    if (m.수신연결 === 0) continue;
    const active = countActiveAvg(d.call.agent_by_date, A, { squad: s });
    const rate = (stdA && active) ? (m.수신연결 / active) / stdA * 100 : null;
    out.push({ squad: s, 수신연결: m.수신연결, active, 응답률: rate });
  }
  return out;
}

// 상담사 채팅 응대 카운트 (지표용 — 상위/하위)
function collectAgentChatCounts(rows, A) {
  const cnt = {}, squadOf = {};
  for (const r of rows) {
    if (!inRange(r.date, A)) continue;
    if (!r.agent) continue;
    cnt[r.agent] = (cnt[r.agent] || 0) + 1;
    squadOf[r.agent] = r.squad || '기타';
  }
  return Object.entries(cnt).map(([name, c]) => ({ name, cnt: c, squad: squadOf[name] }));
}

// 상담사 콜 상세 (지표용 — 상위/하위)
function collectCallAgentDetail(rows, A, stdA) {
  const a = {}, squadOf = {};
  for (const r of rows) {
    if (!inRange(r.date, A)) continue;
    if (!r.agent) continue;
    squadOf[r.agent] = r.squad || '기타';
    if (!a[r.agent]) a[r.agent] = 0;
    a[r.agent] += (r['수신연결'] || 0);
  }
  return Object.entries(a).map(([name, cnt]) => {
    const active = cnt >= CALL_ACTIVE_THRESHOLD;
    const rate = (active && stdA) ? (cnt / stdA * 100) : null;
    return { name, 수신연결: cnt, 응답률: rate, active, squad: squadOf[name] };
  });
}

// 스쿼드 개인별 일자 매트릭스 — 상담사 × 일자
// 콜·채팅 통합: 콜 수신 ≥1 → 숫자 / 콜 0+채팅 활성 → "채팅" / 채팅 응대 ≥1 (콜 view 아님) → 숫자 / 둘 다 0 → "-"
function squadAgentMatrix(squad, A, mode /* 'call' | 'chat' */) {
  const d = state.data;
  // 일자 목록 (기간 안 데이터 있는 날)
  const dates = new Set();
  for (const r of d.call.agent_by_date) if (inRange(r.date, A) && (r.squad === squad)) dates.add(r.date);
  for (const r of d.chat.agent_chats) if (inRange(r.date, A) && (r.squad === squad)) dates.add(r.date);
  const dateList = Array.from(dates).sort();
  if (!dateList.length) return null;
  // 상담사 목록
  const agents = new Set();
  for (const r of d.call.agent_by_date) if (inRange(r.date, A) && r.squad === squad && r.agent) agents.add(r.agent);
  for (const r of d.chat.agent_chats) if (inRange(r.date, A) && r.squad === squad && r.agent) agents.add(r.agent);
  const agentList = Array.from(agents).sort();
  // call 수신·chat 응대 카운트
  const callCnt = {}; // 'date|agent' -> 수신
  for (const r of d.call.agent_by_date) {
    if (!inRange(r.date, A)) continue;
    if (r.squad !== squad || !r.agent) continue;
    const k = `${r.date}|${r.agent}`;
    callCnt[k] = (callCnt[k] || 0) + (r['수신연결'] || 0);
  }
  const chatCnt = {};
  for (const r of d.chat.agent_chats) {
    if (!inRange(r.date, A)) continue;
    if (r.squad !== squad || !r.agent) continue;
    const k = `${r.date}|${r.agent}`;
    chatCnt[k] = (chatCnt[k] || 0) + 1;
  }
  // 콜 응답률 분모 — 일자별 1인당 표준시도 = 그날 팀 연결시도 ÷ 그날 전체 활성자 수
  const stdByDate = {};
  if (mode === 'call') {
    const attemptsByDate = {}, activeByDate = {};
    for (const r of d.call.team_by_date) {
      if (inRange(r.date, A)) attemptsByDate[r.date] = (r['연결시도'] || 0);
    }
    for (const r of d.call.agent_by_date) {
      if (!inRange(r.date, A)) continue;
      if ((r['수신연결'] || 0) >= CALL_ACTIVE_THRESHOLD) activeByDate[r.date] = (activeByDate[r.date] || 0) + 1;
    }
    for (const dt of dateList) {
      const at = attemptsByDate[dt] || 0, ac = activeByDate[dt] || 0;
      stdByDate[dt] = ac ? at / ac : null;
    }
  }
  // 응답률은 '퍼포먼스 확인'(single) 모드에서만 병기. 합계 열은 여러 날일 때만.
  const showRate = (mode === 'call') && (state.mode === 'single');
  const showTotal = dateList.length > 1;
  let periodStd = null;   // 기간 누적 1인당 표준시도 (합계 응답률 분모)
  if (showRate) {
    const at = sumTeamAttempts(d.call.team_by_date, A);
    const ac = countActiveAvg(d.call.agent_by_date, A);
    periodStd = ac ? at / ac : null;
  }
  const rateSpan = pct => `<br><span style="font-size:.85em;color:var(--muted);font-weight:400">${pct.toFixed(1)}%</span>`;
  // 표 그리기
  const head = ['상담원명', ...dateList.map(fmtDateShort), ...(showTotal ? ['합계'] : [])]
    .map(h => `<th>${h}</th>`).join('');
  const body = agentList.map(name => {
    const cells = dateList.map(dt => {
      const k = `${dt}|${name}`;
      const cc = callCnt[k] || 0;
      const ch = chatCnt[k] || 0;
      let cell, cls = '';
      if (mode === 'call') {
        if (cc >= 1) {
          cls = cc >= CALL_ACTIVE_THRESHOLD ? 'mx-active' : 'mx-low';
          // 활성 셀엔 응답률 병기 (수신연결 ÷ 그날 표준시도) — 퍼포먼스 확인 모드만
          if (showRate && cc >= CALL_ACTIVE_THRESHOLD && stdByDate[dt]) {
            cell = `${fmtNum(cc)}${rateSpan(cc / stdByDate[dt] * 100)}`;
          } else {
            cell = fmtNum(cc);
          }
        }
        else if (ch >= CHAT_ACTIVE_THRESHOLD) { cell = '채팅'; cls = 'mx-chat'; }
        else cell = '-';
      } else {
        // chat mode
        if (ch >= 1) { cell = fmtNum(ch); cls = ch >= CHAT_ACTIVE_THRESHOLD ? 'mx-active' : 'mx-low'; }
        else if (cc >= CALL_ACTIVE_THRESHOLD) { cell = '콜'; cls = 'mx-chat'; }
        else cell = '-';
      }
      return `<td class="num ${cls}">${cell}</td>`;
    }).join('');
    // 합계 열 — 일별 건수 합 (콜은 활성 시 기간 응답률 병기)
    let totalCell = '';
    if (showTotal) {
      const total = dateList.reduce((s, dt) => s +
        (mode === 'call' ? (callCnt[`${dt}|${name}`] || 0) : (chatCnt[`${dt}|${name}`] || 0)), 0);
      let tc;
      if (showRate && total >= CALL_ACTIVE_THRESHOLD && periodStd) {
        tc = `<b>${fmtNum(total)}</b>${rateSpan(total / periodStd * 100)}`;
      } else {
        tc = `<b>${fmtNum(total)}</b>`;
      }
      totalCell = `<td class="num" style="background:rgba(99,102,241,.06)">${tc}</td>`;
    }
    return `<tr><td>${name}</td>${cells}${totalCell}</tr>`;
  }).join('');
  const legendRate = showRate ? ' (활성 시 응답률 병기)' : '';
  return `
    <div class="ins-matrix">
      <h4>📋 ${squad}스쿼드 개인별 성과 요약</h4>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      <small class="ins-legend">숫자: ${mode === 'call' ? `수신연결 건수${legendRate}` : '채팅 응대 건수'}${showTotal ? ' · 합계: 기간 누적' : ''} · "${mode === 'call' ? '채팅' : '콜'}": 그 날 ${mode === 'call' ? '채팅' : '콜'} 포지션 · "-": 활동 없음(휴가·야간·휴무 포함)</small>
    </div>`;
}

// 시작
load();

/* CX 대시보드 — 클라이언트. data.json 로드 → 상태 기반 렌더링.
   상위탭(채팅/콜/민원) × 하위탭(전체/스쿼드/상담사/VOC) × 두 기간 비교.
   상담사별 채팅은 상담사태그 날짜 기준 + 중앙값(채널톡 일치). */

const state = {
  data: null,
  type: 'chat',
  view: 'all',
  agent: null,     // 상담사별 뷰 — 특정 상담사 필터(null=전체)
  vocChannel: 'all', // VOC 탭 채널 토글: 'all' | 'chat' | 'call'
  periodA: { start: '', end: '' },
  periodB: { start: '', end: '' },
};

let trendChart = null;
let respRateChart = null;
let complaintTypeChart = null, complaintRewardChart = null;
let fpA = null, fpB = null;  // flatpickr 인스턴스
const SQUAD_CHIP = { 'CX 1': 'squad-cx1', 'CX 2': 'squad-cx2', '교육': 'squad-edu', '기타': 'squad-etc' };

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
  setPreset('7d');
}

function setPreset(p) {
  const today = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
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

function bindEvents() {
  // flatpickr range — 채널톡 풍 듀얼 캘린더
  const ymd = d => d.toISOString().slice(0, 10);
  const fpOpts = (key) => ({
    mode: 'range',
    showMonths: 2,
    locale: 'ko',
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'Y. m. d',
    defaultDate: [state[key].start, state[key].end],
    onChange: (dates) => {
      if (dates.length === 2) {
        state[key].start = ymd(dates[0]);
        state[key].end = ymd(dates[1]);
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
      setActive('.type-tabs .tab', b);
      render();
    };
  });
  document.querySelectorAll('.view-tabs .tab').forEach(b => {
    b.onclick = () => {
      state.view = b.dataset.view;
      state.agent = null;
      setActive('.view-tabs .tab', b);
      render();
    };
  });
  document.querySelectorAll('.presets button').forEach(b => {
    b.onclick = () => { setPreset(b.dataset.preset); render(); };
  });
}

function setActive(sel, target) {
  document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b === target));
}

// ── 포맷 ──────────────────────────────────────────────────────
const fmtNum = n => (n == null || isNaN(n)) ? '-' : Number(n).toLocaleString('ko-KR');
const fmtPct = (p, dec = 1) => p == null ? '-' : p.toFixed(dec) + '%';
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
    main.appendChild(notePanel('💡 전체(팀) 지표는 <strong>생성일 기준 평균</strong>. 상담사별·스쿼드별은 <strong>상담사태그 날짜 + 중앙값</strong>(채널톡과 동일).'));
    main.appendChild(cardsChat(a, b, /*median=*/false));
    main.appendChild(trendPanel(d.by_date, '채팅 일별 인입·응대', ['인입', '응대'], A, B));
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
      rows.push(rowChatGroup(`<span class="chip ${SQUAD_CHIP[s]||''}">${s}</span>`, ma, mb));
    }
    main.appendChild(tablePanel(
      '스쿼드별 채팅 (상담사태그 날짜 기준, 시간 = 중앙값)',
      ['스쿼드', '응대(A)', '첫응대', '응답', '처리'],
      rows,
    ));
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
    // 응답률 dual-axis (위클리 리포트 응답률 이미지처럼 인입호 막대 + 응답률 선)
    main.appendChild(respRatePanel(d.team_by_date, A, B));
    main.appendChild(trendPanel(d.team_by_date.map(r => ({
      date: r.date, 인입: r['총인입'], 응대: r['연결성공'],
    })), '콜 일별 인입·응대', ['인입', '응대'], A, B));
    main.appendChild(dailyCallTable(d.team_by_date, A, B));
    return;
  }

  if (state.view === 'squad') {
    const squads = state.data.squads;
    const rows = [];
    for (const s of squads) {
      const ma = aggCallAgentRow(d.agent_by_date, A, { squad: s });
      const mb = aggCallAgentRow(d.agent_by_date, B, { squad: s });
      if (ma.수신연결 === 0 && mb.수신연결 === 0) continue;
      rows.push(rowCallGroup(`<span class="chip ${SQUAD_CHIP[s]||''}">${s}</span>`, ma, mb));
    }
    main.appendChild(tablePanel(
      '스쿼드별 콜 (1번 기간)',
      ['스쿼드', '수신연결', '총통화', '평균통화', '발신연결'],
      rows,
    ));
    return;
  }

  if (state.view === 'agent') {
    main.appendChild(agentSelector('call'));
    if (state.agent) {
      const ma = aggCallAgentRow(d.agent_by_date, A, { agent: state.agent });
      const mb = aggCallAgentRow(d.agent_by_date, B, { agent: state.agent });
      const cards = [
        { label: '수신연결(응대)', value: fmtNum(ma.수신연결), prev: fmtNum(mb.수신연결), d: delta(ma.수신연결, mb.수신연결) },
        { label: '총통화시간', value: fmtSec(ma.총통화), prev: fmtSec(mb.총통화), d: delta(ma.총통화, mb.총통화) },
        { label: '평균통화', value: fmtSec(ma.평균통화), prev: fmtSec(mb.평균통화), d: delta(ma.평균통화, mb.평균통화) },
        { label: '발신연결', value: fmtNum(ma.발신연결), prev: fmtNum(mb.발신연결), d: delta(ma.발신연결, mb.발신연결) },
      ];
      main.appendChild(makeCardGrid(cards));
      return;
    }
    const agents = collectCallAgentRows(d.agent_by_date, A, B);
    main.appendChild(tablePanel(
      '상담사별 콜 (1번 기간)',
      ['상담사', '스쿼드', '수신연결(A)', '수신연결(B)', '변화', '총통화', '평균통화'],
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
    cards.push({ label: '인입량', value: fmtNum(a.인입), prev: fmtNum(b.인입), d: delta(a.인입, b.인입) });
    cards.push({ label: '응대량', value: fmtNum(a.응대), prev: fmtNum(b.응대), d: delta(a.응대, b.응대) });
    cards.push({ label: '응답률', value: fmtPct(a.응답률), prev: fmtPct(b.응답률), d: deltaPp(a.응답률, b.응답률), pp: true });
  } else {
    cards.push({ label: '응대건수', value: fmtNum(a.응대), prev: fmtNum(b.응대), d: delta(a.응대, b.응대) });
  }
  const tLabel = isMedian ? ' (중앙값)' : ' (평균)';
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

function rowChatGroup(label, a, b) {
  return `<tr>
    <td>${label}</td>
    <td class="num">${fmtNum(a.응대)} ${fmtDelta(delta(a.응대, b.응대))}</td>
    <td class="num">${fmtSec(a.첫응대)}</td>
    <td class="num">${fmtSec(a.응답)}</td>
    <td class="num">${fmtSec(a.처리)}</td>
  </tr>`;
}

function rowCallGroup(label, a, b) {
  return `<tr>
    <td>${label}</td>
    <td class="num">${fmtNum(a.수신연결)} ${fmtDelta(delta(a.수신연결, b.수신연결))}</td>
    <td class="num">${fmtSec(a.총통화)}</td>
    <td class="num">${fmtSec(a.평균통화)}</td>
    <td class="num">${fmtNum(a.발신연결)}</td>
  </tr>`;
}

function collectCallAgentRows(allRows, A, B) {
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
    rows.push(`<tr>
      <td>${name}</td>
      <td><span class="chip ${SQUAD_CHIP[squadOf[name]]||''}">${squadOf[name]||'기타'}</span></td>
      <td class="num">${fmtNum(aCnt)}</td>
      <td class="num">${fmtNum(bCnt)}</td>
      <td class="num">${fmtDelta(delta(aCnt, bCnt))}</td>
      <td class="num">${fmtSec(tot)}</td>
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
    const 응답률 = r['인입'] ? (r['응대'] / r['인입'] * 100) : null;
    const f = r['첫응대_n'] ? r['첫응대_sum'] / r['첫응대_n'] : null;
    const a = r['응답_n'] ? r['응답_sum'] / r['응답_n'] : null;
    const p = r['처리_n'] ? r['처리_sum'] / r['처리_n'] : null;
    return `<tr>
      <td>${r.date}</td>
      <td class="num">${fmtNum(r['인입'])}</td>
      <td class="num">${fmtNum(r['응대'])}</td>
      <td class="num">${fmtPct(응답률)}</td>
      <td class="num">${fmtSec(f)}</td>
      <td class="num">${fmtSec(a)}</td>
      <td class="num">${fmtSec(p)}</td>
    </tr>`;
  });
  return tablePanel('1번 기간 — 일자별 채팅 (팀 전체, 시간=평균)',
    ['일자', '인입', '응대', '응답률', '첫응대', '응답', '처리'], html);
}

// 일자별 표 — 콜 전체
function dailyCallTable(rows, A, B) {
  const inA = rows.filter(r => inRange(r.date, A));
  inA.sort((x, y) => x.date.localeCompare(y.date));
  const html = inA.map(r => `<tr>
    <td>${r.date}</td>
    <td class="num">${fmtNum(r['총인입'])}</td>
    <td class="num">${fmtNum(r['연결시도'])}</td>
    <td class="num">${fmtNum(r['연결성공'])}</td>
    <td class="num">${fmtNum(r['연결포기'])}</td>
    <td class="num">${fmtPct(r['성공률_퍼센트'])}</td>
    <td class="num">${fmtSec(r['평균대기_초'])}</td>
    <td class="num">${fmtSec(r['평균통화_초'])}</td>
  </tr>`);
  return tablePanel('1번 기간 — 일자별 콜 (팀 전체)',
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
    main.innerHTML = `<div class="empty">민원 데이터 없음 — 시트 '2026년 민원데이터' 비어있거나 권한 없음.</div>`;
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
  return k ? `${k} (${o[k]})` : '-';
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
      },
    },
  });
}

function complaintTable(title, aMap, bMap) {
  const keys = Array.from(new Set([...Object.keys(aMap), ...Object.keys(bMap)]));
  keys.sort((x, y) => (aMap[y] || 0) - (aMap[x] || 0));
  const html = keys.map(k => {
    const av = aMap[k] || 0, bv = bMap[k] || 0;
    return `<tr>
      <td>${k}</td>
      <td class="num">${fmtNum(av)}</td>
      <td class="num">${fmtNum(bv)}</td>
      <td class="num">${fmtDelta(delta(av, bv))}</td>
    </tr>`;
  });
  return tablePanel(title, ['카테고리', '1번 건수', '2번 건수', '변화'], html);
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
  const topKey = keys[0] ? keys[0].split('​').join(' > ') : '-';

  const chLabel = state.vocChannel === 'chat' ? '채팅' :
                  state.vocChannel === 'call' ? '콜' : '전체';

  // 카드
  main.appendChild(makeCardGrid([
    { label: `VOC 총건수 (${chLabel})`, value: fmtNum(totalA), prev: fmtNum(totalB), d: delta(totalA, totalB) },
    { label: '상위 카테고리', value: topKey, prev: '', d: null },
  ]));

  // 표 — 위클리 리포트 형식 (순위 | 대 | 중 | 1번 건수 | 2번 건수 | 변화%)
  const rowsHtml = keys.slice(0, 30).map((k, i) => {
    const [c1, c2] = k.split('​');
    const av = aggA[k] || 0, bv = aggB[k] || 0;
    return `<tr>
      <td class="num">${i + 1}</td>
      <td>${c1}</td>
      <td>${c2}</td>
      <td class="num">${fmtNum(av)}</td>
      <td class="num">${fmtNum(bv)}</td>
      <td class="num">${fmtDelta(delta(av, bv))}</td>
    </tr>`;
  });
  main.appendChild(tablePanel(
    `VOC 상위 30 — ${chLabel} (1번 기간 기준 정렬)`,
    ['순위', '대분류', '중분류', '1번 건수', '2번 건수', '변화'],
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

// 응답률 dual-axis (인입·응대 막대 + 응답률 선) — 위클리 리포트 응답률 이미지 풍
function respRatePanel(rows, A, B) {
  const div = document.createElement('div');
  div.className = 'panel';
  div.innerHTML = `<h2>콜 일별 응답률 (1번 기간)</h2><div class="chart-wrap"><canvas id="resp-rate"></canvas></div>`;
  setTimeout(() => drawRespRate(rows, A, B), 0);
  return div;
}

function drawRespRate(rows, A, B) {
  const inA = rows.filter(r => inRange(r.date, A))
    .sort((x, y) => x.date.localeCompare(y.date));
  const labels = inA.map(r => {
    const dt = new Date(r.date);
    const w = ['일','월','화','수','목','금','토'][dt.getDay()];
    return `${r.date.slice(5)}(${w})`;
  });
  const inH = inA.map(r => r['총인입'] || 0);
  const ans = inA.map(r => r['연결성공'] || 0);
  const rate = inA.map(r => r['총인입'] ? (r['연결성공'] / r['총인입'] * 100) : null);

  if (respRateChart) respRateChart.destroy();
  const ctx = document.getElementById('resp-rate');
  if (!ctx) return;
  respRateChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: '인입호', data: inH, backgroundColor: '#4f46e5', yAxisID: 'y' },
        { type: 'bar', label: '응대호', data: ans, backgroundColor: '#5eead4', yAxisID: 'y' },
        { type: 'line', label: '응답률(%)', data: rate, borderColor: '#f97316', backgroundColor: '#f97316',
          yAxisID: 'y1', tension: 0.25, pointRadius: 4, borderWidth: 2 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (ctx.dataset.label === '응답률(%)') return `${ctx.dataset.label}: ${v == null ? '-' : v.toFixed(1) + '%'}`;
              return `${ctx.dataset.label}: ${fmtNum(v)}`;
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
    data: { labels: ds, datasets },
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

// 시작
load();

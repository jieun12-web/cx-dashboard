/* CX 대시보드 — 클라이언트. data.json 로드 → 상태 기반 렌더링.
   상위탭(채팅/콜/민원) × 하위탭(전체/스쿼드/상담사) × 두 기간 비교. */

const state = {
  data: null,
  type: 'chat',
  view: 'all',
  periodA: { start: '', end: '' },
  periodB: { start: '', end: '' },
};

let trendChart = null;
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
  ['pa-start', 'pa-end', 'pb-start', 'pb-end'].forEach((id, i) => {
    document.getElementById(id).value = i < 2
      ? state.periodA[i === 0 ? 'start' : 'end']
      : state.periodB[i === 2 ? 'start' : 'end'];
  });
}

function bindEvents() {
  ['pa-start', 'pa-end', 'pb-start', 'pb-end'].forEach(id => {
    document.getElementById(id).addEventListener('change', e => {
      const k = id.startsWith('pa') ? 'periodA' : 'periodB';
      const w = id.endsWith('start') ? 'start' : 'end';
      state[k][w] = e.target.value;
      render();
    });
  });
  document.querySelectorAll('.type-tabs .tab').forEach(b => {
    b.onclick = () => {
      if (b.disabled) return;
      state.type = b.dataset.type;
      setActive('.type-tabs .tab', b);
      render();
    };
  });
  document.querySelectorAll('.view-tabs .tab').forEach(b => {
    b.onclick = () => {
      state.view = b.dataset.view;
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
function fmtDelta(d, isPp = false) {
  if (d == null || isNaN(d)) return '<span class="delta">-</span>';
  const sign = d >= 0 ? '▲' : '▼';
  const cls = d >= 0 ? 'up' : 'down';
  const unit = isPp ? 'pp' : '%';
  return `<span class="delta ${cls}">${sign}${Math.abs(d).toFixed(1)}${unit}</span>`;
}

// ── 집계 ──────────────────────────────────────────────────────
const inRange = (d, p) => d >= p.start && d <= p.end;

function aggChat(rows, p) {
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
    첫응대_평균: fn ? (fs / fn) : null,
    응답_평균: an ? (as / an) : null,
    처리_평균: rn ? (rs / rn) : null,
  };
}

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
      대기_s += r['평균대기_초'] * r['연결시도'];
      대기_w += r['연결시도'];
    }
    if (r['평균통화_초'] != null && r['연결성공']) {
      통화_s += r['평균통화_초'] * r['연결성공'];
      통화_w += r['연결성공'];
    }
  }
  return {
    총인입: 인입, 연결시도: 시도, 연결성공: 성공, 연결포기: 포기, 연결실패: 실패,
    응답률: 시도 ? (성공 / 시도 * 100) : null,
    평균대기: 대기_w ? (대기_s / 대기_w) : null,
    평균통화: 통화_w ? (통화_s / 통화_w) : null,
  };
}

const delta = (a, b) => (a == null || b == null || b === 0) ? null : ((a - b) / b * 100);
const deltaPp = (a, b) => (a == null || b == null) ? null : (a - b);

// ── 렌더 ──────────────────────────────────────────────────────
function render() {
  const main = document.getElementById('content');
  main.innerHTML = '';
  if (!state.data) return;

  if (state.type === 'voc') {
    main.innerHTML = `<div class="empty">민원 데이터는 엑셀 링크 수령 후 추가됩니다.</div>`;
    return;
  }

  // 기간 유효성
  if (!state.periodA.start || !state.periodA.end) {
    main.innerHTML = `<div class="empty">기간을 선택해주세요.</div>`;
    return;
  }

  if (state.type === 'chat') renderChat(main);
  else renderCall(main);
}

// === 채팅 렌더 ===
function renderChat(main) {
  const d = state.data.chat;
  const A = state.periodA, B = state.periodB;

  if (state.view === 'all') {
    const a = aggChat(d.by_date, A), b = aggChat(d.by_date, B);
    main.appendChild(cardsChat(a, b));
    main.appendChild(trendPanel(d.by_date, '채팅 일별 인입·응대', ['인입', '응대'], A, B));
    main.appendChild(vocPanel(d.voc_by_date, A, B));
  } else if (state.view === 'squad') {
    const squadsA = groupBy(d.by_squad_date, A, 'squad', aggChatBucket);
    const squadsB = groupBy(d.by_squad_date, B, 'squad', aggChatBucket);
    main.appendChild(tablePanel(
      '스쿼드별 채팅 (1번 기간)',
      ['스쿼드', '인입', '응대', '응답률', '첫응대', '응답시간'],
      buildSquadRows(squadsA, squadsB, 'chat'),
    ));
  } else if (state.view === 'agent') {
    const agentsA = groupBy(d.by_agent_date, A, 'agent', aggChatBucket, true);
    const agentsB = groupBy(d.by_agent_date, B, 'agent', aggChatBucket, true);
    main.appendChild(tablePanel(
      '상담사별 채팅 (1번 기간)',
      ['상담사', '스쿼드', '인입', '응대', '응답률', '첫응대', '응답시간'],
      buildAgentRows(agentsA, agentsB, 'chat'),
    ));
  }
}

// === 콜 렌더 ===
function renderCall(main) {
  const d = state.data.call;
  const A = state.periodA, B = state.periodB;

  if (state.view === 'all') {
    const a = aggCallTeam(d.team_by_date, A), b = aggCallTeam(d.team_by_date, B);
    main.appendChild(cardsCall(a, b));
    main.appendChild(trendPanel(d.team_by_date.map(r => ({
      date: r.date, 인입: r['총인입'], 응대: r['연결성공'],
    })), '콜 일별 인입·응대', ['인입', '응대'], A, B));
  } else if (state.view === 'squad') {
    const squadsA = groupBy(d.squad_by_date, A, 'squad', aggCallBucket);
    const squadsB = groupBy(d.squad_by_date, B, 'squad', aggCallBucket);
    main.appendChild(tablePanel(
      '스쿼드별 콜 (1번 기간)',
      ['스쿼드', '수신연결', '총통화', '평균통화', '발신연결'],
      buildSquadRows(squadsA, squadsB, 'call'),
    ));
  } else if (state.view === 'agent') {
    const agentsA = groupBy(d.agent_by_date, A, 'agent', aggCallBucket, true);
    const agentsB = groupBy(d.agent_by_date, B, 'agent', aggCallBucket, true);
    main.appendChild(tablePanel(
      '상담사별 콜 (1번 기간)',
      ['상담사', '스쿼드', '수신연결', '총통화', '평균통화', '발신연결'],
      buildAgentRows(agentsA, agentsB, 'call'),
    ));
  }
}

// ── 카드 ──────────────────────────────────────────────────────
function cardsChat(a, b) {
  const cards = [
    { label: '인입량', value: fmtNum(a.인입), prev: fmtNum(b.인입), d: delta(a.인입, b.인입) },
    { label: '응대량', value: fmtNum(a.응대), prev: fmtNum(b.응대), d: delta(a.응대, b.응대) },
    { label: '응답률', value: fmtPct(a.응답률), prev: fmtPct(b.응답률), d: deltaPp(a.응답률, b.응답률), pp: true },
    { label: '평균 첫응대', value: fmtSec(a.첫응대_평균), prev: fmtSec(b.첫응대_평균), d: delta(a.첫응대_평균, b.첫응대_평균), invert: true },
    { label: '평균 응답시간', value: fmtSec(a.응답_평균), prev: fmtSec(b.응답_평균), d: delta(a.응답_평균, b.응답_평균), invert: true },
    { label: '평균 처리시간', value: fmtSec(a.처리_평균), prev: fmtSec(b.처리_평균), d: delta(a.처리_평균, b.처리_평균), invert: true },
  ];
  return makeCardGrid(cards);
}

function cardsCall(a, b) {
  const cards = [
    { label: '총 인입', value: fmtNum(a.총인입), prev: fmtNum(b.총인입), d: delta(a.총인입, b.총인입) },
    { label: '연결시도', value: fmtNum(a.연결시도), prev: fmtNum(b.연결시도), d: delta(a.연결시도, b.연결시도) },
    { label: '응대(연결성공)', value: fmtNum(a.연결성공), prev: fmtNum(b.연결성공), d: delta(a.연결성공, b.연결성공) },
    { label: '응답률', value: fmtPct(a.응답률), prev: fmtPct(b.응답률), d: deltaPp(a.응답률, b.응답률), pp: true },
    { label: '포기', value: fmtNum(a.연결포기), prev: fmtNum(b.연결포기), d: delta(a.연결포기, b.연결포기), invert: true },
    { label: '평균 대기', value: fmtSec(a.평균대기), prev: fmtSec(b.평균대기), d: delta(a.평균대기, b.평균대기), invert: true },
    { label: '평균 통화', value: fmtSec(a.평균통화), prev: fmtSec(b.평균통화), d: delta(a.평균통화, b.평균통화) },
  ];
  return makeCardGrid(cards);
}

function makeCardGrid(cards) {
  const div = document.createElement('div');
  div.className = 'cards';
  for (const c of cards) {
    // invert: 작아지는 게 좋은 지표(시간·포기)의 화살표 색 반전
    let dHtml = fmtDelta(c.d, c.pp);
    if (c.invert && c.d != null) {
      // 직접 색 적용 — fmtDelta가 부호 기반으로 색을 정해서 반전
      const isImproving = c.d < 0;
      const cls = isImproving ? 'up' : 'down';
      const sign = c.d >= 0 ? '▲' : '▼';
      dHtml = `<span class="delta ${cls}">${sign}${Math.abs(c.d).toFixed(1)}${c.pp ? 'pp' : '%'}</span>`;
    }
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

// ── 표 (스쿼드·상담사) ──────────────────────────────────────
function aggChatBucket(rows) {
  let 인입 = 0, 응대 = 0, fs = 0, fn = 0, as = 0, an = 0;
  for (const r of rows) {
    인입 += r['인입'] || 0;
    응대 += r['응대'] || 0;
    fs += r['첫응대_sum'] || 0; fn += r['첫응대_n'] || 0;
    as += r['응답_sum'] || 0; an += r['응답_n'] || 0;
  }
  return {
    인입, 응대,
    응답률: 인입 ? (응대 / 인입 * 100) : null,
    첫응대: fn ? (fs / fn) : null,
    응답시간: an ? (as / an) : null,
  };
}

function aggCallBucket(rows) {
  let cnt = 0, tot = 0, out_try = 0, out_ans = 0;
  for (const r of rows) {
    cnt += r['수신연결'] || 0;
    tot += r['총통화_초'] || 0;
    out_try += r['발신시도'] || 0;
    out_ans += r['발신연결'] || 0;
  }
  return {
    수신연결: cnt,
    총통화: tot,
    평균통화: cnt ? (tot / cnt) : null,
    발신연결: out_ans,
    발신시도: out_try,
  };
}

function groupBy(rows, p, key, aggFn, captureSquad = false) {
  const buckets = {};
  for (const r of rows) {
    if (!inRange(r.date, p)) continue;
    const k = r[key] || '(미지정)';
    if (!buckets[k]) buckets[k] = { _rows: [], _squad: r.squad };
    buckets[k]._rows.push(r);
    if (captureSquad && !buckets[k]._squad && r.squad) buckets[k]._squad = r.squad;
  }
  const out = {};
  for (const k of Object.keys(buckets)) {
    out[k] = aggFn(buckets[k]._rows);
    if (captureSquad) out[k]._squad = buckets[k]._squad;
  }
  return out;
}

function buildSquadRows(a, b, type) {
  // 스쿼드 순서 고정
  const order = state.data.squads;
  const rows = [];
  for (const s of order) {
    const ma = a[s], mb = b[s];
    if (!ma && !mb) continue;
    rows.push(rowForGroup(s, null, ma, mb, type));
  }
  return rows;
}

function buildAgentRows(a, b, type) {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  // 1번 기간의 인입 또는 수신연결 내림차순 정렬
  const sortKey = type === 'chat' ? '인입' : '수신연결';
  keys.sort((x, y) => ((a[y] || {})[sortKey] || 0) - ((a[x] || {})[sortKey] || 0));
  const rows = [];
  for (const k of keys) {
    const ma = a[k] || {}, mb = b[k] || {};
    const squad = ma._squad || mb._squad || '기타';
    rows.push(rowForGroup(k, squad, ma, mb, type));
  }
  return rows;
}

function rowForGroup(name, squad, a, b, type) {
  const cells = [];
  cells.push(`<td>${name}</td>`);
  if (squad != null) {
    cells.push(`<td><span class="chip ${SQUAD_CHIP[squad] || ''}">${squad}</span></td>`);
  }
  if (type === 'chat') {
    cells.push(cellWithDelta(a.인입, b.인입));
    cells.push(cellWithDelta(a.응대, b.응대));
    cells.push(cellWithDeltaPct(a.응답률, b.응답률));
    cells.push(cellWithDeltaSec(a.첫응대, b.첫응대, true));
    cells.push(cellWithDeltaSec(a.응답시간, b.응답시간, true));
  } else {
    cells.push(cellWithDelta(a.수신연결, b.수신연결));
    cells.push(cellSec(a.총통화));
    cells.push(cellWithDeltaSec(a.평균통화, b.평균통화));
    cells.push(cellWithDelta(a.발신연결, b.발신연결));
  }
  return `<tr>${cells.join('')}</tr>`;
}

function cellWithDelta(av, bv) {
  return `<td class="num">${fmtNum(av)} ${fmtDelta(delta(av, bv))}</td>`;
}
function cellWithDeltaPct(av, bv) {
  return `<td class="num">${fmtPct(av)} ${fmtDelta(deltaPp(av, bv), true)}</td>`;
}
function cellWithDeltaSec(av, bv, invert = false) {
  const d = delta(av, bv);
  let html = fmtDelta(d);
  if (invert && d != null) {
    const isImproving = d < 0;
    const cls = isImproving ? 'up' : 'down';
    const sign = d >= 0 ? '▲' : '▼';
    html = `<span class="delta ${cls}">${sign}${Math.abs(d).toFixed(1)}%</span>`;
  }
  return `<td class="num">${fmtSec(av)} ${html}</td>`;
}
function cellSec(s) { return `<td class="num">${fmtSec(s)}</td>`; }

function tablePanel(title, headers, rowsHtml) {
  const div = document.createElement('div');
  div.className = 'panel';
  div.innerHTML = `
    <h2>${title}</h2>
    <table>
      <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml.join('') || '<tr><td colspan="' + headers.length + '" style="text-align:center;color:var(--muted)">데이터 없음</td></tr>'}</tbody>
    </table>
  `;
  return div;
}

// ── VOC ───────────────────────────────────────────────────────
function vocPanel(rows, A, B) {
  // 기간 A에서 태그별 합산 + B 비교
  const a = {}, b = {};
  for (const r of rows) {
    if (inRange(r.date, A)) a[r.voc] = (a[r.voc] || 0) + r.count;
    if (inRange(r.date, B)) b[r.voc] = (b[r.voc] || 0) + r.count;
  }
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  keys.sort((x, y) => (a[y] || 0) - (a[x] || 0));
  const top = keys.slice(0, 12);
  const rowsHtml = top.map(k =>
    `<tr><td>${k}</td>${cellWithDelta(a[k] || 0, b[k] || 0)}</tr>`,
  );
  return tablePanel('VOC 상위 12 (1번 기간 기준)', ['태그', '건수'], rowsHtml);
}

// ── 추이 차트 ─────────────────────────────────────────────────
function trendPanel(rows, title, metrics, A, B) {
  const div = document.createElement('div');
  div.className = 'panel';
  div.innerHTML = `<h2>${title}</h2><div class="chart-wrap"><canvas id="trend"></canvas></div>`;
  setTimeout(() => drawTrend(rows, metrics, A, B), 0);
  return div;
}

function drawTrend(rows, metrics, A, B) {
  // A와 B 기간을 모두 포함하는 날짜 범위
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
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
      },
    },
  });
}

// ── 시작 ──────────────────────────────────────────────────────
load();

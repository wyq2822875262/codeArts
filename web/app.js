/* 码道网关控制台前端 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  page: 'dashboard',
  logOffset: 0,
  logLimit: 50,
  accounts: [],
  keys: [],
  models: [],
  charts: {},
};

/* ---------------- 主题 ---------------- */

const THEME_KEY = 'deva-theme';
const themeMeta = { light: { icon: '☀', label: '浅色' }, dark: { icon: '☾', label: '深色' } };

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** 读当前主题的 CSS 变量，图表绘制要用，避免把颜色写死在 canvas 里。 */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n) => cs.getPropertyValue(n).trim();
  return {
    grid: get('--chart-grid'),
    text: get('--chart-text'),
    fillA: get('--chart-fill-a'),
    fillB: get('--chart-fill-b'),
    line: get('--chart-line'),
  };
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* 隐私模式忽略 */ }
  const meta = themeMeta[t] || themeMeta.dark;
  for (const id of ['#theme-toggle', '#theme-toggle-login']) {
    const el = $(id);
    if (el) { el.textContent = meta.icon; el.title = `当前${meta.label}主题，点击切换`; }
  }
  // canvas 上的颜色是绘制时取的，主题一变必须重绘
  redrawCharts();
}

function toggleTheme() {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

/** 重绘当前页面上已存在的图表。 */
function redrawCharts() {
  if (state.charts.daily) state.charts.daily();
  if (state.charts.hourly) state.charts.hourly();
}

/* ---------------- 基础工具 ---------------- */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error('未登录'); }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

const fmtNum = (n) => {
  const v = Number(n || 0);
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return v.toLocaleString('en-US');
};
const fmtTime = (ts) => {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('zh-CN') : '-');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 登录 ---------------- */

async function boot() {
  const pub = await fetch('/api/public').then((r) => r.json()).catch(() => ({}));
  if (pub.loggedIn) { showApp(); } else { showLogin(); }
}

function showLogin() {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  setTimeout(() => $('#login-pass')?.focus(), 50);
}
function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  navigate('dashboard');
}

$('#login-btn').onclick = async () => {
  const pw = $('#login-pass').value;
  $('#login-err').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) { $('#login-err').textContent = '密码错误'; return; }
    showApp();
  } catch (e) { $('#login-err').textContent = e.message; }
};
$('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });

$('#logout-btn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  showLogin();
};

/* ---------------- 路由 ---------------- */

const TITLES = {
  dashboard: '仪表盘', accounts: '账号管理', keys: '密钥分发', logs: '调用日志',
  usage: '用量统计', models: '模型中心', security: 'IP 管控', settings: '设置',
  signin: '每日签到',
};

function navigate(page) {
  state.page = page;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  $$('.page').forEach((p) => p.classList.add('hidden'));
  $(`#page-${page}`)?.classList.remove('hidden');
  $('#page-title').textContent = TITLES[page] || page;
  const loaders = {
    dashboard: loadDashboard, accounts: loadAccounts, keys: loadKeys,
    logs: () => loadLogs(true), usage: loadUsage, models: loadModels,
    security: loadRules, settings: loadSettings, signin: loadSignin,
  };
  loaders[page]?.();
}

$$('.nav-item').forEach((n) => { n.onclick = () => navigate(n.dataset.page); });
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-page]');
  if (link && !link.classList.contains('nav-item')) navigate(link.dataset.page);
});

/* ---------------- 仪表盘 ---------------- */

async function loadDashboard() {
  try {
    const [ov, series, recent] = await Promise.all([
      api('/stats/overview'),
      api('/stats/series?days=14'),
      api('/logs?limit=8'),
    ]);
    $('#s-req').textContent = fmtNum(ov.today.requests);
    $('#s-req-foot').textContent = `累计 ${fmtNum(ov.total.requests)} · 失败 ${fmtNum(ov.total.errors)}`;
    $('#s-tok').textContent = fmtNum(ov.today.tokens);
    $('#s-tok-foot').textContent = `累计 ${fmtNum(ov.total.tokens)}`;
    $('#s-acc').textContent = `${ov.accounts.enabled}/${ov.accounts.total}`;
    $('#s-acc-foot').textContent = `异常 ${ov.accounts.error} 个`;
    $('#s-key').textContent = ov.keys.total;
    $('#s-key-foot').textContent = `启用 ${ov.keys.enabled}`;

    drawLine($('#chart-daily'), series.daily.map((d) => d.day.slice(5)), series.daily.map((d) => d.requests));
    // 记住本次绘制，切主题时可直接重绘
    state.charts.daily = () => drawLine($('#chart-daily'), series.daily.map((d) => d.day.slice(5)), series.daily.map((d) => d.requests));
    renderShare($('#model-share'), series.models.map((m) => ({ name: m.model || '(未指定)', value: m.tt })));

    const tb = $('#recent-table tbody');
    tb.innerHTML = recent.rows.length ? recent.rows.map(rowHtml).join('') : '<tr><td colspan="8" class="empty">暂无调用记录</td></tr>';

    const tag = $('#upstream-tag');
    tag.textContent = ov.accounts.enabled > 0 ? '上游 · 已配置账号' : '上游 · 未配置账号';
    tag.classList.toggle('on', ov.accounts.total > 0);
  } catch (e) { toast(e.message, true); }
}

function rowHtml(r) {
  const ok = r.status < 400;
  return `<tr>
    <td class="muted">${fmtTime(r.ts)}</td>
    <td>${esc(r.key_name || '-')}</td>
    <td>${esc(r.account_name || '-')}</td>
    <td>${esc(r.model || '-')}</td>
    <td><span class="badge ${ok ? 'ok' : 'err'}">${r.status}</span></td>
    <td class="muted">${r.first_token_ms ? r.first_token_ms + 'ms' : '-'}</td>
    <td>${fmtNum(r.total_tokens)}</td>
    <td class="muted">${esc(r.ip || '-')}</td>
  </tr>`;
}

function renderShare(el, items) {
  if (!items.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const max = Math.max(...items.map((i) => i.value)) || 1;
  el.innerHTML = items.slice(0, 8).map((i) => `
    <div class="share-row">
      <div>
        <div class="share-name" title="${esc(i.name)}">${esc(i.name)}</div>
        <div class="share-bar"><i style="width:${Math.max(2, (i.value / max) * 100)}%"></i></div>
      </div>
      <div class="share-val">${fmtNum(i.value)}</div>
    </div>`).join('');
}

function drawLine(canvas, labels, values) {
  if (!canvas) return;
  const c = themeColors();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 180;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 42, r: 12, t: 14, b: 24 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const max = Math.max(1, ...values);
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
  }
  ctx.fillStyle = c.text; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = max - (max / 4) * i;
    ctx.fillText(fmtNum(Math.round(v)), pad.l - 6, pad.t + (ih / 4) * i + 3);
  }
  if (!values.length) return;
  const step = values.length > 1 ? iw / (values.length - 1) : 0;
  const pts = values.map((v, i) => [pad.l + step * i, pad.t + ih - (v / max) * ih]);

  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
  grad.addColorStop(0, c.fillA);
  grad.addColorStop(1, c.fillB);
  ctx.beginPath(); ctx.moveTo(pts[0][0], pad.t + ih);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(pts[pts.length - 1][0], pad.t + ih); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = c.line; ctx.lineWidth = 1.8; ctx.stroke();

  ctx.fillStyle = c.text; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  labels.forEach((l, i) => {
    if (labels.length > 8 && i % 2) return;
    ctx.fillText(l, pad.l + step * i, h - 6);
  });
}

/* ---------------- 账号 ---------------- */

async function loadAccounts() {
  state.accounts = await api('/accounts');
  const kw = ($('#acc-search').value || '').toLowerCase();
  const rows = state.accounts.filter((a) => !kw || a.name.toLowerCase().includes(kw));
  const tb = $('#acc-table tbody');
  tb.innerHTML = rows.length ? rows.map((a) => {
    const st = a.state === 'ok' ? 'ok' : a.state === 'invalid' ? 'err' : a.state === 'error' ? 'err' : 'dim';
    const stText = { ok: '正常', error: '异常', unknown: '未校验', invalid: 'Cookie 失效' }[a.state] || a.state;
    const kaText = a.last_keepalive ? fmtTime(a.last_keepalive) : '—';
    const kaBad = a.keepalive_fail > 0;
    return `<tr>
      <td><b>${esc(a.name)}</b>${a.note ? `<div class="muted">${esc(a.note)}</div>` : ''}</td>
      <td class="muted">${esc(a.group_name)}</td>
      <td><span class="badge ${st}">${esc(stText)}</span>${a.state_msg ? `<div class="muted" title="${esc(a.state_msg)}">${esc(a.state_msg.slice(0, 26))}</div>` : ''}</td>
      <td class="muted"${kaBad ? ' title="连续探活失败，请检查 Cookie"' : ''}>${kaText}${kaBad ? ` <span class="badge err">×${a.keepalive_fail}</span>` : ''}</td>
      <td class="muted">${a.models.length ? a.models.length + ' 个' : '—'}</td>
      <td class="muted">${a.ok_count} / ${a.fail_count}</td>
      <td class="muted">${fmtTime(a.last_check)}</td>
      <td>
        <button class="btn sm" data-act="test" data-id="${a.id}">校验</button>
        <button class="btn sm" data-act="recookie" data-id="${a.id}">换 Cookie</button>
        <button class="btn sm" data-act="toggle" data-id="${a.id}">${a.enabled ? '禁用' : '启用'}</button>
        <button class="btn sm danger" data-act="del" data-id="${a.id}">删除</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="empty">还没有账号，点「添加账号」粘贴网页端 Cookie</td></tr>';
}

$('#acc-search').oninput = () => loadAccounts();

$('#add-account').onclick = () => openModal('添加账号', `
  <label>名称<input class="input" id="f-name" placeholder="如：主账号" /></label>
  <label>Cookie（从 devcloud 网页端 F12 复制整段）<textarea class="input mono" id="f-cookie" rows="4" placeholder="HWWAFSESID=...; SessionID=...; cbc-sid=..."></textarea></label>
  <label>cftk（可选，留空自动从 Cookie 提取）<input class="input mono" id="f-cftk" placeholder="devclouddevuibjtcftk 的值" /></label>
  <label>备注<input class="input" id="f-note" /></label>
`, async () => {
  const name = $('#f-name').value.trim();
  const cookie = $('#f-cookie').value.trim();
  if (!name || !cookie) throw new Error('名称和 Cookie 必填');
  await api('/accounts', { method: 'POST', body: { name, cookie, cftk: $('#f-cftk').value.trim(), note: $('#f-note').value.trim() } });
  toast('账号已添加，正在校验…');
  loadAccounts();
});

$('#sync-all').onclick = async () => {
  const list = state.accounts.filter((a) => a.enabled);
  if (!list.length) return toast('没有启用的账号', true);
  toast(`正在同步 ${list.length} 个账号…`);
  let ok = 0;
  for (const a of list) {
    try { const r = await api(`/accounts/${a.id}/sync`, { method: 'POST' }); if (r.ok) ok++; } catch { /* 继续 */ }
  }
  toast(`同步完成：成功 ${ok}/${list.length}`, ok === 0);
  loadAccounts();
};

$('#acc-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  try {
    if (act === 'test') {
      btn.disabled = true; btn.textContent = '校验中…';
      const r = await api(`/accounts/${id}/test`, { method: 'POST' });
      toast(r.ok ? `校验通过，${r.models?.length || 0} 个模型` : `校验失败：${r.error}`, !r.ok);
      loadAccounts();
    } else if (act === 'recookie') {
      const a = state.accounts.find((x) => x.id === id);
      openModal(`更换 Cookie — ${a.name}`, `
        <label>新 Cookie（整段粘贴，覆盖旧的）<textarea class="input mono" id="f-cookie" rows="4" placeholder="SessionID=...; cbc-sid=..."></textarea></label>
        <label>cftk（可选，留空自动从 Cookie 提取）<input class="input mono" id="f-cftk" placeholder="devclouddevuibjtcftk 的值" /></label>
      `, async () => {
        const cookie = $('#f-cookie').value.trim();
        if (!cookie) throw new Error('Cookie 必填');
        await api(`/accounts/${id}`, { method: 'PATCH', body: { cookie, cftk: $('#f-cftk').value.trim() } });
        toast('Cookie 已更新，正在校验…');
        await api(`/accounts/${id}/sync`, { method: 'POST' }).catch(() => {});
        loadAccounts();
      });
    } else if (act === 'toggle') {
      const a = state.accounts.find((x) => x.id === id);
      await api(`/accounts/${id}`, { method: 'PATCH', body: { enabled: !a.enabled } });
      loadAccounts();
    } else if (act === 'del') {
      if (!confirm('确定删除该账号？')) return;
      await api(`/accounts/${id}`, { method: 'DELETE' });
      toast('已删除'); loadAccounts();
    }
  } catch (err) { toast(err.message, true); btn.disabled = false; }
});

/* ---------------- 密钥 ---------------- */

async function loadKeys() {
  state.keys = await api('/keys');
  const tb = $('#key-table tbody');
  tb.innerHTML = state.keys.length ? state.keys.map((k) => {
    const quota = k.quota > 0 ? `${fmtNum(k.used_tokens)} / ${fmtNum(k.quota)}` : '不限';
    return `<tr>
      <td><b>${esc(k.name)}</b></td>
      <td><code>${esc(k.secret_masked)}</code></td>
      <td class="muted">${quota}</td>
      <td>${fmtNum(k.used_tokens)}</td>
      <td class="muted">${fmtNum(k.used_requests)}</td>
      <td class="muted">${k.max_ips || '不限'}</td>
      <td class="muted">${k.model_whitelist.length ? esc(k.model_whitelist.join(', ')) : '全部'}</td>
      <td><span class="badge ${k.enabled ? 'ok' : 'dim'}">${k.enabled ? '启用' : '停用'}</span></td>
      <td>
        <button class="btn sm" data-act="show" data-id="${k.id}">查看</button>
        <button class="btn sm" data-act="toggle" data-id="${k.id}">${k.enabled ? '停用' : '启用'}</button>
        <button class="btn sm danger" data-act="del" data-id="${k.id}">删除</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">还没有密钥，点「新建密钥」生成一把</td></tr>';
}

$('#add-key').onclick = () => openModal('新建密钥', `
  <label>名称<input class="input" id="k-name" placeholder="如：我的客户端" /></label>
  <label>额度上限（Token，0 表示不限）<input class="input" id="k-quota" type="number" value="0" /></label>
  <label>IP 数量上限（0 表示不限）<input class="input" id="k-maxips" type="number" value="0" /></label>
  <label>IP 白名单（逗号分隔，支持 CIDR，留空不限）<input class="input mono" id="k-ips" /></label>
  <label>模型白名单（逗号分隔，留空全部）<input class="input mono" id="k-models" /></label>
`, async () => {
  const name = $('#k-name').value.trim();
  if (!name) throw new Error('名称必填');
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const r = await api('/keys', {
    method: 'POST',
    body: {
      name,
      quota: Number($('#k-quota').value) || 0,
      max_ips: Number($('#k-maxips').value) || 0,
      ip_whitelist: split($('#k-ips').value),
      model_whitelist: split($('#k-models').value),
    },
  });
  await navigator.clipboard?.writeText(r.secret).catch(() => {});
  openModal('密钥已生成（只显示一次）', `
    <p class="muted">请立即复制保存，之后只能在此页面再次查看。</p>
    <textarea class="input mono" rows="3" readonly>${esc(r.secret)}</textarea>
  `, () => {}, '关闭');
  loadKeys();
});

$('#key-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  try {
    if (btn.dataset.act === 'show') {
      const detail = await api(`/keys/${id}`);
      openModal('密钥详情', `
        <label>密钥<textarea class="input mono" rows="2" readonly>${esc(detail.secret)}</textarea></label>
        <label>使用过的 IP（${detail.ips.length}）<div class="muted mono">${detail.ips.map((i) => esc(i.ip)).join('<br>') || '—'}</div></label>
      `, () => {}, '关闭');
    } else if (btn.dataset.act === 'toggle') {
      const k = state.keys.find((x) => x.id === id);
      await api(`/keys/${id}`, { method: 'PATCH', body: { enabled: !k.enabled } });
      loadKeys();
    } else if (btn.dataset.act === 'del') {
      if (!confirm('删除后该密钥立即失效，确定？')) return;
      await api(`/keys/${id}`, { method: 'DELETE' });
      toast('已删除'); loadKeys();
    }
  } catch (err) { toast(err.message, true); }
});

/* ---------------- 日志 ---------------- */

async function loadLogs(reset = false) {
  if (reset) state.logOffset = 0;
  const q = $('#log-q').value.trim();
  const status = $('#log-status').value;
  const params = new URLSearchParams({ limit: state.logLimit, offset: state.logOffset });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const data = await api('/logs?' + params);
  const tb = $('#log-table tbody');
  tb.innerHTML = data.rows.length ? data.rows.map((r) => {
    const ok = r.status < 400;
    return `<tr>
      <td class="muted">${fmtTime(r.ts)}</td>
      <td>${esc(r.key_name || '-')}</td>
      <td>${esc(r.account_name || '-')}</td>
      <td>${esc(r.model || '-')}</td>
      <td class="muted">${esc(r.endpoint || '-')}</td>
      <td><span class="badge ${ok ? 'ok' : 'err'}">${r.status}</span>${r.error ? `<div class="muted" title="${esc(r.error)}">${esc(r.error.slice(0, 40))}</div>` : ''}</td>
      <td class="muted">${r.latency_ms}ms</td>
      <td class="muted">${r.first_token_ms ? r.first_token_ms + 'ms' : '-'}</td>
      <td>${fmtNum(r.total_tokens)}</td>
      <td class="muted">${esc(r.ip || '-')}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">暂无日志</td></tr>';
  $('#log-page').textContent = `${Math.floor(state.logOffset / state.logLimit) + 1} / ${Math.max(1, Math.ceil(data.total / state.logLimit))}`;
  $('#log-prev').disabled = state.logOffset === 0;
  $('#log-next').disabled = state.logOffset + state.logLimit >= data.total;
}

$('#log-refresh').onclick = () => loadLogs(true);
$('#log-status').onchange = () => loadLogs(true);
$('#log-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLogs(true); });
$('#log-prev').onclick = () => { state.logOffset = Math.max(0, state.logOffset - state.logLimit); loadLogs(); };
$('#log-next').onclick = () => { state.logOffset += state.logLimit; loadLogs(); };

/* ---------------- 用量 ---------------- */

async function loadUsage() {
  const [series] = await Promise.all([api('/stats/series?days=30')]);
  const draw = () => drawLine($('#chart-hourly'),
    series.hourly.map((h) => new Date(h.hour).getHours() + '时'),
    series.hourly.map((h) => h.requests));
  draw();
  state.charts.hourly = draw;
  renderShare($('#usage-models'), series.models.map((m) => ({ name: m.model || '(未指定)', value: m.tt })));
  $('#usage-table tbody').innerHTML = series.daily.length ? series.daily.slice().reverse().map((d) => `
    <tr><td>${esc(d.day)}</td><td>${fmtNum(d.requests)}</td><td class="muted">${fmtNum(d.errors)}</td>
    <td>${fmtNum(d.pt)}</td><td>${fmtNum(d.ct)}</td><td><b>${fmtNum(d.tt)}</b></td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">暂无用量数据</td></tr>';
}

/* ---------------- 模型 ---------------- */

async function loadModels() {
  const data = await api('/models');
  state.models = data.models || [];
  $('#model-ts').textContent = data.ts ? `上次同步：${fmtTime(data.ts)}` : '尚未同步';
  $('#model-table tbody').innerHTML = state.models.length ? state.models.map((m) => `
    <tr><td><code>${esc(m.id)}</code></td><td>${esc(m.name)}</td>
    <td class="muted">${m.context ? fmtNum(m.context) : '-'}</td>
    <td class="muted">${m.maxTokens ? fmtNum(m.maxTokens) : '-'}</td>
    <td class="muted">${esc(m.type || '-')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">点「从上游同步模型」获取账号可用模型</td></tr>';
}

$('#refresh-models').onclick = async () => {
  try {
    toast('正在同步…');
    await api('/models', { method: 'POST' });
    await loadModels();
    toast('模型已更新');
  } catch (e) { toast(e.message, true); }
};

/* ---------------- IP 规则 ---------------- */

async function loadRules() {
  const rules = await api('/ip-rules');
  $('#rule-table tbody').innerHTML = rules.length ? rules.map((r) => `
    <tr><td><span class="badge ${r.kind === 'allow' ? 'ok' : 'err'}">${r.kind}</span></td>
    <td><code>${esc(r.cidr)}</code></td><td class="muted">${esc(r.note || '-')}</td>
    <td class="muted">${fmtTime(r.created_at)}</td>
    <td><button class="btn sm danger" data-del="${r.id}">删除</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">暂无规则，默认放行所有 IP</td></tr>';
}

$('#add-rule').onclick = async () => {
  const cidr = $('#rule-cidr').value.trim();
  if (!cidr) return toast('请填 IP 或 CIDR', true);
  try {
    await api('/ip-rules', { method: 'POST', body: { kind: $('#rule-kind').value, cidr, note: $('#rule-note').value.trim() } });
    $('#rule-cidr').value = ''; $('#rule-note').value = '';
    toast('规则已添加'); loadRules();
  } catch (e) { toast(e.message, true); }
};

$('#rule-table').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-del]');
  if (!b) return;
  await api(`/ip-rules/${b.dataset.del}`, { method: 'DELETE' });
  toast('已删除'); loadRules();
});

/* ---------------- 设置 ---------------- */

async function loadSettings() {
  const s = await api('/settings');
  $('#set-default-model').value = s.default_model || '';
  $('#set-session-reuse').value = String(s.session_reuse);
  $('#set-session-ttl').value = s.session_ttl_sec;
  $('#set-timeout').value = s.request_timeout_ms;
  $('#set-alias').value = JSON.stringify(s.model_alias || {}, null, 2);
  $('#ka-enabled').value = String(s.keepalive_enabled !== false);
  $('#ka-interval').value = s.keepalive_interval_sec || 900;
  $('#ka-preheat').value = String(s.signin_preheat !== false);
  loadKeepalive();
  const base = location.origin;
  $('#access-hint').textContent =
`# OpenAI SDK / 任意兼容客户端
base_url = ${base}/v1
api_key  = sk-ca-xxxxxxxx（在「密钥分发」创建）

# Anthropic 客户端（Claude Code 等）
ANTHROPIC_BASE_URL = ${base}
ANTHROPIC_AUTH_TOKEN = sk-ca-xxxxxxxx

# 直接 curl
curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer sk-ca-xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<模型ID>","messages":[{"role":"user","content":"你好"}]}'`;
}

$('#save-settings').onclick = async () => {
  let alias = {};
  const raw = $('#set-alias').value.trim();
  if (raw) {
    try { alias = JSON.parse(raw); } catch { return toast('模型别名不是合法 JSON', true); }
  }
  try {
    await api('/settings', {
      method: 'POST',
      body: {
        default_model: $('#set-default-model').value.trim(),
        session_reuse: $('#set-session-reuse').value === 'true',
        session_ttl_sec: Number($('#set-session-ttl').value) || 1800,
        request_timeout_ms: Number($('#set-timeout').value) || 300000,
        model_alias: alias,
      },
    });
    toast('设置已保存');
  } catch (e) { toast(e.message, true); }
};

$('#clear-sessions').onclick = async () => {
  await api('/sessions/clear', { method: 'POST' });
  toast('会话池已清空');
};

/* ---------------- 账号保活 ---------------- */

async function loadKeepalive() {
  try {
    const st = await api('/keepalive/status');
    const dead = st.accounts.filter((a) => a.enabled && a.state === 'invalid').length;
    const parts = [
      st.enabled ? `每 ${st.interval_sec} 秒心跳一次` : '自动保活已关闭',
      st.running ? '正在执行' : '',
    ].filter(Boolean);
    if (dead) parts.push(`⚠ ${dead} 个账号 Cookie 已失效`);
    $('#ka-summary').textContent = parts.join(' · ');
    $('#ka-summary').classList.toggle('warn-text', dead > 0);
  } catch { /* 状态拿不到不影响设置本身 */ }
}

$('#ka-save').onclick = async () => {
  try {
    await api('/settings', {
      method: 'POST',
      body: {
        keepalive_enabled: $('#ka-enabled').value === 'true',
        keepalive_interval_sec: Math.max(60, Number($('#ka-interval').value) || 900),
        signin_preheat: $('#ka-preheat').value === 'true',
      },
    });
    toast('保活设置已保存');
    loadKeepalive();
  } catch (e) { toast(e.message, true); }
};

$('#ka-run').onclick = async () => {
  const btn = $('#ka-run');
  btn.disabled = true;
  try {
    const r = await api('/keepalive/run', { method: 'POST' });
    if (r?.skipped === 'busy') toast('已有一轮保活正在执行', true);
    else {
      const list = r.results || [];
      const bad = list.filter((x) => x.ok === false);
      const skipped = list.filter((x) => x.skipped === 'recent').length;
      toast(bad.length
        ? `保活完成：${list.length - bad.length} 个正常、${bad.length} 个失效（${bad.map((b) => b.name).join('、')}）`
        : `保活完成：${list.length - skipped} 个探活通过${skipped ? `，${skipped} 个刚用过已跳过` : ''}`, bad.length > 0);
    }
    loadKeepalive();
    if (state.page === 'accounts') loadAccounts();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
};

$('#save-pw').onclick = async () => {
  try {
    await api('/password', { method: 'POST', body: { old_password: $('#pw-old').value, new_password: $('#pw-new').value } });
    toast('密码已更新'); $('#pw-old').value = ''; $('#pw-new').value = '';
  } catch (e) { toast(e.message, true); }
};

/* ---------------- 每日签到 ---------------- */

async function loadSignin() {
  try {
    const [st, logs] = await Promise.all([api('/signin/status'), api('/signin/logs?limit=30')]);
    $('#signin-enabled').value = st.enabled ? '1' : '0';
    $('#signin-hour').value = st.hour;
    $('#signin-minute').value = st.minute;
    $('#signin-next').textContent = st.enabled ? `下次执行 ${fmtTime(st.nextAt)}` : '自动签到已关闭';

    $('#signin-table tbody').innerHTML = st.accounts.length
      ? st.accounts.map((a) => {
          const t = a.today;
          const badge = !t ? '<span class="badge dim">未运行</span>'
            : t.ok ? '<span class="badge ok">已签到</span>' : '<span class="badge err">失败</span>';
          const credit = t && t.credit ? `+${fmtNum(t.credit)}` : '-';
          const note = !a.enabled ? '账号已停用'
            : t ? (t.claimed.length ? t.claimed.map((c) => c.title).join('、') : (t.errors[0] || '今日无可领取权益')) : '等待今日执行';
          return `<tr><td>${esc(a.name)}</td><td>${badge}</td><td>${credit}</td><td class="muted">${esc(note)}</td></tr>`;
        }).join('')
      : '<tr><td colspan="4" class="muted">还没有账号</td></tr>';

    $('#signin-log-table tbody').innerHTML = logs.length
      ? logs.map((r) => {
          const detail = r.claimed.length
            ? r.claimed.map((c) => `${c.title} +${c.amount}`).join('、')
            : (r.errors.length ? r.errors.join('；') : r.skipped.map((s) => s.title).join('、') || '-');
          return `<tr>
            <td>${fmtTime(r.ts)}</td>
            <td>${esc(r.accountName)}</td>
            <td>${r.ok ? '<span class="badge ok">成功</span>' : '<span class="badge err">失败</span>'}</td>
            <td>${r.credit ? '+' + fmtNum(r.credit) : '-'}</td>
            <td class="muted">${esc(detail).slice(0, 120)}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="5" class="muted">暂无记录</td></tr>';
  } catch (e) { toast(e.message, true); }
}

$('#signin-run').onclick = async () => {
  const btn = $('#signin-run');
  btn.disabled = true; btn.textContent = '签到中…';
  try {
    const r = await api('/signin/run', { method: 'POST' });
    const got = (r.results || []).reduce((s, x) => s + (x.total || 0), 0);
    const failed = (r.results || []).filter((x) => x.errors && x.errors.length).length;
    toast(failed ? `签到完成，${failed} 个账号有错误` : `签到完成，本次获得 ${got} 积分`, !!failed);
    loadSignin();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = '立即签到'; }
};

$('#signin-save').onclick = async () => {
  try {
    await api('/settings', {
      method: 'POST',
      body: {
        signin_enabled: $('#signin-enabled').value === '1',
        signin_hour: Number($('#signin-hour').value) || 0,
        signin_minute: Number($('#signin-minute').value) || 0,
      },
    });
    toast('签到设置已保存');
    loadSignin();
  } catch (e) { toast(e.message, true); }
};

$('#signin-refresh').onclick = loadSignin;

/* ---------------- Cookie 教程 ---------------- */

const GUIDE_KEY = 'deva-cookie-guide-open';

function setGuideOpen(open) {
  const panel = $('#cookie-guide');
  if (!panel) return;
  panel.classList.toggle('hidden', !open);
  $('#cookie-guide-toggle').textContent = open ? '? 收起教程' : '? 如何获取 Cookie';
  try { localStorage.setItem(GUIDE_KEY, open ? '1' : '0'); } catch { /* 忽略 */ }
}

$('#cookie-guide-toggle').onclick = () => {
  setGuideOpen($('#cookie-guide').classList.contains('hidden'));
};
$('#cookie-guide-close').onclick = () => setGuideOpen(false);

// 教程里的浏览器标签页
$('#guide-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.guide-tab');
  if (!tab) return;
  const target = tab.dataset.browser;
  for (const t of document.querySelectorAll('.guide-tab')) {
    t.classList.toggle('active', t === tab);
  }
  for (const pane of document.querySelectorAll('.guide-pane')) {
    pane.classList.toggle('hidden', pane.dataset.pane !== target);
  }
});

// 教程底部：直接打开添加账号弹窗
$('#cookie-guide-add').onclick = () => $('#add-account').click();

/* ---------------- 模态 ---------------- */

let modalOk = null;
function openModal(title, html, onOk, okText = '确定') {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-ok').textContent = okText;
  $('#modal-ok').classList.toggle('hidden', !onOk);
  modalOk = onOk;
  $('#modal').classList.remove('hidden');
  setTimeout(() => $('#modal-body input, #modal-body textarea')?.focus(), 60);
}
function closeModal() { $('#modal').classList.add('hidden'); modalOk = null; }
$('#modal-close').onclick = closeModal;
$('#modal-cancel').onclick = closeModal;
$('#modal-ok').onclick = async () => {
  if (!modalOk) return closeModal();
  const btn = $('#modal-ok');
  btn.disabled = true;
  try { await modalOk(); closeModal(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
};
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ---------------- 启动 ---------------- */

$('#theme-toggle').onclick = toggleTheme;
$('#theme-toggle-login').onclick = toggleTheme;
applyTheme(currentTheme());

// 上次展开过 Cookie 教程就保持展开，省得每次进来都要点
try {
  if (localStorage.getItem(GUIDE_KEY) === '1') setGuideOpen(true);
} catch { /* 忽略 */ }

window.addEventListener('resize', () => {
  if (state.page === 'dashboard') loadDashboard();
  if (state.page === 'usage') redrawCharts();
});
boot();

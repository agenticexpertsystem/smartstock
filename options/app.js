/* 期权数据浏览器: 直接在浏览器里读取 stockdata/option/chains_YYYYMMDD.parquet
   - hyparquet 解析 parquet (纯 JS, 无后端)
   - 行数据存成列式数组, 34 万行也能流畅筛选
   - 所有汇总 (每股一行 / 每到期日 / max pain / OI 墙 / IV 微笑) 均在本地计算 */
import { parquetRead } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm'

const DATA_DIR = '../stockdata/option'
const $ = s => document.querySelector(s)
const fmt = (v, n = 2) => (v == null || !isFinite(v)) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: n, maximumFractionDigits: n })
const pct = (v, n = 1) => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(n) + '%'
const int = v => (v == null || !isFinite(v)) ? '—' : Math.round(v).toLocaleString('en-US')
const cls = v => !isFinite(v) ? '' : (v > 0 ? 'pos' : v < 0 ? 'neg' : '')

const D = {}            // 列式数据
let rows = 0, tickers = [], byTicker = new Map(), cur = null, curExpiry = null

/* ---------- 加载 ---------- */
async function findFile() {
  const d = new Date()
  for (let i = 0; i < 45; i++) {
    const s = new Date(d.getTime() - i * 864e5).toISOString().slice(0, 10).replace(/-/g, '')
    const url = `${DATA_DIR}/chains_${s}.parquet`
    try {
      const r = await fetch(url, { method: 'HEAD' })
      if (r.ok) return { url, stamp: s, size: +(r.headers.get('content-length') || 0) }
    } catch (e) { /* 继续往前找 */ }
  }
  throw new Error('未找到 chains_*.parquet (最近 45 天)')
}

/** 下载整个文件为 ArrayBuffer (带进度), 并包装成 hyparquet 需要的 AsyncBuffer */
async function fetchBuffer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const total = +(res.headers.get('content-length') || 0)
  let buf
  if (res.body && total) {                       // 流式读取以显示进度
    const reader = res.body.getReader()
    const chunks = []
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value); got += value.length
      $('#bar').style.width = Math.min(70, got / total * 70).toFixed(0) + '%'
    }
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let off = 0
    for (const c of chunks) { all.set(c, off); off += c.length }
    buf = all.buffer
  } else {
    buf = await res.arrayBuffer()
  }
  $('#bar').style.width = '72%'
  return { byteLength: buf.byteLength, slice: (s, e) => buf.slice(s, e ?? buf.byteLength) }
}


async function load() {
  const { url, stamp, size } = await findFile()
  $('#file').textContent = url.split('/').pop() + (size ? ` (${(size / 1e6).toFixed(1)} MB)` : '')
  $('#srcPath').textContent = url
  // 整份下载再解析: GitHub Pages 会对 parquet 做 gzip, 且 Range 作用在压缩后的字节上,
  // 直接用 range 读 footer 会拿到 gzip 数据 (报错 "footer != PAR1")。
  const file = await fetchBuffer(url)
  await parquetRead({
    file, rowFormat: 'object',
    onComplete: data => {
      rows = data.length
      $('#bar').style.width = '80%'
      const cols = ['ticker', 'expiry', 'dte', 'type', 'strike', 'bid', 'ask', 'mid', 'iv', 'delta', 'gamma',
        'theta', 'vega', 'oi', 'volume', 'spot', 'iv30', 'hv20', 'iv_hv_ratio', 'pcr_oi', 'iv_rank',
        'name', 'sector']
      // parquet 的 int64 会变成 BigInt, 统一转成 Number; 字符串列保持原样
      const strCols = new Set(['ticker', 'type', 'name', 'sector', 'expiry'])
      const num = v => v == null ? NaN : (typeof v === 'bigint' ? Number(v) : v)
      for (const c of cols) D[c] = new Array(rows)
      for (let i = 0; i < rows; i++) {
        const r = data[i]
        for (const c of cols) D[c][i] = strCols.has(c) ? r[c] : num(r[c])
      }
      // 到期日统一成 YYYY-MM-DD (可能是字符串 / Date / 毫秒或微秒时间戳)
      for (let i = 0; i < rows; i++) {
        const e = D.expiry[i]
        if (typeof e === 'string') { D.expiry[i] = e.slice(0, 10); continue }
        if (e instanceof Date) { D.expiry[i] = e.toISOString().slice(0, 10); continue }
        let ms = typeof e === 'bigint' ? Number(e) : Number(e)
        if (ms > 1e14) ms = ms / 1000            // 微秒
        else if (ms < 1e11) ms = ms * 86400000   // 天数
        D.expiry[i] = new Date(ms).toISOString().slice(0, 10)
      }
      for (let i = 0; i < rows; i++) {
        const t = D.ticker[i]
        let a = byTicker.get(t)
        if (!a) byTicker.set(t, a = [])
        a.push(i)
      }
      tickers = [...byTicker.keys()].sort()
    }
  })
  const dd = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6)}`
  $('#meta').textContent = `${dd} · ${tickers.length} 只 · ${rows.toLocaleString()} 个合约 · ${new Set(D.expiry).size} 个到期日`
  $('#src').textContent = 'CBOE 延迟报价'
  $('#bar').style.width = '100%'
  $('#status').classList.add('hide'); $('#app').classList.remove('hide')
}

/* ---------- 派生计算 ---------- */
function tickerInfo(t) {
  const i = byTicker.get(t)[0]
  return { ticker: t, name: D.name[i], sector: D.sector[i], spot: D.spot[i], iv30: D.iv30[i], hv20: D.hv20[i],
    iv_hv: D.iv_hv_ratio[i], pcr: D.pcr_oi[i], iv_rank: D.iv_rank[i] }
}

/** 某股票按到期日聚合 */
function expiries(t) {
  const out = new Map()
  for (const i of byTicker.get(t)) {
    const e = D.expiry[i]
    let o = out.get(e)
    if (!o) out.set(e, o = { expiry: e, dte: D.dte[i], callOi: 0, putOi: 0, callVol: 0, putVol: 0, rows: [] })
    o.rows.push(i)
    if (D.type[i] === 'C') { o.callOi += D.oi[i] || 0; o.callVol += D.volume[i] || 0 }
    else { o.putOi += D.oi[i] || 0; o.putVol += D.volume[i] || 0 }
  }
  const spot = D.spot[byTicker.get(t)[0]]
  for (const o of out.values()) {
    o.pcr = o.callOi ? o.putOi / o.callOi : NaN
    // ATM IV: 最接近现价的 4 个合约
    const near = o.rows.filter(i => isFinite(D.iv[i]) && D.iv[i] > 0)
      .sort((a, b) => Math.abs(D.strike[a] - spot) - Math.abs(D.strike[b] - spot)).slice(0, 4)
    o.atmIv = near.length ? near.reduce((s, i) => s + D.iv[i], 0) / near.length : NaN
    o.impliedMove = isFinite(o.atmIv) ? o.atmIv * Math.sqrt(Math.max(o.dte, 1) / 365) : NaN
    // max pain: 使全部未平仓合约内在价值之和最小的行权价
    const ks = [...new Set(o.rows.map(i => D.strike[i]))].sort((a, b) => a - b)
    let best = NaN, bestV = Infinity
    for (const k of ks) {
      let v = 0
      for (const i of o.rows) {
        const oi = D.oi[i] || 0
        v += D.type[i] === 'P' ? Math.max(k - D.strike[i], 0) * oi : Math.max(D.strike[i] - k, 0) * oi
      }
      if (v < bestV) { bestV = v; best = k }
    }
    o.maxPain = best
    o.callWall = wall(o.rows, 'C'); o.putWall = wall(o.rows, 'P')
    o.put = pickPut(o.rows, +$('#tgtDelta').value || 0.2)
  }
  return [...out.values()].sort((a, b) => a.dte - b.dte)
}

const wall = (idx, ty) => {
  let s = NaN, m = -1
  for (const i of idx) if (D.type[i] === ty && (D.oi[i] || 0) > m) { m = D.oi[i]; s = D.strike[i] }
  return s
}

/** 该到期日内 delta 最接近目标、双边报价、且虚值(行权价 <= 现价)的 put
 *  只取虚值: 实值 put 的权利金含内在价值, 年化收益率没有可比性 */
function pickPut(idx, target) {
  let best = null, bd = 9
  for (const i of idx) {
    if (D.type[i] !== 'P' || !(D.bid[i] > 0) || !(D.ask[i] > 0) || !isFinite(D.delta[i])) continue
    if (!(D.strike[i] <= D.spot[i])) continue
    const d = Math.abs(Math.abs(D.delta[i]) - target)
    if (d < bd) { bd = d; best = i }
  }
  if (best == null) return null
  const mid = D.mid[best], k = D.strike[best], dte = Math.max(D.dte[best], 1)
  return { i: best, strike: k, delta: D.delta[best], bid: D.bid[best], ask: D.ask[best], mid, iv: D.iv[best],
    oi: D.oi[best], spread: mid > 0 ? (D.ask[best] - D.bid[best]) / mid : NaN,
    annYield: mid > 0 ? mid / k * 365 / dte : NaN, otm: k / D.spot[best] - 1 }
}

/** 全市场列表: 每只股票在 dte 区间内挑一个最接近目标 delta 的 put */
function listRows() {
  const lo = +$('#dteMin').value, hi = +$('#dteMax').value, tgt = +$('#tgtDelta').value || 0.2
  const minOi = +$('#minOi').value || 0, maxSp = +$('#maxSpread').value || Infinity
  const q = $('#q').value.trim().toUpperCase(), sec = $('#sector').value
  const out = []
  for (const t of tickers) {
    const inf = tickerInfo(t)
    if (sec && inf.sector !== sec) continue
    if (q && !t.includes(q) && !String(inf.name || '').toUpperCase().includes(q)) continue
    const idx = byTicker.get(t).filter(i => D.dte[i] >= lo && D.dte[i] <= hi)
    const p = pickPut(idx, tgt)
    if (p && (p.oi < minOi || !(p.spread <= maxSp))) continue
    if (!p && (minOi > 0 || isFinite(maxSp))) continue
    out.push({ ...inf, dte: p ? D.dte[p.i] : NaN, ...(p || {}) })
  }
  return out
}

/* ---------- 表格 ---------- */
let sortKey = 'annYield', sortDir = -1
const LIST_COLS = [
  ['ticker', '代码', r => `<td class="tk l">${r.ticker}</td>`],
  ['name', '名称', r => `<td class="l mut">${(r.name || '').slice(0, 22)}</td>`],
  ['sector', '行业', r => `<td class="l mut">${(r.sector || '').slice(0, 20)}</td>`],
  ['spot', '现价', r => `<td>${fmt(r.spot)}</td>`],
  ['iv30', 'IV30', r => `<td>${pct(r.iv30)}</td>`],
  ['hv20', 'HV20', r => `<td>${pct(r.hv20)}</td>`],
  ['iv_hv', 'IV/HV', r => `<td class="${r.iv_hv > 1.1 ? 'pos' : r.iv_hv < 0.9 ? 'neg' : ''}">${fmt(r.iv_hv)}</td>`],
  ['pcr', 'PCR', r => `<td>${fmt(r.pcr)}</td>`],
  ['dte', '到期', r => `<td>${int(r.dte)}</td>`],
  ['strike', 'Put行权', r => `<td>${fmt(r.strike)}</td>`],
  ['otm', '虚值', r => `<td>${pct(r.otm)}</td>`],
  ['delta', 'Delta', r => `<td>${fmt(r.delta, 3)}</td>`],
  ['mid', '权利金', r => `<td>${fmt(r.mid)}</td>`],
  ['annYield', '年化', r => `<td class="pos">${pct(r.annYield)}</td>`],
  ['spread', '点差', r => `<td class="${r.spread > 0.15 ? 'neg' : ''}">${pct(r.spread, 0)}</td>`],
  ['oi', 'OI', r => `<td>${int(r.oi)}</td>`],
]

function renderList() {
  const data = listRows()
  data.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey]
    if (typeof x === 'string' || typeof y === 'string') return String(x || '').localeCompare(String(y || '')) * sortDir
    const xa = isFinite(x) ? x : -Infinity, ya = isFinite(y) ? y : -Infinity
    return (xa - ya) * sortDir
  })
  $('#nList').textContent = `${data.length} 只`
  $('#list').tHead.innerHTML = '<tr>' + LIST_COLS.map(([k, h]) =>
    `<th data-k="${k}" class="${k === 'ticker' || k === 'name' || k === 'sector' ? 'l' : ''}">${h}${sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>'
  $('#list').tBodies[0].innerHTML = data.slice(0, 600).map(r =>
    `<tr data-t="${r.ticker}">` + LIST_COLS.map(([, , f]) => f(r)).join('') + '</tr>').join('')
  window._list = data
}

/* ---------- 个股 ---------- */
function showTicker(t) {
  cur = t
  const inf = tickerInfo(t)
  $('#listView').classList.add('hide'); $('#tickerView').classList.remove('hide')
  $('#tkName').textContent = `${t} · ${inf.name || ''}`
  $('#kpis').innerHTML = [
    ['现价', fmt(inf.spot)], ['IV30', pct(inf.iv30)], ['HV20', pct(inf.hv20)],
    ['IV/HV', fmt(inf.iv_hv)], ['PCR (OI)', fmt(inf.pcr)],
    ['IV Rank', isFinite(inf.iv_rank) ? pct(inf.iv_rank, 0) : '积累中'],
    ['行业', inf.sector || '—'], ['到期日数', expiries(t).length],
  ].map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')

  const ex = expiries(t)
  const EC = [['expiry', '到期日'], ['dte', '天'], ['atmIv', 'ATM IV'], ['impliedMove', '隐含波动'],
    ['callOi', 'Call OI'], ['putOi', 'Put OI'], ['pcr', 'PCR'], ['maxPain', 'Max Pain'],
    ['callWall', 'Call 墙'], ['putWall', 'Put 墙'], ['put', '目标Δ put'], ['ann', '年化']]
  $('#exp').tHead.innerHTML = '<tr>' + EC.map(([k, h]) => `<th class="${k === 'expiry' ? 'l' : ''}">${h}</th>`).join('') + '</tr>'
  $('#exp').tBodies[0].innerHTML = ex.map(o => `<tr data-e="${o.expiry}">
    <td class="l tk">${o.expiry}</td><td>${o.dte}</td><td>${pct(o.atmIv)}</td><td>${pct(o.impliedMove)}</td>
    <td>${int(o.callOi)}</td><td>${int(o.putOi)}</td><td>${fmt(o.pcr)}</td><td>${fmt(o.maxPain)}</td>
    <td>${fmt(o.callWall)}</td><td>${fmt(o.putWall)}</td>
    <td>${o.put ? fmt(o.put.strike) + ' @ ' + fmt(o.put.mid) : '—'}</td>
    <td class="pos">${o.put ? pct(o.put.annYield) : '—'}</td></tr>`).join('')

  drawTerm(ex, inf)
  selectExpiry(ex.find(o => o.dte >= 25) ? ex.find(o => o.dte >= 25).expiry : ex[0].expiry)
}

function selectExpiry(e) {
  curExpiry = e
  $('#expSel').textContent = e
  for (const tr of $('#exp').tBodies[0].rows) tr.classList.toggle('sel', tr.dataset.e === e)
  const ex = expiries(cur).find(o => o.expiry === e)
  drawSmile(ex); drawOi(ex)
  renderChain()
}

function renderChain() {
  const ex = expiries(cur).find(o => o.expiry === curExpiry)
  if (!ex) return
  const spot = D.spot[ex.rows[0]], band = (+$('#band').value || 100) / 100, minOi = +$('#minOi2').value || 0
  const ty = $('#typ').value
  const idx = ex.rows.filter(i => Math.abs(D.strike[i] / spot - 1) <= band && (D.oi[i] || 0) >= minOi &&
    (!ty || D.type[i] === ty)).sort((a, b) => (D.type[b] === 'P' ? 1 : 0) - (D.type[a] === 'P' ? 1 : 0) || D.strike[a] - D.strike[b])
  const H = ['类型', '行权价', '距现价', '买价', '卖价', '中间价', 'IV', 'Delta', 'Gamma', 'Theta', 'Vega', 'OI', '成交']
  $('#chain').tHead.innerHTML = '<tr>' + H.map((h, j) => `<th class="${j === 0 ? 'l' : ''}">${h}</th>`).join('') + '</tr>'
  $('#chain').tBodies[0].innerHTML = idx.map(i => `<tr>
    <td class="l ${D.type[i] === 'P' ? 'neg' : 'pos'}">${D.type[i] === 'P' ? 'Put' : 'Call'}</td>
    <td>${fmt(D.strike[i])}</td><td class="${cls(D.strike[i] / spot - 1)}">${pct(D.strike[i] / spot - 1)}</td>
    <td>${fmt(D.bid[i])}</td><td>${fmt(D.ask[i])}</td><td>${fmt(D.mid[i])}</td><td>${pct(D.iv[i])}</td>
    <td>${fmt(D.delta[i], 3)}</td><td>${fmt(D.gamma[i], 4)}</td><td>${fmt(D.theta[i], 3)}</td>
    <td>${fmt(D.vega[i], 3)}</td><td>${int(D.oi[i])}</td><td>${int(D.volume[i])}</td></tr>`).join('')
  window._chain = idx
}

/* ---------- 图表 (纯 SVG) ---------- */
function axes(svg, x0, x1, y0, y1, W = 480, H = 190, pad = 30) {
  const sx = v => pad + (v - x0) / ((x1 - x0) || 1) * (W - pad - 8)
  const sy = v => H - 22 - (v - y0) / ((y1 - y0) || 1) * (H - 34)
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.innerHTML = `<line x1="${pad}" y1="${H - 22}" x2="${W - 8}" y2="${H - 22}" stroke="currentColor" stroke-opacity=".25"/>
    <line x1="${pad}" y1="8" x2="${pad}" y2="${H - 22}" stroke="currentColor" stroke-opacity=".25"/>
    <text x="2" y="14" font-size="10" fill="currentColor" opacity=".6">${(y1 * 100).toFixed(0)}%</text>
    <text x="2" y="${H - 24}" font-size="10" fill="currentColor" opacity=".6">${(y0 * 100).toFixed(0)}%</text>`
  return { sx, sy, W, H, pad }
}

function drawTerm(ex, inf) {
  const svg = $('#chTerm'), pts = ex.filter(o => isFinite(o.atmIv))
  if (!pts.length) { svg.innerHTML = ''; return }
  const ys = pts.map(o => o.atmIv), y0 = Math.min(...ys, inf.hv20 || 1e9) * .9, y1 = Math.max(...ys, inf.hv20 || 0) * 1.1
  const { sx, sy, W, H } = axes(svg, 0, Math.max(...pts.map(o => o.dte)), y0, y1)
  const line = pts.map(o => `${sx(o.dte)},${sy(o.atmIv)}`).join(' ')
  svg.innerHTML += `<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>` +
    pts.map(o => `<circle cx="${sx(o.dte)}" cy="${sy(o.atmIv)}" r="2.5" fill="var(--accent)"><title>${o.expiry} · ${o.dte}天 · ATM IV ${pct(o.atmIv)}</title></circle>`).join('') +
    (isFinite(inf.hv20) ? `<line x1="30" y1="${sy(inf.hv20)}" x2="${W - 8}" y2="${sy(inf.hv20)}" stroke="var(--warn)" stroke-dasharray="4 3"/>
      <text x="${W - 60}" y="${sy(inf.hv20) - 4}" font-size="10" fill="var(--warn)">HV20</text>` : '') +
    `<text x="${W - 40}" y="${H - 6}" font-size="10" fill="currentColor" opacity=".6">天</text>`
}

function drawSmile(ex) {
  const svg = $('#chSmile')
  if (!ex) { svg.innerHTML = ''; return }
  const spot = D.spot[ex.rows[0]]
  const pts = ex.rows.filter(i => isFinite(D.iv[i]) && D.iv[i] > 0 && Math.abs(D.strike[i] / spot - 1) <= 0.35)
  if (!pts.length) { svg.innerHTML = ''; return }
  const xs = pts.map(i => D.strike[i]), ys = pts.map(i => D.iv[i])
  const { sx, sy, W, H } = axes(svg, Math.min(...xs), Math.max(...xs), Math.min(...ys) * .95, Math.max(...ys) * 1.05)
  const seg = ty => pts.filter(i => D.type[i] === ty).sort((a, b) => D.strike[a] - D.strike[b])
    .map(i => `${sx(D.strike[i])},${sy(D.iv[i])}`).join(' ')
  svg.innerHTML += `<polyline points="${seg('C')}" fill="none" stroke="var(--up)" stroke-width="1.8"/>
    <polyline points="${seg('P')}" fill="none" stroke="var(--down)" stroke-width="1.8"/>
    <line x1="${sx(spot)}" y1="8" x2="${sx(spot)}" y2="${H - 22}" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="3 3"/>
    <text x="${sx(spot) + 3}" y="16" font-size="10" fill="currentColor" opacity=".6">现价 ${fmt(spot)}</text>`
}

function drawOi(ex) {
  const svg = $('#chOi')
  if (!ex) { svg.innerHTML = ''; return }
  const spot = D.spot[ex.rows[0]]
  const idx = ex.rows.filter(i => Math.abs(D.strike[i] / spot - 1) <= 0.3 && (D.oi[i] || 0) > 0)
  if (!idx.length) { svg.innerHTML = ''; return }
  const xs = idx.map(i => D.strike[i]), maxOi = Math.max(...idx.map(i => D.oi[i]))
  const W = 480, H = 190, pad = 30
  const sx = v => pad + (v - Math.min(...xs)) / ((Math.max(...xs) - Math.min(...xs)) || 1) * (W - pad - 8)
  const hgt = v => v / maxOi * (H - 40)
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.innerHTML = `<line x1="${pad}" y1="${H - 22}" x2="${W - 8}" y2="${H - 22}" stroke="currentColor" stroke-opacity=".25"/>
    <text x="2" y="14" font-size="10" fill="currentColor" opacity=".6">${int(maxOi)}</text>` +
    idx.map(i => {
      const h = hgt(D.oi[i]), c = D.type[i] === 'C' ? 'var(--up)' : 'var(--down)'
      return `<rect x="${sx(D.strike[i]) - 1.5}" y="${H - 22 - h}" width="3" height="${h}" fill="${c}" opacity=".75">
        <title>${D.type[i] === 'C' ? 'Call' : 'Put'} ${fmt(D.strike[i])} · OI ${int(D.oi[i])}</title></rect>`
    }).join('') +
    `<line x1="${sx(spot)}" y1="8" x2="${sx(spot)}" y2="${H - 22}" stroke="currentColor" stroke-opacity=".5" stroke-dasharray="3 3"/>`
}

/* ---------- 导出 ---------- */
function download(name, text, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type }))
  a.download = name; a.click(); URL.revokeObjectURL(a.href)
}
const toCsv = (cols, rowsArr) => [cols.join(','), ...rowsArr.map(r => cols.map(c => {
  const v = r[c]; return v == null || (typeof v === 'number' && !isFinite(v)) ? '' : v
}).join(','))].join('\n')

/* ---------- 事件 ---------- */
function bind() {
  $('#list').addEventListener('click', e => {
    const th = e.target.closest('th'); const tr = e.target.closest('tr')
    if (th && th.dataset.k) { const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : -1; sortKey = k; renderList() }
    else if (tr && tr.dataset.t) showTicker(tr.dataset.t)
  })
  $('#exp').addEventListener('click', e => { const tr = e.target.closest('tr'); if (tr?.dataset.e) selectExpiry(tr.dataset.e) })
  $('#back').onclick = () => { $('#tickerView').classList.add('hide'); $('#listView').classList.remove('hide') }
  for (const id of ['#q', '#sector', '#dteMin', '#dteMax', '#tgtDelta', '#minOi', '#maxSpread'])
    $(id).addEventListener('input', renderList)
  for (const id of ['#typ', '#band', '#minOi2']) $(id).addEventListener('input', renderChain)
  $('#csv').onclick = () => download(`options_list_${Date.now()}.csv`,
    toCsv(['ticker', 'name', 'sector', 'spot', 'iv30', 'hv20', 'iv_hv', 'pcr', 'dte', 'strike', 'delta', 'bid', 'ask',
      'mid', 'annYield', 'spread', 'oi'], window._list || []))
  $('#csv2').onclick = () => download(`${cur}_${curExpiry}.csv`, toCsv(
    ['type', 'strike', 'bid', 'ask', 'mid', 'iv', 'delta', 'gamma', 'theta', 'vega', 'oi', 'volume'],
    (window._chain || []).map(i => ({ type: D.type[i], strike: D.strike[i], bid: D.bid[i], ask: D.ask[i], mid: D.mid[i],
      iv: D.iv[i], delta: D.delta[i], gamma: D.gamma[i], theta: D.theta[i], vega: D.vega[i], oi: D.oi[i], volume: D.volume[i] }))))
  $('#jsonBtn').onclick = () => {
    const inf = tickerInfo(cur)
    const doc = { ...inf, expiries: expiries(cur).map(o => ({
      expiry: o.expiry, dte: o.dte, call_oi: o.callOi, put_oi: o.putOi, atm_iv: o.atmIv, max_pain: o.maxPain,
      calls: o.rows.filter(i => D.type[i] === 'C').map(contract),
      puts: o.rows.filter(i => D.type[i] === 'P').map(contract) })) }
    download(`${cur}_options.json`, JSON.stringify(doc, null, 1), 'application/json')
  }
  $('#theme').onclick = () => {
    const r = document.documentElement
    r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark'
  }
}
const contract = i => ({ strike: D.strike[i], bid: D.bid[i], ask: D.ask[i], mid: D.mid[i], iv: D.iv[i],
  delta: D.delta[i], gamma: D.gamma[i], theta: D.theta[i], vega: D.vega[i], oi: D.oi[i], volume: D.volume[i] })

/* ---------- 启动 ---------- */
load().then(() => {
  const secs = [...new Set(tickers.map(t => tickerInfo(t).sector).filter(Boolean))].sort()
  $('#sector').innerHTML = '<option value="">全部行业</option>' + secs.map(s => `<option>${s}</option>`).join('')
  bind(); renderList()
}).catch(err => {
  $('#status').innerHTML = `<div class="warnbox">加载失败: ${err.message}<br>
    请确认 <code>stockdata/option/chains_YYYYMMDD.parquet</code> 存在, 且通过 http(s) 访问本页
    (本地可运行 <code>python -m http.server</code> 后打开 http://localhost:8000/options/)</div>`
  console.error(err)
})

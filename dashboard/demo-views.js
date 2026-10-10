// Slideshow for reports that carry a `demo` block (results_demo.py). app.js renders this instead of the usual
// report when data.demo exists: four slides, one at a time, with Back/Next, numbered slide buttons and arrow keys.
//   1 The result  ·  2 Every model we tried  ·  3 Cheapest safe choice + the fixes  ·  4 The pull request
// Every number comes from data; the only thing the viewer types is a test case volume (slide 1).

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const usd = (n, d = 2) => typeof n === 'number' ? '$' + n.toLocaleString('en-US', {minimumFractionDigits: d, maximumFractionDigits: d}) : 'n/a';
const pct = n => typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : 'n/a';
const frac = o => o ? `${o.n}/${o.of}` : '–';
const STEPS = ['classify', 'decide', 'draft', 'tone'];
// One name per test set, used on every screen: practice 24 · hard 12 · holdout 12 · newest 8 (56 in all).
const SPLIT = {dev: 'practice', hard: 'hard', holdout2: 'holdout', fresh3: 'newest'};

const SLIDES = [
  {id: 'results', title: 'The result'},
  {id: 'models', title: 'Every model we tried'},
  {id: 'choice', title: 'Cheapest safe choice + fixes'},
  {id: 'pr', title: 'The pull request'},
];
// Links from the earlier tab layout keep working.
const OLD_LINKS = {savings: 'results', evidence: 'choice'};

function slideFromHash() {
  const h = location.hash.slice(1);
  const id = OLD_LINKS[h] || h;
  const i = SLIDES.findIndex((s, n) => s.id === id || String(n + 1) === id);
  return i < 0 ? 0 : i;
}

export const demoState = {slide: slideFromHash(), volume: null, decisions: {}, editing: null, edits: {}, choice: 'cheap', view: 'deck', live: null, liveCap: 2};

// The reviewer picks one option: the cheapest model per step ('cheap') or gpt-5.6-sol everywhere ('sol').
const chosenRec = d => demoState.choice === 'sol' ? d.fallback : d.recommended;
const chooser = d => `<div class="sl-choose" role="group" aria-label="Option to ship">
  <span class="sl-label">Option</span>
  <button class="sl-choice" data-choice="cheap" aria-pressed="${demoState.choice === 'cheap'}">Cheapest mix <small>${usd(d.recommended.usd_per_1k)} per 1,000</small></button>
  <button class="sl-choice" data-choice="sol" aria-pressed="${demoState.choice === 'sol'}">gpt-5.6-sol + tone fix <small>${usd(d.fallback.usd_per_1k)} per 1,000</small></button>
</div>`;

// ---- Slide 1: the result ---------------------------------------------------------------------------
function slideResults(data) {
  const d = data.demo, old = d.totals_usd_per_1k.all_old, rec = chosenRec(d), q = d.quality, c = d.confidence;
  const r = d.pool?.retest, cheap = demoState.choice === 'cheap' && rec.config === 'cheap_mix' && r;
  // The cheap mix is judged on every test case it ran: practice, holdout and newest.
  const sets = cheap ? [r.dev, r.holdout2_seen, r.fresh3.mix] : [];
  const cases = sets.reduce((n, x) => n + x.of, 0);
  const before = cheap ? d.pool.mix.holdout2.regressed.length : c.regressed_dev + c.regressed_heldout_before;
  const after = cheap ? sets.reduce((n, x) => n + x.regressed, 0) : data.candidates[0].summary.verdict_counts_after_fix?.REGRESSED;
  const passed = cheap ? sets.reduce((n, x) => n + x.passed_all * x.of, 0) / cases : q.new_fixed.passed_all;
  const vol = demoState.volume ?? d.monthly_requests_default;
  const price = Object.values(d.prices)[0] || {};
  return `
  <p class="sl-kicker">${esc(d.pair.old)} → ${cheap ? 'cheaper models' : esc(d.pair.new)} · 4-step support agent · gpt-4 shuts down Oct 23</p>
  ${chooser(d)}
  <h2 class="sl-title" tabindex="-1">${cheap ? 'Move every step to a cheaper model, with two one-line prompt fixes' : `Switch to <span class="dm-mono">${esc(rec.assignment.classify)}</span> on every step with a one-line prompt fix`}</h2>
  <div class="sl-kpis">
    <div class="sl-kpi">
      <span class="sl-label">Test cases that got worse</span>
      <strong>${before} → ${after}</strong>
      <small>${cheap ? `${before} on the first try, ${after} of ${cases} after the two prompt fixes (24 practice, 12 holdout, ${r.fresh3.mix.of} newest). The newest set is small.` : `out of ${c.dev_tickets + c.heldout_tickets} test cases (24 practice + 12 hard), before → after the fix.`}</small>
    </div>
    <div class="sl-kpi">
      <span class="sl-label">Accuracy</span>
      <strong>${pct(q.old.passed_all)} → ${pct(passed)}</strong>
      <small>replies passing every check${cheap ? ` across ${cases} test cases` : ` (${pct(q.new_as_is.passed_all)} without the fix)`}. Correct-answer score ${q.old.gold.toFixed(3)} → ${(cheap ? 1 : q.new_fixed.gold).toFixed(3)}.</small>
    </div>
    <div class="sl-kpi sl-kpi-good">
      <span class="sl-label">Model cost per 1,000 test cases</span>
      <strong>${usd(old)} → ${usd(rec.usd_per_1k)}</strong>
      <small>${Math.round((1 - rec.usd_per_1k / old) * 100)}% lower${rec.api_only ? `, API calls only. The ${esc(rec.self_hosted_steps.join(', '))} step runs on your own computer (about ${Math.round(rec.self_hosted_tokens_per_ticket)} tokens per test case, not priced).` : ''}</small>
    </div>
  </div>
  <div class="sl-calc">
    <label for="dm-volume">Uses per month</label>
    <input id="dm-volume" class="dm-input" type="number" min="0" step="1000" inputmode="numeric" value="${vol}">
    <p aria-live="polite">Today <strong id="dm-today">${usd(vol * old / 1000, 0)}</strong> → after <strong id="dm-after">${usd(vol * rec.usd_per_1k / 1000, 0)}</strong>.
      You save <strong class="dm-good" id="dm-save">${usd(vol * (old - rec.usd_per_1k) / 1000, 0)}</strong> a month.</p>
  </div>
  ${caseGrid(d)}
  ${liveButtons(d)}
  <p class="sl-foot">Real model runs on hand-written test cases, ${c.runs_per_ticket} runs each. Same prompts, tools and test cases on both sides; only the models changed.
    Cost = measured tokens × list prices (${esc(price.source)}, checked ${esc(price.checked)}); model cost only. The volume is your number.</p>`;
}

// ---- Every test case: input, expected answer, and what each model said ---------------------------------------
const CASE_COLS = [['old', 'gpt-4 (today)'], ['sol', 'gpt-5.6-sol, as is'], ['sol_fix', 'gpt-5.6-sol + tone fix'], ['cheap_fix', 'Cheapest mix + classify fix']];

function caseGrid(d) {
  if (!d.cases?.length) return '';
  const key = demoState.choice === 'sol' ? 'sol_fix' : 'cheap_fix';
  const tiles = d.cases.map((c, i) => {
    const r = c[key], state = !r ? 'na' : r.passed === r.of ? 'ok' : 'bad';
    return `<button class="sl-case ${state}" data-case="${i}" title="${esc(c.id)} · ${!r ? 'not run for this option' : `${r.passed}/${r.of} runs passed every check`}" aria-label="Test case ${esc(c.id)}, ${state === 'ok' ? 'passed' : state === 'bad' ? 'failed' : 'not run'}">${esc(c.id.replace(/^t/, ''))}</button>`;
  }).join('');
  return `<div class="sl-cases"><p class="sl-label">Every test case, for ${demoState.choice === 'sol' ? 'gpt-5.6-sol + tone fix' : 'the cheapest mix'} · click one to compare old and new</p>
    <div class="sl-case-grid">${tiles}</div>
    <p class="dm-foot"><span class="sl-case ok sl-key"></span> passed every check in all runs <span class="sl-case bad sl-key"></span> failed a check <span class="sl-case na sl-key"></span> not run for this option</p></div>`;
}

function openCase(d, i) {
  const c = d.cases[i], dialog = document.querySelector('#detail');
  if (!c || !dialog) return;
  const exp = c.expected ? Object.entries(c.expected).map(([k, v]) => `${k}: ${v ?? 'none'}`).join(' · ') : '';
  const col = ([k, name]) => {
    const r = c[k];
    return `<section class="dm-case-col${k === (demoState.choice === 'sol' ? 'sol_fix' : 'cheap_fix') ? ' sel' : ''}"><h4>${esc(name)}</h4>${!r ? '<p class="dm-foot">Not run on this test case.</p>' :
      `<p class="dm-foot"><span class="${r.passed === r.of ? 'dm-good' : 'dm-bad'}">${r.passed}/${r.of}</span> runs passed every check${r.failed?.length ? ` · failed: ${esc(r.failed.join(', '))}` : ''}</p><pre class="dm-case-out">${esc(r.output)}</pre>`}</section>`;
  };
  dialog.innerHTML = `<div class="detail-head"><div><p class="eyebrow">${esc(c.id)} · ${esc(SPLIT[c.split] || c.split)}${c.tricky ? ' · tricky' : ''}</p><h2 id="detail-title">Old vs new model</h2></div><button class="close" aria-label="Close details">×</button></div>
    <div class="detail-body"><h3 class="sl-label">Input</h3><p class="dm-case-in">${esc(c.text)}</p>
    ${exp ? `<p class="dm-foot">Expected: ${esc(exp)}${c.note ? ` · ${esc(c.note)}` : ''}</p>` : ''}
    <div class="dm-case-cols">${CASE_COLS.map(col).join('')}${liveRows(c.id).length ? `<section class="dm-case-col sel"><h4>Live run</h4>${liveRows(c.id).map(r => `<p class="dm-foot"><span class="${r.passed ? 'dm-good' : 'dm-bad'}">run ${r.run}: ${r.error ? 'error' : r.passed ? 'passed' : 'failed ' + esc(r.failed.join(', '))}</span></p><pre class="dm-case-out">${esc(r.output ?? r.error ?? '')}</pre>`).join('')}</section>` : ''}</div>
    <div class="dm-actions"><button class="button" id="dm-case-live">▶ Run this test case live</button></div></div>`;
  dialog.querySelector('.close').onclick = () => dialog.close();
  dialog.querySelector('#dm-case-live').onclick = () => { dialog.close(); window.__upshiftLive?.(c.id); };
  dialog.showModal();
}

// ---- Live runs: call the real models on chosen test cases, on a screen of their own -------------------------
const LIVE_SCOPES = [['fresh3', 'Newest (8)'], ['dev', 'Practice (24)'], ['holdout2', 'Holdout (12)'], ['hard', 'Hard (12)'], ['all', 'All 56']];
const SCOPE_N = {fresh3: 8, dev: 24, holdout2: 12, hard: 12, all: 56};
const liveRows = id => (demoState.live?.rows || []).filter(r => r.id === id);

function liveButtons(d) {
  const L = demoState.live;
  return `<div class="lv-start"><button class="button primary" id="dm-live-open">▶ Run live</button>
    ${L ? `<button class="button" data-live-view>View ${L.state === 'running' ? 'the run in progress' : 'last live run'}</button>` : ''}
    <span class="dm-foot">Calls the real models on these test cases, instead of replaying recorded runs. It costs money; you'll see an estimate first.</span></div>`;
}

function openLiveConfirm(data, only) {
  const d = data.demo, dialog = document.querySelector('#detail'), rec = chosenRec(d), sol = demoState.choice === 'sol';
  if (!dialog) return;
  const scopes = only ? '' : `<label class="dm-label" for="lv-scope">Test cases</label><select id="lv-scope" class="dm-input">${LIVE_SCOPES.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select>`;
  dialog.innerHTML = `<div class="detail-head"><div><p class="eyebrow">LIVE RUN · COSTS MONEY</p><h2 id="detail-title">Run ${sol ? 'gpt-5.6-sol + tone fix' : 'the cheapest mix'} live</h2></div><button class="close" aria-label="Close">×</button></div>
    <div class="detail-body">
      <p>${sol ? 'gpt-5.6-sol on every step, with the tone fix.' : `${STEPS.map(st => `${st} → <span class="dm-mono">${esc(rec.assignment[st])}</span>`).join(', ')}, with the classify and tone fixes.`}</p>
      ${scopes}${only ? `<p><strong>Test case ${esc(only)}</strong> only.</p>` : ''}
      <label class="dm-label" for="lv-runs">Runs per test case</label><select id="lv-runs" class="dm-input"><option value="1">1</option><option value="3">3 (measures run-to-run noise)</option></select>
      <p id="lv-est" class="dm-foot" aria-live="polite"></p>
      <p class="dm-foot">Uses the OpenAI key in the environment of the server${sol ? '' : ', and Ollama on this computer for the tone step'}. Hard cap: ${usd(demoState.liveCap)} per run; it stops by itself if it gets there. Rows are saved to a new file in <span class="dm-mono">results/</span>; recorded runs aren't touched.</p>
      <div class="dm-actions"><button class="button primary" id="lv-go">Start live run</button><button class="button" id="lv-cancel">Cancel</button></div>
      <p id="lv-err" class="dm-bad" role="alert"></p>
    </div>`;
  const est = () => {
    const n = only ? 1 : SCOPE_N[dialog.querySelector('#lv-scope').value], runs = Number(dialog.querySelector('#lv-runs').value);
    const cost = n * runs * rec.usd_per_1k / 1000;
    dialog.querySelector('#lv-est').innerHTML = `${n * runs} test case runs × 4 steps. Estimated model cost <strong>about ${cost < 0.01 ? '$' + cost.toFixed(3) : usd(cost)}</strong>${sol ? '' : ' in API calls (the tone step runs locally and isn\'t priced)'}. Based on measured tokens in the recorded runs.`;
  };
  dialog.querySelectorAll('select').forEach(x => x.onchange = est);
  est();
  dialog.querySelector('.close').onclick = dialog.querySelector('#lv-cancel').onclick = () => dialog.close();
  dialog.showModal();
  dialog.querySelector('#lv-go').onclick = async () => {
    const body = {option: demoState.choice, runs: Number(dialog.querySelector('#lv-runs').value),
      ...(only ? {cases: [only]} : {sets: dialog.querySelector('#lv-scope').value})};
    try {
      const r = await fetch('/api/live-run', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
      const out = await r.json().catch(() => ({error: `the server answered ${r.status}`}));
      if (out.error) { dialog.querySelector('#lv-err').textContent = out.error; return; }
    } catch { dialog.querySelector('#lv-err').textContent = 'the upshift server isn\'t reachable (start it with npm start)'; return; }
    demoState.live = {option: demoState.choice, state: 'running', total: 0, ids: [], rows: [], spent_usd: 0, started: Date.now(), runs: body.runs};
    demoState.view = 'live';
    dialog.close();
    const panel = document.querySelector('#demo-panel');
    panel.outerHTML = demoSection(data); bindDemo(document.querySelector('#app'), data);
    window.scrollTo({top: 0});
  };
}

const LV_STATE = {running: ['Running', 'pending'], done: ['Finished', 'accepted'], budget: ['Stopped at the spend cap', 'warn'],
  stopped: ['Stopped', 'warn'], error: ['Problem', 'rejected']};

function liveScreen(data) {
  const d = data.demo, L = demoState.live || {rows: [], ids: [], state: 'running'}, st = LV_STATE[L.state] || LV_STATE.running;
  const byId = new Map(d.cases.map(c => [c.id, c]));
  const ids = L.ids?.length ? L.ids : [], total = L.total || 0, done = L.rows.length;
  const tiles = ids.map(id => {
    const rs = liveRows(id), bad = rs.some(r => r.passed === false || r.error), ok = rs.length && rs.every(r => r.passed);
    const state = !rs.length ? 'pending' : bad ? 'bad' : ok && rs.length >= L.runs ? 'ok' : 'part';
    return `<button class="sl-case lv-${state}" data-case-live="${esc(id)}" title="${esc(id)} · ${rs.length}/${L.runs} runs done" aria-label="Test case ${esc(id)}, ${state}">${esc(id.replace(/^t/, ''))}</button>`;
  }).join('');
  const verdict = (r, c) => {
    if (r.error) return ['error', 'Error: ' + r.error.slice(0, 120)];
    const oldOK = c?.old && c.old.passed === c.old.of;
    return r.passed ? [oldOK ? 'ok' : 'better', oldOK ? 'Passes, like gpt-4' : 'Passes (gpt-4 failed a check)'] : [oldOK ? 'bad' : 'same', oldOK ? `Worse than gpt-4: failed ${r.failed.join(', ') || 'a check'}` : 'Fails, like gpt-4'];
  };
  const feed = [...L.rows].reverse().slice(0, 40).map(r => {
    const c = byId.get(r.id), [cls, msg] = verdict(r, c);
    return `<article class="lv-row"><div class="lv-row-head"><strong class="dm-mono">${esc(r.id)}</strong><span class="lv-chip ${cls}">${esc(msg)}</span>
      <span class="dm-foot">run ${r.run} · ${r.latency_s}s · ${r.cost_usd ? '$' + r.cost_usd.toFixed(4) : 'no priced calls'}</span></div>
      <p class="dm-case-in">${esc(r.text)}</p>
      <div class="dm-case-cols"><section class="dm-case-col"><h4>gpt-4 (recorded)</h4>${c?.old ? `<p class="dm-foot">${c.old.passed}/${c.old.of} runs passed every check</p><pre class="dm-case-out">${esc(c.old.output)}</pre>` : '<p class="dm-foot">no recorded run</p>'}</section>
      <section class="dm-case-col sel"><h4>Live · ${esc(L.label || '')}</h4><pre class="dm-case-out">${esc(r.output ?? r.error ?? '')}</pre></section></div></article>`;
  }).join('');
  const elapsed = Math.max(0, Math.round((Date.now() - (L.started || Date.now())) / 1000));
  const worse = L.rows.filter(r => r.passed === false && byId.get(r.id)?.old && byId.get(r.id).old.passed === byId.get(r.id).old.of).length;
  return `<section id="demo-panel" class="sl-deck sl-live" aria-label="Live run">
    <div class="lv-top"><button class="button" data-live-back>← Back to the report</button><span class="dm-pill ${st[1]}" aria-live="polite">${st[0]}</span></div>
    <article class="sl-slide">
      <p class="sl-kicker">Live run · real model calls · ${esc(L.option === 'sol' ? 'gpt-5.6-sol + tone fix' : 'cheapest mix')}</p>
      <h2 class="sl-title" tabindex="-1">${L.state === 'error' && !total ? "The live run didn't start" : `${done} of ${total || '…'} test case runs done`}</h2>
      <div class="lv-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${total ? done / total * 100 : 0}%"></i></div>
      <p class="dm-foot">Spent <strong>${usd(L.spent_usd || 0, 4)}</strong> of the ${usd(L.max_usd || demoState.liveCap)} cap · ${elapsed}s since start · ${worse} worse than gpt-4 on hard checks so far${L.models ? ` · ${STEPS.map(x => `${x}: ${esc(L.models[x])}`).join(' · ')}` : ''}</p>
      ${L.error ? `<p class="lv-error" role="alert"><strong>${L.state === 'error' ? 'Problem:' : 'Note:'}</strong> ${esc(L.error)}</p>` : ''}
      <div class="sl-case-grid">${tiles}</div>
      <p class="dm-foot"><span class="sl-case lv-pending sl-key"></span> waiting <span class="sl-case lv-part sl-key"></span> some runs in <span class="sl-case lv-ok sl-key"></span> passed every check <span class="sl-case lv-bad sl-key"></span> a check failed or errored · click a tile to compare</p>
      <div class="dm-actions">${L.state === 'running' ? '<button class="button dm-reject" data-live-stop>Stop</button>' : '<button class="button primary" data-live-again>Run again…</button>'}</div>
      <div class="lv-feed" aria-live="polite">${feed || '<p class="dm-foot">Waiting for the first result…</p>'}</div>
    </article></section>`;
}

let liveBound = false;
function bindLive(root, data) {
  if (liveBound) return;
  liveBound = true;
  const redrawLive = () => {
    const panel = document.querySelector('#demo-panel');
    if (!panel || demoState.view !== 'live') return;
    const y = window.scrollY;
    panel.outerHTML = demoSection(data); bindDemo(document.querySelector('#app'), data);
    window.scrollTo({top: y});
  };
  fetch('/api/live-run', {cache: 'no-store'}).then(r => r.json()).then(j => {
    if (j.max_usd) demoState.liveCap = j.max_usd;
    if (j.run && !demoState.live) {
      demoState.live = j.run;
      if (demoState.view === 'deck' && document.querySelector('#demo-panel')) { document.querySelector('#demo-panel').outerHTML = demoSection(data); bindDemo(document.querySelector('#app'), data); }
    }
  }).catch(() => {});
  try {
    const es = new EventSource('/api/live');
    es.addEventListener('liverun', e => {
      const ev = JSON.parse(e.data), L = demoState.live || (demoState.live = {rows: [], ids: [], state: 'running', started: Date.now(), runs: 1});
      if (ev.event === 'start') Object.assign(L, {label: ev.label, total: ev.total, ids: ev.ids, runs: ev.runs, models: ev.models, max_usd: ev.max_usd, option: ev.option, state: 'running', rows: [], spent_usd: 0, error: null});
      if (ev.event === 'row') { L.rows.push(ev); L.spent_usd = ev.spent_usd; }
      if (ev.event === 'done') Object.assign(L, {state: ev.stopped_on_budget ? 'budget' : 'done', spent_usd: ev.spent_usd});
      if (ev.event === 'error') Object.assign(L, {state: 'error', error: ev.message});
      if (ev.event === 'stopped') L.state = 'stopped';
      redrawLive();
    });
  } catch { /* no live feed without the server */ }
}

// ---- Slide 2: every model ----------------------------------------------------------------------------
const stepCell = v => !v ? '–' : v.usd_per_1k != null ? usd(v.usd_per_1k) : `${v.tokens.toLocaleString('en-US')} tok`;
const worse = v => v ? `<span class="${v.regressed ? 'dm-bad' : 'dm-good'}">${v.regressed}</span><span class="dm-of">/${v.of}</span>` : '–';

function chosenPerStep(d) {
  return Object.fromEntries(Object.entries(d.pool?.ladder || {}).map(([s, tried]) => [s, (tried.find(t => t.passed) || {}).model]));
}

function slideModels(data) {
  const d = data.demo, chosen = chosenPerStep(d);
  const rank = m => m.role === 'today' ? -2 : m.usd_per_1k ?? 1e9;
  const rows = [...(d.models || [])].sort((a, b) => rank(a) - rank(b)).map(m => `
    <tr${m.role === 'today' ? ' class="dm-today"' : ''}>
      <th scope="row"><span class="dm-mono">${esc(m.model)}</span>${m.role === 'today' ? ' <span class="dm-pill">today</span>' : ''}
        <small class="sl-host">${m.hosting === 'self-hosted' ? 'your own computer · open-source' : 'OpenAI API'}</small></th>
      ${STEPS.map(s => `<td class="dm-num${chosen[s] === m.model ? ' sl-pick' : ''}">${stepCell(m.per_step?.[s])}${chosen[s] === m.model ? ' <span aria-label="chosen for this step">✓</span>' : ''}</td>`).join('')}
      <td class="dm-num sl-total">${m.usd_per_1k != null ? usd(m.usd_per_1k) : `${Math.round(m.tokens_per_ticket || 0).toLocaleString('en-US')} tok`}</td>
      <td class="dm-num">${m.role === 'today' ? '<span class="dm-of">baseline</span>' : `${worse(m.sets.dev)} · ${worse(m.sets.hard)} · ${worse(m.sets.holdout2)}`}</td>
    </tr>`).join('');
  return `
  <p class="sl-kicker">Candidates</p>
  <h2 class="sl-title" tabindex="-1">Cost per step, and how each model did on its own</h2>
  <div class="dm-scroll"><table class="dm-table sl-table">
    <thead><tr><th scope="col">Model</th>${STEPS.map(s => `<th scope="col" class="dm-num">${s}</th>`).join('')}
      <th scope="col" class="dm-num">Total per 1,000 test cases</th><th scope="col" class="dm-num">Got worse alone<br><small>practice · hard · holdout</small></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="sl-foot">Costs are per 1,000 test cases. "Got worse alone": each model ran the whole agent with no prompt changes, 3 runs per test case, against gpt-4 on 24 practice, 12 hard and 12 holdout test cases (48).
    ✓ marks the cheapest model that passed that step (next slide). ${esc(d.pool?.self_hosted_note || '')}
    ${d.sol_cost ? `<br>gpt-5.6-sol is ${usd(d.sol_cost.table_no_fix)} here (no prompt fix, 24 practice + 12 hard + 12 holdout = 48 test cases). The other slides show ${usd(d.sol_cost.same_cases_fixed)} for sol with the tone fix on 24 practice + 12 hard = 36 test cases: the same 36 cost ${usd(d.sol_cost.same_cases_no_fix)} without the fix, because the fixed tone step uses fewer tokens.` : ''}</p>`;
}

// ---- Slide 3: cheapest safe choice + fixes -------------------------------------------------------------
const diff = (a, b) => `<pre class="dm-diff"><span class="del">− ${esc(a)}</span>\n<span class="add">+ ${esc(b)}</span></pre>`;

function slideChoice(data) {
  const d = data.demo, p = d.pool, patch = d.patch, rec = d.recommended, fb = d.fallback, r = p?.retest;
  const guilty = d.per_step.find(s => s.guilty), line = d.lines.results.find(x => x.repairs);
  const ladder = !p ? '' : `<ol class="sl-ladder">${STEPS.map(s => `<li><span class="dm-mono sl-step">${s}</span>${(p.ladder[s] || []).map(t =>
    `<span class="sl-chip ${t.passed ? 'ok' : 'no'}">${esc(t.model)} ${t.passed ? '✓' : `✗ ${t.regressed}`}</span>`).join('')}</li>`).join('')}</ol>`;
  const fbResults = [`${data.candidates[0].summary.verdict_counts_after_fix?.REGRESSED} of ${d.confidence.dev_tickets + d.confidence.heldout_tickets} (practice + hard)`,
    p?.sol_patch_holdout2 && `${p.sol_patch_holdout2.regressed} of ${p.sol_patch_holdout2.of} (holdout)`,
    r && `${r.fresh3.sol_patch.regressed} of ${r.fresh3.sol_patch.of} (newest)`].filter(Boolean).join(', ');
  const main = !r ? '' : `
    <section class="sl-option${demoState.choice === 'cheap' ? ' sl-option-rec' : ''}" aria-labelledby="sl-a">
      <span class="dm-pill accepted">Recommended · cheapest</span>
      <h3 id="sl-a">${STEPS.map(s => `${s} → <span class="dm-mono">${esc(rec.assignment[s])}</span>`).join(', ')}</h3>
      <p class="sl-price">${usd(rec.usd_per_1k)} <small>per 1,000 test cases in API calls, plus about ${Math.round(r.cost.self_hosted_tokens_per_ticket)} tokens per test case on your own computer</small></p>
      <p><strong>First try:</strong> ${p.mix.holdout2.regressed.map(esc).join(', ')} got worse. The order ID was typed in lowercase ("a1005") and the classify step dropped it.</p>
      <p><strong>Fixes (the mix was tested with both):</strong> the classify prompt, then the tone prompt written for sol.</p>
      ${rec.edits.map(e => diff(e.old, e.new)).join('')}
      <p><strong>After the fix:</strong> ${r.dev.regressed} of ${r.dev.of} practice test cases and ${r.fresh3.mix.regressed} of ${r.fresh3.mix.of} newest test cases got worse.
        Encouraging, but ${r.fresh3.mix.of} test cases is a small test, and the cost of running the model yourself isn't measured.</p>
      <button class="button${demoState.choice === 'cheap' ? ' primary' : ''}" data-choice="cheap" aria-pressed="${demoState.choice === 'cheap'}">${demoState.choice === 'cheap' ? '✓ Selected' : 'Choose this option'}</button>
    </section>`;
  const safer = `
    <section class="sl-option${demoState.choice === 'sol' ? ' sl-option-rec' : ''}" aria-labelledby="sl-b">
      <span class="dm-pill warn">Safer, costlier fallback</span>
      <h3 id="sl-b"><span class="dm-mono">${esc(fb.assignment.classify)}</span> on every step + a tone fix</h3>
      <p class="sl-price">${usd(fb.usd_per_1k)} <small>per 1,000 test cases</small></p>
      <p><strong>What broke:</strong> the tone step deleted the "5–7 business days" refund timeline.
        Putting gpt-4 back at <span class="dm-mono">${esc(guilty.step)}</span> alone fixes ${frac(guilty.repair)} broken test cases; no other step fixes any.
        Removing line ${line ? line.line_index + 1 : '?'} alone fixes ${line ? `${line.repairs}/${line.of}` : '–'}.</p>
      <p><strong>Fix, tone prompt</strong> (written by ${esc(patch.fixer)} from the practice test cases only):</p>
      ${patch.edits.map(e => diff(e.old, e.new)).join('')}
      <p><strong>Got worse after the fix:</strong> ${fbResults}, including test cases the fix never saw.</p>
      <button class="button${demoState.choice === 'sol' ? ' primary' : ''}" data-choice="sol" aria-pressed="${demoState.choice === 'sol'}">${demoState.choice === 'sol' ? '✓ Selected' : 'Choose this option'}</button>
    </section>`;
  return `
  <p class="sl-kicker">Cheapest safe choice</p>
  <h2 class="sl-title" tabindex="-1">Pick the cheapest model that passes each step, then fix what breaks</h2>
  ${p ? `<div class="sl-ladder-box"><p class="sl-label">Each step, cheapest first (✗ n = test cases that got worse)</p>${ladder}</div>` : ''}
  <div class="sl-options">
    ${main}
    ${safer}
  </div>
  <p class="sl-foot">Step-finder on a practice test with planted bugs: ${frac(d.benchmark.held_out_exact)} exact; ${d.benchmark.partial.n} partially right (${d.benchmark.partial.missed} missed a step, ${d.benchmark.partial.extra} named an extra one),
    on held-out breaks (${esc(d.benchmark.source)}).</p>`;
}

// ---- Slide 4: the pull request -------------------------------------------------------------------------
function prChanges(data) {
  const d = data.demo, rec = chosenRec(d);
  const temp = st => 'temperature' in (rec.params?.[st] || {}) ? 'temperature: 0' : 'default temperature';
    return [
    {id: 'model', where: 'All 4 steps', summary: demoState.choice === 'sol' ? `Model ${d.pair.old} → ${d.pair.new}` : 'A cheaper model on each step',
     old: STEPS.map(st => `${st}: ${d.pair.old}   temperature: 0`).join('\n'),
     new: STEPS.map(st => `${st}: ${rec.assignment[st]}   ${temp(st)}`).join('\n')},
    ...rec.edits.map((e, i) => ({id: 'line' + i, where: `${e.step} prompt, line ${e.line_index + 1}`, summary: e.summary, old: e.old, new: e.new})),
  ];
}

function slidePR(data) {
  const d = data.demo, rec = chosenRec(d), r = d.pool.retest, changes = prChanges(data), sol = demoState.choice === 'sol';
  const sets = [r.dev, r.holdout2_seen, r.fresh3.mix];
  const total = sets.reduce((n, x) => n + x.of, 0), worse = sets.reduce((n, x) => n + x.regressed, 0);
  const status = id => demoState.decisions[id] || 'pending';
  const label = {pending: 'Waiting for review', accepted: 'Accepted', rejected: 'Rejected', edited: 'Edited: re-run needed'};
  const items = changes.map((ch, i) => {
    const text = demoState.edits[ch.id] ?? ch.new;
    const editing = demoState.editing === ch.id;
    return `<article class="dm-change" data-change="${ch.id}">
      <div class="dm-change-head"><div><span class="dm-col">Change ${i + 1} · ${esc(ch.where)}</span><h4>${esc(ch.summary)}</h4></div>
        <span class="dm-pill ${status(ch.id)}">${label[status(ch.id)]}</span></div>
      <pre class="dm-diff"><span class="del">− ${esc(ch.old)}</span>\n<span class="add">+ ${esc(text)}</span></pre>
      ${editing ? `<label class="dm-label" for="dm-edit-${ch.id}">Your version</label><textarea id="dm-edit-${ch.id}" class="dm-input dm-textarea" rows="3">${esc(text)}</textarea>
        <div class="dm-actions"><button class="button primary" data-act="save">Save edit</button><button class="button" data-act="cancel">Cancel</button></div>` :
      `<div class="dm-actions"><button class="button primary" data-act="accept">Accept</button><button class="button" data-act="edit">Edit</button><button class="button dm-reject" data-act="reject">Reject</button></div>`}
      ${status(ch.id) === 'edited' ? `<p class="dm-foot">An edited change hasn't been tested. Re-run the suite with your line before merging.</p>` : ''}
    </article>`;
  }).join('');
  const ready = changes.every(ch => status(ch.id) === 'accepted');
  const included = changes.filter(ch => ['accepted', 'edited'].includes(status(ch.id)));
  const undecided = changes.filter(ch => status(ch.id) === 'pending');
  const pr = demoState.pr || {};
  const create = !d.target_repo ? '' : `<div class="sl-create">
    <button class="button primary" id="sl-create"${!included.length || undecided.length || pr.busy ? ' disabled' : ''}>${pr.busy ? 'Opening pull request…' : `Create pull request in ${esc(d.target_repo)}`}</button>
    <div aria-live="polite">
      ${pr.url ? `<p class="dm-good">Pull request ${pr.existed ? 'already open' : 'opened'}: <a href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">${esc(pr.url)}</a></p>` : ''}
      ${pr.error ? `<p class="dm-bad">Couldn't open the pull request: ${esc(pr.error)}</p>` : ''}
      <p class="dm-foot">${undecided.length ? 'Decide every change first: accept, edit or reject.' : !included.length ? 'Accept or edit at least one change.'
        : `Opens a real pull request with ${included.length} change${included.length > 1 ? 's' : ''}. Rejected changes are left out; edited ones are marked untested.`}</p>
    </div>
  </div>`;
  return `
  <div class="dm-change-head"><div><p class="sl-kicker">Draft pull request · ${changes.length} changes</p>
    <h2 class="sl-title" tabindex="-1">${esc(sol ? 'Move the support agent to ' + d.pair.new + '; keep the refund timeline in the tone check' : data.pr.title)}</h2>${chooser(d)}</div>
    <span class="dm-pill ${ready ? 'accepted' : 'pending'}" aria-live="polite">${ready ? 'Ready to merge' : 'Needs review'}</span></div>
  <ul class="dm-summary">
    <li><strong>Where:</strong> ${sol ? `the <span class="dm-mono">${esc(rec.edits[0].step)}</span> step` : `all 4 steps, and the ${[...new Set(rec.edits.map(e => e.step))].map(x => `<span class="dm-mono">${esc(x)}</span>`).join(' and ')} prompts`}.</li>
    <li><strong>What:</strong> ${sol ? `the model swap to ${esc(d.pair.new)}` : 'a cheaper model on each step'} and ${rec.edits.length} prompt line${rec.edits.length > 1 ? 's' : ''}.</li>
    <li><strong>Proof:</strong> ${sol ? `test cases that got worse ${d.confidence.regressed_dev + d.confidence.regressed_heldout_before} → ${data.candidates[0].summary.verdict_counts_after_fix?.REGRESSED} of ${d.confidence.dev_tickets + d.confidence.heldout_tickets} (practice + hard), including ${d.patch.heldout_before.REGRESSED} → ${d.patch.heldout_after.REGRESSED} on the 12 hard test cases the fix never saw.` : `test cases that got worse ${d.pool.mix.holdout2.regressed.length} on the first try → ${worse} of ${total} after the fix (24 practice, 12 holdout, ${r.fresh3.mix.of} newest). ${r.fresh3.mix.of} newest test cases is a small test.`}</li>
    <li><strong>Cost:</strong> ${usd(d.totals_usd_per_1k.all_old)} → ${usd(rec.usd_per_1k)} per 1,000 test cases${sol ? '' : ` (API calls only; the ${esc(rec.self_hosted_steps.join(', '))} step runs locally)`}.</li>
  </ul>
  ${items}
  ${create}`;
}

// ---- Deck ------------------------------------------------------------------------------------------------
const RENDER = [slideResults, slideModels, slideChoice, slidePR];

export function demoSection(data) {
  if (!data?.demo) return '';
  if (demoState.view === 'live') return liveScreen(data);
  const i = demoState.slide, s = SLIDES[i];
  return `<section id="demo-panel" class="sl-deck" aria-roledescription="slideshow" aria-label="Migration report">
    <nav class="sl-dots" aria-label="Slides"><ol>${SLIDES.map((x, j) =>
      `<li><button class="sl-dot" data-go="${j}"${j === i ? ' aria-current="step"' : ''}><span>${j + 1}</span>${esc(x.title)}</button></li>`).join('')}</ol></nav>
    <article class="sl-slide" aria-roledescription="slide" aria-label="${i + 1} of ${SLIDES.length}: ${esc(s.title)}">${RENDER[i](data)}</article>
    <div class="sl-nav">
      <button class="button" data-go="${i - 1}"${i === 0 ? ' disabled' : ''}>← Back</button>
      <span class="sl-count" aria-live="polite">${i + 1} / ${SLIDES.length} · ${esc(s.title)}</span>
      <button class="button primary" data-go="${i + 1}"${i === SLIDES.length - 1 ? ' disabled' : ''}>Next →</button>
    </div>
  </section>`;
}

let keysBound = false;

export function bindDemo(root, data) {
  const panel = root.querySelector('#demo-panel');
  if (!panel) return;
  const redraw = () => { panel.outerHTML = demoSection(data); bindDemo(root, data); };
  const go = n => {
    if (n < 0 || n >= SLIDES.length || n === demoState.slide) return;
    demoState.slide = n;
    demoState.editing = null;
    history.replaceState(null, '', '#' + SLIDES[n].id);
    redraw();
    root.querySelector('.sl-title')?.focus({preventScroll: true});
    window.scrollTo({top: 0});
  };
  panel.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(Number(b.dataset.go)));
  if (!keysBound) {
    keysBound = true;
    document.addEventListener('keydown', e => {
      if (!document.querySelector('#demo-panel') || demoState.view === 'live' || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable], dialog[open]')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(demoState.slide + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(demoState.slide - 1); }
    });
  }
  panel.querySelectorAll('[data-choice]').forEach(b => b.onclick = () => {
    if (b.dataset.choice === demoState.choice) return;
    demoState.choice = b.dataset.choice;
    Object.assign(demoState, {decisions: {}, edits: {}, editing: null, pr: null});  // a different option is a different pull request
    redraw();
  });
  panel.querySelectorAll('[data-case]').forEach(b => b.onclick = () => openCase(data.demo, Number(b.dataset.case)));
  panel.querySelectorAll('[data-case-live]').forEach(b => b.onclick = () => { const i = data.demo.cases.findIndex(c => c.id === b.dataset.caseLive); if (i >= 0) openCase(data.demo, i); });
  bindLive(root, data);
  window.__upshiftLive = id => openLiveConfirm(data, id);
  const show = view => { demoState.view = view; redraw(); window.scrollTo({top: 0}); };
  panel.querySelector('#dm-live-open')?.addEventListener('click', () => openLiveConfirm(data));
  panel.querySelector('[data-live-view]')?.addEventListener('click', () => show('live'));
  panel.querySelector('[data-live-back]')?.addEventListener('click', () => show('deck'));
  panel.querySelector('[data-live-again]')?.addEventListener('click', () => openLiveConfirm(data));
  panel.querySelector('[data-live-stop]')?.addEventListener('click', () => fetch('/api/live-run/stop', {method: 'POST'}).catch(() => {}));
  const vol = panel.querySelector('#dm-volume');
  if (vol) vol.oninput = () => {
    const d = data.demo, v = Math.max(0, Number(vol.value) || 0), old = d.totals_usd_per_1k.all_old, rec = chosenRec(d).usd_per_1k;
    demoState.volume = v;
    panel.querySelector('#dm-today').textContent = usd(v * old / 1000, 0);
    panel.querySelector('#dm-after').textContent = usd(v * rec / 1000, 0);
    panel.querySelector('#dm-save').textContent = usd(v * (old - rec) / 1000, 0);
  };
  const create = panel.querySelector('#sl-create');
  if (create) create.onclick = async () => {
    const changes = prChanges(data).map(ch => ({id: ch.id, decision: demoState.decisions[ch.id] || 'pending',
      ...(demoState.edits[ch.id] != null ? {text: demoState.edits[ch.id]} : {})}));
    demoState.pr = {busy: true};
    redraw();
    try {
      const r = await fetch('/api/create-pr', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({changes, option: demoState.choice})});
      const out = await r.json().catch(() => ({error: `the server answered ${r.status}`}));
      demoState.pr = {...out, busy: false};
    } catch {
      demoState.pr = {busy: false, error: 'the upshift server isn\'t reachable (start it with npm start)'};
    }
    const current = document.querySelector('#demo-panel');  // the viewer may have changed slides meanwhile
    if (current) { current.outerHTML = demoSection(data); bindDemo(root, data); }
    document.querySelector('#sl-create')?.focus();
  };
  panel.querySelectorAll('.dm-change').forEach(el => {
    const id = el.dataset.change;
    el.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const act = btn.dataset.act;
      if (act !== 'edit' && act !== 'cancel') demoState.pr = null;  // a new decision means a different pull request
      if (act === 'accept') demoState.decisions[id] = 'accepted';
      if (act === 'reject') demoState.decisions[id] = 'rejected';
      if (act === 'edit') demoState.editing = id;
      if (act === 'cancel') demoState.editing = null;
      if (act === 'save') {
        demoState.edits[id] = el.querySelector('textarea').value;
        demoState.decisions[id] = 'edited';
        demoState.editing = null;
      }
      redraw();
      root.querySelector(`[data-change="${id}"] ${act === 'edit' ? 'textarea' : 'button'}`)?.focus();
    });
  });
}

// Slideshow for reports that carry a `demo` block (results_demo.py). app.js renders this instead of the usual
// report when data.demo exists: four slides, one at a time, with Back/Next, numbered slide buttons and arrow keys.
//   1 The result  ·  2 Every model we tried  ·  3 Cheapest safe choice + the fixes  ·  4 The pull request
// Every number comes from data; the only thing the viewer types is a test case volume (slide 1).

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const usd = (n, d = 2) => typeof n === 'number' ? '$' + n.toLocaleString('en-US', {minimumFractionDigits: d, maximumFractionDigits: d}) : 'n/a';
const pct = n => typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : 'n/a';
const frac = o => o ? `${o.n}/${o.of}` : '–';
const STEPS = ['classify', 'decide', 'draft', 'tone'];

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

export const demoState = {slide: slideFromHash(), volume: null, decisions: {}, editing: null, edits: {}};

// ---- Slide 1: the result ---------------------------------------------------------------------------
function slideResults(data) {
  const d = data.demo, old = d.totals_usd_per_1k.all_old, rec = d.recommended, q = d.quality, c = d.confidence;
  const r = d.pool?.retest, cheap = rec.config === 'cheap_mix' && r;
  // The cheap mix is judged on every test case it ran: practice, hard (seen once) and fresh.
  const sets = cheap ? [r.dev, r.holdout2_seen, r.fresh3.mix] : [];
  const cases = sets.reduce((n, x) => n + x.of, 0);
  const before = cheap ? d.pool.mix.holdout2.regressed.length : c.regressed_dev + c.regressed_heldout_before;
  const after = cheap ? sets.reduce((n, x) => n + x.regressed, 0) : data.candidates[0].summary.verdict_counts_after_fix?.REGRESSED;
  const passed = cheap ? sets.reduce((n, x) => n + x.passed_all * x.of, 0) / cases : q.new_fixed.passed_all;
  const vol = demoState.volume ?? d.monthly_requests_default;
  const price = Object.values(d.prices)[0] || {};
  return `
  <p class="sl-kicker">${esc(d.pair.old)} → cheaper models · 4-step support agent · gpt-4 shuts down Oct 23</p>
  <h2 class="sl-title" tabindex="-1">${cheap ? 'Move every step to a cheaper model, with a one-line prompt fix' : `Switch to <span class="dm-mono">${esc(rec.assignment.classify)}</span> with a one-line prompt fix`}</h2>
  <div class="sl-kpis">
    <div class="sl-kpi">
      <span class="sl-label">Test cases that got worse</span>
      <strong>${before} → ${after}</strong>
      <small>${cheap ? `${before} on the first try, ${after} of ${cases} after the one-line fix (24 practice, 12 held-out, ${r.fresh3.mix.of} fresh). The fresh set is small.` : `out of ${c.dev_tickets + c.heldout_tickets} test cases, before → after the fix.`}</small>
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
  <p class="sl-foot">Real model runs on hand-written test cases, ${c.runs_per_ticket} runs each. Same prompts, tools and test cases on both sides; only the models changed.
    Cost = measured tokens × list prices (${esc(price.source)}, checked ${esc(price.checked)}); model cost only. The volume is your number.</p>`;
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
      <th scope="col" class="dm-num">Total per 1,000 test cases</th><th scope="col" class="dm-num">Got worse alone<br><small>practice · hard · fresh</small></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="sl-foot">Costs are per 1,000 test cases. "Got worse alone": each model ran the whole agent with no prompt changes, 3 runs per test case, against gpt-4 on 24 practice, 12 hard and 12 fresh test cases.
    ✓ marks the cheapest model that passed that step (next slide). ${esc(d.pool?.self_hosted_note || '')}</p>`;
}

// ---- Slide 3: cheapest safe choice + fixes -------------------------------------------------------------
const diff = (a, b) => `<pre class="dm-diff"><span class="del">− ${esc(a)}</span>\n<span class="add">+ ${esc(b)}</span></pre>`;

function slideChoice(data) {
  const d = data.demo, p = d.pool, patch = d.patch, rec = d.recommended, fb = d.fallback, r = p?.retest;
  const guilty = d.per_step.find(s => s.guilty), line = d.lines.results.find(x => x.repairs);
  const ladder = !p ? '' : `<ol class="sl-ladder">${STEPS.map(s => `<li><span class="dm-mono sl-step">${s}</span>${(p.ladder[s] || []).map(t =>
    `<span class="sl-chip ${t.passed ? 'ok' : 'no'}">${esc(t.model)} ${t.passed ? '✓' : `✗ ${t.regressed}`}</span>`).join('')}</li>`).join('')}</ol>`;
  const fbResults = [`${data.candidates[0].summary.verdict_counts_after_fix?.REGRESSED} of ${d.confidence.dev_tickets + d.confidence.heldout_tickets}`,
    p?.sol_patch_holdout2 && `${p.sol_patch_holdout2.regressed} of ${p.sol_patch_holdout2.of}`,
    r && `${r.fresh3.sol_patch.regressed} of ${r.fresh3.sol_patch.of}`].filter(Boolean).join(', ');
  const main = !r ? '' : `
    <section class="sl-option sl-option-rec" aria-labelledby="sl-a">
      <span class="dm-pill accepted">Recommended · cheapest</span>
      <h3 id="sl-a">${STEPS.map(s => `${s} → <span class="dm-mono">${esc(rec.assignment[s])}</span>`).join(', ')}</h3>
      <p class="sl-price">${usd(rec.usd_per_1k)} <small>per 1,000 test cases in API calls, plus about ${Math.round(r.cost.self_hosted_tokens_per_ticket)} tokens per test case on your own computer</small></p>
      <p><strong>First try:</strong> ${p.mix.holdout2.regressed.map(esc).join(', ')} got worse. The order ID was typed in lowercase ("a1005") and the classify step dropped it.</p>
      <p><strong>Fix, classify prompt:</strong></p>
      ${diff(r.fix.old, r.fix.new)}
      <p><strong>After the fix:</strong> ${r.dev.regressed} of ${r.dev.of} practice test cases and ${r.fresh3.mix.regressed} of ${r.fresh3.mix.of} brand-new test cases got worse.
        Encouraging, but ${r.fresh3.mix.of} test cases is a small test, and the cost of running the model yourself isn't measured.</p>
    </section>`;
  const safer = `
    <section class="sl-option" aria-labelledby="sl-b">
      <span class="dm-pill warn">Safer, costlier fallback</span>
      <h3 id="sl-b"><span class="dm-mono">${esc(fb.assignment.classify)}</span> on every step + a tone fix</h3>
      <p class="sl-price">${usd(fb.usd_per_1k)} <small>per 1,000 test cases</small></p>
      <p><strong>What broke:</strong> the tone step deleted the "5–7 business days" refund timeline.
        Putting gpt-4 back at <span class="dm-mono">${esc(guilty.step)}</span> alone fixes ${frac(guilty.repair)} broken test cases; no other step fixes any.
        Removing line ${line ? line.line_index + 1 : '?'} alone fixes ${line ? `${line.repairs}/${line.of}` : '–'}.</p>
      <p><strong>Fix, tone prompt</strong> (written by ${esc(patch.fixer)} from the practice test cases only):</p>
      ${patch.edits.map(e => diff(e.old, e.new)).join('')}
      <p><strong>Got worse after the fix:</strong> ${fbResults}, including test cases the fix never saw.</p>
    </section>`;
  return `
  <p class="sl-kicker">Cheapest safe choice</p>
  <h2 class="sl-title" tabindex="-1">Pick the cheapest model that passes each step, then fix what breaks</h2>
  ${p ? `<div class="sl-ladder-box"><p class="sl-label">Each step, cheapest first (✗ n = test cases that got worse)</p>${ladder}</div>` : ''}
  <div class="sl-options">
    ${main}
    ${safer}
  </div>
  <p class="sl-foot">How often the step-finder names the right step: ${frac(d.benchmark.held_out_exact)} exactly, ${frac(d.benchmark.wrong_step)} wrong,
    on a practice test with planted bugs (${esc(d.benchmark.source)}).</p>`;
}

// ---- Slide 4: the pull request -------------------------------------------------------------------------
function prChanges(data) {
  const d = data.demo, rec = d.recommended;
  const temp = st => 'temperature' in (rec.params?.[st] || {}) ? 'temperature: 0' : 'default temperature';
  return [
    {id: 'model', where: 'All 4 steps', summary: 'A cheaper model on each step',
     old: STEPS.map(st => `${st}: ${d.pair.old}   temperature: 0`).join('\n'),
     new: STEPS.map(st => `${st}: ${rec.assignment[st]}   ${temp(st)}`).join('\n')},
    ...rec.edits.map((e, i) => ({id: 'line' + i, where: `${e.step} prompt, line ${e.line_index + 1}`,
      summary: 'Keep lowercase order IDs working', old: e.old, new: e.new})),
  ];
}

function slidePR(data) {
  const d = data.demo, rec = d.recommended, r = d.pool.retest, changes = prChanges(data);
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
    <h2 class="sl-title" tabindex="-1">${esc(data.pr.title)}</h2></div>
    <span class="dm-pill ${ready ? 'accepted' : 'pending'}" aria-live="polite">${ready ? 'Ready to merge' : 'Needs review'}</span></div>
  <ul class="dm-summary">
    <li><strong>Where:</strong> all 4 steps, and the <span class="dm-mono">${esc(rec.edits[0].step)}</span> prompt.</li>
    <li><strong>What:</strong> a cheaper model on each step and ${rec.edits.length} prompt line.</li>
    <li><strong>Proof:</strong> test cases that got worse ${d.pool.mix.holdout2.regressed.length} on the first try → ${worse} of ${total} after the fix. ${r.fresh3.mix.of} fresh test cases is a small test.</li>
    <li><strong>Cost:</strong> ${usd(d.totals_usd_per_1k.all_old)} → ${usd(rec.usd_per_1k)} per 1,000 test cases (API calls only; the ${esc(rec.self_hosted_steps.join(', '))} step runs locally).</li>
  </ul>
  ${items}
  ${create}`;
}

// ---- Deck ------------------------------------------------------------------------------------------------
const RENDER = [slideResults, slideModels, slideChoice, slidePR];

export function demoSection(data) {
  if (!data?.demo) return '';
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
      if (!document.querySelector('#demo-panel') || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable], dialog[open]')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(demoState.slide + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(demoState.slide - 1); }
    });
  }
  const vol = panel.querySelector('#dm-volume');
  if (vol) vol.oninput = () => {
    const d = data.demo, v = Math.max(0, Number(vol.value) || 0), old = d.totals_usd_per_1k.all_old, rec = d.recommended.usd_per_1k;
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
      const r = await fetch('/api/create-pr', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({changes})});
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

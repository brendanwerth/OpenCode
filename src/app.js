// ============================================================================
// CodeNexus renderer — chat UI + agentic tool-calling loop.
//
// What makes this different from a plain terminal coding agent:
//   • Multi-provider — native Anthropic + OpenAI + OpenRouter (bring your key).
//   • Smart routing — a cheap "worker" model handles read-only exploration; a
//     strong "planner" model handles writes, decisions, and error recovery.
//   • Plan-first mode — the agent drafts an editable plan you approve first.
//   • Visual diff review — every file change is shown as a diff you accept/reject.
//   • Checkpoints & rewind — file edits are journaled; jump back in one click.
//
// All provider HTTP is proxied through the Electron main process (window.nexus),
// so there are no browser-CORS limits and every provider streams uniformly.
// ============================================================================

const md = window.marked;
const clean = (s) => window.DOMPurify.sanitize(s);
const mdRender = (s) => clean(md.parse(s || ''));

// ---------------------------------------------------------------------------
// Default agent system prompt (Claude Code / Codex style).
// ---------------------------------------------------------------------------
const DEFAULT_SYSTEM_PROMPT =
`You are CodeNexus, an autonomous coding agent running on the user's machine with direct access to their project folder and shell.

You operate in an agentic loop: think, call a tool, observe the result, and continue until the task is fully done. Work decisively — don't ask for permission to read files or explore.

Guidelines:
- Use list_dir, read_file, and grep to understand the project before changing anything. Never edit a file you haven't read.
- Make changes with edit_file (for targeted edits) or write_file (for new files). Match the existing code style.
- Use run_command to install deps, build, run tests, or use git — and to verify your work afterward.
- Use web_search and fetch_url to look up documentation, APIs, error messages, or current information when your own knowledge is insufficient or possibly out of date. Search first, then fetch the most relevant URLs for detail.
- Keep going until the task is complete. After making changes, verify them (build/test/run) when possible.
- Be concise in your text replies. Explain what you did and why, not a play-by-play of every tool call.
- If you lack a workspace folder, tell the user to open one with the "Open Project Folder" button.

You are working on real files. Be careful and precise.`;

const PLAN_MODE_ADDENDUM =
`\n\nPLAN-FIRST MODE IS ON. You may briefly explore with read_file / list_dir / grep to inform your plan, but before any write_file, edit_file, or run_command you MUST call present_plan with a concise ordered list of steps and wait for the user to approve it. After approval, execute the plan and call present_plan again to mark steps done as you progress.`;

// ---------------------------------------------------------------------------
// Curated model catalogs (prices are approximate USD per 1M tokens; you can
// type any custom model id into the search box). OpenRouter models are loaded
// live with exact pricing.
// ---------------------------------------------------------------------------
const CURATED = {
  anthropic: [
    { id: 'claude-opus-4-8',              ctx: 200000, pin: 15,   pout: 75 },
    { id: 'claude-sonnet-4-6',            ctx: 200000, pin: 3,    pout: 15 },
    { id: 'claude-haiku-4-5-20251001',    ctx: 200000, pin: 1,    pout: 5  },
    { id: 'claude-fable-5',               ctx: 200000, pin: 0,    pout: 0  }
  ],
  openai: [
    { id: 'gpt-5',       ctx: 400000,  pin: 1.25, pout: 10 },
    { id: 'gpt-5-mini',  ctx: 400000,  pin: 0.25, pout: 2  },
    { id: 'gpt-4.1',     ctx: 1000000, pin: 2,    pout: 8  },
    { id: 'gpt-4.1-mini',ctx: 1000000, pin: 0.4,  pout: 1.6},
    { id: 'gpt-4o',      ctx: 128000,  pin: 2.5,  pout: 10 },
    { id: 'o4-mini',     ctx: 200000,  pin: 1.1,  pout: 4.4}
  ]
};
const PROVIDER_LABEL = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter' };

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  keys: { anthropic: '', openai: '', openrouter: '' },
  models: {
    planner: { provider: 'openrouter', id: '' },
    worker:  { provider: 'openrouter', id: '' }
  },
  routing: false,
  planMode: false,
  orModelCache: [],
  sessions: {},
  currentSessionId: null,
  workspace: null,
  autoApprove: false,
  maxSteps: 25,
  generating: false,
  stopRequested: false,
  currentRequestId: null
};

const $ = id => document.getElementById(id);
const els = {
  keyAnthropic: $('key-anthropic'), keyOpenai: $('key-openai'), keyOpenrouter: $('key-openrouter'),
  dotAnthropic: $('dot-anthropic'), dotOpenai: $('dot-openai'), dotOpenrouter: $('dot-openrouter'),
  orLoginBtn: $('or-login-btn'),
  routingToggle: $('routing-toggle'), planModeToggle: $('plan-mode-toggle'),
  slotWorker: $('slot-worker'),
  systemPrompt: $('system-prompt'),
  paramTemp: $('param-temp'), numTemp: $('num-temp'),
  paramMaxTokens: $('param-max_tokens'), numMaxTokens: $('num-max_tokens'),
  paramMaxSteps: $('param-max_steps'), numMaxSteps: $('num-max_steps'),
  autoApproveToggle: $('auto-approve-toggle'),
  sessionsList: $('sessions-list'), messages: $('messages'), input: $('user-input'),
  sendBtn: $('send-btn'), sendLabel: $('send-label'), chatTitle: $('chat-title'),
  msgCount: $('msg-count'), headerModel: $('header-model'),
  headerCost: $('header-cost'), statusCost: $('status-cost'),
  statusDot: $('status-dot'), stateText: $('state-text'),
  toast: $('toast'),
  clearBtn: $('clear-workspace-btn'), exportBtn: $('export-workspace-btn'),
  newSessionBtn: $('new-session-btn'),
  workspacePath: $('workspace-path'), pickFolderBtn: $('pick-folder-btn'),
  timelineSection: $('timeline-section'), timelineList: $('timeline-list'), checkpointCount: $('checkpoint-count')
};

const SUGGESTIONS = [
  { title: 'Explore', body: 'Read through this project and give me a summary of its architecture and main entry points.' },
  { title: 'Plan & build', body: 'Add a dark-mode toggle to the settings page. Plan it first, then implement.' },
  { title: 'Fix', body: 'Run the test suite, find any failing tests, and fix the underlying bugs.' }
];

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling schema — converted per provider)
// ---------------------------------------------------------------------------
const TOOLS = [
  { type: 'function', function: {
    name: 'list_dir',
    description: 'List files and folders in a directory within the workspace. Use "." for the project root.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path relative to the workspace root.' } }, required: [] }
  }},
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read the full contents of a text file in the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to the workspace root.' } }, required: ['path'] }
  }},
  { type: 'function', function: {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing one. Creates parent folders as needed.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      content: { type: 'string', description: 'The full file contents to write.' }
    }, required: ['path', 'content'] }
  }},
  { type: 'function', function: {
    name: 'edit_file',
    description: 'Replace an exact string in a file with new text. The old_string must match the file exactly, including whitespace, and be unique unless replace_all is set.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to find and replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring uniqueness.' }
    }, required: ['path', 'old_string', 'new_string'] }
  }},
  { type: 'function', function: {
    name: 'grep',
    description: 'Search file contents across the workspace with a case-insensitive regular expression. Returns matching file:line:text.',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      glob: { type: 'string', description: 'Optional filename glob filter, e.g. "*.js".' }
    }, required: ['pattern'] }
  }},
  { type: 'function', function: {
    name: 'run_command',
    description: 'Run a shell command in the workspace root (PowerShell on Windows) and return its stdout, stderr, and exit code. Use for builds, tests, git, installing dependencies, etc.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command line to execute.' } }, required: ['command'] }
  }},
  { type: 'function', function: {
    name: 'web_search',
    description: 'Search the web and return a list of results (title, url, snippet). Use to find documentation, current information, or relevant pages, then fetch_url the best ones.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'The search query.' },
      limit: { type: 'number', description: 'Max results to return (default 8).' }
    }, required: ['query'] }
  }},
  { type: 'function', function: {
    name: 'fetch_url',
    description: 'Fetch a web page (or text/JSON resource) and return its readable text content. Use after web_search, or directly when you have a URL.',
    parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'The full http(s) URL to fetch.' }
    }, required: ['url'] }
  }}
];

const PRESENT_PLAN_TOOL = { type: 'function', function: {
  name: 'present_plan',
  description: 'Present an ordered implementation plan to the user for approval. In plan-first mode you MUST call this and get approval before any write_file, edit_file, or run_command. Call it again later (after approval) to update step statuses as you progress.',
  parameters: { type: 'object', properties: {
    summary: { type: 'string', description: 'One-line summary of the goal.' },
    steps: { type: 'array', description: 'Ordered list of plan steps.', items: { type: 'object', properties: {
      text: { type: 'string', description: 'What this step does.' },
      status: { type: 'string', enum: ['todo', 'active', 'done'], description: 'Progress of this step.' }
    }, required: ['text'] } }
  }, required: ['steps'] }
}};

const READ_ONLY_TOOLS = new Set(['list_dir', 'read_file', 'grep', 'web_search', 'fetch_url']);
const FILE_MUTATING = new Set(['write_file', 'edit_file']);
const GATED_IN_PLAN = new Set(['write_file', 'edit_file', 'run_command']);

function getTools() {
  return state.planMode ? [...TOOLS, PRESENT_PLAN_TOOL] : TOOLS;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function uid() { return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function toast(msg, kind = '') {
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (kind ? ' ' + kind : '');
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

function setStatus(dotClass, text) {
  els.statusDot.className = 'dot ' + dotClass;
  els.stateText.textContent = text;
}

function getKey(provider) { return (state.keys[provider] || '').trim(); }

// Resolve which model (provider+id) handles a given turn under the routing rules.
function modelForSlot(slot) {
  let cfg = state.models[slot];
  // Fall back to planner if a worker turn is requested but no usable worker exists.
  if (slot === 'worker' && (!cfg.id || !getKey(cfg.provider))) cfg = state.models.planner;
  return cfg;
}

// ---------------------------------------------------------------------------
// Model catalogs
// ---------------------------------------------------------------------------
function getCatalog(provider) {
  if (provider === 'openrouter') {
    return state.orModelCache.map(m => ({
      id: m.id,
      label: m.name || m.id,
      ctx: m.context_length || 0,
      pin: m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1e6 : 0,
      pout: m.pricing?.completion ? parseFloat(m.pricing.completion) * 1e6 : 0
    }));
  }
  return (CURATED[provider] || []).map(m => ({ ...m, label: m.id }));
}

function findModel(provider, id) {
  return getCatalog(provider).find(m => m.id === id) || null;
}

function pricePerMillion(provider, id) {
  const m = findModel(provider, id);
  return m ? { pin: m.pin, pout: m.pout, exact: provider === 'openrouter' } : null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function serializeState() {
  return {
    keys: state.keys, models: state.models, routing: state.routing, planMode: state.planMode,
    sessions: state.sessions, currentSessionId: state.currentSessionId,
    autoApprove: state.autoApprove, maxSteps: state.maxSteps,
    systemPrompt: els.systemPrompt.value, temp: els.paramTemp.value, maxTokens: els.paramMaxTokens.value
  };
}

function save() {
  try {
    localStorage.setItem('codenexus_state', JSON.stringify(serializeState()));
  } catch (e) {
    // Checkpoints journal full file contents and can overflow the ~5MB quota.
    // Shed the heaviest payload — older checkpoints' file snapshots — and retry.
    try {
      const all = Object.values(state.sessions);
      all.forEach(s => (s.checkpoints || []).forEach((cp, i, arr) => {
        if (i < arr.length - 4) { cp.files = {}; cp._shed = true; } // keep last 4 rewindable
      }));
      localStorage.setItem('codenexus_state', JSON.stringify(serializeState()));
      if (!save._warned) { toast('Storage near full — older checkpoints are no longer rewindable', 'error'); save._warned = true; }
    } catch (e2) {
      console.error('save failed even after shedding checkpoints:', e2);
    }
  }
}

function load() {
  els.systemPrompt.value = DEFAULT_SYSTEM_PROMPT;
  try {
    const raw = localStorage.getItem('codenexus_state');
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.keys) state.keys = { ...state.keys, ...p.keys };
    if (p.models?.planner) state.models.planner = p.models.planner;
    if (p.models?.worker) state.models.worker = p.models.worker;
    state.routing = !!p.routing;
    state.planMode = !!p.planMode;
    state.sessions = p.sessions || {};
    state.currentSessionId = p.currentSessionId || null;
    state.autoApprove = !!p.autoApprove;
    state.maxSteps = p.maxSteps || 25;
    if (p.systemPrompt) els.systemPrompt.value = p.systemPrompt;
    if (p.temp) { els.paramTemp.value = p.temp; els.numTemp.textContent = parseFloat(p.temp).toFixed(2); }
    if (p.maxTokens) { els.paramMaxTokens.value = p.maxTokens; els.numMaxTokens.textContent = p.maxTokens; }
  } catch (e) { console.error('Failed to load state:', e); }

  els.paramMaxSteps.value = state.maxSteps; els.numMaxSteps.textContent = state.maxSteps;
  els.keyAnthropic.value = state.keys.anthropic || '';
  els.keyOpenai.value = state.keys.openai || '';
  els.keyOpenrouter.value = state.keys.openrouter || '';
  els.autoApproveToggle.classList.toggle('on', state.autoApprove);
  els.routingToggle.classList.toggle('on', state.routing);
  els.planModeToggle.classList.toggle('on', state.planMode);
  els.slotWorker.classList.toggle('disabled', !state.routing);
  refreshKeyDots();
  // Reflect saved provider choices in the two model slots.
  ['planner', 'worker'].forEach(slot => {
    const prov = state.models[slot].provider;
    document.querySelectorAll(`.mini-seg[data-provider-seg="${slot}"] .mini-seg-btn`).forEach(b =>
      b.classList.toggle('active', b.dataset.provider === prov));
  });
}

function refreshKeyDots() {
  els.dotAnthropic.classList.toggle('set', !!getKey('anthropic'));
  els.dotOpenai.classList.toggle('set', !!getKey('openai'));
  els.dotOpenrouter.classList.toggle('set', !!getKey('openrouter'));
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------
async function refreshWorkspaceLabel() {
  try { state.workspace = await window.nexus.getWorkspace(); }
  catch (e) { state.workspace = null; }
  if (state.workspace) {
    els.workspacePath.textContent = state.workspace;
    els.workspacePath.classList.remove('empty');
  } else {
    els.workspacePath.textContent = 'No folder open';
    els.workspacePath.classList.add('empty');
  }
}

async function pickFolder() {
  const p = await window.nexus.pickFolder();
  if (p) { await refreshWorkspaceLabel(); toast('Workspace set', 'good'); }
}

// ---------------------------------------------------------------------------
// Model picker (two slots: planner + worker), provider-aware
// ---------------------------------------------------------------------------
function rebuildModelSelect(slot) {
  const cfg = state.models[slot];
  const select = document.querySelector(`.model-select[data-slot="${slot}"]`);
  const searchEl = document.querySelector(`.model-search[data-slot="${slot}"]`);
  if (!select) return;
  const q = (searchEl.value || '').toLowerCase().trim();
  const list = getCatalog(cfg.provider);
  let filtered = q ? list.filter(m => m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q)) : list.slice();
  // Allow any custom model id by typing it into the search box.
  if (q && !list.some(m => m.id.toLowerCase() === q)) {
    filtered.unshift({ id: searchEl.value.trim(), label: searchEl.value.trim() + ' (custom)', custom: true, pin: 0, pout: 0, ctx: 0 });
  }
  select.innerHTML = '';
  if (!filtered.length) {
    select.innerHTML = cfg.provider === 'openrouter'
      ? '<option value="">Loading models…</option>'
      : '<option value="">No models</option>';
  }
  filtered.slice(0, 400).forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = labelFor(m);
    select.appendChild(opt);
  });
  if (cfg.id && [...select.options].some(o => o.value === cfg.id)) select.value = cfg.id;
  else if (select.options[0] && select.options[0].value) { cfg.id = select.options[0].value; select.value = cfg.id; }
  updateModelPricing(slot);
  updateHeaderModel();
  save();
}

function labelFor(m) {
  const ctx = m.ctx ? ` [${Math.round(m.ctx / 1000)}k]` : '';
  const price = (m.pin === 0 && m.pout === 0) ? (m.custom ? '' : ' · free') : ` · $${m.pin.toFixed(2)}/$${m.pout.toFixed(2)} per 1M`;
  return `${m.id}${ctx}${price}`;
}

function updateModelPricing(slot) {
  const cfg = state.models[slot];
  const el = document.querySelector(`.model-pricing[data-slot="${slot}"]`);
  if (!el) return;
  const p = pricePerMillion(cfg.provider, cfg.id);
  if (!cfg.id) { el.textContent = 'No model selected'; return; }
  if (!p) { el.textContent = `${cfg.id} · custom (pricing unknown)`; return; }
  const approx = p.exact ? '' : '~';
  el.textContent = (p.pin === 0 && p.pout === 0)
    ? `${cfg.id} · free`
    : `${cfg.id} · ${approx}$${p.pin.toFixed(2)} in / ${approx}$${p.pout.toFixed(2)} out per 1M`;
}

function setProvider(slot, provider) {
  state.models[slot].provider = provider;
  state.models[slot].id = '';
  document.querySelectorAll(`.mini-seg[data-provider-seg="${slot}"] .mini-seg-btn`).forEach(b =>
    b.classList.toggle('active', b.dataset.provider === provider));
  const searchEl = document.querySelector(`.model-search[data-slot="${slot}"]`);
  if (searchEl) searchEl.value = '';
  if (provider === 'openrouter' && !state.orModelCache.length) fetchOpenRouterModels();
  else rebuildModelSelect(slot);
}

function plannerLabel() {
  const p = state.models.planner;
  return p.id || '—';
}

function updateHeaderModel() {
  let label = plannerLabel();
  if (state.routing) {
    const w = state.models.worker;
    if (w.id && w.id !== state.models.planner.id) label += '  +  ' + w.id;
  }
  els.headerModel.textContent = label.length > 40 ? label.slice(0, 39) + '…' : label;
}

// ---------------------------------------------------------------------------
// OpenRouter OAuth + live model list (no key required to browse)
// ---------------------------------------------------------------------------
async function exchangeOpenRouterCode(code) {
  toast('Exchanging OpenRouter credentials…');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    });
    if (!res.ok) throw new Error('rejected');
    const data = await res.json();
    if (data && data.key) {
      state.keys.openrouter = data.key; els.keyOpenrouter.value = data.key;
      refreshKeyDots(); save();
      toast('OpenRouter connected', 'good');
    }
  } catch { toast('OpenRouter auth failed', 'error'); }
}

function handleOpenRouterAuth() {
  if (window.nexus?.onOAuthCallback) {
    window.nexus.onOAuthCallback(({ code }) => { if (code) exchangeOpenRouterCode(code); });
  }
  const code = new URLSearchParams(window.location.search).get('code');
  if (code) {
    window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
    exchangeOpenRouterCode(code);
  }
}

async function fetchOpenRouterModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error('http');
    const payload = await res.json();
    state.orModelCache = (payload.data || []).sort((a, b) => a.id.localeCompare(b.id));
  } catch { state.orModelCache = []; }
  ['planner', 'worker'].forEach(slot => { if (state.models[slot].provider === 'openrouter') rebuildModelSelect(slot); });
}

// ---------------------------------------------------------------------------
// Cost / usage tracking
// ---------------------------------------------------------------------------
function fmtCost(c, approx) {
  const v = !c ? '$0.0000' : (c < 1 ? '$' + c.toFixed(4) : '$' + c.toFixed(2));
  return (approx ? '~' : '') + v;
}

function updateCostDisplay() {
  const s = currentSession();
  const cost = s?.cost || 0;
  els.headerCost.textContent = fmtCost(cost, s?.costApprox);
  els.statusCost.textContent = fmtCost(cost, s?.costApprox);
}

function computeUsage(provider, modelId, raw) {
  // Normalize provider usage into { prompt_tokens, completion_tokens, cost, approx }.
  if (!raw) return null;
  const pt = raw.prompt_tokens ?? raw.input_tokens ?? 0;
  const ct = raw.completion_tokens ?? raw.output_tokens ?? 0;
  if (provider === 'openrouter' && typeof raw.cost === 'number') {
    return { prompt_tokens: pt, completion_tokens: ct, cost: raw.cost, approx: false };
  }
  const price = pricePerMillion(provider, modelId);
  if (price && (price.pin || price.pout)) {
    return { prompt_tokens: pt, completion_tokens: ct, cost: (pt * price.pin + ct * price.pout) / 1e6, approx: true };
  }
  return { prompt_tokens: pt, completion_tokens: ct, cost: 0, approx: true };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function newSession() {
  const id = uid();
  state.sessions[id] = { id, title: 'New task', messages: [], checkpoints: [], updated: Date.now() };
  state.currentSessionId = id;
  renderSessions(); renderMessages(); renderTimeline(); save();
  els.input.focus();
}

function currentSession() { return state.sessions[state.currentSessionId]; }

function renderSessions() {
  const sorted = Object.values(state.sessions).sort((a, b) => b.updated - a.updated);
  if (!sorted.length) { els.sessionsList.innerHTML = '<div class="empty-state">No tasks yet</div>'; return; }
  els.sessionsList.innerHTML = '';
  sorted.forEach(s => {
    const div = document.createElement('div');
    div.className = 'session' + (s.id === state.currentSessionId ? ' active' : '');
    div.innerHTML = `<span class="session-title">${clean(s.title)}</span><span class="session-del">×</span>`;
    div.addEventListener('click', () => { state.currentSessionId = s.id; renderSessions(); renderMessages(); renderTimeline(); save(); });
    div.querySelector('.session-del').addEventListener('click', (e) => {
      e.stopPropagation();
      delete state.sessions[s.id];
      if (state.currentSessionId === s.id) {
        const keys = Object.keys(state.sessions);
        state.currentSessionId = keys[keys.length - 1] || null;
      }
      if (!state.currentSessionId) newSession();
      else { renderSessions(); renderMessages(); renderTimeline(); save(); }
    });
    els.sessionsList.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Rendering messages + tool cards
// ---------------------------------------------------------------------------
function renderWelcome() {
  const w = document.createElement('div');
  w.className = 'welcome';
  w.innerHTML = `
    <div class="welcome-mark">&lt;/&gt;</div>
    <div class="welcome-h">What should we build?</div>
    <div class="welcome-p">Open a project folder, bring an Anthropic / OpenAI / OpenRouter key, and describe a task. CodeNexus plans, edits, runs, and verifies — with diff review and one-click rewind.</div>
    <div id="suggestions-bin"></div>`;
  els.messages.appendChild(w);
  SUGGESTIONS.forEach(sug => {
    const btn = document.createElement('button');
    btn.className = 'suggestion';
    btn.innerHTML = `<strong>${sug.title}:</strong> ${sug.body}`;
    btn.onclick = () => { els.input.value = sug.body; els.input.focus(); };
    w.querySelector('#suggestions-bin').appendChild(btn);
  });
}

function toolArgPreview(name, args) {
  try {
    if (name === 'run_command') return args.command || '';
    if (name === 'grep') return args.pattern + (args.glob ? `  (${args.glob})` : '');
    if (name === 'list_dir') return args.path || '.';
    if (name === 'web_search') return args.query || '';
    if (name === 'fetch_url') return args.url || '';
    if (name === 'present_plan') return (args.summary || `${(args.steps || []).length} steps`);
    return args.path || '';
  } catch { return ''; }
}

const TOOL_ICONS = { read_file: '📄', write_file: '✍️', edit_file: '✏️', list_dir: '📁', grep: '🔎', run_command: '▶️', web_search: '🌐', fetch_url: '🔗', present_plan: '📋' };

function makeToolCard(name, args) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">${TOOL_ICONS[name] || '🔧'}</span>
      <span class="tool-name">${name}</span>
      <span class="tool-arg">${clean(toolArgPreview(name, args))}</span>
      <span class="tool-status running">running</span>
    </div>
    <div class="tool-body"></div>`;
  const head = card.querySelector('.tool-head');
  const statusEl = card.querySelector('.tool-status');
  const bodyEl = card.querySelector('.tool-body');
  head.addEventListener('click', () => card.classList.toggle('open'));
  return {
    card,
    setStatus(kind, label) { statusEl.className = 'tool-status ' + kind; statusEl.textContent = label; },
    setBody(html, { open = false } = {}) { bodyEl.innerHTML = html; if (open) card.classList.add('open'); }
  };
}

function renderToolBody(name, args, result) {
  const esc = (s) => clean(String(s ?? '')).replace(/</g, '&lt;');
  if (name === 'run_command') {
    let html = '';
    if (args.command) html += `<div class="tool-section-label">command</div><div class="tool-pre cmd">${esc(args.command)}</div>`;
    html += `<div class="tool-section-label">output</div><div class="tool-pre">${esc(result.text)}</div>`;
    return html;
  }
  if (name === 'write_file' || name === 'edit_file') {
    let html = `<div class="tool-section-label">${name === 'write_file' ? 'content' : 'change'}</div>`;
    const preview = name === 'write_file' ? args.content : `- ${args.old_string}\n+ ${args.new_string}`;
    html += `<div class="tool-pre">${esc(preview)}</div>`;
    html += `<div class="tool-section-label">result</div><div class="tool-pre">${esc(result.text)}</div>`;
    return html;
  }
  return `<div class="tool-pre">${esc(result.text)}</div>`;
}

function renderMessages() {
  const s = currentSession();
  els.messages.innerHTML = '';
  if (!s || !s.messages.length) {
    renderWelcome();
    els.chatTitle.textContent = s ? s.title : 'New task';
    els.msgCount.textContent = '0';
    updateCostDisplay();
    return;
  }
  const container = document.createElement('div');
  container.className = 'messages-inner';

  const toolResults = {};
  s.messages.forEach(m => { if (m.role === 'tool') toolResults[m.tool_call_id] = m; });

  s.messages.forEach(m => {
    if (m.role === 'tool') return;
    if (m.role === 'user') {
      container.appendChild(buildTextMsg('user', 'You', '', m.content));
    } else if (m.role === 'assistant') {
      if (m.content && m.content.trim()) {
        container.appendChild(buildTextMsg('assistant', 'CodeNexus', m._engine || plannerLabel(), m.content, true));
      }
      if (m.tool_calls && m.tool_calls.length) {
        const wrap = document.createElement('div');
        wrap.className = 'msg';
        wrap.innerHTML = `<div class="msg-avatar assistant">N</div><div class="msg-content"></div>`;
        const content = wrap.querySelector('.msg-content');
        m.tool_calls.forEach(tc => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          if (tc.function.name === 'present_plan') {
            content.appendChild(renderPlanStatic(args));
            return;
          }
          const tcard = makeToolCard(tc.function.name, args);
          const res = toolResults[tc.id];
          if (res) {
            const ok = !res._isError;
            tcard.setStatus(ok ? 'ok' : 'err', ok ? 'done' : 'error');
            tcard.setBody(renderToolBody(tc.function.name, args, { ok, text: res.content }));
          } else {
            tcard.setStatus('wait', 'pending');
          }
          content.appendChild(tcard.card);
        });
        container.appendChild(wrap);
      }
    }
  });

  els.messages.appendChild(container);
  els.chatTitle.textContent = s.title;
  els.msgCount.textContent = String(s.messages.filter(m => m.role === 'assistant' || m.role === 'tool').length);
  updateCostDisplay();
  els.messages.scrollTop = els.messages.scrollHeight;
}

function buildTextMsg(role, name, tag, content, isMarkdown) {
  const item = document.createElement('div');
  item.className = 'msg';
  item.innerHTML = `
    <div class="msg-avatar ${role}">${role === 'user' ? 'U' : 'N'}</div>
    <div class="msg-content">
      <div class="msg-meta"><span>${name}</span>${tag ? `<span class="msg-meta-tag">${clean(tag)}</span>` : ''}</div>
      <div class="msg-body">${isMarkdown ? mdRender(content) : clean(content)}</div>
      <div class="msg-actions"><button class="msg-action copy">Copy</button></div>
    </div>`;
  const btn = item.querySelector('.copy');
  btn.onclick = () => {
    navigator.clipboard.writeText(content).then(() => {
      btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
  };
  return item;
}

function scrollToBottom() { els.messages.scrollTop = els.messages.scrollHeight; }

// ---------------------------------------------------------------------------
// Plan rendering — interactive (approval) and static (progress)
// ---------------------------------------------------------------------------
function normalizeSteps(steps) {
  return (steps || []).map(s => typeof s === 'string'
    ? { text: s, status: 'todo' }
    : { text: s.text || '', status: s.status || 'todo' });
}

function renderPlanStatic(args) {
  const steps = normalizeSteps(args.steps);
  const card = document.createElement('div');
  card.className = 'plan-card';
  const dot = (st) => st === 'done' ? '✓' : '';
  card.innerHTML = `
    <div class="plan-head">📋 ${clean(args.summary || 'Implementation plan')}<span class="plan-badge">plan</span></div>
    <div class="plan-steps">
      ${steps.map(s => `<div class="plan-step ${s.status}"><span class="step-dot">${dot(s.status)}</span><span class="step-text">${clean(s.text)}</span></div>`).join('')}
    </div>`;
  return card;
}

// Interactive plan: returns a promise resolving to { approved, steps, summary }.
function requestPlanApproval(container, args) {
  return new Promise((resolve) => {
    const steps = normalizeSteps(args.steps);
    const card = document.createElement('div');
    card.className = 'plan-card editable';
    card.innerHTML = `
      <div class="plan-head">📋 ${clean(args.summary || 'Review the plan')}<span class="plan-badge">review</span></div>
      <div class="plan-steps"></div>
      <div class="plan-actions">
        <button class="plan-btn add-step">+ Add step</button>
        <button class="plan-btn run" style="margin-left:auto;">Approve &amp; Run</button>
        <button class="plan-btn cancel">Cancel</button>
      </div>`;
    const stepsBin = card.querySelector('.plan-steps');
    const addStepRow = (text) => {
      const row = document.createElement('div');
      row.className = 'plan-step';
      row.innerHTML = `<span class="step-dot"></span><textarea rows="1">${clean(text)}</textarea><span class="plan-btn" style="padding:2px 7px;" title="Remove">×</span>`;
      const ta = row.querySelector('textarea');
      ta.style.height = 'auto'; ta.style.height = Math.max(24, ta.scrollHeight) + 'px';
      ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
      row.querySelector('.plan-btn').onclick = () => row.remove();
      stepsBin.appendChild(row);
    };
    steps.forEach(s => addStepRow(s.text));
    if (!steps.length) addStepRow('');
    card.querySelector('.add-step').onclick = () => addStepRow('');
    container.appendChild(card);
    scrollToBottom();

    const finish = (approved) => {
      const collected = [...stepsBin.querySelectorAll('textarea')].map(t => t.value.trim()).filter(Boolean);
      card.classList.remove('editable');
      card.querySelector('.plan-actions').remove();
      // Re-render as a static (approved) plan.
      if (approved) {
        card.querySelector('.plan-badge').textContent = 'approved';
        stepsBin.innerHTML = collected.map(t => `<div class="plan-step todo"><span class="step-dot"></span><span class="step-text">${clean(t)}</span></div>`).join('');
      }
      resolve({ approved, steps: collected.map(t => ({ text: t, status: 'todo' })), summary: args.summary || '' });
    };
    card.querySelector('.run').onclick = () => finish(true);
    card.querySelector('.cancel').onclick = () => finish(false);
  });
}

// ---------------------------------------------------------------------------
// Visual diff — LCS line diff + accept/reject review gate
// ---------------------------------------------------------------------------
function lineDiff(oldStr, newStr) {
  const a = (oldStr || '').split('\n');
  const b = (newStr || '').split('\n');
  const n = a.length, m = b.length;
  // LCS DP (fine for typical source files; capped defensively).
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'ctx', text: a[i], oldNo: i + 1, newNo: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', text: a[i], oldNo: i + 1 }); i++; }
    else { out.push({ t: 'add', text: b[j], newNo: j + 1 }); j++; }
  }
  while (i < n) out.push({ t: 'del', text: a[i], oldNo: ++i });
  while (j < m) out.push({ t: 'add', text: b[j], newNo: ++j });
  return out;
}

// Collapse long runs of unchanged context for readability.
function collapseDiff(rows, pad = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, idx) => {
    if (r.t !== 'ctx') for (let k = Math.max(0, idx - pad); k <= Math.min(rows.length - 1, idx + pad); k++) keep[k] = true;
  });
  const result = [];
  let skipping = false;
  rows.forEach((r, idx) => {
    if (keep[idx]) { result.push(r); skipping = false; }
    else if (!skipping) { result.push({ t: 'gap' }); skipping = true; }
  });
  return result;
}

function diffStats(rows) {
  let add = 0, del = 0;
  rows.forEach(r => { if (r.t === 'add') add++; else if (r.t === 'del') del++; });
  return { add, del };
}

// Show a diff review card. Resolves true (accept) / false (reject).
function requestDiffReview(container, filePath, oldStr, newStr) {
  return new Promise((resolve) => {
    const rows = lineDiff(oldStr, newStr);
    const { add, del } = diffStats(rows);
    const shown = collapseDiff(rows);
    const card = document.createElement('div');
    card.className = 'diff-review';
    const esc = (s) => clean(String(s ?? '')).replace(/</g, '&lt;');
    const body = shown.map(r => {
      if (r.t === 'gap') return `<div class="diff-line ctx"><span class="ln">⋯</span><span class="ln"></span><span class="lc" style="color:var(--faint)"> </span></div>`;
      const sign = r.t === 'add' ? '+' : r.t === 'del' ? '-' : ' ';
      return `<div class="diff-line ${r.t}"><span class="ln">${r.oldNo || ''}</span><span class="ln">${r.newNo || ''}</span><span class="lc">${esc(sign + ' ' + r.text)}</span></div>`;
    }).join('');
    card.innerHTML = `
      <div class="diff-head">📝 Review change <span class="diff-file">${clean(filePath)}</span>
        <span class="diff-stat"><span class="add">+${add}</span> <span class="del">-${del}</span></span></div>
      <div class="diff-body">${body || '<div class="diff-line ctx"><span class="ln"></span><span class="ln"></span><span class="lc"> (no textual change)</span></div>'}</div>
      <div class="diff-actions">
        <button class="diff-btn reject">Reject</button>
        <button class="diff-btn accept accept-all">Accept change</button>
      </div>`;
    container.appendChild(card);
    scrollToBottom();
    const finish = (ok) => {
      card.querySelector('.diff-actions').remove();
      const head = card.querySelector('.diff-head');
      head.insertAdjacentHTML('beforeend', `<span style="margin-left:8px;font-size:11px;color:${ok ? 'var(--good)' : 'var(--danger)'}">${ok ? '✓ accepted' : '✗ rejected'}</span>`);
      resolve(ok);
    };
    card.querySelector('.accept').onclick = () => finish(true);
    card.querySelector('.reject').onclick = () => finish(false);
  });
}

// ---------------------------------------------------------------------------
// Plain approval (for run_command)
// ---------------------------------------------------------------------------
function requestApproval(container, name, args) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'approval';
    const detail = name === 'run_command' ? args.command : JSON.stringify(args, null, 2);
    box.innerHTML = `
      <div class="approval-head">⚠️ CodeNexus wants to run a command</div>
      <div class="approval-detail">${clean(detail)}</div>
      <div class="approval-actions">
        <button class="approval-btn approve">Approve</button>
        <button class="approval-btn deny">Deny</button>
        <button class="approval-btn always">Approve &amp; don't ask again</button>
      </div>`;
    container.appendChild(box);
    scrollToBottom();
    const done = (val, always) => {
      if (always) { state.autoApprove = true; els.autoApproveToggle.classList.add('on'); save(); }
      box.remove();
      resolve(val);
    };
    box.querySelector('.approve').onclick = () => done(true, false);
    box.querySelector('.deny').onclick = () => done(false, false);
    box.querySelector('.always').onclick = () => done(true, true);
  });
}

// ---------------------------------------------------------------------------
// Checkpoints & rewind
// ---------------------------------------------------------------------------
async function journalFile(cp, relPath) {
  if (cp.files[relPath] !== undefined) return; // already captured pre-state this step
  try {
    const snap = await window.nexus.snapshotFile(relPath);
    cp.files[relPath] = snap.exists ? snap.content : null;
  } catch { cp.files[relPath] = null; }
}

function renderTimeline() {
  const s = currentSession();
  const cps = s?.checkpoints || [];
  if (!cps.length) { els.timelineSection.classList.add('hidden'); return; }
  els.timelineSection.classList.remove('hidden');
  els.checkpointCount.textContent = String(cps.length);
  els.timelineList.innerHTML = '';
  cps.forEach((cp, idx) => {
    const fileCount = Object.keys(cp.files || {}).length;
    const div = document.createElement('div');
    div.className = 'checkpoint' + (idx === cps.length - 1 ? ' current' : '');
    const meta = fileCount ? `${fileCount} file${fileCount === 1 ? '' : 's'} • ${cp.label || ''}` : (cp.label || 'no file changes');
    div.innerHTML = `
      <div class="cp-rail"><div class="cp-dot"></div><div class="cp-line"></div></div>
      <div class="cp-body">
        <div class="cp-label">${clean(cp.title || ('Step ' + (idx + 1)))}</div>
        <div class="cp-meta">${clean(meta)}</div>
      </div>
      <span class="cp-rewind">⟲ rewind</span>`;
    div.querySelector('.cp-rewind').onclick = () => rewindTo(idx);
    els.timelineList.appendChild(div);
  });
}

async function rewindTo(index) {
  const s = currentSession();
  if (!s || !s.checkpoints[index]) return;
  if (state.generating) { toast('Stop the agent before rewinding', 'error'); return; }
  const cp = s.checkpoints[index];
  const affected = new Set();
  for (let i = index; i < s.checkpoints.length; i++)
    Object.keys(s.checkpoints[i].files || {}).forEach(p => affected.add(p));
  if (!confirm(`Rewind to "${cp.title || 'Step ' + (index + 1)}"?\n\nThis restores ${affected.size} file(s) to their state before this step and removes everything after it.`)) return;

  // Build the restore map: earliest pre-state recorded at-or-after the target.
  const restore = {};
  for (let i = index; i < s.checkpoints.length; i++) {
    const files = s.checkpoints[i].files || {};
    for (const p in files) if (!(p in restore)) restore[p] = files[p];
  }
  let restored = 0, deleted = 0;
  for (const p in restore) {
    try {
      if (restore[p] === null) { await window.nexus.deleteFile(p); deleted++; }
      else { await window.nexus.writeFile(p, restore[p]); restored++; }
    } catch (e) { console.error('rewind restore failed for', p, e); }
  }
  s.messages = s.messages.slice(0, cp.msgIndex);
  s.checkpoints = s.checkpoints.slice(0, index);
  s.updated = Date.now();
  save();
  renderMessages(); renderTimeline(); renderSessions();
  toast(`Rewound · ${restored} restored, ${deleted} removed`, 'good');
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
async function executeTool(name, args) {
  if (!window.nexus) throw new Error('Native bridge unavailable (not running in Electron).');
  switch (name) {
    case 'list_dir': {
      const entries = await window.nexus.listDir(args.path || '.');
      return entries.map(e => (e.dir ? e.name + '/' : e.name)).join('\n') || '(empty directory)';
    }
    case 'read_file': {
      const content = await window.nexus.readFile(args.path);
      return content === '' ? '(empty file)' : content;
    }
    case 'write_file': {
      const r = await window.nexus.writeFile(args.path, args.content ?? '');
      return `Wrote ${r.bytes} bytes to ${r.path}`;
    }
    case 'edit_file': {
      const r = await window.nexus.editFile(args.path, args.old_string, args.new_string, !!args.replace_all);
      return `Edited ${r.path} (${r.replaced} replacement${r.replaced === 1 ? '' : 's'})`;
    }
    case 'grep': {
      const hits = await window.nexus.grep(args.pattern, args.glob);
      if (!hits.length) return 'No matches.';
      return hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n');
    }
    case 'run_command': {
      const r = await window.nexus.runCommand(args.command);
      let out = '';
      if (r.stdout) out += r.stdout;
      if (r.stderr) out += (out ? '\n' : '') + '[stderr]\n' + r.stderr;
      out += `\n[exit code: ${r.code}]`;
      return out.trim();
    }
    case 'web_search': {
      const hits = await window.nexus.webSearch(args.query, args.limit);
      if (!hits.length) return 'No results.';
      return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n');
    }
    case 'fetch_url': {
      const r = await window.nexus.webFetch(args.url);
      const head = r.title ? `# ${r.title}\n(${r.url})\n\n` : `(${r.url})\n\n`;
      return head + (r.text || '(no readable text extracted)');
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Provider request builders + SSE parsers
// ---------------------------------------------------------------------------
function toApiMessage(m) {
  if (m.role === 'assistant') {
    const out = { role: 'assistant', content: m.content || '' };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    return out;
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  return { role: m.role, content: m.content };
}

function convertToAnthropic(rawMessages) {
  const out = [];
  let pending = [];
  const flush = () => { if (pending.length) { out.push({ role: 'user', content: pending }); pending = []; } };
  for (const m of rawMessages) {
    if (m.role === 'tool') {
      pending.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '', is_error: !!m._isError });
      continue;
    }
    flush();
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content || '' }] });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content });
      for (const tc of (m.tool_calls || [])) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    }
  }
  flush();
  return out;
}

function buildRequest(provider, modelId, rawMessages, system) {
  const temp = parseFloat(els.paramTemp.value);
  const maxTokens = parseInt(els.paramMaxTokens.value);
  const tools = getTools();

  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getKey('anthropic'),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: {
        model: modelId,
        system,
        max_tokens: maxTokens,
        temperature: Math.min(temp, 1),
        stream: true,
        tools: tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
        messages: convertToAnthropic(rawMessages)
      }
    };
  }

  // OpenAI + OpenRouter share the chat/completions shape.
  const isOR = provider === 'openrouter';
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getKey(provider)}` };
  if (isOR) { headers['HTTP-Referer'] = 'https://codenexus.local'; headers['X-Title'] = 'CodeNexus'; }
  const body = {
    model: modelId,
    temperature: temp,
    max_tokens: maxTokens,
    stream: true,
    tools,
    tool_choice: 'auto',
    messages: [{ role: 'system', content: system }, ...rawMessages.map(toApiMessage)]
  };
  if (isOR) body.usage = { include: true };
  else body.stream_options = { include_usage: true };
  const url = isOR ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  return { url, headers, body };
}

// ---------------------------------------------------------------------------
// One streaming inference request (routed through the main-process proxy).
// Returns { content, tool_calls, usage } in canonical (OpenAI-ish) shape.
// ---------------------------------------------------------------------------
function streamCompletion(provider, modelId, rawMessages, system, onText) {
  return new Promise(async (resolve, reject) => {
    if (!modelId) return reject(new Error('No model selected. Pick one in the Models panel.'));
    if (!getKey(provider)) return reject(new Error(`Add your ${PROVIDER_LABEL[provider]} API key in the right panel.`));

    let req;
    try { req = buildRequest(provider, modelId, rawMessages, system); }
    catch (e) { return reject(e); }

    const requestId = uid();
    state.currentRequestId = requestId;

    // Accumulators
    let content = '';
    let usage = null;
    const toolCalls = [];     // OpenAI-style, indexed
    const anthropicBlocks = {}; // index -> { id, name, json }
    let buffer = '';

    const handleOpenAI = (json) => {
      if (json.usage) usage = json.usage;
      const delta = json.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) { content += delta.content; onText(content); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    };

    const handleAnthropic = (json) => {
      switch (json.type) {
        case 'message_start':
          usage = { input_tokens: json.message?.usage?.input_tokens || 0, output_tokens: 0 };
          break;
        case 'content_block_start':
          if (json.content_block?.type === 'tool_use')
            anthropicBlocks[json.index] = { id: json.content_block.id, name: json.content_block.name, json: '' };
          break;
        case 'content_block_delta':
          if (json.delta?.type === 'text_delta') { content += json.delta.text; onText(content); }
          else if (json.delta?.type === 'input_json_delta' && anthropicBlocks[json.index])
            anthropicBlocks[json.index].json += json.delta.partial_json;
          break;
        case 'message_delta':
          if (json.usage?.output_tokens != null) usage = { ...(usage || {}), output_tokens: json.usage.output_tokens };
          break;
      }
    };

    const processLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { return; }
      if (provider === 'anthropic') handleAnthropic(json); else handleOpenAI(json);
    };

    llmListeners.set(requestId, (text) => {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    });

    let res;
    try {
      res = await window.nexus.llmStream({ requestId, url: req.url, headers: req.headers, body: req.body });
    } catch (e) {
      llmListeners.delete(requestId);
      return reject(e);
    }
    llmListeners.delete(requestId);
    if (buffer.trim()) processLine(buffer);

    if (res.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; return reject(err); }
    if (!res.ok) {
      let detail = res.error || '';
      try { const j = JSON.parse(detail); detail = j.error?.message || j.error?.type || detail; } catch {}
      return reject(new Error(`${PROVIDER_LABEL[provider]} error${res.status ? ' ' + res.status : ''}${detail ? ': ' + String(detail).slice(0, 300) : ''}`));
    }

    // Assemble Anthropic tool_use blocks into canonical tool_calls.
    if (provider === 'anthropic') {
      Object.keys(anthropicBlocks).sort((a, b) => a - b).forEach(k => {
        const b = anthropicBlocks[k];
        toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: b.json || '{}' } });
      });
    }

    resolve({ content, tool_calls: toolCalls.filter(Boolean), usage: computeUsage(provider, modelId, usage) });
  });
}

// Global chunk dispatcher (registered once).
const llmListeners = new Map();

// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------
function stopAgent() {
  state.stopRequested = true;
  if (state.currentRequestId) window.nexus.llmAbort(state.currentRequestId);
}

async function runAgent() {
  if (state.generating) { stopAgent(); return; }

  const text = els.input.value.trim();
  if (!text) return;

  let s = currentSession();
  if (!s) { newSession(); s = currentSession(); }
  if (!s.checkpoints) s.checkpoints = [];

  s.messages.push({ role: 'user', content: text });
  if (s.title === 'New task') s.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  if (state.planMode) s.planApproved = false; // each instruction gets a fresh plan
  els.input.value = '';
  renderSessions();
  renderMessages();

  state.generating = true;
  state.stopRequested = false;
  setStatus('computing', 'Working…');
  els.sendLabel.textContent = 'Stop';
  els.sendBtn.classList.add('stop');

  let container = els.messages.querySelector('.messages-inner');
  if (!container) {
    els.messages.innerHTML = '';
    container = document.createElement('div');
    container.className = 'messages-inner';
    els.messages.appendChild(container);
  }

  let lastBatchReadOnly = false, lastBatchError = false;

  try {
    for (let step = 0; step < state.maxSteps; step++) {
      if (state.stopRequested) break;

      // --- Smart routing: choose which model handles this turn ---
      let slot = 'planner';
      if (state.routing) {
        if (step === 0 || lastBatchError) slot = 'planner';
        else if (lastBatchReadOnly) slot = 'worker';
        else slot = 'planner';
      }
      const turn = modelForSlot(slot);
      const engine = turn.id;

      let system = els.systemPrompt.value || DEFAULT_SYSTEM_PROMPT;
      if (state.planMode && !s.planApproved) system += PLAN_MODE_ADDENDUM;

      // Live assistant text node
      const liveMsg = document.createElement('div');
      liveMsg.className = 'msg streaming';
      liveMsg.innerHTML = `
        <div class="msg-avatar assistant">N</div>
        <div class="msg-content">
          <div class="msg-meta"><span>CodeNexus</span><span class="msg-meta-tag">${clean(engine)}</span>${state.routing ? `<span class="msg-meta-tag">${slot}</span>` : ''}</div>
          <div class="msg-body"></div>
        </div>`;
      const liveBody = liveMsg.querySelector('.msg-body');
      container.appendChild(liveMsg);
      scrollToBottom();

      let result;
      try {
        result = await streamCompletion(turn.provider, turn.id, s.messages, system, (txt) => {
          liveBody.innerHTML = mdRender(txt);
          scrollToBottom();
        });
      } catch (err) {
        liveMsg.remove();
        if (err.name === 'AbortError') break;
        throw err;
      }

      liveMsg.classList.remove('streaming');
      if (!result.content.trim()) liveMsg.remove();

      const assistantMsg = { role: 'assistant', content: result.content, _engine: engine };
      if (result.tool_calls.length) assistantMsg.tool_calls = result.tool_calls;
      const preToolMsgIndex = s.messages.length; // index of this assistant message
      s.messages.push(assistantMsg);
      s.updated = Date.now();

      if (result.usage) {
        s.cost = (s.cost || 0) + (result.usage.cost || 0);
        if (result.usage.approx) s.costApprox = true;
        s.tokensIn = (s.tokensIn || 0) + (result.usage.prompt_tokens || 0);
        s.tokensOut = (s.tokensOut || 0) + (result.usage.completion_tokens || 0);
        updateCostDisplay();
      }
      save();

      if (!result.tool_calls.length) break; // turn complete

      // --- Create a checkpoint for this step (journaled as tools mutate files) ---
      const cp = { id: uid(), title: 'Step ' + (s.checkpoints.length + 1), label: '', ts: Date.now(), files: {}, msgIndex: preToolMsgIndex };
      s.checkpoints.push(cp);

      // Execute each tool call
      const toolWrap = document.createElement('div');
      toolWrap.className = 'msg';
      toolWrap.innerHTML = `<div class="msg-avatar assistant">N</div><div class="msg-content"></div>`;
      const toolContent = toolWrap.querySelector('.msg-content');
      container.appendChild(toolWrap);

      let batchAllReadOnly = true, batchHadError = false;
      const usedTools = [];

      for (const tc of result.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        const name = tc.function.name;
        usedTools.push(name);
        if (!READ_ONLY_TOOLS.has(name)) batchAllReadOnly = false;

        // --- present_plan: interactive approval / progress update ---
        if (name === 'present_plan') {
          let resultText;
          if (!s.planApproved) {
            const outcome = await requestPlanApproval(toolContent, args);
            if (outcome.approved) {
              s.planApproved = true;
              s.plan = outcome.steps;
              resultText = 'The user APPROVED this plan. Proceed with implementation now.\nApproved plan:\n' +
                outcome.steps.map((st, i) => `${i + 1}. ${st.text}`).join('\n');
            } else {
              resultText = 'The user CANCELLED the plan. Stop and wait for further instructions.';
              batchHadError = true;
            }
          } else {
            s.plan = normalizeSteps(args.steps);
            toolContent.appendChild(renderPlanStatic(args));
            resultText = 'Plan progress updated.';
          }
          s.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: resultText });
          save();
          scrollToBottom();
          continue;
        }

        const tcard = makeToolCard(name, args);
        toolContent.appendChild(tcard.card);
        scrollToBottom();

        // --- Plan-first gate: block writes/commands before approval ---
        if (state.planMode && !s.planApproved && GATED_IN_PLAN.has(name)) {
          const msg = 'Blocked: present_plan and get user approval before editing files or running commands.';
          tcard.setStatus('err', 'blocked');
          tcard.setBody(renderToolBody(name, args, { ok: false, text: msg }), { open: true });
          s.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: msg, _isError: true });
          batchHadError = true; save(); continue;
        }

        // --- Review gate for mutating tools (skipped under auto-approve) ---
        if (!state.autoApprove && !READ_ONLY_TOOLS.has(name)) {
          if (FILE_MUTATING.has(name)) {
            // Visual diff review.
            tcard.setStatus('wait', 'review');
            let oldStr = '', newStr = '';
            try {
              const snap = await window.nexus.snapshotFile(args.path);
              oldStr = snap.exists ? snap.content : '';
              if (name === 'write_file') newStr = args.content ?? '';
              else { // edit_file — compute the preview result
                if (!snap.exists) { newStr = oldStr; }
                else if (!oldStr.includes(args.old_string)) { newStr = oldStr; }
                else newStr = args.replace_all ? oldStr.split(args.old_string).join(args.new_string) : oldStr.replace(args.old_string, args.new_string);
              }
            } catch {}
            const ok = await requestDiffReview(toolContent, args.path, oldStr, newStr);
            if (!ok) {
              tcard.setStatus('err', 'rejected');
              const msg = 'The user rejected this change.';
              tcard.setBody(renderToolBody(name, args, { ok: false, text: msg }), { open: false });
              s.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: msg, _isError: true });
              batchHadError = true; save(); continue;
            }
          } else {
            // run_command — plain approval.
            tcard.setStatus('wait', 'awaiting approval');
            const ok = await requestApproval(toolContent, name, args);
            if (!ok) {
              tcard.setStatus('err', 'denied');
              const msg = 'The user denied this action.';
              tcard.setBody(renderToolBody(name, args, { ok: false, text: msg }), { open: true });
              s.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: msg, _isError: true });
              batchHadError = true; save(); continue;
            }
          }
        }

        // --- Journal pre-state for rewind, then execute ---
        if (FILE_MUTATING.has(name) && args.path) await journalFile(cp, args.path);

        tcard.setStatus('running', 'running');
        let resultText, isError = false;
        try {
          resultText = await executeTool(name, args);
        } catch (err) {
          resultText = 'Error: ' + err.message;
          isError = true;
        }
        if (isError) batchHadError = true;
        tcard.setStatus(isError ? 'err' : 'ok', isError ? 'error' : 'done');
        tcard.setBody(renderToolBody(name, args, { ok: !isError, text: resultText }), { open: isError || name === 'run_command' });
        s.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: resultText, _isError: isError });
        s.updated = Date.now();
        save();
        scrollToBottom();
      }

      // Label the checkpoint and refresh the timeline.
      cp.label = [...new Set(usedTools)].join(', ');
      const changed = Object.keys(cp.files);
      if (changed.length) cp.title = changed.length === 1 ? changed[0].split('/').pop() : `${changed.length} files`;
      renderTimeline();

      lastBatchReadOnly = batchAllReadOnly && !batchHadError;
      lastBatchError = batchHadError;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      const errBox = document.createElement('div');
      errBox.className = 'msg';
      errBox.innerHTML = `<div class="msg-avatar assistant">N</div><div class="msg-content"><div class="msg-body" style="color:var(--danger)">⚠️ ${clean(err.message)}</div></div>`;
      container.appendChild(errBox);
      toast(err.message, 'error');
    }
  } finally {
    state.generating = false;
    state.stopRequested = false;
    state.currentRequestId = null;
    setStatus('ready', 'Ready');
    els.sendLabel.textContent = 'Send';
    els.sendBtn.className = 'send-btn';
    renderSessions();
    renderMessages();
    renderTimeline();
    save();
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
function wire() {
  els.paramTemp.oninput = () => { els.numTemp.textContent = parseFloat(els.paramTemp.value).toFixed(2); save(); };
  els.paramMaxTokens.oninput = () => { els.numMaxTokens.textContent = els.paramMaxTokens.value; save(); };
  els.paramMaxSteps.oninput = () => { state.maxSteps = parseInt(els.paramMaxSteps.value); els.numMaxSteps.textContent = els.paramMaxSteps.value; save(); };

  els.autoApproveToggle.onclick = () => {
    state.autoApprove = !state.autoApprove;
    els.autoApproveToggle.classList.toggle('on', state.autoApprove);
    save();
  };
  els.routingToggle.onclick = () => {
    state.routing = !state.routing;
    els.routingToggle.classList.toggle('on', state.routing);
    els.slotWorker.classList.toggle('disabled', !state.routing);
    updateHeaderModel(); save();
  };
  els.planModeToggle.onclick = () => {
    state.planMode = !state.planMode;
    els.planModeToggle.classList.toggle('on', state.planMode);
    save();
  };

  // API keys
  els.keyAnthropic.oninput = () => { state.keys.anthropic = els.keyAnthropic.value.trim(); refreshKeyDots(); save(); };
  els.keyOpenai.oninput = () => { state.keys.openai = els.keyOpenai.value.trim(); refreshKeyDots(); save(); };
  els.keyOpenrouter.oninput = () => { state.keys.openrouter = els.keyOpenrouter.value.trim(); refreshKeyDots(); save(); };

  // Model slots: provider segs + search + select
  document.querySelectorAll('.mini-seg').forEach(seg => {
    const slot = seg.dataset.providerSeg;
    seg.querySelectorAll('.mini-seg-btn').forEach(btn => {
      btn.onclick = () => setProvider(slot, btn.dataset.provider);
    });
  });
  document.querySelectorAll('.model-search').forEach(inp => {
    inp.oninput = () => rebuildModelSelect(inp.dataset.slot);
  });
  document.querySelectorAll('.model-select').forEach(sel => {
    sel.onchange = () => { state.models[sel.dataset.slot].id = sel.value; updateModelPricing(sel.dataset.slot); updateHeaderModel(); save(); };
  });

  els.orLoginBtn.onclick = async () => {
    if (window.nexus?.startOAuth) {
      const r = await window.nexus.startOAuth();
      if (r?.ok) toast('Opening OpenRouter in your browser…');
      else toast('Could not start OAuth: ' + (r?.error || 'unknown'), 'error');
    } else {
      const callbackUrl = window.location.origin + window.location.pathname;
      window.location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}`;
    }
  };

  els.pickFolderBtn.onclick = pickFolder;
  els.newSessionBtn.onclick = newSession;
  els.sendBtn.onclick = runAgent;

  els.input.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runAgent(); }
  });

  els.clearBtn.onclick = () => {
    const s = currentSession();
    if (s && confirm('Clear all messages and checkpoints in this task?')) {
      s.messages = []; s.checkpoints = []; s.cost = 0; s.costApprox = false; s.planApproved = false;
      renderMessages(); renderTimeline(); save();
    }
  };

  els.exportBtn.onclick = () => {
    const s = currentSession();
    if (!s || !s.messages.length) return;
    let out = `# ${s.title}\n\n`;
    s.messages.forEach(m => {
      if (m.role === 'user') out += `## You\n\n${m.content}\n\n`;
      else if (m.role === 'assistant') {
        if (m.content) out += `## CodeNexus\n\n${m.content}\n\n`;
        (m.tool_calls || []).forEach(tc => out += `> 🔧 \`${tc.function.name}(${tc.function.arguments})\`\n\n`);
      } else if (m.role === 'tool') out += `> ↳ ${m.content.slice(0, 500)}\n\n`;
    });
    const blob = new Blob([out], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${s.title.replace(/[^\w]+/g, '_').toLowerCase()}.md`;
    document.body.appendChild(a); a.click(); a.remove();
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function main() {
  // Register the single global chunk dispatcher for the streaming proxy.
  if (window.nexus?.onLlmChunk) {
    window.nexus.onLlmChunk(({ requestId, text }) => {
      const fn = llmListeners.get(requestId);
      if (fn) fn(text);
    });
  }

  wire();
  load();

  if (!Object.keys(state.sessions).length) newSession();
  else { renderSessions(); renderMessages(); renderTimeline(); }

  setStatus('ready', 'Ready');
  updateHeaderModel();
  refreshWorkspaceLabel();
  handleOpenRouterAuth();

  // Load OpenRouter's live catalog (used by either slot set to OpenRouter).
  await fetchOpenRouterModels();
  rebuildModelSelect('planner');
  rebuildModelSelect('worker');
}
main();

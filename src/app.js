// ============================================================================
// CodeNexus renderer — chat UI + agentic tool-calling loop.
// Talks to OpenRouter / OpenAI / Anthropic for inference; talks to the Electron
// main process (via window.nexus) for filesystem + shell access.
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

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  keys: { openrouter: '' },
  models: { openrouter: '' },
  orModelCache: [],
  sessions: {},
  currentSessionId: null,
  workspace: null,
  autoApprove: false,
  maxSteps: 25,
  generating: false,
  abortController: null
};

const $ = id => document.getElementById(id);
const els = {
  orKey: $('or-key'), orModelSearch: $('or-model-search'), orModelSelect: $('or-model-select'),
  orPricingHint: $('or-pricing-hint'), orLoginBtn: $('or-login-btn'),
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
  workspacePath: $('workspace-path'), pickFolderBtn: $('pick-folder-btn')
};

const SUGGESTIONS = [
  { title: 'Explore', body: 'Read through this project and give me a summary of its architecture and main entry points.' },
  { title: 'Research', body: 'Search the web for the latest stable version of the main dependency here and tell me what changed.' },
  { title: 'Fix', body: 'Run the test suite, find any failing tests, and fix the underlying bugs.' }
];

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling schema, sent to the model)
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

const READ_ONLY_TOOLS = new Set(['list_dir', 'read_file', 'grep', 'web_search', 'fetch_url']);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function uid() { return 'task_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

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

function activeModel() {
  return state.models.openrouter;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function save() {
  localStorage.setItem('codenexus_state', JSON.stringify({
    keys: state.keys, models: state.models,
    sessions: state.sessions, currentSessionId: state.currentSessionId,
    autoApprove: state.autoApprove, maxSteps: state.maxSteps,
    systemPrompt: els.systemPrompt.value, temp: els.paramTemp.value, maxTokens: els.paramMaxTokens.value
  }));
}

function load() {
  try {
    const raw = localStorage.getItem('codenexus_state');
    els.systemPrompt.value = DEFAULT_SYSTEM_PROMPT;
    if (!raw) return;
    const p = JSON.parse(raw);
    state.keys = p.keys || state.keys;
    state.models = p.models || state.models;
    state.sessions = p.sessions || {};
    state.currentSessionId = p.currentSessionId || null;
    state.autoApprove = !!p.autoApprove;
    state.maxSteps = p.maxSteps || 25;
    if (p.systemPrompt) els.systemPrompt.value = p.systemPrompt;
    if (p.temp) { els.paramTemp.value = p.temp; els.numTemp.textContent = parseFloat(p.temp).toFixed(2); }
    if (p.maxTokens) { els.paramMaxTokens.value = p.maxTokens; els.numMaxTokens.textContent = p.maxTokens; }
    els.paramMaxSteps.value = state.maxSteps; els.numMaxSteps.textContent = state.maxSteps;
    els.orKey.value = state.keys.openrouter || '';
    els.autoApproveToggle.classList.toggle('on', state.autoApprove);
  } catch (e) { console.error('Failed to load state:', e); }
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
// OpenRouter model browser (carried over from the original app)
// ---------------------------------------------------------------------------
// Exchange an OpenRouter OAuth code for an API key and wire it into the app.
async function exchangeOpenRouterCode(code) {
  toast('Exchanging OpenRouter credentials…');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    });
    if (!res.ok) throw new Error('rejected');
    const data = await res.json();
    if (data && data.key) {
      state.keys.openrouter = data.key; els.orKey.value = data.key; save();
      await fetchOpenRouterModels();
      toast('OpenRouter connected', 'good');
    }
  } catch { toast('OpenRouter auth failed', 'error'); }
}

async function handleOpenRouterAuth() {
  // Electron: the main process delivers the code via the codenexus:// deep link.
  if (window.nexus?.onOAuthCallback) {
    window.nexus.onOAuthCallback(({ code }) => { if (code) exchangeOpenRouterCode(code); });
  }
  // Web fallback: code arrives as a ?code= URL param.
  const code = new URLSearchParams(window.location.search).get('code');
  if (code) {
    window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
    await exchangeOpenRouterCode(code);
  }
}

async function fetchOpenRouterModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error('http');
    const payload = await res.json();
    state.orModelCache = payload.data || [];
    rebuildOpenRouterDropdown();
  } catch { els.orModelSelect.innerHTML = '<option value="">Failed to load models</option>'; }
}

function rebuildOpenRouterDropdown() {
  const q = els.orModelSearch.value.toLowerCase().trim();
  const filtered = state.orModelCache.filter(m => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
  els.orModelSelect.innerHTML = '';
  if (!filtered.length) { els.orModelSelect.innerHTML = '<option value="">No models found</option>'; return; }
  filtered.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const inRate = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1e6 : 0;
    const outRate = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1e6 : 0;
    const isFree = (inRate === 0 && outRate === 0);
    const tag = isFree ? ' · free' : ` · $${inRate.toFixed(2)}/$${outRate.toFixed(2)} per 1M`;
    const ctx = m.context_length ? ` [${Math.round(m.context_length / 1000)}k]` : '';
    opt.textContent = `${m.id}${ctx}${tag}`;
    els.orModelSelect.appendChild(opt);
  });
  if (state.models.openrouter && [...els.orModelSelect.options].some(o => o.value === state.models.openrouter)) {
    els.orModelSelect.value = state.models.openrouter;
  } else if (els.orModelSelect.options[0]) {
    state.models.openrouter = els.orModelSelect.options[0].value;
  }
  updatePricingHint(); updateHeaderModel();
}

function updatePricingHint() {
  const m = state.orModelCache.find(x => x.id === els.orModelSelect.value);
  if (!m) { els.orPricingHint.textContent = 'No model selected'; return; }
  const inC = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1e6 : 0;
  const outC = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1e6 : 0;
  const ctx = m.context_length ? m.context_length.toLocaleString() : 'unknown';
  els.orPricingHint.innerHTML = (inC === 0 && outC === 0)
    ? `<strong>Free model</strong><br>$0.00 / 1M tokens<br>Context: ${ctx}`
    : `<strong>Pricing</strong><br>In: $${inC.toFixed(2)} / 1M<br>Out: $${outC.toFixed(2)} / 1M<br>Context: ${ctx}`;
}

function updateHeaderModel() {
  const m = activeModel();
  els.headerModel.textContent = m ? (m.length > 28 ? m.slice(0, 27) + '…' : m) : '—';
}

// ---------------------------------------------------------------------------
// Cost / usage tracking
// ---------------------------------------------------------------------------
function fmtCost(c) {
  if (!c) return '$0.0000';
  return c < 1 ? '$' + c.toFixed(4) : '$' + c.toFixed(2);
}

function updateCostDisplay() {
  const s = currentSession();
  const cost = s?.cost || 0;
  els.headerCost.textContent = fmtCost(cost);
  els.statusCost.textContent = fmtCost(cost);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function newSession() {
  const id = uid();
  state.sessions[id] = { id, title: 'New task', messages: [], updated: Date.now() };
  state.currentSessionId = id;
  renderSessions(); renderMessages(); save();
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
    div.addEventListener('click', () => { state.currentSessionId = s.id; renderSessions(); renderMessages(); save(); });
    div.querySelector('.session-del').addEventListener('click', (e) => {
      e.stopPropagation();
      delete state.sessions[s.id];
      if (state.currentSessionId === s.id) {
        const keys = Object.keys(state.sessions);
        state.currentSessionId = keys[keys.length - 1] || null;
      }
      if (!state.currentSessionId) newSession(); else { renderSessions(); renderMessages(); save(); }
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
    <div class="welcome-p">Open a project folder, pick a model, and describe a task. CodeNexus will read, edit, and run code to get it done.</div>
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
    return args.path || '';
  } catch { return ''; }
}

const TOOL_ICONS = { read_file: '📄', write_file: '✍️', edit_file: '✏️', list_dir: '📁', grep: '🔎', run_command: '▶️', web_search: '🌐', fetch_url: '🔗' };

// Build a tool-call card element. Returns { card, setStatus, setBody }.
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
  // result: { ok, text } where text is the raw tool output string
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

  // Index tool results by tool_call_id for quick lookup
  const toolResults = {};
  s.messages.forEach(m => { if (m.role === 'tool') toolResults[m.tool_call_id] = m; });

  s.messages.forEach(m => {
    if (m.role === 'tool') return; // rendered inside their assistant card
    if (m.role === 'user') {
      container.appendChild(buildTextMsg('user', 'You', '', m.content));
    } else if (m.role === 'assistant') {
      if (m.content && m.content.trim()) {
        container.appendChild(buildTextMsg('assistant', 'CodeNexus', m._engine || activeModel(), m.content, true));
      }
      if (m.tool_calls && m.tool_calls.length) {
        const wrap = document.createElement('div');
        wrap.className = 'msg';
        wrap.innerHTML = `<div class="msg-avatar assistant">N</div><div class="msg-content"></div>`;
        const content = wrap.querySelector('.msg-content');
        m.tool_calls.forEach(tc => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
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
// Approval flow — returns a promise resolving to true (run) or false (deny)
// ---------------------------------------------------------------------------
function requestApproval(container, name, args) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'approval';
    const detail = name === 'run_command' ? args.command
      : name === 'write_file' ? `${args.path}\n\n${(args.content || '').slice(0, 1200)}`
      : name === 'edit_file' ? `${args.path}\n\n- ${args.old_string}\n+ ${args.new_string}`
      : JSON.stringify(args, null, 2);
    const verb = name === 'run_command' ? 'run a command' : name === 'write_file' ? 'write a file' : 'edit a file';
    box.innerHTML = `
      <div class="approval-head">⚠️ CodeNexus wants to ${verb}</div>
      <div class="approval-detail">${clean(detail)}</div>
      <div class="approval-actions">
        <button class="approval-btn approve">Approve</button>
        <button class="approval-btn deny">Deny</button>
        <button class="approval-btn always">Approve & don't ask again</button>
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
// One streaming inference request. Accumulates assistant text + tool_calls.
// Calls onText(deltaText) as content streams in.
// Returns { content, tool_calls } in OpenAI assistant-message shape.
// ---------------------------------------------------------------------------
async function streamCompletion(apiMessages, onText) {
  const model = activeModel();
  if (!model) throw new Error('No model selected. Pick one in the OpenRouter panel.');

  const key = state.keys.openrouter || els.orKey.value.trim();
  if (!key) throw new Error('Add your OpenRouter API key (or connect via OAuth) in the right panel.');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
    'HTTP-Referer': 'https://codenexus.local',
    'X-Title': 'CodeNexus'
  };
  const body = {
    model,
    temperature: parseFloat(els.paramTemp.value),
    max_tokens: parseInt(els.paramMaxTokens.value),
    stream: true,
    tools: TOOLS,
    tool_choice: 'auto',
    usage: { include: true }, // ask OpenRouter to report token usage + cost
    messages: apiMessages
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body), signal: state.abortController.signal
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`API error ${res.status}${detail ? ': ' + detail : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let usage = null;
  const toolCalls = []; // accumulate by index

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith(':') || !t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.usage) usage = chunk.usage; // final chunk carries token + cost totals
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
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
    }
  }
  return { content, tool_calls: toolCalls.filter(Boolean), usage };
}

// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------
async function runAgent() {
  if (state.generating) { state.abortController?.abort(); return; }

  const text = els.input.value.trim();
  if (!text) return;

  let s = currentSession();
  if (!s) { newSession(); s = currentSession(); }

  s.messages.push({ role: 'user', content: text });
  if (s.title === 'New task') s.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  els.input.value = '';
  renderSessions();
  renderMessages();

  state.generating = true;
  state.abortController = new AbortController();
  setStatus('computing', 'Working…');
  els.sendLabel.textContent = 'Stop';
  els.sendBtn.classList.add('stop');

  // Use a persistent live container so streaming nodes append in order.
  let container = els.messages.querySelector('.messages-inner');
  if (!container) {
    els.messages.innerHTML = '';
    container = document.createElement('div');
    container.className = 'messages-inner';
    els.messages.appendChild(container);
  }

  const engine = activeModel();
  let denied = false;

  try {
    for (let step = 0; step < state.maxSteps; step++) {
      if (state.abortController.signal.aborted) break;

      // Build API messages from session history (strip our private fields)
      const apiMessages = [
        { role: 'system', content: els.systemPrompt.value || DEFAULT_SYSTEM_PROMPT },
        ...s.messages.map(toApiMessage)
      ];

      // Live assistant text node
      const liveMsg = document.createElement('div');
      liveMsg.className = 'msg streaming';
      liveMsg.innerHTML = `
        <div class="msg-avatar assistant">N</div>
        <div class="msg-content">
          <div class="msg-meta"><span>CodeNexus</span><span class="msg-meta-tag">${clean(engine)}</span></div>
          <div class="msg-body"></div>
        </div>`;
      const liveBody = liveMsg.querySelector('.msg-body');
      container.appendChild(liveMsg);
      scrollToBottom();

      let result;
      try {
        result = await streamCompletion(apiMessages, (txt) => {
          liveBody.innerHTML = mdRender(txt);
          scrollToBottom();
        });
      } catch (err) {
        liveMsg.remove();
        throw err;
      }

      liveMsg.classList.remove('streaming');
      if (!result.content.trim()) liveMsg.remove(); // no text this turn (pure tool call)

      // Record assistant message
      const assistantMsg = { role: 'assistant', content: result.content, _engine: engine };
      if (result.tool_calls.length) assistantMsg.tool_calls = result.tool_calls;
      s.messages.push(assistantMsg);
      s.updated = Date.now();

      // Accumulate token usage + cost reported by OpenRouter
      if (result.usage) {
        s.cost = (s.cost || 0) + (result.usage.cost || 0);
        s.tokensIn = (s.tokensIn || 0) + (result.usage.prompt_tokens || 0);
        s.tokensOut = (s.tokensOut || 0) + (result.usage.completion_tokens || 0);
        updateCostDisplay();
      }
      save();

      if (!result.tool_calls.length) break; // task turn complete

      // Execute each tool call
      const toolWrap = document.createElement('div');
      toolWrap.className = 'msg';
      toolWrap.innerHTML = `<div class="msg-avatar assistant">N</div><div class="msg-content"></div>`;
      const toolContent = toolWrap.querySelector('.msg-content');
      container.appendChild(toolWrap);

      for (const tc of result.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        const name = tc.function.name;
        const tcard = makeToolCard(name, args);
        toolContent.appendChild(tcard.card);
        scrollToBottom();

        // Approval gate for mutating tools
        if (!READ_ONLY_TOOLS.has(name) && !state.autoApprove) {
          tcard.setStatus('wait', 'awaiting approval');
          const ok = await requestApproval(toolContent, name, args);
          if (!ok) {
            tcard.setStatus('err', 'denied');
            const denyText = 'The user denied this action.';
            tcard.setBody(renderToolBody(name, args, { ok: false, text: denyText }), { open: true });
            s.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: denyText, _isError: true });
            save();
            continue;
          }
        }

        tcard.setStatus('running', 'running');
        let resultText, isError = false;
        try {
          resultText = await executeTool(name, args);
        } catch (err) {
          resultText = 'Error: ' + err.message;
          isError = true;
        }
        tcard.setStatus(isError ? 'err' : 'ok', isError ? 'error' : 'done');
        tcard.setBody(renderToolBody(name, args, { ok: !isError, text: resultText }), { open: isError || name === 'run_command' });
        s.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: resultText, _isError: isError });
        s.updated = Date.now();
        save();
        scrollToBottom();
      }
      // loop continues: model sees tool results next iteration
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
    state.abortController = null;
    setStatus('ready', 'Ready');
    els.sendLabel.textContent = 'Send';
    els.sendBtn.className = 'send-btn';
    renderSessions();
    renderMessages(); // canonical re-render from saved state
    save();
  }
}

// Strip private fields (_engine, _isError) before sending to the API.
function toApiMessage(m) {
  if (m.role === 'assistant') {
    const out = { role: 'assistant', content: m.content || '' };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    return out;
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  }
  return { role: m.role, content: m.content };
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

  els.orKey.oninput = () => { state.keys.openrouter = els.orKey.value.trim(); save(); };
  els.orModelSelect.onchange = () => { state.models.openrouter = els.orModelSelect.value; updatePricingHint(); updateHeaderModel(); save(); };
  els.orModelSearch.oninput = rebuildOpenRouterDropdown;
  els.orLoginBtn.onclick = async () => {
    if (window.nexus?.startOAuth) {
      // Electron: main process runs a localhost callback server and opens the
      // auth page in the user's real browser. The code comes back via onOAuthCallback.
      const r = await window.nexus.startOAuth();
      if (r?.ok) toast('Opening OpenRouter in your browser…');
      else toast('Could not start OAuth: ' + (r?.error || 'unknown'), 'error');
    } else {
      // Web fallback: redirect this page through the auth flow.
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
    if (s && confirm('Clear all messages in this task?')) { s.messages = []; renderMessages(); save(); }
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
  wire();
  load();
  // Render the UI up front so a slow/failed async call never leaves a blank app.
  if (!Object.keys(state.sessions).length) newSession();
  else { renderSessions(); renderMessages(); }
  setStatus('ready', 'Ready');
  updateHeaderModel();
  // Best-effort async setup.
  refreshWorkspaceLabel();
  handleOpenRouterAuth();
  fetchOpenRouterModels();
}
main();

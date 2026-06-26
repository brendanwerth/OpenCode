// ============================================================================
// CodeNexus — Electron main process
// Owns the window and all privileged operations (filesystem, shell). The
// renderer can only reach these through IPC, and every path is sandboxed to
// the currently selected workspace root.
// ============================================================================
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const { spawn } = require('child_process');

let mainWindow = null;
let workspaceRoot = null; // absolute path of the project the agent operates in

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#fafaf9',
    title: 'CodeNexus',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // Keep the app window on its own page. Any attempt to navigate to an external
  // site (e.g. the OpenRouter auth page) is opened in the user's real browser.
  const wc = mainWindow.webContents;
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('console-message', (_e, level, message) => {
    console.log('[renderer]', message);
  });
}

// Single instance: focus the existing window instead of opening a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Path sandboxing: resolve a user/agent-supplied path against the workspace
// root and refuse anything that escapes it.
// ---------------------------------------------------------------------------
function resolveInWorkspace(relOrAbs) {
  if (!workspaceRoot) throw new Error('No workspace folder is open. Pick a folder first.');
  const resolved = path.resolve(workspaceRoot, relOrAbs || '.');
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${relOrAbs}" is outside the workspace and was blocked.`);
  }
  return resolved;
}

function rel(p) {
  return path.relative(workspaceRoot, p).split(path.sep).join('/') || '.';
}

// ---------------------------------------------------------------------------
// Workspace selection
// ---------------------------------------------------------------------------
ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a project folder for CodeNexus'
  });
  if (result.canceled || !result.filePaths.length) return null;
  workspaceRoot = result.filePaths[0];
  return workspaceRoot;
});

ipcMain.handle('workspace:get', () => workspaceRoot);

ipcMain.handle('workspace:set', (_e, p) => {
  if (p) workspaceRoot = p;
  return workspaceRoot;
});

// ---------------------------------------------------------------------------
// OpenRouter OAuth via a localhost loopback callback.
// OpenRouter only accepts `localhost` (any port) or https:443/3000 callback
// URLs — custom schemes like codenexus:// are rejected. So we bind a throwaway
// HTTP server on a random port, open the auth page in the user's browser, and
// catch the ?code= redirect here, then hand it to the renderer.
// ---------------------------------------------------------------------------
let oauthServer = null;
ipcMain.handle('oauth:start', async () => {
  if (oauthServer) { try { oauthServer.close(); } catch {} oauthServer = null; }
  return await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let code = null;
      try { code = new URL(req.url, 'http://localhost').searchParams.get('code'); } catch {}
      if (!code) { res.writeHead(204); res.end(); return; } // ignore favicon etc.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:3rem;color:#09090b">
        <h2>✅ OpenRouter connected</h2>
        <p>You can close this tab and return to CodeNexus.</p></body></html>`);
      try { server.close(); } catch {}
      oauthServer = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('oauth:callback', { code });
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
    server.on('error', (err) => resolve({ ok: false, error: err.message }));
    // Bind dual-stack (no host) so the browser reaches us whether `localhost`
    // resolves to 127.0.0.1 or ::1 on this machine.
    server.listen(0, () => {
      oauthServer = server;
      const port = server.address().port;
      const callbackUrl = `http://localhost:${port}/callback`;
      shell.openExternal(`https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}`);
      resolve({ ok: true, port });
    });
    // Stop listening after 5 minutes if the user never completes the flow.
    setTimeout(() => { try { server.close(); } catch {} if (oauthServer === server) oauthServer = null; }, 5 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Filesystem tools
// ---------------------------------------------------------------------------
ipcMain.handle('fs:read', async (_e, relPath) => {
  const abs = resolveInWorkspace(relPath);
  const data = await fs.readFile(abs, 'utf8');
  return data;
});

ipcMain.handle('fs:write', async (_e, { path: relPath, content }) => {
  const abs = resolveInWorkspace(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return { ok: true, path: rel(abs), bytes: Buffer.byteLength(content, 'utf8') };
});

ipcMain.handle('fs:edit', async (_e, { path: relPath, oldString, newString, replaceAll }) => {
  const abs = resolveInWorkspace(relPath);
  const original = await fs.readFile(abs, 'utf8');
  if (!original.includes(oldString)) {
    throw new Error('The text to replace was not found in the file. Read the file first to get an exact match.');
  }
  const occurrences = original.split(oldString).length - 1;
  if (!replaceAll && occurrences > 1) {
    throw new Error(`The text appears ${occurrences} times. Provide more surrounding context to make it unique, or set replaceAll.`);
  }
  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);
  await fs.writeFile(abs, updated, 'utf8');
  return { ok: true, path: rel(abs), replaced: replaceAll ? occurrences : 1 };
});

ipcMain.handle('fs:list', async (_e, relPath) => {
  const abs = resolveInWorkspace(relPath || '.');
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries
    .filter(e => e.name !== '.git' && e.name !== 'node_modules')
    .map(e => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
});

// Recursive grep across the workspace (skips heavy/binary dirs).
ipcMain.handle('fs:grep', async (_e, { pattern, glob }) => {
  const re = new RegExp(pattern, 'i');
  const results = [];
  const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out']);
  async function walk(dir) {
    if (results.length >= 200) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= 200) return;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (glob && !e.name.match(globToRegExp(glob))) continue;
      let content;
      try { content = await fs.readFile(full, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push({ file: rel(full), line: i + 1, text: lines[i].slice(0, 240).trim() });
          if (results.length >= 200) break;
        }
      }
    }
  }
  await walk(workspaceRoot);
  return results;
});

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

// ---------------------------------------------------------------------------
// Shell tool — runs a command inside the workspace and streams nothing back,
// just resolves with captured output. Hard timeout to avoid hung processes.
// ---------------------------------------------------------------------------
ipcMain.handle('shell:exec', async (_e, { command, timeoutMs }) => {
  if (!workspaceRoot) throw new Error('No workspace folder is open.');
  return await new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const args = isWin ? ['-NoProfile', '-Command', command] : ['-lc', command];
    const child = spawn(shell, args, { cwd: workspaceRoot, windowsHide: true });

    let stdout = '';
    let stderr = '';
    const cap = 100_000; // cap captured output so a runaway command can't blow up memory
    child.stdout.on('data', d => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', d => { if (stderr.length < cap) stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr: stderr + '\n[CodeNexus] Command timed out and was killed.', code: -1, timedOut: true });
    }, timeoutMs || 120_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n' + err.message, code: -1 });
    });
  });
});

// ---------------------------------------------------------------------------
// Checkpoint primitives — snapshot a file's current state (for rewind) and
// delete a file (to undo a creation). Both are workspace-sandboxed.
// ---------------------------------------------------------------------------
ipcMain.handle('fs:snapshot', async (_e, relPath) => {
  const abs = resolveInWorkspace(relPath);
  try {
    const content = await fs.readFile(abs, 'utf8');
    return { exists: true, content };
  } catch {
    return { exists: false, content: null };
  }
});

ipcMain.handle('fs:delete', async (_e, relPath) => {
  const abs = resolveInWorkspace(relPath);
  try { await fs.unlink(abs); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// LLM streaming proxy. All provider traffic (OpenRouter / Anthropic / OpenAI)
// flows through the main process so we never hit browser CORS limits and the
// renderer keeps a single, uniform SSE stream to parse. Chunks are forwarded
// to the renderer as raw decoded text via the `llm:chunk` channel.
// ---------------------------------------------------------------------------
const llmControllers = new Map();

ipcMain.handle('llm:stream', async (_e, { requestId, url, headers, body }) => {
  const ctrl = new AbortController();
  llmControllers.set(requestId, ctrl);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch {}
      return { ok: false, status: res.status, error: detail.slice(0, 2000) };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('llm:chunk', { requestId, text });
      }
    }
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: err.message };
  } finally {
    llmControllers.delete(requestId);
  }
});

ipcMain.handle('llm:abort', (_e, requestId) => {
  const c = llmControllers.get(requestId);
  if (c) { try { c.abort(); } catch {} }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Web tools — let the agent browse. No API key required: search uses
// DuckDuckGo's HTML endpoint; fetch pulls a page and extracts readable text.
// ---------------------------------------------------------------------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

ipcMain.handle('web:search', async (_e, { query, limit }) => {
  const res = await fetchWithTimeout(
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
    { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }
  );
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const html = await res.text();
  const results = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let sm;
  while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]));
  let m, i = 0;
  const max = Math.min(limit || 8, 15);
  while ((m = linkRe.exec(html)) && results.length < max) {
    let url = m[1];
    // DuckDuckGo wraps results in a redirect: //duckduckgo.com/l/?uddg=<real>
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith('//')) url = 'https:' + url;
    const title = stripTags(m[2]);
    const isAd = /duckduckgo\.com\/y\.js|ad_domain=/.test(url); // skip sponsored results
    if (title && url.startsWith('http') && !isAd) {
      results.push({ title, url, snippet: snippets[i] || '' });
    }
    i++;
  }
  return results;
});

ipcMain.handle('web:fetch', async (_e, { url, maxChars }) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Fetch failed (HTTP ${res.status})`);
  const ctype = res.headers.get('content-type') || '';
  const raw = await res.text();
  const cap = Math.min(maxChars || 15000, 50000);
  if (!/html/i.test(ctype)) {
    return { url: res.url, title: '', text: raw.slice(0, cap) }; // plain text / json / etc.
  }
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';
  const body = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = stripTags(body).slice(0, cap);
  return { url: res.url, title, text };
});

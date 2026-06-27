const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { createLmStudioManager } = require('./src/main/services/lmStudioManager.js');

// Resource Monitoring System
let resourceMonitorInterval = null;
function startResourceMonitor(win) {
    if (resourceMonitorInterval) clearInterval(resourceMonitorInterval);
    
    resourceMonitorInterval = setInterval(async () => {
        if (!win || win.isDestroyed()) return;
        
        try {
            const memoryInfo = await process.getProcessMemoryInfo();
            const systemMem = os.freemem();
            const totalMem = os.totalmem();
            const freePercent = (systemMem / totalMem) * 100;
            
            // RSS (Resident Set Size) is the actual RAM used by the process
            const rssMB = memoryInfo.residentSet / 1024 / 1024;
            
            let status = 'healthy';
            if (freePercent < 15 || rssMB > 1500) {
                status = 'congested';
            } else if (freePercent < 30 || rssMB > 1000) {
                status = 'warning';
            }
            
            if (status !== 'healthy') {
                console.log(`[RESOURCE MONITOR] Status: ${status} (Free RAM: ${freePercent.toFixed(1)}%, Process: ${rssMB.toFixed(0)}MB)`);
                pushEvent('resource-update', {
                    status,
                    freePercent,
                    rssMB,
                    timestamp: Date.now()
                });
            }
        } catch (e) {
            console.error('Resource monitor error:', e);
        }
    }, 5000); // Check every 5 seconds
}

// Hardware Optimizations & Crash Prevention
function applyHardwareOptimizations() {
    let vendor = 'GENERIC';
    try {
        let isNVIDIA = false;
        let isAMD = false;

        // Detect GPU — Linux via lspci; Windows via wmic (optional); skip quietly on failure
        if (process.platform === 'linux') {
            try {
                const lspciOut = execSync('lspci | grep -i "3d\\|display\\|vga"', { encoding: 'utf8' }).toLowerCase();
                isNVIDIA = lspciOut.includes('nvidia');
                isAMD = lspciOut.includes('amd') || lspciOut.includes('radeon');
                
                if (isAMD) {
                    console.log(`Hardware: AMD GPU Detected.`);
                    vendor = 'AMD';
                    if (lspciOut.includes('strix') || lspciOut.includes('880m') || lspciOut.includes('890m')) {
                        console.log('Hardware: Applying HSA_OVERRIDE_GFX_VERSION=11.0.0 for Strix Point compatibility.');
                        process.env.HSA_OVERRIDE_GFX_VERSION = '11.0.0';
                    }
                }
                if (isNVIDIA) {
                    console.log(`Hardware: NVIDIA GPU Detected.`);
                    vendor = 'NVIDIA';
                }
            } catch (e) {
                console.warn('Could not detect GPU via lspci');
            }
        } else if (process.platform === 'win32') {
            try {
                const psOut = execSync(
                    'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name -join \',\'"',
                    { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
                ).toLowerCase();
                isNVIDIA = psOut.includes('nvidia');
                isAMD = psOut.includes('amd') || psOut.includes('radeon');
                if (isNVIDIA) { vendor = 'NVIDIA'; console.log('Hardware: NVIDIA GPU Detected (Windows).'); }
                else if (isAMD) { vendor = 'AMD'; console.log('Hardware: AMD GPU Detected (Windows).'); }
            } catch (e) {
                console.log('Hardware: GPU detection skipped on Windows.');
            }
        }

        // Apply OS-level GPU fixes to prevent Electron crashes
        if (process.platform === 'linux' || process.platform === 'win32') {
            app.commandLine.appendSwitch('disable-gpu-sandbox');
            app.commandLine.appendSwitch('ignore-gpu-blocklist');
            app.commandLine.appendSwitch('disable-dev-shm-usage');
            app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
        }

        if (process.platform === 'linux') {
            app.commandLine.appendSwitch('disable-gpu-rasterization');
            app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
            app.commandLine.appendSwitch('disable-accelerated-video-decode');
            app.commandLine.appendSwitch('disable-zero-copy');
        }

        // Optimize threading based on CPU (Linux /proc/cpuinfo only)
        if (process.platform === 'linux') {
            try {
                const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8').toLowerCase();
                if (cpuInfo.includes('authenticamd')) {
                    console.log('Hardware: AMD CPU Detected. Optimizing threads.');
                    const cores = require('os').cpus();
                    const physicalCores = cores.length > 4 ? cores.length / 2 : cores.length;
                    process.env.OMP_NUM_THREADS = Math.floor(physicalCores).toString();
                }
            } catch (e) {
                console.warn('Hardware: could not read /proc/cpuinfo');
            }
        }

        // Prevent network service crashes on Linux Wayland/XWayland with AMD by disabling buggy rasterization flags
        if (process.platform === 'linux' && isAMD) {
            app.commandLine.appendSwitch('disable-gpu-rasterization');
            app.commandLine.appendSwitch('disable-zero-copy');
        }

    } catch (e) {
        console.warn('Hardware detection notice:', e.message);
    }
    return vendor;
}

function resolveAppIcon() {
    const candidates = [
        path.join(__dirname, 'build', 'icons', '512x512.png'),
        path.join(__dirname, 'build', 'icon.png'),
        path.join(__dirname, 'icon.png')
    ];
    for (const iconPath of candidates) {
        try {
            if (!fs.existsSync(iconPath)) continue;
            const img = nativeImage.createFromPath(iconPath);
            if (!img.isEmpty()) return { img, iconPath };
        } catch (_) { /* try next */ }
    }
    return { img: null, iconPath: null };
}

/** Linux: frameless + correct taskbar/dock icon need WM_CLASS and often X11 CSD. */
function applyLinuxWindowFlags() {
    if (process.platform !== 'linux') return;
    app.commandLine.appendSwitch('class', 'agent-smith');
    app.commandLine.appendSwitch('name', 'agent-smith');
    // Wayland compositors may keep a server titlebar alongside our custom chrome.
    // Default to X11 for reliable borderless windows; set AGENT_SMITH_WAYLAND=1 to opt out.
    if (process.env.AGENT_SMITH_WAYLAND !== '1') {
        app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    }
}

if (typeof app.setName === 'function') app.setName('Agent Smith');
applyLinuxWindowFlags();
const APP_ICON = resolveAppIcon();
if (APP_ICON.iconPath) console.log('[app] icon:', APP_ICON.iconPath);
else console.warn('[app] icon not found — taskbar will use the Electron default');

const gpuVendor = applyHardwareOptimizations();

if (process.env.XKALIBER_NO_GPU === '1') {
    app.disableHardwareAcceleration();
}

// Clear GPU Cache on startup to prevent NVIDIA corruption issues.
// The path is derived from Electron's userData dir, not user input, so it
// isn't attacker-controlled today — but guard anyway: a future refactor that
// makes this configurable must not be able to point the recursive `rmSync`
// outside the app's own data directory.
const initUserDataPath = app.getPath('userData');
const gpuCachePath = path.join(initUserDataPath, 'GPUCache');
function isWithinUserData(target) {
    const base = path.resolve(initUserDataPath) + path.sep;
    const resolved = path.resolve(target) + path.sep;
    return resolved === base || resolved.startsWith(base);
}
try {
    if (fs.existsSync(gpuCachePath)) {
        if (!isWithinUserData(gpuCachePath)) {
            throw new Error(`Refusing to clear GPUCache: resolved path escapes userData (${gpuCachePath})`);
        }
        fs.rmSync(gpuCachePath, { recursive: true, force: true });
        console.log('Cleared GPUCache to prevent NVIDIA driver issues.');
    }
} catch (err) {
    console.error('Failed to clear GPUCache:', err);
}

// Wrap ipcMain.handle to save a copy for the web UI
const originalHandle = ipcMain.handle.bind(ipcMain);
const webHandlers = new Map();
ipcMain.handle = (channel, listener) => {
    webHandlers.set(channel, listener);
    return originalHandle(channel, listener);
};

let mainWindow;
const { createSseHub } = require('./src/main/server/sseHub.js');
const { createPushEvent } = require('./src/main/server/pushEvent.js');
const { handlePreviewRequest } = require('./src/main/server/previewRoutes.js');
const { createPreviewRunner } = require('./src/main/services/previewRunner.js');
const { createBrowserVerify } = require('./src/main/services/browserVerify.js');
const { createActionLog } = require('./src/main/services/actionLog.js');
const sseHub = createSseHub();
const getMainWindowRef = () => mainWindow;
const pushEvent = createPushEvent(getMainWindowRef, sseHub);

const registerWhatsAppIpc = require('./src/main/lifecycle/whatsapp.js');
// WhatsApp deps are optional (puppeteer/Chromium); never let a failure here abort startup.
try { registerWhatsAppIpc(ipcMain, getMainWindowRef, app, pushEvent); }
catch (e) { console.error('[startup] WhatsApp IPC registration skipped:', (e && e.message) || e); }

// IPC domains (open-file-dialog, auth, history, agent, edit, project, plan,
// ledger, git, memory, plugins) are registered from src/main/ipc/* near the
// bottom of this file via registerAllIpc(ipcMain, ipcDeps). OS/lifecycle
// handlers (whatsapp, tts, gpu, app-reset, set-lms-url, web server, host/env
// /external-url) stay inline below.

// Persistent Session Memory Paths
const userDataPath = app.getPath('userData');
const AuthManager = require('./src/main/services/auth.js');
const authManager = new AuthManager(userDataPath);

const historyFile = path.join(userDataPath, 'xkaliber_agent_session_v38_5.json');
const legacyFiles = [
    'xkaliber_agent_session_v38_4.json',
    'xkaliber_agent_session_v38_3.json',
    'xkaliber_agent_session_v37_9_1.json',
    'xkaliber_agent_session_v37.json',
    'xkaliber_agent_session_v36.json',
    'xkaliber_agent_session_v35.json',
    'xkaliber_agent_session_v34.json',
    'xkaliber_agent_session_v33.json',
    'xkaliber_agent_session_v32.json',
    'xkaliber_agent_session_v30.json',
    'xkaliber_agent_session_v29.json',
    'xkaliber_agent_session.json'
];

// Agent Harness IPC Handlers
const projectContext = require('./src/main/services/projectContext.js');
const ChangeLedger = require('./src/main/services/changeLedger.js');
const EditEngine = require('./src/main/services/editEngine.js');

const changeLedger = new ChangeLedger(userDataPath);
const editEngine = new EditEngine(changeLedger, projectContext);

// Shared mutable state for the extracted IPC domains. currentPlanId is the
// fallback plan id when the renderer omits one; it is read/written across the
// plan, agent, edit, and ledger domains, so it must live in one shared object.
const ipcState = { currentPlanId: null };

function relPathFromRoot(absPath) {
    const root = projectContext.getRoot();
    return path.relative(root, absPath).replace(/\\/g, '/');
}

const { grepProject, hasRipgrep } = require('./src/shared/grepTool.js');
const { globFiles } = require('./src/shared/globTool.js');
const { buildRepoMap, invalidate: invalidateRepoMap } = require('./src/shared/repoMap.js');
const projectDetector = require('./src/main/services/projectDetector.js');
const verificationHarness = require('./src/shared/verificationHarness.js');
const gitIntegration = require('./src/shared/gitIntegration.js');
const { stepsForType } = require('./src/shared/planTemplates.js');

// Search Handler (Netrunner Mode)
ipcMain.handle('perform-search', async (event, query) => {
    try {
        console.log(`Searching for: ${query}`);
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://html.duckduckgo.com/'
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`Search failed: ${response.statusText}`);

        const html = await response.text();
        const results = [];
        const bodies = html.split('result__body');

        for (let i = 1; i < bodies.length; i++) {
            if (results.length >= 6) break;
            const block = bodies[i];

            const linkMatch = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
            const snippetMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

            if (linkMatch) {
                let url = linkMatch[1];
                let title = linkMatch[2];
                let snippet = snippetMatch ? snippetMatch[1] : '';

                if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
                    try {
                        const urlObj = new URL('https:' + url);
                        const uddg = urlObj.searchParams.get('uddg');
                        if (uddg) url = decodeURIComponent(uddg);
                    } catch (e) { /* keep original */ }
                }

                const cleanText = (str) => str
                    .replace(/<[^>]+>/g, '')
                    .replace(/&quot;/g, '"')
                    .replace(/&#x27;/g, "'")
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                title = cleanText(title);
                snippet = cleanText(snippet);

                if (url && title) results.push({ url, title, snippet });
            }
        }

        return results;
    } catch (error) {
        console.error('Search error:', error);
        return { error: error.message };
    }
});

function createWindow() {
    const winOpts = {
        width: 1000,
        height: 800,
        title: 'Agent Smith',
        show: false,
        frame: false,
        backgroundColor: '#050705',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        },
        autoHideMenuBar: true
    };
    if (APP_ICON.img) winOpts.icon = APP_ICON.img;

    mainWindow = new BrowserWindow(winOpts);
    mainWindow.setMenu(null);

    // Content-Security-Policy: the renderer shows LLM/markdown-derived HTML, so lock down
    // what it can load/execute. 'unsafe-inline' for styles is needed by the existing UI;
    // scripts are restricted to self (the bundled renderer) — no remote/eval script.
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self'; " +
                    "script-src 'self'; " +
                    "style-src 'self' 'unsafe-inline'; " +
                    "img-src 'self' data: blob:; " +
                    "font-src 'self' data:; " +
                    "media-src 'self' blob: data:; " +
                    // connect-src is permissive: the app must reach arbitrary user-configured
                    // LLM endpoints. Script execution (the RCE vector) stays locked via script-src.
                    "connect-src 'self' http: https: ws: wss:; " +
                    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
                ]
            }
        });
    });

    // Block the renderer from navigating away or opening new windows to attacker URLs.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) e.preventDefault();
    });

    mainWindow.webContents.on("console-message", (e, level, msg, line, sourceId) => console.log(`[Renderer] ${msg} (${sourceId}:${line})`));
    mainWindow.webContents.on("console-message", (e, level, msg, line, sourceId) => console.log(`[Renderer] ${msg} (${sourceId}:${line})`));
    mainWindow.once('ready-to-show', () => {
        if (APP_ICON.img) mainWindow.setIcon(APP_ICON.img);
        mainWindow.show();
    });
    mainWindow.loadFile('index.html');
    startResourceMonitor(mainWindow);
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- VRAM & Crash Detection (v30) ---
let isTelemetryInProgress = false;

ipcMain.handle('get-gpu-telemetry', async () => {
    if (isTelemetryInProgress) return { error: 'Telemetry already in progress' };
    isTelemetryInProgress = true;

    return new Promise((resolve) => {
        // os module is already required at the top
        const systemRam = {
            total: Math.round(os.totalmem() / 1024 / 1024),
            free: Math.round(os.freemem() / 1024 / 1024),
            used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024)
        };

        const finalize = (data) => {
            isTelemetryInProgress = false;
            resolve(data);
        };

        // Try AMD first (sysfs)
        if (process.platform === 'linux' && fs.existsSync('/sys/class/drm/card0/device/mem_info_vram_total')) {
            try {
                const vramTotal = parseInt(fs.readFileSync('/sys/class/drm/card0/device/mem_info_vram_total', 'utf8')) || 0;
                const vramUsed = parseInt(fs.readFileSync('/sys/class/drm/card0/device/mem_info_vram_used', 'utf8')) || 0;
                let util = 0;
                try { util = parseInt(fs.readFileSync('/sys/class/drm/card0/device/gpu_busy_percent', 'utf8')); } catch(e){}
                
                finalize({
                    vendor: 'AMD',
                    memory: { 
                        total: Math.round(vramTotal / 1024 / 1024), 
                        used: Math.round(vramUsed / 1024 / 1024), 
                        free: Math.round((vramTotal - vramUsed) / 1024 / 1024) 
                    },
                    utilization: util,
                    is_high_pressure: (vramUsed / vramTotal) > 0.95,
                    systemRam
                });
                return;
            } catch (err) {
                console.error("Failed to read AMD sysfs:", err);
            }
        }

        // Fallback to NVIDIA
        exec('nvidia-smi --query-gpu=memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits', { timeout: 3000 }, (err, stdout) => {
            if (err) {
                finalize({ 
                    error: 'No compatible GPU telemetry found (AMD or NVIDIA)', 
                    details: err.message,
                    systemRam 
                });
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                const gpus = lines.map(line => {
                    const [total, used, free, util] = line.split(',').map(s => parseInt(s.trim()));
                    return { total, used, free, utilization: util };
                });
                
                const primaryGpu = gpus[0];
                finalize({
                    vendor: 'NVIDIA',
                    memory: { total: primaryGpu.total, used: primaryGpu.used, free: primaryGpu.free },
                    utilization: primaryGpu.utilization,
                    is_high_pressure: (primaryGpu.used / primaryGpu.total) > 0.95,
                    systemRam
                });
            } catch (e) {
                finalize({ error: 'Failed to parse nvidia-smi output', systemRam });
            }
        });
    });
});

ipcMain.handle('app-reset', async (event, { killBackends = false, sudoPass = '' } = {}) => {
    console.log('--- EMERGENCY RESET TRIGGERED ---');
    
    if (killBackends) {
        console.log('Attempting to kill/restart AI backends (Ollama/LM Studio)...');
        
        if (process.platform === 'linux') {
            const haveSudo = !!sudoPass;
            try {
                // 1. Graceful SIGTERM first to allow VRAM release (Crucial for AMD/ROCm and NVIDIA)
                exec('pkill -15 -f ollama || true');
                exec('pkill -15 "LM Studio" || true');
                exec('pkill -15 lms || true');
                
                // Wait 2.5 seconds for graceful shutdown and VRAM deallocation
                await new Promise(res => setTimeout(res, 2500));
                
                // 2. Force kill remaining orphans
                exec('pkill -9 -f ollama || true');
                exec('pkill -9 "LM Studio" || true');
                exec('pkill -9 lms || true');

                // Wait 1 second to ensure ports are freed
                await new Promise(res => setTimeout(res, 1000));

                // 3. Attempt to restart Ollama service if we have sudo. The password is
                // passed on sudo's stdin (-S) via spawn args — never interpolated into a
                // shell string — so it can't be injected and doesn't transit a shell.
                if (haveSudo) {
                    try {
                        console.log('Restarting Ollama service via systemctl...');
                        const sudoProc = spawn('sudo', ['-S', 'systemctl', 'restart', 'ollama'], { stdio: ['pipe', 'ignore', 'ignore'] });
                        sudoProc.stdin.write(sudoPass + '\n');
                        sudoProc.stdin.end();
                        await new Promise((res) => sudoProc.on('close', res));
                    } catch(e) {
                        console.log('systemctl restart failed or not applicable.');
                    }
                }
            } catch (e) {
                console.error('Failed to kill backends:', e);
            }
        } else if (process.platform === 'win32') {
            try {
                exec('taskkill /IM ollama.exe /T'); // Try graceful
                exec('taskkill /IM "LM Studio.exe" /T');
                await new Promise(res => setTimeout(res, 2000));
                exec('taskkill /F /IM ollama.exe /T'); // Force
                exec('taskkill /F /IM "LM Studio.exe" /T');
            } catch (e) {}
        }
    }

    setTimeout(() => {
        app.relaunch();
        app.exit(0);
    }, 1000);
    
    return { success: true };
});

// Vector Memory Integration (via memory.js)
const memoryManager = require('./src/main/services/memory.js');
if (typeof gpuVendor !== 'undefined') {
    memoryManager.setGpuVendor(gpuVendor);
}

// --- Web Hosting (Mobile Access) ---
const http = require('http');
// os module is already required at the top
let WEB_PORT = 3000;

// Host state for LM Studio proxying
let lmsHostUrl = 'http://127.0.0.1:1234';
// Let vector memory fall back to this server's /v1/embeddings when Ollama is absent.
try { memoryManager.setLlmBase(lmsHostUrl); } catch (e) { /* optional */ }

// --- SSRF / download hardening (pure logic in lib/netGuard.js) ---------------
const netGuard = require('./src/shared/netGuard.js');
const { isBlockedHost } = netGuard;
const { requiresToolPermission } = require('./src/shared/channelPolicy.js');
const { assessCommand } = require('./src/shared/commandPolicy.js');

// IPC: the renderer notifies the main process when the user changes the LLM backend
// URL (used for the /api/proxy origin allow-list and the embeddings fallback base).
// Previously this channel existed only on the web server, so the desktop renderer's
// invoke threw "Blocked IPC channel: set-lms-url" — aborting fetchModels() on a URL
// change so the model list never reloaded for the new backend.
ipcMain.handle('set-lms-url', async (event, arg) => {
    const raw = Array.isArray(arg) ? arg[0] : arg;
    let candidate;
    try { candidate = new URL(String(raw)); } catch (e) { candidate = null; }
    if (!candidate || (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') || isBlockedHost(candidate.hostname)) {
        return { error: 'Invalid LLM server URL' };
    }
    lmsHostUrl = candidate.toString();
    try { memoryManager.setLlmBase(lmsHostUrl); } catch (e) { /* optional */ }
    return { success: true };
});

// Permit a proxy target only if it's loopback or the configured LLM server.
function validateProxyTarget(targetUrl) {
    return netGuard.validateProxyTarget(targetUrl, lmsHostUrl);
}

// Permit a download only for real files inside the project root / app data / downloads.
function validateDownloadPath(rawPath) {
    const roots = [];
    const projRoot = projectContext.getRootOrNull();
    if (projRoot) roots.push(projRoot);
    try { roots.push(app.getPath('userData')); } catch (e) {}
    try { roots.push(app.getPath('downloads')); } catch (e) {}
    return netGuard.validateDownloadPath(rawPath, roots);
}

// --- Plugin system (lib/pluginManager.js + pluginInstaller.js) ---------------
const PluginManager = require('./src/main/services/pluginManager.js');
const PluginInstaller = require('./src/main/services/pluginInstaller.js');

// Core agent tool names plugins may not shadow (kept in sync with PLAN_TOOLS).
const CORE_TOOL_NAMES = [
    'submit_plan', 'mark_step_done', 'mark_step_blocked', 'run_shell_command',
    'run_command', 'read_file', 'write_file', 'edit_file', 'list_directory',
    'list_project', 'delete_file', 'set_project_root', 'memory_search',
    'save_new_user_fact_only', 'read_process_log', 'send_input',
    'provide_file_download_link', 'web_search', 'send_whatsapp_message',
    'dynamic_schema_generate', 'grep_project', 'glob_files', 'get_repo_map',
    'apply_patch', 'apply_edits', 'add_files', 'drop_files', 'run_verify',
    'record_decision', 'init_project'
];

// Foreground command runner for a plugin's `shell` capability (project-root cwd).
function runCommandForPlugin(command) {
    return new Promise((resolve) => {
        const verdict = assessCommand(command);
        if (!verdict.allowed) {
            return resolve({ error: `Command blocked by safety policy (${verdict.reason}).`, stdout: '', stderr: '' });
        }
        const cwd = projectContext.getRoot();
        if (projectContext.isWindows()) {
            exec(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, { cwd, maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
                resolve({ error: error ? error.message : null, stdout, stderr });
            });
        } else {
            exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
                resolve({ error: error ? error.message : null, stdout, stderr });
            });
        }
    });
}

// Optional subsystems are initialized defensively. A throw here (e.g. puppeteer/Chromium
// missing on a fresh Linux box, LM Studio probing, or a bad plugin) must NOT abort startup
// before registerAllIpc() runs below — otherwise the window loads but every IPC channel
// reports "No handler registered for 'auth-register'". Each falls back to null and its
// feature degrades gracefully while sign-in and the core app keep working.
function safeInit(label, factory) {
    try {
        return factory();
    } catch (e) {
        console.error(`[startup] ${label} failed to initialize (continuing without it):`, (e && e.message) || e);
        return null;
    }
}

const pluginManager = safeInit('pluginManager', () => new PluginManager(userDataPath, {
    projectContext,
    runCommand: runCommandForPlugin,
    memory: {
        store: (text, metadata) => memoryManager.storeVector(text, metadata),
        query: (query, limit) => memoryManager.queryVectors(query, limit),
    },
    uiNotify: (pluginId, msg) => {
        pushEvent('plugin-ui-event', { pluginId, message: msg });
    },
    netGuard,
    coreToolNames: CORE_TOOL_NAMES,
}));
if (pluginManager) { try { pluginManager.discover(); } catch (e) { console.error('[plugins] discover failed:', e); } }

const pluginInstaller = pluginManager
    ? safeInit('pluginInstaller', () => new PluginInstaller(pluginManager.pluginsDir, { netGuard }))
    : null;

// --- Register the extracted IPC domains (src/main/ipc/*) --------------------
// Every service, helper, and shared-state reference the domain handlers need is
// injected here so the handler modules close over nothing global. `ipcMain` is
// the web-handler-wrapping version installed near the top of this file, so the
// mobile web UI's /api/invoke proxy keeps seeing every channel.
const registerAllIpc = require('./src/main/ipc/index.js');
let previewDesktopAllowed = false;
const previewRunner = safeInit('previewRunner', () => createPreviewRunner({
    projectContext,
    userDataPath,
    getMainWindow: getMainWindowRef,
    pushEvent,
    getWebServerPort: () => WEB_PORT,
    getLocalIP,
    isElectronDesktop: true,
    getAllowDesktopPreview: () => previewDesktopAllowed
}));
const browserVerify = safeInit('browserVerify', () => createBrowserVerify({ projectContext }));
const actionLog = safeInit('actionLog', () => createActionLog({ userDataPath }));
const lmStudioManager = safeInit('lmStudioManager', () => createLmStudioManager());
registerAllIpc(ipcMain, {
    // electron + node
    dialog, fs, fsPromises, path, spawn, exec,
    // services
    authManager, projectContext, changeLedger, editEngine,
    memoryManager, gitIntegration, verificationHarness, projectDetector,
    pluginManager, pluginInstaller, netGuard,
    // search / repo-map tools
    grepProject, hasRipgrep, globFiles, buildRepoMap, invalidateRepoMap,
    stepsForType,
    // helpers + paths + shared mutable state
    relPathFromRoot, historyFile, legacyFiles, userDataPath,
    state: ipcState,
    getLmsUrl: () => lmsHostUrl,
    getMainWindow: getMainWindowRef,
    pushEvent,
    previewRunner,
    browserVerify,
    actionLog,
    lmStudioManager,
    isElectronDesktop: true,
    setAllowDesktopPreview: (enabled) => { previewDesktopAllowed = !!enabled; },
});

// GhostTrace append for Agent chat runs (renderer → main JSONL)
let ghostTraceEventsFile;
if (__dirname.includes('app.asar')) {
    ghostTraceEventsFile = path.join(os.homedir(), '.config', 'Agent Smith', 'ghosttrace', 'events.jsonl');
} else {
    ghostTraceEventsFile = path.join(__dirname, 'src', 'data', 'ghosttrace', 'events.jsonl');
}
ipcMain.handle('ghosttrace-append', async (_event, payload) => {
    try {
        const dir = path.dirname(ghostTraceEventsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify(Object.assign({ timestamp: new Date().toISOString() }, payload || {}));
        fs.appendFileSync(ghostTraceEventsFile, line + '\n');
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const webServer = http.createServer((req, res) => {
    // CORS Headers for Mobile Web Mode
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-target-url');
    if (req.method === 'OPTIONS') return res.end();

    const url = req.url.split('?')[0];
    const authHeader = req.headers['authorization'];
    const parsedUrlForAuth = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const queryToken = parsedUrlForAuth.searchParams.get('token');
    const token = authHeader ? authHeader.replace('Bearer ', '') : queryToken;
    const user = authManager.verifyToken(token);
    const isAuthenticated = !!user;
    const canUseApp = isAuthenticated && user.permissions.canUseApp;
    const canUseTools = isAuthenticated && user.permissions.canUseTools;
    const openLanMode = !authManager.hasUsers();

    // SSE stream for web/mobile push events (code-event, whatsapp-*, resource-update, …)
    if (url === '/api/events' && req.method === 'GET') {
        if (!openLanMode && (!isAuthenticated || !canUseApp)) {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Unauthorized — log in to receive live events.' }));
        }
        sseHub.addClient(res);
        return;
    }

    // Public routes (login/register)
    const isPublicApi = url === '/api/invoke' && req.method === 'POST' && (
        req.headers['x-auth-action'] === 'login' || 
        req.headers['x-auth-action'] === 'register' ||
        req.headers['x-auth-action'] === 'has-users'
    );

    const publicFiles = ['/index.html', '/', '/src/renderer/app.js', '/preload.js', '/style.css', '/icon.png'];
    const isPublicFile = publicFiles.includes(url) || url.endsWith('.css') || url.endsWith('.js') || url.endsWith('.png') || url.endsWith('.jpg');
    const isDownloadRemote = url.startsWith('/download_remote');

    // Validated file handoff — allowed in open LAN mode without login; otherwise requires auth.
    if (isDownloadRemote) {
        if (!openLanMode && !isAuthenticated) {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        if (isAuthenticated && !canUseApp) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
        }
    } else if (!isAuthenticated && !isPublicApi && !isPublicFile) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    
    if (isAuthenticated && !canUseApp && !isPublicApi && !isPublicFile) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
    }

    // API Proxy for Ollama and LM Studio (Solves CORS and localhost binding issues)
    if (url.startsWith('/api/proxy/')) {
        if (!canUseApp) {
            res.writeHead(403); return res.end('Account pending admin approval');
        }
        const targetUrl = req.headers['x-target-url'];
        if (!targetUrl) {
            res.writeHead(400); return res.end('Missing x-target-url header');
        }
        const parsed = validateProxyTarget(targetUrl);
        if (!parsed) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Proxy target not allowed. Only the configured local LLM server may be proxied.' }));
        }
        try {
            const transport = parsed.protocol === 'https:' ? require('https') : require('http');
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: req.method,
                headers: { ...req.headers, host: parsed.host }
            };

            delete options.headers['origin'];
            delete options.headers['referer'];
            delete options.headers['x-target-url'];
            delete options.headers['accept-encoding'];
            // Don't leak the app's session token / cookies to the proxied target.
            delete options.headers['authorization'];
            delete options.headers['cookie'];
            
            const proxyReq = transport.request(options, (proxyRes) => {
                // Merge target headers with our required CORS headers
                const mergedHeaders = { ...proxyRes.headers };
                mergedHeaders['Access-Control-Allow-Origin'] = '*';
                // Remove some headers that might conflict with the browser's security model
                delete mergedHeaders['content-security-policy'];
                delete mergedHeaders['x-frame-options'];

                res.writeHead(proxyRes.statusCode, mergedHeaders);
                proxyRes.pipe(res);
            });
            
            proxyReq.on('error', e => {
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                }
                res.end(JSON.stringify({ error: 'Proxy failed to connect: ' + e.message }));
            });
            
            req.pipe(proxyReq);
        } catch (e) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            }
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // IPC Proxy for Web Clients
    if (url === '/api/invoke' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { channel, args } = JSON.parse(body);
                
                // Special handling for auth actions via proxy
                if (channel === 'auth-login' || channel === 'auth-register' || channel === 'auth-has-users') {
                    // These are allowed even if not authenticated if they come with x-auth-action header
                } else if (!isAuthenticated) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Unauthorized' }));
                } else if (!canUseApp && channel !== 'auth-check' && channel !== 'auth-logout') {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
                } else if (requiresToolPermission(channel) && !canUseTools) {
                    // Gate by CAPABILITY, not name shape: code-run/git-*/edit-*/plugin-*
                    // expose shell + file writes just like agent-*, and must require tools.
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Tool usage restricted by Administrator' }));
                }

                // Special trap to let host know LMS server changed from web UI.
                // Validate it's a well-formed http(s) URL and not a metadata/link-local
                // host before trusting it (it feeds the proxy allowlist).
                if (channel === 'set-lms-url') {
                    let candidate;
                    try { candidate = new URL(String(args[0])); } catch (e) { candidate = null; }
                    if (!candidate || (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') || isBlockedHost(candidate.hostname)) {
                        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        return res.end(JSON.stringify({ error: 'Invalid LLM server URL' }));
                    }
                    lmsHostUrl = candidate.toString();
                    try { memoryManager.setLlmBase(lmsHostUrl); } catch (e) { /* optional */ }
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    return res.end(JSON.stringify({ success: true }));
                }

                const handler = webHandlers.get(channel);
                if (handler) {
                    const val = await handler({ sender: { send: () => {} } }, ...args);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify(val));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'No handler for ' + channel }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // File Download Endpoint — only files inside the project root / app data may be
    // served (previously any absolute path → arbitrary file read for authd users).
    if (url.startsWith('/download_remote')) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const fileToDownload = parsedUrl.searchParams.get('file');
        const safePath = validateDownloadPath(fileToDownload);
        if (safePath) {
            const safeName = path.basename(safePath).replace(/["\r\n]/g, '_');
            res.writeHead(200, {
                'Content-Disposition': `attachment; filename="${safeName}"`,
                'Access-Control-Allow-Origin': '*'
            });
            const readStream = fs.createReadStream(safePath);
            readStream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
            readStream.pipe(res);
            return;
        } else {
            res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('File not found or not permitted');
            return;
        }
    }

    if (handlePreviewRequest(req, res, {
        projectContext,
        userDataPath,
        canUseApp,
        openLanMode,
        isAuthenticated
    })) {
        return;
    }

    // Static File Serving
    // Decode and contain within __dirname to prevent path traversal
    // (e.g. "/../../secret.js" — extensions like .js/.css bypass the auth gate above).
    let decodedUrl;
    try {
        decodedUrl = decodeURIComponent(url);
    } catch (e) {
        decodedUrl = url;
    }
    const appDir = path.resolve(__dirname);
    let filePath = path.resolve(appDir, '.' + (decodedUrl === '/' ? '/index.html' : decodedUrl));
    const relToApp = path.relative(appDir, filePath);
    if (relToApp.startsWith('..') || path.isAbsolute(relToApp)) {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        return res.end('Forbidden');
    }
    fs.promises.readFile(filePath)
        .then(content => {
            const ext = path.extname(filePath);
            const contentType = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.jpg': 'image/jpeg'
            }[ext] || 'text/plain';
            res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
            res.end(content);
        })
        .catch(e => {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('Not Found');
        });
});

let remoteUrl = null;
async function startCloudflareTunnel() {
    const userData = app.getPath('userData');
    const cfPath = path.join(userData, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    const legacyCfPath = path.join(userData, 'cloudflared');
    if (process.platform === 'win32' && !fs.existsSync(cfPath) && fs.existsSync(legacyCfPath)) {
        try { fs.renameSync(legacyCfPath, cfPath); } catch (e) { /* use legacy path */ }
    }
    const cfBinary = fs.existsSync(cfPath) ? cfPath : legacyCfPath;
    const platform = process.platform;
    const arch = process.arch;

    let downloadUrl = "";
    if (platform === 'linux' && arch === 'x64') {
        downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
    } else if (platform === 'win32' && arch === 'x64') {
        downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
    }

    if (!fs.existsSync(cfBinary) && downloadUrl) {
        console.log('Downloading cloudflared for remote hosting...');
        try {
            if (platform === 'linux') {
                execSync(`wget -O "${cfPath}" "${downloadUrl}"`);
                fs.chmodSync(cfPath, 0o755);
            } else if (platform === 'win32') {
                execSync(`powershell.exe -NoProfile -Command "Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${cfPath.replace(/'/g, "''")}'"`);
            }
            console.log('cloudflared downloaded successfully.');
        } catch (err) {
            console.error('Failed to download cloudflared:', err);
            return;
        }
    }

    const resolvedBinary = fs.existsSync(cfPath) ? cfPath : (fs.existsSync(legacyCfPath) ? legacyCfPath : null);
    if (resolvedBinary) {
        console.log('Starting Cloudflare Tunnel...');
        const cfProcess = spawn(resolvedBinary, ['tunnel', '--url', `http://localhost:${WEB_PORT}`]);

        cfProcess.stderr.on('data', (data) => {
            const output = data.toString();
            const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match && !remoteUrl) {
                remoteUrl = match[0];
                console.log('\n=========================================');
                console.log(' Remote Access URL: ' + remoteUrl);
                console.log('=========================================\n');
            }
        });

        cfProcess.on('close', (code) => {
            console.log(`cloudflared process exited with code ${code}`);
            remoteUrl = null;
        });
    }
}

// Resilient bind: a stale instance or another app on :3000 must NOT crash the
// desktop app. Without an 'error' handler, EADDRINUSE is an unhandled server
// error that takes down the whole main process. Retry on the next free port and,
// if none is free, keep the desktop app running with the web UI disabled.
const WEB_PORT_MAX_TRIES = 10;
function startWebServer(attempt = 0) {
    webServer.listen(WEB_PORT, '0.0.0.0', () => {
        console.log('\n=========================================');
        console.log(' Web Interface hosted at: http://' + getLocalIP() + ':' + WEB_PORT);
        console.log('=========================================\n');
        // Opt-out for headless / automated runs: skip the cloudflared download +
        // public tunnel (AGENT_SMITH_NO_TUNNEL=1). The local web UI still serves.
        if (!process.env.AGENT_SMITH_NO_TUNNEL) startCloudflareTunnel().catch(console.error);
    });
}
webServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        if (WEB_PORT - 3000 < WEB_PORT_MAX_TRIES) {
            console.warn(`[web] port ${WEB_PORT} in use, trying ${WEB_PORT + 1}...`);
            WEB_PORT += 1;
            setTimeout(() => { try { webServer.close(); } catch {} startWebServer(); }, 50);
            return;
        }
        console.error(`[web] no free port in ${3000}-${WEB_PORT}; web UI disabled. Desktop app continues.`);
        return;
    }
    console.error('[web] server error (web UI disabled, desktop app continues):', (err && err.message) || err);
});
startWebServer();

ipcMain.handle('get-host-url', async () => {
    return {
        url: 'http://' + getLocalIP() + ':' + WEB_PORT,
        remoteUrl: remoteUrl
    };
});

function focusedWindow() {
    return BrowserWindow.getFocusedWindow() || mainWindow;
}

ipcMain.handle('window-minimize', () => { focusedWindow()?.minimize(); });
ipcMain.handle('window-maximize', () => {
    const win = focusedWindow();
    if (!win) return { maximized: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { maximized: win.isMaximized() };
});
ipcMain.handle('window-close', () => { focusedWindow()?.close(); });
ipcMain.handle('window-is-maximized', () => ({ maximized: !!focusedWindow()?.isMaximized() }));

// Render a QR of the best phone-reachable URL (public tunnel if up, else the LAN URL)
// so a user can scan it from the composer and open Agent Smith on their phone.
ipcMain.handle('get-remote-qr', async () => {
    const lanUrl = 'http://' + getLocalIP() + ':' + WEB_PORT;
    const best = remoteUrl || lanUrl;
    try {
        const QRCode = require('qrcode');
        // Standard high-contrast (black on white) for reliable scanning across phones.
        const qrDataUrl = await QRCode.toDataURL(best, { margin: 1, width: 320, color: { dark: '#000000', light: '#ffffff' } });
        return { qrDataUrl, url: best, lanUrl, remoteUrl, isRemote: !!remoteUrl };
    } catch (e) {
        return { error: 'QR generator unavailable: ' + e.message, url: best, lanUrl, remoteUrl, isRemote: !!remoteUrl };
    }
});

ipcMain.handle('open-external-url', async (event, url) => {
    // Only open real web URLs in the browser — never file:, javascript:, etc.
    let parsed;
    try { parsed = new URL(String(url)); } catch (e) { return { error: 'Invalid URL' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
        return { error: `Refusing to open non-web URL scheme: ${parsed.protocol}` };
    }
    try {
        await shell.openExternal(parsed.toString());
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('get-env-info', async () => {
    const selectedRoot = projectContext.getRootOrNull();
    return {
        platform: os.platform(),
        arch: os.arch(),
        homedir: os.homedir(),
        username: os.userInfo().username,
        // The agent must operate on the user-selected workspace, not the app's
        // own install dir. Report the project root as cwd; expose both fields so
        // callers can tell whether a workspace was actually chosen.
        cwd: projectContext.getRoot(),
        projectRoot: selectedRoot,
        appDir: process.cwd()
    };
});

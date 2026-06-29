const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Run git via execFile (argv, NO shell) so user-controlled args — notably the commit
// message — can't be shell-interpreted ($(...), backticks, ;, &&, |). Also avoids the
// Windows cmd.exe vs POSIX quoting mismatch of building a shell string.
function gitExec(cwd, args) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim(),
                error: error ? error.message : null
            });
        });
    });
}

function isRepo(projectRoot) {
    return fs.existsSync(path.join(projectRoot, '.git'));
}

function gitDir(projectRoot) {
    const dotGit = path.join(projectRoot, '.git');
    try {
        const st = fs.statSync(dotGit);
        if (st.isDirectory()) return dotGit;
        if (st.isFile()) {
            const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/i);
            if (m) return path.resolve(projectRoot, m[1]);
        }
    } catch (e) { /* fall through */ }
    return dotGit;
}

function ownedCommitsPath(projectRoot) {
    return path.join(gitDir(projectRoot), 'agentsmith-owned-commits.json');
}

function readOwnedCommits(projectRoot) {
    try {
        const d = JSON.parse(fs.readFileSync(ownedCommitsPath(projectRoot), 'utf8'));
        return Array.isArray(d.commits) ? d.commits : [];
    } catch (e) {
        return [];
    }
}

function writeOwnedCommits(projectRoot, commits) {
    try {
        fs.writeFileSync(ownedCommitsPath(projectRoot), JSON.stringify({ commits }, null, 2), { mode: 0o600 });
    } catch (e) { /* non-fatal */ }
}

async function init(projectRoot) {
    if (isRepo(projectRoot)) return { ok: true, already: true };
    return gitExec(projectRoot, ['init']);
}

async function status(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    return gitExec(projectRoot, ['status', '--porcelain']);
}

async function diff(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    return gitExec(projectRoot, ['diff', '--stat']);
}

async function commit(projectRoot, message) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    await gitExec(projectRoot, ['add', '-A']);
    // execFile passes argv directly — no shell, no quoting needed (and no injection).
    const res = await gitExec(projectRoot, ['commit', '-m', String(message || '').slice(0, 500), '--allow-empty']);
    if (res.ok) {
        const head = await gitExec(projectRoot, ['rev-parse', 'HEAD']);
        if (head.ok && head.stdout) {
            const commits = readOwnedCommits(projectRoot).filter(c => c !== head.stdout);
            commits.push(head.stdout);
            writeOwnedCommits(projectRoot, commits.slice(-100));
        }
    }
    return res;
}

async function undoLast(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    const log = await gitExec(projectRoot, ['rev-parse', 'HEAD']);
    if (!log.ok) return log;
    const head = log.stdout;
    const owned = readOwnedCommits(projectRoot);
    if (!owned.includes(head)) {
        return { ok: false, error: 'Refusing to undo: HEAD was not created by Agent Smith.' };
    }
    const dirty = await gitExec(projectRoot, ['status', '--porcelain']);
    if (!dirty.ok) return dirty;
    if (dirty.stdout) {
        return { ok: false, error: 'Refusing to undo: working tree has uncommitted changes.' };
    }
    const parent = await gitExec(projectRoot, ['rev-parse', 'HEAD~1']);
    let res;
    if (!parent.ok) {
        res = await gitExec(projectRoot, ['update-ref', '-d', 'HEAD']);
    } else {
        res = await gitExec(projectRoot, ['reset', '--hard', 'HEAD~1']);
    }
    if (res.ok) writeOwnedCommits(projectRoot, owned.filter(c => c !== head));
    return res;
}

async function logOneline(projectRoot, n = 10) {
    if (!isRepo(projectRoot)) return { ok: false, lines: [] };
    const res = await gitExec(projectRoot, ['log', `--oneline`, `-n`, String(n)]);
    return { ...res, lines: res.stdout ? res.stdout.split('\n') : [] };
}

module.exports = {
    isRepo,
    init,
    status,
    diff,
    commit,
    undoLast,
    logOneline,
    gitExec
};

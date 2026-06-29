const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const replaceToolsSrc = fs.readFileSync(path.join(__dirname, '..', 'replace-tools.js'), 'utf8');

test('main registers renderer console logging only once', () => {
    const matches = mainSrc.match(/webContents\.on\("console-message"/g) || [];
    assert.equal(matches.length, 1);
});

test('web invoke proxy enforces a request body size limit', () => {
    assert.match(mainSrc, /WEB_INVOKE_MAX_BODY_BYTES\s*=\s*1024 \* 1024/);
    assert.match(mainSrc, /bodyBytes\s*>\s*WEB_INVOKE_MAX_BODY_BYTES/);
    assert.match(mainSrc, /writeHead\(413/);
});

test('unauthenticated static files use an explicit allowlist, not extension wildcarding', () => {
    assert.match(mainSrc, /function isPublicStaticPath/);
    assert.doesNotMatch(mainSrc, /url\.endsWith\('\.js'\)|url\.endsWith\("\.js"\)/);
    assert.doesNotMatch(mainSrc, /url\.endsWith\('\.css'\)|url\.endsWith\("\.css"\)/);
    assert.match(mainSrc, /const isPublicFile = isPublicStaticPath\(url\)/);
    assert.match(mainSrc, /!isAuthenticated && !isPublicApi && !isPublicFile[\s\S]{0,120}writeHead\(401/);
    assert.match(mainSrc, /relToApp\.startsWith\('\.\.'\)[\s\S]{0,80}writeHead\(403[\s\S]{0,400}fs\.promises\.readFile/);
});

test('cloudflared tunnel and download require explicit opt-in env flags', () => {
    assert.match(mainSrc, /AGENT_SMITH_ENABLE_TUNNEL === '1' && process\.env\.AGENT_SMITH_NO_TUNNEL !== '1'[\s\S]{0,80}startCloudflareTunnel\(\)/);
    assert.match(mainSrc, /process\.env\.AGENT_SMITH_ALLOW_CLOUDFLARED_DOWNLOAD !== '1'[\s\S]{0,200}console\.log\('Cloudflare Tunnel unavailable/);
    assert.doesNotMatch(mainSrc, /releases\/latest[\s\S]{0,300}execSync\(`wget/);
});

test('replace-tools reports a usage error when legacy paths are missing', () => {
    assert.match(replaceToolsSrc, /process\.argv\[2\]/);
    assert.match(replaceToolsSrc, /Usage: node replace-tools\.js/);
    assert.match(replaceToolsSrc, /fs\.existsSync/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

const totp = require('../dist/utils/totp.js');

// RFC 6238 附录 B 官方向量（SHA1）。官方给出 8 位码，同一 HMAC 结果对 10^6 取模即为 6 位码。
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_CASES = [
    { time: 59, hotp8: '94287082' },
    { time: 1111111109, hotp8: '07081804' },
    { time: 1111111111, hotp8: '14050471' },
    { time: 1234567890, hotp8: '89005924' },
    { time: 2000000000, hotp8: '69279037' },
    { time: 20000000000, hotp8: '65353130' },
];

const code6 = hotp8 => String(Number(hotp8) % 1000000).padStart(6, '0');

test('base32 编解码往返一致', () => {
    const buf = Buffer.from('QQ农场TOTP测试数据-0123456789', 'utf8');
    const encoded = totp.base32Encode(buf);
    assert.match(encoded, /^[A-Z2-7]+$/);
    assert.equal(Buffer.compare(totp.base32Decode(encoded), buf), 0);
});

test('RFC 6238 官方时间向量：当前窗口通过', () => {
    for (const { time, hotp8 } of RFC_CASES) {
        assert.ok(totp.verifyTotpAt(RFC_SECRET_B32, code6(hotp8), time * 1000), `t=${time}`);
    }
});

test('RFC 6238 官方时间向量：码互不互换（间隔远超 ±1 窗口）', () => {
    for (const { time, hotp8 } of RFC_CASES) {
        for (const other of RFC_CASES) {
            if (other.time === time) continue;
            const gapSec = Math.abs(other.time - time);
            if (gapSec > 90) {
                assert.ok(
                    !totp.verifyTotpAt(RFC_SECRET_B32, code6(other.hotp8), time * 1000),
                    `t=${time} 不应接受 ${code6(other.hotp8)}`,
                );
            }
        }
    }
});

test('窗口语义：±1 窗内的相邻码通过，±2 窗外的码拒绝', () => {
    const t0 = 1700000000 * 1000;
    const code0 = totp.totpCodeAt(RFC_SECRET_B32, t0);
    const codePrev = totp.totpCodeAt(RFC_SECRET_B32, t0 - 30 * 1000);
    const codeNext = totp.totpCodeAt(RFC_SECRET_B32, t0 + 30 * 1000);
    const codeFar = totp.totpCodeAt(RFC_SECRET_B32, t0 + 60 * 1000);
    // 当前码与相邻码都应在默认 ±1 窗口内通过
    assert.ok(totp.verifyTotpAt(RFC_SECRET_B32, code0, t0));
    assert.ok(totp.verifyTotpAt(RFC_SECRET_B32, codePrev, t0));
    assert.ok(totp.verifyTotpAt(RFC_SECRET_B32, codeNext, t0));
    // ±2 窗外的码拒绝
    assert.ok(!totp.verifyTotpAt(RFC_SECRET_B32, codeFar, t0));
    // 收紧到 window=0 后相邻码拒绝
    assert.ok(!totp.verifyTotpAt(RFC_SECRET_B32, codePrev, t0, 0));
    assert.ok(!totp.verifyTotpAt(RFC_SECRET_B32, codeNext, t0, 0));
    // 放宽到 window=2 后 ±2 窗的码通过
    assert.ok(totp.verifyTotpAt(RFC_SECRET_B32, codeFar, t0, 2));
});

test('非法输入全部拒绝', () => {
    const at = Date.now();
    assert.ok(!totp.verifyTotpAt(RFC_SECRET_B32, '12ab34', at), '含非数字');
    assert.ok(!totp.verifyTotpAt(RFC_SECRET_B32, '12345', at), '5 位');
    assert.ok(!totp.verifyTotpAt(RFC_SECRET_B32, '1234567', at), '7 位');
    assert.ok(!totp.verifyTotpAt('!!invalid!!', '123456', at), '非法 base32');
    assert.ok(!totp.verifyTotpAt('', '123456', at), '空密钥');
    assert.ok(!totp.verifyTotpAt(RFC_SECRET_B32, '', at), '空码');
});

test('generateSecret：格式正确、足够随机', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
        const s = totp.generateSecret();
        assert.match(s, /^[A-Z2-7]{32,}$/);
        assert.equal(totp.base32Decode(s).length >= 20, true);
        assert.ok(!seen.has(s));
        seen.add(s);
    }
});

test('otpauth 链接格式（兼容主流验证器 App）', () => {
    const url = totp.buildOtpauthUrl(RFC_SECRET_B32, 'admin', 'QQ农场管家');
    assert.ok(url.startsWith('otpauth://totp/'));
    const parsed = new URL(url.replace('otpauth://totp/', 'https://totp.local/'));
    assert.equal(parsed.searchParams.get('secret'), RFC_SECRET_B32);
    assert.equal(parsed.searchParams.get('issuer'), 'QQ农场管家');
    assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
    assert.equal(parsed.searchParams.get('digits'), '6');
    assert.equal(parsed.searchParams.get('period'), '30');
});

test('admin-store 两步验证完整流程（隔离临时数据目录）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'totp-store-'));
    fs.chmodSync(dir, 0o700);
    // auth-security 也用隔离的 attempts 文件，避免污染真实 core/data/login-attempts.json
    const secFilename = path.resolve(__dirname, '../dist/models/auth-security.js');
    const secRealRequire = createRequire(secFilename);
    const secSandbox = {
        require: name => name === '../config/runtime-paths'
            ? { getDataFile: () => path.join(dir, 'login-attempts.json'), ensureDataDir() {} }
            : secRealRequire(name),
        module: { exports: {} }, exports: {}, process, console, Buffer,
    };
    vm.runInNewContext(fs.readFileSync(secFilename, 'utf8'), secSandbox, { filename: secFilename });
    const security = secSandbox.module.exports;

    const filename = path.resolve(__dirname, '../dist/models/admin-store.js');
    const realRequire = createRequire(filename);
    const sandbox = {
        require: name => {
            if (name === '../config/runtime-paths') return { getDataFile: f => path.join(dir, f), ensureDataDir() {} };
            if (name === './auth-security') return security;
            return realRequire(name);
        },
        module: { exports: {} }, exports: {}, process, console, Buffer,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const adminStore = sandbox.module.exports;

    // 初始化密码
    const setup = adminStore.setupPassword('Str0ng!Passw0rd#9');
    assert.equal(setup.ok, true, `初始化应成功: ${setup.error || ''}`);

    // 未绑定前：无验证码也可登录
    const login1 = adminStore.validateAdmin('admin', 'Str0ng!Passw0rd#9', '1.2.3.4');
    assert.ok(login1 && !login1.error, '未启用 TOTP 时应直接登录成功');

    // 生成绑定密钥
    const begin = adminStore.beginTotpSetup('admin', 'Test');
    assert.equal(begin.ok, true);
    assert.ok(begin.secret && begin.otpauthUrl);
    // 已生成未激活：登录仍不需验证码
    const login2 = adminStore.validateAdmin('admin', 'Str0ng!Passw0rd#9', '1.2.3.4');
    assert.ok(login2 && !login2.error, '未激活前不要求验证码');

    // 激活：错误码失败
    const badAct = adminStore.activateTotp('000000');
    assert.equal(badAct.ok, false);
    // 激活：正确码成功
    const goodCode = totp.totpCodeAt(begin.secret, Date.now());
    const act = adminStore.activateTotp(goodCode);
    assert.equal(act.ok, true, `激活应成功: ${act.error || ''}`);

    // 启用后：无验证码 → totp_required，且不计失败尝试
    const login3 = adminStore.validateAdmin('admin', 'Str0ng!Passw0rd#9', '9.9.9.9');
    assert.equal(login3.error, 'totp_required');
    // 无验证码尝试 8 次也不应锁定、不消耗限流配额（不计失败）
    for (let i = 0; i < 8; i++) {
        const r = adminStore.validateAdmin('admin', 'Str0ng!Passw0rd#9', '8.8.8.8');
        assert.equal(r.error, 'totp_required');
    }
    const login3b = adminStore.validateAdmin('admin', 'Str0ng!Passw0rd#9', '8.8.8.8', goodCode);
    assert.ok(login3b && !login3b.error, '补上正确验证码后应登录成功（未被错误策略锁定）');

    // 启用后：错误验证码 → invalid_totp，计入失败尝试
    const login4 = adminStore.validateAdmin('admin', 'Str0ng!Passw0rd#9', '7.7.7.7', '000000');
    assert.equal(login4.error, 'invalid_totp');

    // 关闭：密码错误失败；密码正确成功
    const badOff = adminStore.disableTotp('wrong');
    assert.equal(badOff.ok, false);
    const off = adminStore.disableTotp('Str0ng!Passw0rd#9');
    assert.equal(off.ok, true);
    const login5 = adminStore.validateAdmin('admin', 'Str0ng!Passw0rd#9', '6.6.6.6');
    assert.ok(login5 && !login5.error, '关闭后仅需密码');
});

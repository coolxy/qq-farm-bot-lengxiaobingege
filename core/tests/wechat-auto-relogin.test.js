const assert = require('node:assert/strict');
const test = require('node:test');
const { after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 每个 harness 都会启动一个 10 分钟的会话刷新周期任务，测试结束必须统一清理，
// 否则 node --test 的进程会因残留 interval 无法退出。
const createdServices = [];

const { createWechatAutoReloginService, WX_FARM_APP_ID } = require('../dist/runtime/wechat-auto-relogin');

function createHarness(overrides = {}) {
    const accounts = [{
        id: '1',
        name: 'wx-user',
        platform: 'wx',
        code: 'old-code',
        loginBuffer: 'saved-buffer',
    }];
    const tasks = new Map();
    const started = [];
    const stopped = [];
    const issued = [];
    const reminders = [];
    const accountLogs = [];
    const clearedSessions = [];
    const pushes = [];
    let issueWxLoginCode = overrides.issueWxLoginCode || (async () => 'new-code');

    const service = createWechatAutoReloginService({
        store: {
            getLoginSettings: () => ({ wechatAutoRelogin: true, ...(overrides.loginSettings || {}) }),
            getAccounts: () => ({ accounts }),
            addOrUpdateAccount(acc) {
                const current = accounts.find(item => item.id === acc.id);
                if (current) Object.assign(current, acc);
                return { accounts };
            },
            clearWxAutoReloginSession(accountId) {
                clearedSessions.push(accountId);
                const current = accounts.find(item => item.id === accountId);
                if (!current) return { accounts };
                delete current.loginBuffer;
                delete current.wxOpenId;
                delete current.wxAccessToken;
                delete current.wxRefreshToken;
                return { accounts };
            },
        },
        log() {},
        addAccountLog(...args) {
            accountLogs.push(args);
        },
        startWorker(account, options) {
            started.push({ account, options });
            return overrides.startWorker ? overrides.startWorker(account, options) : true;
        },
        stopWorker(accountId, options) {
            stopped.push({ accountId, options });
        },
        waitForWorkerExit: overrides.waitForWorkerExit || (() => Promise.resolve()),
        triggerEventNotify(payload) {
            reminders.push(payload);
        },
        sendPush(payload) {
            pushes.push(payload);
        },
        setTimeoutTask(name, delayMs, fn) {
            tasks.set(name, { delayMs, fn });
        },
        clearTimeoutTask(name) {
            tasks.delete(name);
        },
        issueWxLoginCode(loginBuffer, appId, credentials) {
            issued.push({ loginBuffer, appId, credentials });
            return issueWxLoginCode(loginBuffer, appId, credentials);
        },
        kickoutStateFile: Object.prototype.hasOwnProperty.call(overrides, 'kickoutStateFile')
            ? overrides.kickoutStateFile
            : '',
        ...(Object.prototype.hasOwnProperty.call(overrides, 'retryDelaysMs')
            ? (overrides.retryDelaysMs ? { retryDelaysMs: overrides.retryDelaysMs } : {})
            : { retryDelaysMs: [5, 10, 15] }),
    });

    createdServices.push(service);

    return {
        accounts,
        accountLogs,
        issued,
        pushes,
        reminders,
        service,
        started,
        stopped,
        tasks,
        clearedSessions,
        setIssueWxLoginCode(next) {
            issueWxLoginCode = next;
        },
    };
}

test('schedules WeChat auto relogin and restarts with a fresh code', async () => {
    const harness = createHarness();

    assert.equal(harness.service.handleDisconnect('1', 'wx-user', 'kickout:test'), true);
    assert.equal(harness.tasks.size, 1);

    await [...harness.tasks.values()][0].fn();

    assert.equal(harness.stopped[0].options.preserveAutoRelogin, true);
    assert.equal(harness.issued[0].loginBuffer, 'saved-buffer');
    assert.equal(harness.issued[0].appId, WX_FARM_APP_ID);
    assert.equal(harness.accounts[0].code, 'new-code');
    assert.equal(harness.started.length, 1);
    assert.equal(harness.started[0].account.code, 'new-code');
    assert.equal(harness.started[0].options.preserveAutoRelogin, true);
    assert.equal(harness.reminders.length, 0);
    assert.equal(harness.accountLogs.some(entry => entry[0] === 'wx_auto_relogin_success'), true);
});

test('persists refreshed WeChat credentials after auto relogin', async () => {
    const harness = createHarness({
        issueWxLoginCode: async () => ({
            code: 'new-code',
            loginBuffer: 'fresh-buffer',
            credentials: {
                openid: 'openid-value',
                accessToken: 'new-access',
                refreshToken: 'new-refresh',
                loginType: 'WX',
                expiresAt: 1_800_000_000,
                expiresIn: 7200,
            },
        }),
    });
    harness.accounts[0].wxOpenId = 'openid-value';
    harness.accounts[0].wxAccessToken = 'old-access';
    harness.accounts[0].wxRefreshToken = 'old-refresh';

    assert.equal(harness.service.handleDisconnect('1', 'wx-user', 'kickout:test'), true);
    await [...harness.tasks.values()][0].fn();

    assert.equal(harness.accounts[0].loginBuffer, 'fresh-buffer');
    assert.equal(harness.accounts[0].wxAccessToken, 'new-access');
    assert.equal(harness.accounts[0].wxRefreshToken, 'new-refresh');
    assert.equal(harness.issued[0].credentials.refreshToken, 'old-refresh');
});

test('waits 60 seconds before the first kickout code refresh', () => {
    const harness = createHarness({ retryDelaysMs: undefined });
    harness.service.handleDisconnect('1', 'wx-user', 'kickout:test');
    assert.equal([...harness.tasks.values()][0].delayMs, 60000);
});

test('kickout backoff walks 1 → 3 → 5 → 10 minutes', () => {
    const harness = createHarness({ retryDelaysMs: undefined });
    const expected = [60000, 180000, 300000, 600000];
    for (const delayMs of expected) {
        assert.equal(harness.service.handleDisconnect('1', 'wx-user', 'kickout:test'), true);
        assert.equal(harness.tasks.get('wx_auto_relogin_1').delayMs, delayMs);
    }
});

test('pauses kickout relogin for 30 minutes after 5 consecutive kicks', () => {
    const harness = createHarness({ retryDelaysMs: undefined });
    for (let i = 0; i < 4; i++) {
        assert.equal(harness.service.handleDisconnect('1', 'wx-user', 'kickout:test'), true);
    }
    assert.equal(harness.service.handleDisconnect('1', 'wx-user', 'kickout:test'), false);
    assert.equal(
        harness.accountLogs.some(entry => entry[0] === 'wx_auto_relogin_skipped' && String(entry[1] || '').includes('暂停自动重登')),
        true,
    );
    // 暂停要让用户知道「bot 已经让位，不用扫码」，但不能催他马上处理
    assert.equal(harness.reminders.length, 1);
    assert.match(String(harness.reminders[0].reason), /^kickout_limit:/);
    assert.ok(harness.tasks.has('wx_kickout_resume_1'), '暂停到期后要自动再试，不能永远不上线');

    // 让位期内再被挤：不重登、不重复通知
    assert.equal(harness.service.handleDisconnect('1', 'wx-user', 'kickout:test'), false);
    assert.equal(harness.reminders.length, 1);
});

test('kickout backoff survives a restart', () => {
    const file = path.join(os.tmpdir(), `kickout-guard-${process.pid}-${Date.now()}.json`);
    try {
        const first = createHarness({ retryDelaysMs: undefined, kickoutStateFile: file });
        first.service.handleDisconnect('1', 'wx-user', 'kickout:test');
        first.service.handleDisconnect('1', 'wx-user', 'kickout:test');
        assert.equal(first.tasks.get('wx_auto_relogin_1').delayMs, 180000);
        assert.ok(fs.existsSync(file), '让位进度要落盘');

        const restarted = createHarness({ retryDelaysMs: undefined, kickoutStateFile: file });
        restarted.service.handleDisconnect('1', 'wx-user', 'kickout:test');
        assert.equal(restarted.tasks.get('wx_auto_relogin_1').delayMs, 300000, '重启后继续走 5 分钟档');
    } finally {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
});

test('skips auto relogin when the setting is disabled or loginBuffer is missing', () => {
    const disabled = createHarness({ loginSettings: { wechatAutoRelogin: false } });
    assert.equal(disabled.service.handleDisconnect('1', 'wx-user', 'kickout:test'), false);
    assert.equal(disabled.tasks.size, 0);

    const accountDisabled = createHarness();
    accountDisabled.accounts[0].wechatAutoRelogin = false;
    assert.equal(accountDisabled.service.handleDisconnect('1', 'wx-user', 'kickout:test'), false);
    assert.equal(accountDisabled.tasks.size, 0);
    assert.equal(accountDisabled.accountLogs.some(entry => entry[0] === 'wx_auto_relogin_skipped'), true);

    const missing = createHarness();
    missing.accounts[0].loginBuffer = '';
    assert.equal(missing.service.handleDisconnect('1', 'wx-user', 'kickout:test'), false);
    assert.equal(missing.tasks.size, 0);
    assert.equal(missing.accountLogs.some(entry => entry[0] === 'wx_auto_relogin_skipped'), true);
});

test('retries failed code refresh then sends an offline reminder', async () => {
    const harness = createHarness({
        retryDelaysMs: [1, 2],
        issueWxLoginCode: async () => {
            throw new Error('refresh failed');
        },
    });

    assert.equal(harness.service.handleDisconnect('1', 'wx-user', 'disconnect:ws'), true);
    await [...harness.tasks.values()][0].fn();
    assert.equal(harness.tasks.size, 1);
    assert.equal(harness.reminders.length, 0);

    await [...harness.tasks.values()][0].fn();
    assert.equal(harness.started.length, 0);
    assert.equal(harness.reminders.length, 1);
    assert.match(String(harness.reminders[0].reason), /auto_relogin_failed/);
    assert.deepEqual(harness.clearedSessions, []);
    assert.equal(harness.accounts[0].loginBuffer, 'saved-buffer');
    assert.equal(harness.accountLogs.some(entry => entry[0] === 'wx_auto_relogin_session_cleared'), false);
});

test('manual cancel after code refresh does not restart the worker', async () => {
    let releaseWait;
    let secondWaitStarted;
    const waitForSecondExit = new Promise((resolve) => {
        secondWaitStarted = resolve;
    });
    const blockedExit = new Promise((resolve) => {
        releaseWait = resolve;
    });
    let exitWaits = 0;
    const harness = createHarness({
        waitForWorkerExit() {
            exitWaits += 1;
            if (exitWaits === 1) return Promise.resolve();
            secondWaitStarted();
            return blockedExit;
        },
    });

    harness.service.handleDisconnect('1', 'wx-user', 'kickout:test');
    const pending = [...harness.tasks.values()][0].fn();
    await waitForSecondExit;
    harness.service.cancel('1');
    releaseWait();
    await pending;

    assert.equal(harness.started.length, 0);
    assert.equal(harness.reminders.length, 0);
});

test('host sleep disconnects relogin immediately instead of waiting 30s', () => {
    const harness = createHarness({ retryDelaysMs: [30000, 12000, 30000] });
    assert.equal(harness.service.handleDisconnect('1', 'wx-user', 'disconnect:host_sleep:online:0'), true);
    assert.equal([...harness.tasks.values()][0].delayMs, 0);
});

test('requestImmediate schedules WeChat relogin with delay 0', () => {
    const harness = createHarness({ retryDelaysMs: [30000, 12000, 30000] });
    assert.equal(harness.service.requestImmediate('1', 'wx-user', 'host_sleep:180000'), true);
    assert.equal([...harness.tasks.values()][0].delayMs, 0);
});

test('cancelAll stops an in-flight code refresh', async () => {
    let release;
    let startedIssue;
    const waitForIssue = new Promise((resolve) => {
        startedIssue = resolve;
    });
    const harness = createHarness({
        loginSettings: { wechatAutoRelogin: true },
        issueWxLoginCode: () => {
            startedIssue();
            return new Promise((resolve) => {
                release = resolve;
            });
        },
    });

    harness.service.handleDisconnect('1', 'wx-user', 'kickout:test');
    const pending = [...harness.tasks.values()][0].fn();
    await waitForIssue;
    harness.service.cancelAll();
    release('new-code');
    await pending;

    assert.equal(harness.started.length, 0);
    assert.equal(harness.reminders.length, 0);
});

test('manual cancel prevents a later worker restart', async () => {
    let release;
    let startedIssue;
    const waitForIssue = new Promise((resolve) => {
        startedIssue = resolve;
    });
    const harness = createHarness({
        issueWxLoginCode: () => {
            startedIssue();
            return new Promise((resolve) => {
                release = resolve;
            });
        },
    });

    harness.service.handleDisconnect('1', 'wx-user', 'kickout:test');
    const pending = [...harness.tasks.values()][0].fn();
    await waitForIssue;
    harness.service.cancel('1');
    release('new-code');
    await pending;

    assert.equal(harness.started.length, 0);
    assert.equal(harness.reminders.length, 0);
});

function primeWxSession(harness, refreshedAt) {
    const acc = harness.accounts[0];
    acc.wxOpenId = 'openid-1';
    acc.wxAccessToken = 'token-1';
    acc.wxRefreshToken = 'refresh-1';
    acc.wxExpiresAt = Math.floor(Date.now() / 1000) + 7200;
    acc.wxSessionRefreshedAt = refreshedAt;
}

test('refreshes at the top of the hour and stays silent on success', async () => {
    const harness = createHarness();
    // 同一小时内已经刷过 → 不刷新也不推送
    primeWxSession(harness, Date.now() - 60 * 1000);

    await harness.service.refreshAllSessionsIfNeeded();
    assert.equal(harness.issued.length, 0, '同一小时内不应重复刷新');
    assert.equal(harness.pushes.length, 0, '未刷新不应推送');

    // 上一个整点之前刷过 → 本整点刷新，但成功不发推送
    primeWxSession(harness, Date.now() - 2 * 60 * 60 * 1000);
    harness.setIssueWxLoginCode(async () => 'new-code');
    await harness.service.refreshAllSessionsIfNeeded();

    assert.equal(harness.issued.length, 1);
    assert.equal(harness.accounts[0].code, 'new-code');
    assert.equal(harness.pushes.length, 0, '刷新成功不推送');

    // 成功文案仍可用于手动查看
    const { buildSessionRefreshPush } = require('../dist/runtime/wechat-auto-relogin');
    const okPush = buildSessionRefreshPush({ name: 'wx-user' }, { ok: true, expiresAt: 1794573390, now: 1794570000000 });
    assert.match(okPush.title, /微信会话自动刷新成功/);
    assert.match(okPush.content, /新会话有效期至/);
});

test('pushes a failure reminder when the hourly refresh fails', async () => {
    const harness = createHarness();
    primeWxSession(harness, Date.now() - 2 * 60 * 60 * 1000);
    harness.setIssueWxLoginCode(async () => { throw new Error('session dead'); });

    await harness.service.refreshAllSessionsIfNeeded();

    assert.equal(harness.pushes.length, 1);
    assert.match(harness.pushes[0].title, /微信会话自动刷新失败/);
    assert.match(harness.pushes[0].content, /session dead/);
});

after(() => {
    for (const service of createdServices) service.cancelAll();
});

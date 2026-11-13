const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createEventNotifyService,
    markRuntimeStopping,
    resetRuntimeStopping,
} = require('../dist/runtime/event-notify');

/**
 * 掉线提醒兜底的「真时间」验证：用生产同款窗口（默认 150 秒，不注水、不假时钟），
 * 真实等定时器到点，验证 13 个关键行为。
 *
 * 常规 CI 不跑（单次约 190 秒），需要时：
 *   SLOW_OFFLINE_E2E=1 pnpm -C core test
 * 或临时缩短窗口（逻辑等价，只是等待变短）：
 *   SLOW_OFFLINE_E2E=1 OFFLINE_E2E_MS=3000 pnpm -C core test
 */
const SLOW = process.env.SLOW_OFFLINE_E2E === '1';
const W = Number(process.env.OFFLINE_E2E_MS || 150000);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const CFG = {
    channel: 'pushplus',
    endpoint: '',
    token: 'token-e2e',
    secret: '',
    title: '{accountName} 已离线',
    msg: '农场连接已断开，重新扫码登录即可继续。',
    offlineDeleteSec: 0,
};

function makeService(deferMs = W) {
    const pushes = [];
    const service = createEventNotifyService({
        store: { getEventNotify: () => CFG },
        sendPushooMessage: async (payload) => {
            pushes.push({ at: Date.now(), title: payload.title, content: payload.content });
            return { ok: true };
        },
        log: () => {},
        offlineDeferMs: deferMs,
        offlineDedupeMs: 10 * 60 * 1000,
    });
    return { service, pushes };
}

test('掉线兜底全矩阵（真时间窗口）', { skip: SLOW ? false : '慢测，设 SLOW_OFFLINE_E2E=1 开启' }, async () => {
    const t0 = Date.now();
    const elapsed = () => Date.now() - t0;

    // A：过程态断线 → 满窗口必推一条
    // B：在 0.6W 恢复在线 → 到点不推
    // C：0.2W 处抖动再断 → 从最后一次重算
    // D：终态立即推，随后晚到的过程态消息不重推
    const A = makeService();
    const B = makeService();
    const C = makeService();
    const D = makeService();

    await A.service.triggerEventNotify({ accountId: 'A1', accountName: 'A号', reason: 'disconnect:ws_error:connecting:400' });
    await B.service.triggerEventNotify({ accountId: 'B1', accountName: 'B号', reason: 'disconnect:ws_error:connecting:400' });
    await C.service.triggerEventNotify({ accountId: 'C1', accountName: 'C号', reason: 'disconnect:ws_error:connecting:400' });
    await D.service.triggerEventNotify({ accountId: 'D1', accountName: 'D号', reason: 'auto_relogin_failed:3_retries' });

    assert.equal(A.pushes.length, 0, '断线瞬间不应推送，必须等自动重登结果');
    assert.equal(D.pushes.length, 1, '终态必须立即推');

    // t=1s：终态之后又收到一条过程态断线
    await wait(1000);
    await D.service.triggerEventNotify({ accountId: 'D1', accountName: 'D号', reason: 'disconnect:kickout' });

    // t=0.2W：C 抖动
    await wait(Math.round(W * 0.2) - 1000);
    await C.service.triggerEventNotify({ accountId: 'C1', accountName: 'C号', reason: 'disconnect:ws_error:connecting:400' });

    // t=0.6W：B 恢复
    await wait(Math.round(W * 0.4));
    B.service.noteAccountRecovered('B1', 'B号');

    // t=W-2s：A 仍应挂着，C 已重算所以更不会推
    await wait(Math.round(W * 0.4) - 2000);
    assert.ok(elapsed() >= W - 3000, `应已接近窗口末尾，实际 ${elapsed()}ms`);
    assert.equal(A.pushes.length, 0, '窗口未到期不应推送');
    assert.equal(C.pushes.length, 0, '抖动后应从最后一次断线重算，此时仍未到期');

    // t=W+3s：A 到点推一条
    await wait(5000);
    assert.equal(A.pushes.length, 1, '窗口到期必须推且只推一条');
    assert.ok(A.pushes[0].at - t0 >= W, `推送时间应不早于 ${W}ms`);
    assert.match(A.pushes[0].content, new RegExp(`已等待\\s*${Math.round(W / 1000)}\\s*秒自动重登未成功`));
    assert.match(A.pushes[0].title, /A号/);
    assert.equal(B.pushes.length, 0, '已恢复在线的账号不应再推离线');
    assert.equal(C.pushes.length, 0, 'C 还没到重算后的到期点');
    assert.equal(D.pushes.length, 1, '终态推送后晚到的过程态消息不得重复推送');

    // t=1.2W：C 才到期
    await wait(Math.round(W * 0.2) + 4000);
    assert.equal(C.pushes.length, 1, 'C 从最后一次断线起满窗口后推一条');

    // 停机标记：断线不挂起 + 已挂起的到点不推
    const F = makeService();
    markRuntimeStopping();
    await F.service.triggerEventNotify({ accountId: 'F1', accountName: 'F号', reason: 'disconnect:ws_error' });
    resetRuntimeStopping();
    assert.equal(F.pushes.length, 0);

    const F2 = makeService(800);
    await F2.service.triggerEventNotify({ accountId: 'F2', accountName: 'F号2', reason: 'disconnect:ws_error' });
    markRuntimeStopping();      // 挂起之后才停机
    await wait(1300);
    assert.equal(F2.pushes.length, 0, '停机标记置位后，已挂起的提醒不应再推');
    resetRuntimeStopping();

    // 取消停机后能力恢复
    const G = makeService(500);
    await G.service.triggerEventNotify({ accountId: 'G1', accountName: 'G号', reason: 'disconnect:ws_error' });
    await wait(900);
    assert.equal(G.pushes.length, 1, '取消停机标记后应恢复正常推送');
});

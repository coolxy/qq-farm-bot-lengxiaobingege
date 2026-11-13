export {};

const {
    WX_FARM_APP_ID,
    WxLoginService,
    accountFieldsFromCredentials,
    credentialsFromAccount,
} = require('../services/wx-login/service');
const { ignoreError } = require('../utils/ignore-error');
const { createScheduler } = require('../services/scheduler');
const { isHostSleepReason } = require('../utils/host-sleep');
const { getServerTimeSec, toNum, log, sleep } = require('../utils/utils');

const DEFAULT_RETRY_DELAYS_MS = [30000, 12000, 30000];
const HOUR_MS = 60 * 60 * 1000;
// 用户要求：每小时整点主动刷新一次 access token / login buffer，不等临期
const SESSION_REFRESH_INTERVAL_MS = HOUR_MS;
// 传给底层换码的提前量，与刷新周期保持一致
const SESSION_REFRESH_AHEAD_MS = SESSION_REFRESH_INTERVAL_MS;
// 用户要求：成功后不推送，只在续期失败时提醒；想恢复「每小时一条成功提醒」改成 true 即可
const PUSH_SESSION_REFRESH_SUCCESS = false;

interface WechatAutoReloginOptions {
    store: any;
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    startWorker: (account: any, options?: { preserveAutoRelogin?: boolean }) => boolean;
    stopWorker: (accountId: string, options?: { preserveAutoRelogin?: boolean }) => void;
    waitForWorkerExit?: (accountId: string) => Promise<void>;
    triggerEventNotify: (payload: any) => void;
    /** 走事件通知渠道发送自定义消息（每小时会话续期提醒） */
    sendPush?: (payload: { title: string; content: string; accountId?: string; accountName?: string; logLabel?: string }) => Promise<void> | void;
    setTimeoutTask?: (taskName: string, delayMs: number, taskFn: () => Promise<void> | void) => any;
    clearTimeoutTask?: (taskName: string) => void;
    issueWxLoginCode?: (loginBuffer: string, appId: string, credentials?: any, aheadMs?: number) => Promise<any>;
    retryDelaysMs?: number[];
}

function isWechatPlatform(platform: unknown): boolean {
    const value = String(platform || '').trim().toLowerCase();
    return value === 'wx' || value === 'wechat';
}

function formatStamp(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '-';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 每小时续期是一条独立提醒：成功报一次“续上了”，失败要让人立刻知道下次可能掉线
function buildSessionRefreshPush(
    account: any,
    result: { ok: boolean; expiresAt?: number; error?: any; now?: number },
): { title: string; content: string } {
    const name = String(account?.name || account?.id || '账号');
    const now = Number(result.now || Date.now());
    const lines = [
        `账号：${name}`,
        `结果：${result.ok ? '刷新成功' : '刷新失败'}`,
        `时间：${formatStamp(now)}`,
    ];
    if (result.ok) {
        const expiresAtMs = Number(result.expiresAt || 0) * 1000;
        lines.push(`新会话有效期至：${expiresAtMs > 0 ? formatStamp(expiresAtMs) : '未知'}`);
        lines.push('说明：每小时自动续期一次，正常情况无需重新扫码');
    } else {
        lines.push(`原因：${String(result.error?.message || result.error || 'unknown')}`);
        lines.push('说明：本次续期失败，10 分钟后巡检会再试；若账号已掉线需要重新扫码');
    }
    return {
        title: result.ok ? '微信会话自动刷新成功' : '微信会话自动刷新失败',
        content: lines.join('\n'),
    };
}

function hasSavedWxSession(account: any): boolean {
    if (String(account?.loginBuffer || '').trim()) return true;
    return !!(String(account?.wxOpenId || '').trim() && String(account?.wxAccessToken || '').trim());
}

function taskName(accountId: string): string {
    return `wx_auto_relogin_${accountId}`;
}

function createWechatAutoReloginService(options: WechatAutoReloginOptions) {
    const {
        store,
        log,
        addAccountLog,
        startWorker,
        stopWorker,
        waitForWorkerExit,
        triggerEventNotify,
        sendPush,
        retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    } = options;
    const scheduler = createScheduler('wechat_auto_relogin');
    const sessionRefreshTask = `wx_session_refresh_all`;

    function isWechatAccountNeedsRefresh(account: any): boolean {
        if (!String(account?.loginBuffer || '').trim()) return false;
        // 对齐整点：上次刷新落在哪个小时，和当前小时不同就刷新，保证每个整点最多一次
        const last = Number(account?.wxSessionRefreshedAt || 0) || Number(account?.updatedAt || 0);
        if (last <= 0) return true;
        return Math.floor(last / HOUR_MS) < Math.floor(Date.now() / HOUR_MS);
    }

    async function pushSessionRefresh(account: any, push: { title: string; content: string }): Promise<void> {
        if (typeof sendPush !== 'function') return;
        try {
            await sendPush({
                title: push.title,
                content: push.content,
                accountId: String(account?.id || ''),
                accountName: String(account?.name || ''),
                logLabel: '会话刷新提醒',
            });
        } catch (e: any) {
            log('错误', `会话刷新提醒发送异常: ${e?.message || e}`);
        }
    }

    async function refreshSessionIfNeeded(account: any): Promise<void> {
        const id = String(account.id || '');
        const name = String(account.name || id);
        const loginBuffer = String(account.loginBuffer || '').trim();
        const credentials = credentialsFromAccount(account);
        if (!loginBuffer || !credentials) return;
        if (!isWechatAccountNeedsRefresh(account)) return;
        if (cancelled.has(id)) return;
        try {
            log('系统', `账号 ${name} 微信会话满 1 小时，自动刷新`, {
                accountId: id, accountName: name,
                lastRefreshedAt: Number(account.wxSessionRefreshedAt || 0),
                expiresAt: Number(account.wxExpiresAt || 0),
            });            const issued = await issueWxLoginCode(loginBuffer, WX_FARM_APP_ID, credentials, SESSION_REFRESH_AHEAD_MS);
            let code: string, nextBuffer: string, nextCredentials: any;
            if (typeof issued === 'string') {
                code = String(issued || '').trim();
                nextBuffer = loginBuffer;
                nextCredentials = credentials;
            } else {
                code = String(issued?.code || '').trim();
                nextBuffer = String(issued?.loginBuffer || loginBuffer || '').trim();
                nextCredentials = issued?.credentials || credentials;
            }
            if (!code) throw new Error('empty wx login code');
            store.addOrUpdateAccount({ id, code, ...accountFieldsFromCredentials(nextBuffer, nextCredentials) });
            log('系统', `账号 ${name} 微信会话自动刷新成功`, { accountId: id, accountName: name });
            addAccountLog('wx_session_refreshed', `账号 ${name} 微信会话自动刷新成功（每小时一次）`, id, name);
            // 成功不推送：每小时一条太吵，只有失败才需要人介入
            if (PUSH_SESSION_REFRESH_SUCCESS) {
                await pushSessionRefresh(account, buildSessionRefreshPush(account, {
                    ok: true,
                    expiresAt: Number(nextCredentials?.expiresAt || 0),
                }));
            }
        } catch (error: any) {
            log('错误', `账号 ${name} 微信会话自动刷新失败: ${error?.message || error}`, {
                accountId: id, accountName: name,
            });
            await pushSessionRefresh(account, buildSessionRefreshPush(account, { ok: false, error }));
        }
    }

    async function refreshAllSessionsIfNeeded(): Promise<void> {
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
        for (const account of accounts) {
            try {
                if (!account || String(account.platform || '').toLowerCase() !== 'wx') continue;
                if (account?.wechatAutoRelogin === false) continue;
                await refreshSessionIfNeeded(account);
            } catch (err) { ignoreError('core/src/runtime/wechat-auto-relogin.ts:107', err); }
        }
    }

    // 整点对齐：每小时的第 0 分触发（+1 秒缓冲，避免边界抖动落在上一小时）
    function msUntilNextHour(now: number = Date.now()): number {
        const next = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS + 1000;
        return Math.max(1000, next - now);
    }

    let hourlyRefreshStopped = false;

    function scheduleNextHourlyRefresh(): void {
        if (hourlyRefreshStopped) return;
        scheduler.setTimeoutTask(sessionRefreshTask, msUntilNextHour(), async () => {
            try {
                await refreshAllSessionsIfNeeded();
            } catch (err) {
                ignoreError('core/src/runtime/wechat-auto-relogin.ts:hourlyRefresh', err);
            } finally {
                scheduleNextHourlyRefresh();
            }
        });
    }

    function startSessionRefreshScheduler(): void {
        hourlyRefreshStopped = false;
        scheduleNextHourlyRefresh();
    }

    function stopSessionRefreshScheduler(): void {
        hourlyRefreshStopped = true;
        scheduler.clear(sessionRefreshTask);
    }
    const setTimeoutTask = options.setTimeoutTask
        || ((taskName: string, delayMs: number, taskFn: () => Promise<void> | void) => scheduler.setTimeoutTask(taskName, delayMs, taskFn));
    const clearTimeoutTask = options.clearTimeoutTask
        || ((taskName: string) => scheduler.clear(taskName));
    const wxLogin = new WxLoginService();
    const issueWxLoginCode = options.issueWxLoginCode
        || ((loginBuffer: string, appId: string, credentials?: any, aheadMs?: number) => wxLogin.issueCodeFromLoginBuffer(loginBuffer, appId, credentials, aheadMs));
    const attempts = new Map<string, number>();
    const cancelled = new Set<string>();
    const trackedIds = new Set<string>();

    function isGloballyEnabled(): boolean {
        const settings = store.getLoginSettings ? store.getLoginSettings() : null;
        return settings?.wechatAutoRelogin !== false;
    }

    function isAccountEnabled(account: any): boolean {
        return account?.wechatAutoRelogin !== false;
    }

    function isEnabled(account?: any): boolean {
        if (!isGloballyEnabled()) return false;
        if (account && !isAccountEnabled(account)) return false;
        return true;
    }

    function findAccount(accountId: string): any {
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
        return accounts.find((item: any) => String(item?.id || '') === String(accountId || '')) || null;
    }

    function forget(accountId: string): void {
        const id = String(accountId || '');
        if (!id) return;
        attempts.delete(id);
        trackedIds.delete(id);
    }

    function cancel(accountId: string): void {
        const id = String(accountId || '');
        if (!id) return;
        clearTimeoutTask(taskName(id));
        forget(id);
        cancelled.add(id);
    }

    function cancelAll(): void {
        stopSessionRefreshScheduler();
        for (const id of [...trackedIds]) cancel(id);
    }

    function wasCancelled(accountId: string): boolean {
        return cancelled.has(accountId);
    }

    function clearExpiredWxSession(accountId: string, accountName: string, reason: string): void {
        if (typeof store.clearWxAutoReloginSession !== 'function') return;
        store.clearWxAutoReloginSession(accountId);
        log('系统', `账号 ${accountName} 微信离线自动重新登录失败，已清除失效会话，请重新扫码`, {
            accountId,
            accountName,
            reason,
        });
        addAccountLog('wx_auto_relogin_session_cleared', `账号 ${accountName} 微信离线自动重新登录失败，已清除失效会话，请重新扫码`, accountId, accountName, { reason });
    }

    function skip(accountId: string, accountName: string, reason: string, skipReason: string): boolean {
        const id = String(accountId || '');
        const name = String(accountName || id);
        log('系统', `账号 ${name} 跳过微信离线自动重新登录：${skipReason}`, {
            accountId: id,
            accountName: name,
            reason,
            skipReason,
        });
        addAccountLog('wx_auto_relogin_skipped', `账号 ${name} 跳过微信离线自动重新登录：${skipReason}`, id, name, {
            reason,
            skipReason,
        });
        return false;
    }

    function schedule(accountId: string, accountName: string, reason: string, delayMs = 0): boolean {
        const id = String(accountId || '');
        const name = String(accountName || id);
        if (!id) return false;
        if (!isGloballyEnabled()) return skip(id, name, reason, '设置未开启');
        const account = findAccount(id);
        if (!account || !isWechatPlatform(account.platform)) return false;
        if (!isAccountEnabled(account)) return skip(id, name, reason, '该账号未开启自动重新登录');
        if (!hasSavedWxSession(account)) {
            skip(id, name, reason, '没有已保存的扫码会话，请重新微信扫码登录');
            // 完全没有会话 = 确定救不回来，立即推送，不再等掉线兜底窗口
            triggerEventNotify({ accountId: id, accountName: name, reason: `no_session:${reason}`, offlineMs: 0 });
            return false;
        }

        cancelled.delete(id);
        trackedIds.add(id);
        clearTimeoutTask(taskName(id));
        const waitMs = Math.max(0, Number(delayMs) || 0);
        log('系统', `账号 ${name} 将尝试微信离线自动重新登录`, {
            accountId: id,
            accountName: name,
            reason,
            delayMs: waitMs,
        });
        addAccountLog(
            'wx_auto_relogin_scheduled',
            `账号 ${name} 已安排微信离线自动重新登录`,
            id,
            name,
            { reason, delayMs: waitMs },
        );
        setTimeoutTask(taskName(id), waitMs, () => run(id, name, reason));
        return true;
    }

    async function run(accountId: string, accountName: string, reason: string): Promise<void> {
        const id = String(accountId || '');
        const name = String(accountName || id);
        const account = findAccount(id);
        if (wasCancelled(id) || !isEnabled(account)) {
            forget(id);
            return;
        }

        if (!account || !isWechatPlatform(account.platform)) {
            forget(id);
            return;
        }

        const loginBuffer = String(account.loginBuffer || '').trim();
        const credentials = credentialsFromAccount(account);
        if (!loginBuffer && !credentials) {
            forget(id);
            log('系统', `账号 ${name} 没有可用的微信登录会话，等待重新扫码`, { accountId: id, accountName: name, reason });
            addAccountLog('wx_auto_relogin_missing_session', `账号 ${name} 没有可用的微信登录会话，等待重新扫码`, id, name, { reason });
            // 没有会话可用 = 终态，自动重登救不回来，立即推送（no_session 前缀见 event-notify 的终态白名单）
            triggerEventNotify({ accountId: id, accountName: name, reason: `no_session:${reason}`, offlineMs: 0 });
            return;
        }

        stopWorker(id, { preserveAutoRelogin: true });
        if (typeof waitForWorkerExit === 'function') {
            await waitForWorkerExit(id);
        }
        if (wasCancelled(id) || !isEnabled(findAccount(id))) {
            forget(id);
            return;
        }
        const attempt = (attempts.get(id) || 0) + 1;
        attempts.set(id, attempt);
        log('系统', `账号 ${name} 正在通过已保存的微信扫码会话换取新 Code（第 ${attempt} 次）`, {
            accountId: id,
            accountName: name,
            reason,
            attempt,
        });

        try {
            const issued = await issueWxLoginCode(loginBuffer, WX_FARM_APP_ID, credentials);
            let code: string, nextBuffer: string, nextCredentials: any;
            if (typeof issued === 'string') {
                code = String(issued || '').trim();
                nextBuffer = loginBuffer;
                nextCredentials = credentials;
            } else {
                code = String(issued?.code || '').trim();
                nextBuffer = String(issued?.loginBuffer || loginBuffer || '').trim();
                nextCredentials = issued?.credentials || credentials;
            }
            if (!code) throw new Error('empty wx login code');
            if (wasCancelled(id) || !isEnabled(findAccount(id))) {
                forget(id);
                return;
            }
            store.addOrUpdateAccount({ id, code, ...accountFieldsFromCredentials(nextBuffer, nextCredentials) });
            const latest = findAccount(id);
            if (!latest) {
                forget(id);
                return;
            }
            if (typeof waitForWorkerExit === 'function') {
                await waitForWorkerExit(id);
            }
            if (wasCancelled(id) || !isEnabled(findAccount(id))) {
                forget(id);
                return;
            }
            const started = startWorker({ ...latest, code, loginBuffer: nextBuffer }, { preserveAutoRelogin: true });
            if (!started) throw new Error('worker start rejected');
            forget(id);
            log('系统', `账号 ${name} 微信离线自动重新登录成功`, { accountId: id, accountName: name, reason, attempt });
            addAccountLog('wx_auto_relogin_success', `账号 ${name} 微信离线自动重新登录成功`, id, name, { reason, attempt });
        } catch (error: any) {
            const message = String(error?.message || error || 'unknown error');
            log('错误', `账号 ${name} 微信离线自动重新登录失败: ${message}`, {
                accountId: id,
                accountName: name,
                reason,
                attempt,
            });
            addAccountLog('wx_auto_relogin_failed', `账号 ${name} 微信离线自动重新登录失败`, id, name, {
                reason,
                attempt,
                error: message,
            });
            if (wasCancelled(id) || attempt >= retryDelaysMs.length) {
                forget(id);
                if (!wasCancelled(id)) {
                    log('系统', `账号 ${name} 微信离线自动重新登录失败，已保留扫码会话等待下次重试`, {
                        accountId: id,
                        accountName: name,
                        reason,
                    });
                    triggerEventNotify({ accountId: id, accountName: name, reason: `auto_relogin_failed:${reason}`, offlineMs: 0 });
                }
                return;
            }
            schedule(id, name, reason, retryDelaysMs[attempt] || retryDelaysMs[retryDelaysMs.length - 1]);
        }
    }

    // 被挤下线（kickout）的重登保护：延迟重登避免与用户手机端立即互踢，
    // 且同一账号短时间内被挤多次时暂停自动重登，防止 bot 与手机循环互挤
    const kickoutReloginTimes = new Map<string, number[]>();
    const KICKOUT_WINDOW_MS = 10 * 60 * 1000;
    const KICKOUT_MAX_RELOGINS = 3;
    const KICKOUT_DELAY_MS = 60000;

    function handleDisconnect(accountId: string, accountName: string, reason: string): boolean {
        if (String(reason || '').startsWith('kickout')) {
            const id = String(accountId || '');
            const now = Date.now();
            const times = (kickoutReloginTimes.get(id) || []).filter((t: number) => now - t < KICKOUT_WINDOW_MS);
            if (times.length >= KICKOUT_MAX_RELOGINS) {
                kickoutReloginTimes.set(id, times);
                return skip(id, accountName, reason, `短时间内已被挤下线 ${times.length} 次，已暂停自动重登，避免与手机端循环互挤，请手动处理`);
            }
            times.push(now);
            kickoutReloginTimes.set(id, times);
            return schedule(accountId, accountName, reason, KICKOUT_DELAY_MS);
        }
        const delayMs = isHostSleepReason(reason) ? 0 : (retryDelaysMs[0] || 30000);
        return schedule(accountId, accountName, reason, delayMs);
    }

    function requestImmediate(accountId: string, accountName: string, reason = 'host_sleep'): boolean {
        if (!hasSavedWxSession(findAccount(accountId))) return false;
        return schedule(accountId, accountName, reason, 0);
    }

    startSessionRefreshScheduler();

    return {
        cancel,
        cancelAll,
        handleDisconnect,
        isEnabled,
        requestImmediate,
        refreshAllSessionsIfNeeded,
    };
}

module.exports = {
    createWechatAutoReloginService,
    buildSessionRefreshPush,
    WX_FARM_APP_ID,
};

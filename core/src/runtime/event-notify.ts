export {};

interface ReloginReminderOptions {
    store: any;
    sendPushooMessage: (payload: any) => Promise<any>;
    log: (tag: string, msg: string, extra?: any) => void;
    // 延迟判定窗口与去重窗口可注入，便于测试与后续调参
    offlineDeferMs?: number;
    offlineDedupeMs?: number;
}

interface EventNotifyPayload {
    accountId?: string;
    accountName?: string;
    reason?: string;
    offlineMs?: number;
}

// 掉线提醒延迟判定窗口：覆盖自动重登的 3 次重试（30s + 12s + 30s）。
// 实测 11-06 完整失败链 43 秒，加上首次重试前等待与换码耗时最坏约 92 秒，
// 因此兜底窗口取 150 秒——正常失败会在 75~90 秒由终态推送接管并清掉本定时器，
// 这里只负责「既不成功也不失败」的卡死兜底
const OFFLINE_DEFER_MS = 150 * 1000;
// 同账号同类掉线 10 分钟内只推一条：pushplus 对重复内容返回 999 直接丢，
// 与其推两条被判重，不如自己先去重
const OFFLINE_DEDUPE_MS = 10 * 60 * 1000;
// 「已恢复」只在真推过「已离线」之后才补发；超过这个时长仍恢复也补，
// 但隔夜或跨进程的陈旧记录不再补，避免第二天收到莫名通知
const RECOVER_NOTICE_TTL_MS = 12 * 60 * 60 * 1000;

// 这些原因已经是终态，自动重登救不回来了，必须立刻推
const IMMEDIATE_REASON_PREFIXES = ['auto_relogin_failed:', 'no_session', 'offline_timeout', 'kickout_limit'];

// 主进程收到退出信号后置位：之后所有掉线提醒直接丢弃，
// 避免改代码重启被当成掉线打扰用户
let runtimeStopping = false;

function markRuntimeStopping(): void {
    runtimeStopping = true;
}

function isRuntimeStopping(): boolean {
    return runtimeStopping;
}

// 仅在测试或「取消停机」场景使用：清掉停机标记
function resetRuntimeStopping(): void {
    runtimeStopping = false;
}

function createEventNotifyService(options: ReloginReminderOptions) {
    const { store, sendPushooMessage, log } = options;
    const offlineDeferMs = Number.isFinite(options.offlineDeferMs) && (options.offlineDeferMs as number) > 0
        ? Number(options.offlineDeferMs)
        : OFFLINE_DEFER_MS;
    const offlineDedupeMs = Number.isFinite(options.offlineDedupeMs) && (options.offlineDedupeMs as number) > 0
        ? Number(options.offlineDedupeMs)
        : OFFLINE_DEDUPE_MS;

    // 推送配置问题的报错只提醒一次：账号掉线循环重试期间会反复触发提醒，
    // 同一条配置错误刷屏 error 日志没有额外价值；配置变更后允许再次提示。
    let lastConfigErrorReason = '';

    // 推送串行队列：登录提醒、神秘商人到货等可能同一刻触发，
    // pushplus 一类渠道对同 token 并发会返回「服务端验证错误」，串行后不会互相顶掉。
    let pushQueue: Promise<any> = Promise.resolve();

    // 挂起中的掉线提醒：key 是账号 id，恢复在线或转终态时清掉
    const pendingOffline = new Map<string, { timer: any; payload: EventNotifyPayload }>();
    // 已推送过的掉线提醒：用于同类原因 10 分钟内去重
    const lastOfflinePush = new Map<string, { category: string; at: number }>();
    // 已成功推送过「已离线」的账号及时间：恢复时据此补一条「已恢复」，形成完整闭环
    const offlineNoticeSentAt = new Map<string, number>();

    function enqueuePush<T>(task: () => Promise<T>): Promise<T> {
        const run = pushQueue.then(task, task);
        pushQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    function reportConfigError(reason: string): void {
        if (reason === lastConfigErrorReason) return;
        lastConfigErrorReason = reason;
        log('错误', `${reason}（同一问题只提示一次，修正推送配置后会重新校验）`);
    }

    function getOfflineAutoDeleteMs(): number {
        const cfg = store.getEventNotify ? store.getEventNotify() : null;
        const sec = Math.max(0, Number.parseInt(cfg?.offlineDeleteSec, 10) || 0);
        return sec === 0 ? Infinity : sec * 1000;
    }

    function resolvePushChannel(): { ok: true; channel: string; endpoint: string; token: string; secret: string } | { ok: false; reason: string } {
        const cfg = store.getEventNotify ? store.getEventNotify() : null;
        if (!cfg) return { ok: false, reason: '未找到事件通知配置' };

        const channel = String(cfg.channel || '').trim().toLowerCase();
        const endpoint = String(cfg.endpoint || '').trim();
        const token = String(cfg.token || '').trim();
        const secret = String(cfg.secret || '').trim();
        if (!channel) return { ok: false, reason: '事件通知配置不完整' };
        if (channel === 'webhook' && !endpoint) return { ok: false, reason: 'Webhook 渠道未设置接口地址' };
        if (channel === 'dingtalk' && !endpoint && !token) return { ok: false, reason: '钉钉渠道未设置 Webhook 地址' };
        if (channel !== 'webhook' && channel !== 'dingtalk' && !token) return { ok: false, reason: '事件通知渠道未设置 Token' };
        return { ok: true, channel, endpoint, token, secret };
    }

    function renderTemplate(template: string, vars: Record<string, string>): string {
        return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
            const value = vars[key];
            return value == null ? '' : String(value);
        });
    }

    function composeTitle(baseTitle: string, accountName: string): string {
        const title = String(baseTitle || '').trim();
        const name = String(accountName || '').trim();
        if (!name || !title || title.includes(name)) return title;
        return `${title} ${name}`.trim();
    }

    async function sendConfiguredPush(payload: { title?: string; content?: string; accountId?: string; accountName?: string; logLabel?: string } = {}): Promise<void> {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const baseTitle = String(payload.title || '').trim();
        const content = String(payload.content || '').trim();
        const title = composeTitle(baseTitle, accountName);
        const logLabel = String(payload.logLabel || '事件提醒').trim() || '事件提醒';
        try {
            const channelCfg = resolvePushChannel();
            if (channelCfg.ok === false) {
                reportConfigError(channelCfg.reason);
                return;
            }
            lastConfigErrorReason = '';
            if (!title || !content) {
                log('错误', '推送标题或内容为空');
                return;
            }
            const sendOnce = () => sendPushooMessage({
                channel: channelCfg.channel,
                endpoint: channelCfg.endpoint,
                token: channelCfg.token,
                secret: channelCfg.secret,
                title,
                content,
            });
            // 串行发送；失败（并发/瞬时校验）等 2 秒重试一次，避免提醒被静默丢掉
            const result = await enqueuePush(async () => {
                const first = await sendOnce();
                if (first?.ok) return first;
                await new Promise(resolve => setTimeout(resolve, 2000));
                return sendOnce();
            });
            if (result?.ok) {
                log('系统', `${logLabel}发送成功: ${accountName || accountId || title}`);
            } else {
                log('错误', `${logLabel}发送失败: ${result?.msg || 'unknown'}`);
            }
        } catch (e: any) {
            log('错误', `${logLabel}发送异常: ${e.message}`);
        }
    }

    function classifyOfflineReason(reason: string): string {
        const value = String(reason || '');
        if (value.startsWith('kickout')) return 'kickout';
        if (value.startsWith('auto_relogin_failed') || value.startsWith('no_session')) return 'relogin_failed';
        if (value.startsWith('offline_timeout')) return 'offline_timeout';
        if (value.startsWith('ws_error')) return 'ws_error';
        return 'disconnect';
    }

    function isImmediateReason(reason: string): boolean {
        const value = String(reason || '');
        return IMMEDIATE_REASON_PREFIXES.some(prefix => value.startsWith(prefix));
    }

    function buildOfflineMessage(payload: EventNotifyPayload): { title: string; content: string; accountId: string; accountName: string } | null {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const reason = String(payload.reason || 'unknown');
        const cfg = store.getEventNotify ? store.getEventNotify() : null;
        if (!cfg) {
            log('错误', '未找到事件通知配置');
            return null;
        }
        const vars = {
            accountName: accountName || '账号',
            accountId: accountId || '',
            reason: reason || 'unknown',
        };
        const title = renderTemplate(String(cfg.title || '').trim(), vars);
        const content = renderTemplate(String(cfg.msg || '').trim(), vars);
        if (!title || !content) {
            log('错误', '事件通知配置不完整');
            return null;
        }
        return { title, content, accountId, accountName };
    }

    function clearPendingOffline(accountId: string, logMessage?: string): boolean {
        const id = String(accountId || '').trim();
        if (!id) return false;
        const pending = pendingOffline.get(id);
        if (!pending) return false;
        if (pending.timer) clearTimeout(pending.timer);
        pendingOffline.delete(id);
        if (logMessage) {
            log('系统', logMessage, { accountId: id, accountName: pending.payload.accountName, reason: pending.payload.reason });
        }
        return true;
    }

    async function deliverOfflineNotice(payload: EventNotifyPayload, extraNote = ''): Promise<void> {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const reason = String(payload.reason || 'unknown');
        const category = classifyOfflineReason(reason);
        const now = Date.now();
        const last = lastOfflinePush.get(accountId);
        if (last && last.category === category && now - last.at < offlineDedupeMs) {
            log('系统', `账号 ${accountName || accountId} 同类掉线 ${Math.round((now - last.at) / 1000)} 秒前已提醒过，跳过重复推送`, {
                accountId, accountName, reason, category,
            });
            return;
        }
        const built = buildOfflineMessage(payload);
        if (!built) return;
        lastOfflinePush.set(accountId, { category, at: now });
        if (accountId) offlineNoticeSentAt.set(accountId, now);
        const content = extraNote ? `${built.content}\n${extraNote}` : built.content;
        await sendConfiguredPush({
            title: built.title,
            content,
            accountId: built.accountId,
            accountName: built.accountName,
            logLabel: '事件通知',
        });
    }

    function scheduleOfflineNotice(payload: EventNotifyPayload): void {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const reason = String(payload.reason || 'unknown');
        // 刚推过这条账号的掉线提醒（可能是终态），晚到的过程态消息不再重复挂起，
        // 否则终态推送之后又来一条 disconnect，会在窗口到期后再喊一次
        const recent = lastOfflinePush.get(accountId);
        if (recent && Date.now() - recent.at < offlineDedupeMs) {
            const ago = Math.round((Date.now() - recent.at) / 1000);
            log('系统', `账号 ${accountName || accountId} ${ago} 秒前已推送掉线提醒，本次断线不再重复判定`, {
                accountId, accountName, reason,
            });
            return;
        }
        // 同账号再次断线：重置计时，但保留最初那条原因，避免抖动刷屏
        const existed = pendingOffline.get(accountId);
        if (existed && existed.timer) clearTimeout(existed.timer);
        const keepPayload = existed ? { ...existed.payload, accountName: accountName || existed.payload.accountName } : payload;
        const timer = setTimeout(() => {
            pendingOffline.delete(accountId);
            if (isRuntimeStopping()) return;
            const waitSec = Math.round(offlineDeferMs / 1000);
            deliverOfflineNotice(keepPayload, `已等待 ${waitSec} 秒自动重登未成功，请检查账号或重新扫码。`).catch(() => null);
        }, offlineDeferMs);
        if (typeof timer.unref === 'function') timer.unref();
        pendingOffline.set(accountId, { timer, payload: keepPayload });
        const waitSec = Math.round(offlineDeferMs / 1000);
        log('系统', `账号 ${accountName || accountId} 连接断开，延后 ${waitSec} 秒判定是否提醒（等待自动重登结果）`, {
            accountId, accountName, reason,
        });
    }

    // 连接已恢复：取消挂起的「已离线」。
    // 若此前确实推送过掉线提醒，再补一条「已恢复」形成闭环——只有真掉过线才通知，
    // 150 秒内的抖动恢复保持静默，不会因为重启或短暂断连打扰。
    function noteAccountRecovered(accountId: string, accountName?: string): void {
        const id = String(accountId || '').trim();
        const sentAt = id ? offlineNoticeSentAt.get(id) : undefined;
        const cleared = clearPendingOffline(accountId, `账号 ${accountName || accountId} 已恢复在线，取消掉线提醒`);
        if (cleared) lastOfflinePush.delete(id);
        if (!sentAt) return;
        offlineNoticeSentAt.delete(id);
        const now = Date.now();
        if (now - sentAt > RECOVER_NOTICE_TTL_MS) return;
        const minutes = Math.max(1, Math.round((now - sentAt) / 60000));
        Promise.resolve(sendConfiguredPush({
            title: '农场已恢复在线',
            content: `账号 ${accountName || id} 掉线约 ${minutes} 分钟后已自动重新登录。`,
            accountId: id,
            accountName,
            logLabel: '恢复通知',
        })).catch(() => null);
    }

    async function triggerEventNotify(payload: EventNotifyPayload = {}): Promise<void> {
        const accountId = String(payload.accountId || '').trim();
        const accountName = String(payload.accountName || '').trim();
        const reason = String(payload.reason || 'unknown');
        try {
            if (isRuntimeStopping()) {
                log('系统', `进程正在退出，跳过掉线提醒: 账号=${accountName || accountId}, 原因=${reason}`, { accountId, accountName, reason });
                return;
            }
            log('系统', `触发事件通知: 账号=${accountName || accountId}, 原因=${reason}`, { accountId, accountName, reason });

            if (isImmediateReason(reason)) {
                // 终态：自动重登已放弃或持续离线超时，此时「需要扫码」的判断才成立
                clearPendingOffline(accountId);
                await deliverOfflineNotice(payload);
                return;
            }

            // 过程态：先挂起，等自动重登结果再决定推不推（延迟判定）
            scheduleOfflineNotice(payload);
        } catch (e: any) {
            log('错误', `事件通知发送异常: ${e.message}`);
        }
    }

    return { getOfflineAutoDeleteMs, triggerEventNotify, sendConfiguredPush, noteAccountRecovered };
}

module.exports = { createEventNotifyService, markRuntimeStopping, resetRuntimeStopping };

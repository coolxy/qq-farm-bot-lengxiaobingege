import type { ActivityWindow, SellConditionContext } from '../config/sell-conditions';

export {};

const { sendMsgAsync, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, logWarn, toNum } = require('../utils/utils');

const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_LOG_INTERVAL_MS = 60 * 1000;

let activityWindows: ReadonlyMap<string, ActivityWindow> = new Map();
let loadedAt = 0;
let pendingRefresh: Promise<ReadonlyMap<string, ActivityWindow>> | null = null;
let lastFailureLogAt = 0;

function decodeActivityWindows(reply: any): ReadonlyMap<string, ActivityWindow> {
    const rows: any[] = Array.isArray(reply?.activity_windows) ? reply.activity_windows : [];
    const metas = decodeActivityMeta(reply);
    const windows = new Map<string, ActivityWindow>();
    for (const row of rows) {
        const id = String(toNum(row?.id) || '').trim();
        if (!id) continue;
        const meta = metas.get(id);
        windows.set(id, {
            id,
            name: String(row?.name || ''),
            beginTime: toNum(row?.begin_time),
            endTime: toNum(row?.end_time),
            ...(meta ? { type: meta.type, groupId: meta.groupId, rules: meta.rules } : {}),
        });
    }
    return windows;
}

/**
 * ActivityListReply.activities 携带每个活动的 ActivityContent（type / group_id / extra），
 * 而 activity_windows 只有时间窗口。活动目录要判断玩法归属、拿到说明文本，就得读前者。
 * 注意 activities 是树（children 嵌套），要递归展开。
 */
function decodeActivityMeta(reply: any): Map<string, { type: number; groupId: string; rules: string[] }> {
    const metas = new Map<string, { type: number; groupId: string; rules: string[] }>();
    const walk = (node: any): void => {
        const head = node?.activity;
        const id = String(toNum(head?.activity_id) || '').trim();
        if (id) {
            metas.set(id, {
                type: toNum(head?.type),
                groupId: String(toNum(head?.group_id) || ''),
                rules: extractActivityRules(head?.extra),
            });
        }
        const children = Array.isArray(node?.children) ? node.children : [];
        for (const child of children) walk(child);
    };
    const roots = Array.isArray(reply?.activities) ? reply.activities : [];
    for (const root of roots) walk(root);
    return metas;
}

/** ActivityContent.extra 是 UTF-8 JSON，活动说明藏在 tips.txt 里，带富文本标签 */
function extractActivityRules(extra: any): string[] {
    try {
        const raw = Buffer.from(extra || []).toString('utf8').trim();
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        const txt = parsed?.tips?.txt;
        if (!Array.isArray(txt)) return [];
        return txt
            .filter((value: any) => typeof value === 'string')
            .map((value: string) => value.replace(/<[^>]+>/g, '').trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function refreshActivityWindows(): Promise<ReadonlyMap<string, ActivityWindow>> {
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
        const body: Uint8Array = types.ActivityListRequest.encode(
            types.ActivityListRequest.create({})
        ).finish();
        const { body: replyBody } = await sendMsgAsync(
            'gamepb.activitypb.ActivityService',
            'List',
            body
        );
        const reply = types.ActivityListReply.decode(replyBody);
        const nextWindows = decodeActivityWindows(reply);
        if (nextWindows.size === 0) {
            throw new Error('活动列表回包未包含时间配置');
        }
        activityWindows = nextWindows;
        loadedAt = Date.now();
        return activityWindows;
    })();
    try {
        return await pendingRefresh;
    } finally {
        pendingRefresh = null;
    }
}

async function getActivityWindows(): Promise<ReadonlyArray<ActivityWindow>> {
    const fresh = loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS;
    if (!fresh) {
        try {
            await refreshActivityWindows();
        } catch (error) {
            if (activityWindows.size === 0) throw error;
        }
    }
    return Array.from(activityWindows.values(), window => ({ ...window }));
}

function invalidateActivityWindows(): void {
    loadedAt = 0;
}

async function getSellConditionContext(): Promise<SellConditionContext> {
    const fresh = loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS;
    if (!fresh) {
        try {
            await refreshActivityWindows();
        } catch (error: any) {
            const now = Date.now();
            if (now - lastFailureLogAt >= RETRY_LOG_INTERVAL_MS) {
                lastFailureLogAt = now;
                logWarn('仓库', `活动时间同步失败: ${error?.message || error}`);
            }
        }
    }
    return {
        nowSec: getServerTimeSec(),
        activityWindows,
        activityWindowsLoaded: loadedAt > 0,
    };
}

networkEvents.on('activitiesChanged', invalidateActivityWindows);
networkEvents.on('disconnected', invalidateActivityWindows);

module.exports = {
    refreshActivityWindows,
    getActivityWindows,
    invalidateActivityWindows,
    getSellConditionContext,
};

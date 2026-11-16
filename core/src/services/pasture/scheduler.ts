export {};
/**
 * 牧场自动调度 - 成熟即收、缺草即补、可喂即喂、每日抚摸与清灾害
 *
 * 接入 unified scheduler 的独立班次（pasture tick），与农场/好友并列。
 * 所有写操作前都重新拉一次 RanchInfo 复核，避免用过期状态乱点。
 */

const { getAutomation, isAutomationOn } = require('../../models/store');
const { getUserState } = require('../../utils/network');
const { toLong, toNum, logWarn, sleep } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { recordOperation } = require('../stats');
const { getFriendsList } = require('../friend');
const api = require('./api');
const {
    analyzeRanch, isGrassLow, BUCKET_ITEM_ID, CANNED_ITEM_ID, CANNED_TO_BUCKET_SECONDS,
} = require('./analysis');

const pastureScheduler = createScheduler('pasture');

let isChecking = false;
let loopRunning = false;
let idleUntil = 0;

// 一轮完全无可做时拉长内部自驱间隔，有实质动作后回到正常间隔。
const IDLE_COOLDOWN_MS = 5 * 60 * 1000;
const TICK_MIN_MS = 30 * 1000;
const TICK_MAX_MS = 45 * 1000;

const FEED_MACHINE_INST_ID = 10002;   // 实测牧草机 inst_id
const GRASS_LOW_THRESHOLD = 3000;     // 牧草低于此值触发牧草机补草
const FRIEND_VISIT_LIMIT = 3;         // 每轮最多访问的好友数
const FRIEND_VISIT_COOLDOWN_MS = 10 * 60 * 1000;
let lastCheckAt = 0;
let lastActions: string[] = [];
let nextFriendVisitAt = 0;
let lastBucketSeconds = 0;

function randomIntervalMs(): number {
    return TICK_MIN_MS + Math.floor(Math.random() * (TICK_MAX_MS - TICK_MIN_MS + 1));
}

function canRun(): boolean {
    const state = getUserState();
    return loopRunning && !!state && !!state.gid && isAutomationOn('pasture');
}

function noteOutcome(didWork: boolean): void {
    idleUntil = didWork ? 0 : Date.now() + IDLE_COOLDOWN_MS;
}

/**
 * 跑一轮牧场自动检查。返回本轮动作描述数组（供手动调用与面板展示）。
 * external=true 时由 unified tick 驱动，跳过内部空闲冷却判断（间隔由外层控制）。
 */
async function checkPasture(options: { external?: boolean } = {}): Promise<{ actions: string[]; hadWork: boolean }> {
    const state = getUserState();
    if (isChecking || !state || !state.gid || !isAutomationOn('pasture')) {
        return { actions: [], hadWork: false };
    }
    if (!options.external && Date.now() < idleUntil) {
        return { actions: [], hadWork: false };
    }
    isChecking = true;
    const actions: string[] = [];
    lastActions = [];

    // 单个动作失败不应该让后续动作全部停摆（例如金币不足、好友离线）。
    const safeStep = async (label: string, fn: () => Promise<any>): Promise<any> => {
        try {
            return await fn();
        } catch (e: any) {
            logWarn('牧场', `${label}失败: ${e && e.message ? e.message : e}`, { module: 'pasture' });
            return null;
        }
    };

    try {
        const auto = getAutomation();
        const detail = await api.getRanchDetail(state.gid);
        let ranch = detail && detail.ranch;
        if (!ranch) {
            noteOutcome(false);
            return { actions, hadWork: false };
        }

        let hazardRemaining = 0;
        if (auto.pasture_hazard) {
            const quotas = (await safeStep('读取操作配额', () => api.getRanchOpTimes())) || [];
            const hazardQuota = quotas.find((q: any) => toNum(q.op_id) === 11003);
            hazardRemaining = hazardQuota ? toNum(hazardQuota.remaining_times) : 0;
        }
        // feed_type=1 消耗「有机罐头容器」余额（item 7004，单位秒）；
        // feed_type=2 消耗牧场牧草，实测可用，优先用免费资源。
        lastBucketSeconds = (await safeStep('读取罐头桶余额', () => api.getBagItemCount(BUCKET_ITEM_ID))) || 0;

        // 0. 空栏自动补幼崽（买满到容量上限，单轮最多 3 只，价格从幼崽商店实包读取）
        if (auto.pasture_buy_cub) {
            const beforeBuy = analyzeRanch(ranch, Date.now());
            const vacancy = beforeBuy.capacity - beforeBuy.animalCount;
            if (vacancy > 0) {
                const shop = await safeStep('读取幼崽商店', () => api.getCubShopGoods());
                const cub = shop && shop.cub;
                if (cub && toNum(cub.price) > 0) {
                    const stock = toNum(cub.limit) > 0
                        ? Math.max(0, toNum(cub.limit) - toNum(cub.bought))
                        : vacancy;
                    const num = Math.min(vacancy, stock, 3);
                    if (num > 0) {
                        const bought = await safeStep('购买幼崽', () => api.buyCub(toNum(cub.goodsId), num, toNum(cub.price)));
                        if (bought) {
                            actions.push(`购买幼崽 ×${num}（${toNum(cub.price)} 金/只）`);
                            recordOperation('牧场买幼崽', num);
                            await sleep(500);
                        }
                    }
                }
            }
        }

        // 1. 成熟即收（回包直接带最新 RanchInfo，用回包更新本地引用）
        if (auto.pasture_harvest) {
            await safeStep('收获产物', async () => {
                const before = analyzeRanch(ranch, Date.now());
                if (before.harvestable.length > 0) {
                    const res = await api.harvestRanch(toNum(ranch.ranch_inst_id), 1);
                    if (res && res.ranch) {
                        ranch = res.ranch;
                        actions.push(`收获 ${before.harvestable.length} 只动物的产物`);
                        recordOperation('牧场收获', before.harvestable.length);
                        await sleep(400);
                    }
                }
            });
        }

        // 2. 一键催产（空请求）→ 若又成熟则再收一次；回包带最新状态
        if (auto.pasture_harvest) {
            await safeStep('一键催产', async () => {
                const res = await api.triggerProduce();
                if (res && res.ranch) {
                    ranch = res.ranch;
                    const after = analyzeRanch(ranch, Date.now());
                    if (after.harvestable.length > 0) {
                        const harvested = await api.harvestRanch(toNum(ranch.ranch_inst_id), 1);
                        if (harvested && harvested.ranch) {
                            ranch = harvested.ranch;
                            actions.push(`催产后收获 ${after.harvestable.length} 只`);
                            recordOperation('牧场收获', after.harvestable.length);
                            await sleep(400);
                        }
                    }
                }
            });
        }

        // 3. 缺草即补：先加免费牧草机，仍低则把背包里的罐头换成牧草。
        if (auto.pasture_grass && isGrassLow(ranch, GRASS_LOW_THRESHOLD, Date.now())) {
            await safeStep('牧草机加草', async () => {
                const machine = await api.getFacilityDetail(FEED_MACHINE_INST_ID);
                if (machine && toNum(machine.grass && machine.grass.amount) > 0) {
                    const grass = await api.addFeed(FEED_MACHINE_INST_ID, 1);
                    if (grass) {
                        actions.push('牧草机加草 ×1');
                        recordOperation('牧场加草', 1);
                        if (ranch.grass) ranch.grass.amount = toLong(toNum(grass.amount));
                        await sleep(400);
                    }
                }
            });
        }

        // 4. 可喂即喂（每轮只喂一只）：优先罐头桶，其次牧草，最后才消耗罐头道具补桶。
        if (auto.pasture_feed) {
            await safeStep('喂养动物', async () => {
                const feedState = analyzeRanch(ranch, Date.now());
                if (feedState.feedable.length === 0) return;
                let feedType = 2;
                if (lastBucketSeconds > 0) {
                    feedType = 1;
                }
                else if (feedState.grass <= 0) {
                    // 两种免费口粮都没有，才把背包罐头转成有机罐头桶时长。
                    const cans = (await api.getBagItemCount(CANNED_ITEM_ID)) || 0;
                    if (cans <= 0) return;
                    const used = Math.min(cans, Math.max(1, Math.ceil(3600 / CANNED_TO_BUCKET_SECONDS)));
                    const exchanged = await api.batchUse(CANNED_ITEM_ID, used);
                    const gained = toNum(exchanged && exchanged.gained && exchanged.gained.count);
                    if (gained <= 0) return;
                    lastBucketSeconds += gained;
                    actions.push(`补充罐头桶 ${gained} 秒（${used} 个罐头）`);
                    recordOperation('牧场补充罐头', used);
                    feedType = 1;
                    await sleep(400);
                }
                const target = feedState.feedable[0];
                const updated = await api.feedAnimal(toNum(ranch.ranch_inst_id), feedType);
                if (updated) {
                    ranch = updated;
                    actions.push(`喂养栏位 ${target.slot_index}（${feedType === 1 ? '罐头桶' : '牧草'}）`);
                    recordOperation('牧场喂养', 1);
                    await sleep(500);
                }
            });
        }

        // 5. 清灾害（有配额时尝试一次；服务端无灾害时回包 result≠1，静默跳过）
        if (auto.pasture_hazard && hazardRemaining > 0) {
            await safeStep('清理灾害', async () => {
                const res = await api.putHazard(toNum(ranch.ranch_inst_id), toNum(state.gid), 11003);
                if (res && toNum(res.result) === 1) {
                    hazardRemaining -= 1;
                    actions.push(`清理灾害，剩余 ${hazardRemaining} 次`);
                    recordOperation('牧场清灾害', 1);
                    await sleep(400);
                }
            });
        }

        // 6. 每日抚摸（有 strokable 的动物，每轮一只）
        if (auto.pasture_stroke) {
            await safeStep('每日抚摸', async () => {
                const strokeState = analyzeRanch(ranch, Date.now());
                if (strokeState.strokable.length > 0) {
                    const target = strokeState.strokable[0];
                    const updated = await api.strokeAnimal(
                        toNum(state.gid), toNum(ranch.ranch_inst_id), toNum(target.animal_inst_id));
                    if (updated) {
                        ranch = updated;
                        actions.push(`抚摸栏位 ${target.slot_index}`);
                        recordOperation('牧场抚摸', 1);
                    }
                }
            });
        }

        // 7. 访问好友家园并互动（10 分钟一轮，最多 3 位，进/出成对）
        if (auto.pasture_friend_visit && Date.now() >= nextFriendVisitAt) {
            nextFriendVisitAt = Date.now() + FRIEND_VISIT_COOLDOWN_MS;
            const friends = (await safeStep('读取好友列表', () => getFriendsList(false, 'low'))) || [];
            const candidates = friends
                .filter((f: any) => toNum(f.gid) > 0 && toNum(f.gid) !== toNum(state.gid))
                .slice(0, FRIEND_VISIT_LIMIT);
            for (const friend of candidates) {
                const friendGid = toNum(friend.gid);
                const friendName = String(friend.name || friend.nick || friendGid);
                let entered = false;
                try {
                    await api.enterHomestead(friendGid, 2);
                    entered = true;
                    const friendDetail = await api.getRanchDetail(friendGid);
                    const friendRanch = friendDetail && friendDetail.ranch;
                    if (!friendRanch) continue;
                    const friendState = analyzeRanch(friendRanch, Date.now());
                    if (auto.pasture_stroke && friendState.strokable.length > 0) {
                        const target = friendState.strokable[0];
                        await api.strokeAnimal(friendGid, toNum(friendRanch.ranch_inst_id), toNum(target.animal_inst_id));
                        actions.push(`抚摸 ${friendName} 的牧场动物`);
                        recordOperation('牧场好友互动', 1);
                    }
                    if (auto.pasture_hazard && hazardRemaining > 0) {
                        const res = await api.putHazard(toNum(friendRanch.ranch_inst_id), toNum(state.gid), 11003);
                        if (res && toNum(res.result) === 1) {
                            hazardRemaining -= 1;
                            actions.push(`清理 ${friendName} 牧场灾害`);
                            recordOperation('牧场清灾害', 1);
                        }
                    }
                } catch (e: any) {
                    logWarn('牧场', `访问好友 ${friendGid} 失败: ${e && e.message ? e.message : e}`, { module: 'pasture' });
                } finally {
                    if (entered) {
                        try { await api.leaveHomestead(friendGid); } catch { /* 离开失败忽略 */ }
                    }
                }
            }
        }

        lastCheckAt = Date.now();
        lastActions = [...actions];
        noteOutcome(actions.length > 0);
        return { actions, hadWork: actions.length > 0 };
    } catch (e: any) {
        logWarn('牧场', `自动检查失败: ${e && e.message ? e.message : e}`, { module: 'pasture' });
        lastCheckAt = Date.now();
        lastActions = [...actions];
        noteOutcome(false);
        return { actions, hadWork: false };
    } finally {
        isChecking = false;
    }
}

function scheduleNext(delayMs?: number): void {
    if (!loopRunning) return;
    pastureScheduler.clear('pasture_tick');
    pastureScheduler.setTimeoutTask('pasture_tick', delayMs ?? randomIntervalMs(), async () => {
        if (canRun()) {
            await runExclusiveAutomationTask('pasture_tick', () => checkPasture({ external: true }));
        }
        scheduleNext();
    });
}

function startPastureLoop(options: { externalScheduler?: boolean } = {}): void {
    if (loopRunning) return;
    loopRunning = true;
    idleUntil = 0;
    if (!options.externalScheduler) scheduleNext(3000);
}

function stopPastureLoop(): void {
    loopRunning = false;
    pastureScheduler.clearAll();
    idleUntil = 0;
}

function refreshPastureLoop(delayMs: number = 500): void {
    if (!loopRunning) return;
    idleUntil = 0;
    scheduleNext(delayMs);
}

module.exports = {
    checkPasture,
    startPastureLoop,
    stopPastureLoop,
    refreshPastureLoop,
    analyzeRanch,
    isChecking: () => isChecking,
    getLastState: () => ({ lastCheckAt, lastActions: [...lastActions], lastBucketSeconds }),
};

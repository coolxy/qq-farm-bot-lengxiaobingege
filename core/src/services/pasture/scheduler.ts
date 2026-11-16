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
const api = require('./api');
const { analyzeRanch, isGrassLow } = require('./analysis');

const pastureScheduler = createScheduler('pasture');

let isChecking = false;
let loopRunning = false;
let idleUntil = 0;

// 一轮完全无可做时拉长内部自驱间隔，有实质动作后回到正常间隔。
const IDLE_COOLDOWN_MS = 5 * 60 * 1000;
const TICK_MIN_MS = 30 * 1000;
const TICK_MAX_MS = 45 * 1000;

const FEED_MACHINE_INST_ID = 10002;   // 实测牧草机 inst_id
const GRASS_LOW_THRESHOLD = 3000;     // 牧草低于此值触发补草

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

    try {
        const auto = getAutomation();
        const detail = await api.getRanchDetail(state.gid);
        let ranch = detail && detail.ranch;
        if (!ranch) {
            noteOutcome(false);
            return { actions, hadWork: false };
        }

        // 1. 成熟即收（回包直接带最新 RanchInfo，用回包更新本地引用）
        if (auto.pasture_harvest) {
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
        }

        // 2. 一键催产（空请求）→ 若又成熟则再收一次；回包带最新状态
        if (auto.pasture_harvest) {
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
        }

        // 3. 缺草即补：牧草机加草（免费）。单次增量实测不确定，每轮加一次，下轮复查。
        if (auto.pasture_grass && isGrassLow(ranch, GRASS_LOW_THRESHOLD, Date.now())) {
            const machine = await api.getFacilityDetail(FEED_MACHINE_INST_ID);
            if (machine && toNum(machine.grass && machine.grass.amount) > 0) {
                const grass = await api.addFeed(FEED_MACHINE_INST_ID, 1);
                if (grass) {
                    actions.push('牧草机加草 ×1');
                    recordOperation('牧场加草', 1);
                    if (ranch.grass) ranch.grass.amount = grass.amount != null ? grass.amount : toLong(toNum(grass.amount));
                    await sleep(400);
                }
            }
        }

        // 4. 可喂即喂（每轮只喂一只，避免请求风暴；牧草为 0 时跳过）
        if (auto.pasture_feed) {
            const feedState = analyzeRanch(ranch, Date.now());
            if (feedState.grass > 0 && feedState.feedable.length > 0) {
                const target = feedState.feedable[0];
                const updated = await api.feedAnimal(toNum(ranch.ranch_inst_id), 1);
                if (updated) {
                    ranch = updated;
                    actions.push(`喂养栏位 ${target.slot_index}`);
                    recordOperation('牧场喂养', 1);
                    await sleep(500);
                }
            }
        }

        // 5. 清灾害（有配额时尝试一次；服务端无灾害时回包 result≠1，静默跳过）
        if (auto.pasture_hazard) {
            const quotas = await api.getRanchOpTimes();
            const hazardQuota = (quotas || []).find((q: any) => toNum(q.op_id) === 11003);
            if (hazardQuota && toNum(hazardQuota.remaining_times) > 0) {
                const res = await api.putHazard(toNum(ranch.ranch_inst_id), toNum(state.gid), 11003);
                if (res && toNum(res.result) === 1) {
                    actions.push(`清理灾害，剩余 ${toNum(res.remaining)} 次`);
                    recordOperation('牧场清灾害', 1);
                    await sleep(400);
                }
            }
        }

        // 6. 每日抚摸（有 strokable 的动物，每轮一只）
        if (auto.pasture_stroke) {
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
        }

        noteOutcome(actions.length > 0);
        return { actions, hadWork: actions.length > 0 };
    } catch (e: any) {
        logWarn('牧场', `自动检查失败: ${e && e.message ? e.message : e}`);
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
};

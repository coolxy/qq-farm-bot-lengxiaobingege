export {};
/**
 * 牧场模块 barrel - 对外统一入口
 */

const api = require('./api');
const analysis = require('./analysis');
const scheduler = require('./scheduler');

/** 给前端的完整牧场快照：详情 + 分析结果 + 配额 + 牧草机 */
async function getPastureSnapshot(): Promise<any> {
    const detail = await api.getRanchDetail();
    const ranch = detail && detail.ranch;
    let quotas: any[] = [];
    let facility: any = null;
    try {
        quotas = await api.getRanchOpTimes();
    } catch { /* 配额接口失败不影响主快照 */ }
    try {
        facility = await api.getFacilityDetail(10002);
    } catch { /* 牧草机详情失败不影响主快照 */ }

    const analyzed = ranch ? analysis.analyzeRanch(ranch, Date.now()) : {
        animals: [], harvestable: [], feedable: [], strokable: [],
        grass: 0, grassEmptyAt: 0, capacity: 0, animalCount: 0,
    };

    return {
        ownerGid: detail && detail.ownerGid,
        ranchInstId: ranch ? Number(ranch.ranch_inst_id) : 0,
        capacity: analyzed.capacity,
        animalCount: analyzed.animalCount,
        grass: analyzed.grass,
        grassEmptyAt: analyzed.grassEmptyAt,
        animals: analyzed.animals,
        quotas: (quotas || []).map((q: any) => ({
            opId: Number(q.op_id),
            limit: Number(q.times_limit),
            used: Number(q.used_times),
            remaining: Number(q.remaining_times),
        })),
        facility: facility ? {
            instId: Number(facility.inst_id),
            name: facility.name,
            level: Number(facility.level),
            grass: Number(facility.grass && facility.grass.amount),
        } : null,
        constants: {
            cannedItemId: analysis.CANNED_ITEM_ID,
            grassPerCan: analysis.CANNED_TO_GRASS,
        },
        serverTime: Date.now(),
    };
}

/** 手动执行单个牧场操作（面板按钮用） */
async function operatePasture(action: string, input: any = {}): Promise<any> {
    switch (action) {
        case 'refresh':
            return getPastureSnapshot();
        case 'harvest': {
            const res = await api.harvestRanch(input.ranchInstId, 1);
            return { ok: true, ranch: res && res.ranch };
        }
        case 'triggerProduce': {
            const res = await api.triggerProduce();
            return { ok: true, ranch: res && res.ranch };
        }
        case 'feed': {
            const ranch = await api.feedAnimal(input.ranchInstId, 1);
            return { ok: true, ranch };
        }
        case 'addFeed': {
            const grass = await api.addFeed(input.instId || 10002, input.count || 1);
            return { ok: true, grass };
        }
        case 'stroke': {
            const ranch = await api.strokeAnimal(input.ownerGid, input.ranchInstId, input.animalInstId);
            return { ok: true, ranch };
        }
        case 'putHazard': {
            const res = await api.putHazard(input.ranchInstId, input.ownerGid, input.opId || 11003);
            return { ok: true, result: res };
        }
        case 'buyCub': {
            const res = await api.buyCub(input.goodsId, input.num || 1, input.price);
            return { ok: true, result: res };
        }
        case 'enterHomestead': {
            const res = await api.enterHomestead(input.hostGid, input.reason || 2);
            return { ok: true, basic: res && res.basic };
        }
        case 'leaveHomestead':
            await api.leaveHomestead(input.hostGid);
            return { ok: true };
        default:
            throw new Error(`未知牧场操作: ${action}`);
    }
}

module.exports = {
    getPastureSnapshot,
    operatePasture,
    checkPasture: scheduler.checkPasture,
    startPastureLoop: scheduler.startPastureLoop,
    stopPastureLoop: scheduler.stopPastureLoop,
    refreshPastureLoop: scheduler.refreshPastureLoop,
    analyzeRanch: analysis.analyzeRanch,
    // 暴露 api 供测试与高级调用
    api,
};

export {};
/**
 * 牧场模块 barrel - 对外统一入口
 */

const api = require('./api');
const analysis = require('./analysis');
const scheduler = require('./scheduler');
const { getUserState } = require('../../utils/network');

/** 给前端的完整牧场快照：详情 + 分析结果 + 配额 + 牧草机 + 商店/背包 */
async function getPastureSnapshot(): Promise<any> {
    const detail = await api.getRanchDetail();
    const ranch = detail && detail.ranch;
    let quotas: any[] = [];
    let facility: any = null;
    let cubShop: any = null;
    let cannedCount = 0;
    let bucketSeconds = 0;
    try {
        quotas = await api.getRanchOpTimes();
    } catch { /* 配额接口失败不影响主快照 */ }
    try {
        facility = await api.getFacilityDetail(10002);
    } catch { /* 牧草机详情失败不影响主快照 */ }
    try {
        cubShop = await api.getCubShopGoods();
    } catch { /* 幼崽商店失败不影响主快照 */ }
    try {
        cannedCount = await api.getBagItemCount(analysis.CANNED_ITEM_ID);
        bucketSeconds = await api.getBagItemCount(analysis.BUCKET_ITEM_ID);
    } catch { /* 背包失败不影响主快照 */ }

    const analyzed = ranch ? analysis.analyzeRanch(ranch, Date.now()) : {
        animals: [], harvestable: [], feedable: [], strokable: [],
        grass: 0, grassEmptyAt: 0, capacity: 0, animalCount: 0,
    };
    const lastState = scheduler.getLastState();

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
        cubShop: cubShop ? {
            shopId: cubShop.shopId,
            shopName: cubShop.shopName,
            cub: cubShop.cub,
        } : null,
        cannedCount,
        bucketSeconds,
        lastCheckAt: lastState.lastCheckAt,
        lastActions: lastState.lastActions,
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
        case 'check': {
            const result = await scheduler.checkPasture({ external: true });
            return { ok: true, ...result };
        }
        case 'shopInfo': {
            const shop = await api.getShopInfo(Number(input.shopId) || 6);
            return {
                ok: true,
                goods: ((shop && shop.goods_list) || []).map((g: any) => ({
                    goodsId: Number(g.id),
                    itemId: Number(g.item_id),
                    itemCount: Number(g.item_count),
                    price: Number(g.price),
                    unlocked: !!g.unlocked,
                })),
            };
        }
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
            const num = Math.max(1, Number(input.num) || 1);
            let goodsId = Number(input.goodsId) || 0;
            let price = Number(input.price) || 0;
            if (!goodsId || !price) {
                const shop = await api.getCubShopGoods();
                if (!goodsId) goodsId = Number(shop && shop.cub && shop.cub.goodsId) || 0;
                if (!price) price = Number(shop && shop.cub && shop.cub.price) || 0;
            }
            if (!goodsId || !price) throw new Error('无法获取幼崽商品与价格');
            const res = await api.buyCub(goodsId, num, price);
            return { ok: true, goodsId, price, num, result: res };
        }
        case 'refillBucket':
        case 'exchangeGrass': {
            const count = Math.max(1, Number(input.count) || 1);
            const res = await api.batchUse(analysis.CANNED_ITEM_ID, count);
            return {
                ok: true,
                used: res && res.used ? { itemId: Number(res.used.item_id), count: Number(res.used.count) } : null,
                gained: res && res.gained ? { itemId: Number(res.gained.item_id), count: Number(res.gained.count) } : null,
                message: `罐头桶增加 ${Math.max(1, Number(input.count) || 1) * analysis.CANNED_TO_BUCKET_SECONDS} 秒`,
            };
        }
        case 'visitFriend': {
            const hostGid = Number(input.hostGid) || 0;
            if (!hostGid) throw new Error('缺少好友 GID');
            let entered = false;
            try {
                await api.enterHomestead(hostGid, Number(input.reason) || 2);
                entered = true;
                const detail = await api.getRanchDetail(hostGid);
                const friendRanch = detail && detail.ranch;
                const detailView = friendRanch ? analysis.analyzeRanch(friendRanch, Date.now()) : null;
                const interaction: string[] = [];
                if (input.interact && friendRanch) {
                    if (input.stroke && detailView && detailView.strokable.length > 0) {
                        const target = detailView.strokable[0];
                        await api.strokeAnimal(hostGid, Number(friendRanch.ranch_inst_id), Number(target.animal_inst_id));
                        interaction.push('抚摸动物');
                    }
                    if (input.clearHazard) {
                        const selfGid = Number((getUserState() || {}).gid) || Number(detail.ownerGid);
                        const res = await api.putHazard(Number(friendRanch.ranch_inst_id), selfGid, 11003);
                        if (res && Number(res.result) === 1) interaction.push('清理灾害');
                    }
                }
                return {
                    ok: true,
                    hostGid,
                    ranchInstId: friendRanch ? Number(friendRanch.ranch_inst_id) : 0,
                    animals: detailView ? detailView.animals : [],
                    grass: detailView ? detailView.grass : 0,
                    interaction,
                };
            } finally {
                if (entered && input.leave !== false) {
                    try { await api.leaveHomestead(hostGid); } catch { /* 离开失败忽略 */ }
                }
            }
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

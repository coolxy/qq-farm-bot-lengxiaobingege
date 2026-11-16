export {};
/**
 * 牧场模块 barrel - 对外统一入口
 */

const api = require('./api');
const analysis = require('./analysis');
const scheduler = require('./scheduler');
const { getUserState } = require('../../utils/network');

/**
 * 把服务端业务码翻成人话。
 * 牧场这些码都是正常业务态（不是故障），直接抛给前端只会显示成一串「gamepb... code=1045211」。
 */
const PASTURE_ERROR_TEXT: Record<number, string> = {
    1045211: '当前没有可收取的产物',
    1045232: '当前没有可以生产的动物',
    1045233: '牧场没有需要清理的蚊子或便便',
    1045234: '罐头皮已用完，需要补充有机罐头',
    1045136: '牧草机已经满了',
    1045226: '该动物已经用过无机罐头桶（一生只能用一次）',
    1000020: '目标不存在或当前不可操作',
};

function readablePastureError(message: string): string {
    const matched = message.match(/\b(1045\d{3}|104\d{4}|1000020)\b/);
    if (matched) {
        const text = PASTURE_ERROR_TEXT[Number(matched[1])];
        if (text) return text;
    }
    return message;
}

/** 给前端的完整牧场快照：详情 + 分析结果 + 配额 + 牧草机 + 商店/背包 */
async function getPastureSnapshot(): Promise<any> {
    const detail = await api.getRanchDetail();
    const ranch = detail && detail.ranch;
    let quotas: any[] = [];
    let facility: any = null;
    let nest: any = null;
    let cubShop: any = null;
    let cannedCount = 0;
    let bucketSeconds = 0;
    let ranchLevel: any = null;
    let mallGoods: any[] = [];
    try {
        quotas = await api.getRanchOpTimes();
    } catch { /* 配额接口失败不影响主快照 */ }
    try {
        facility = await api.getFacilityDetail(10002);
    } catch { /* 牧草机详情失败不影响主快照 */ }
    try {
        nest = await api.getFacilityDetail(10001);
    } catch { /* 窝详情失败不影响主快照 */ }
    try {
        cubShop = await api.getCubShopGoods();
    } catch { /* 幼崽商店失败不影响主快照 */ }
    try {
        cannedCount = await api.getBagItemCount(analysis.CANNED_ITEM_ID);
        bucketSeconds = await api.getBagItemCount(analysis.BUCKET_ITEM_ID);
    } catch { /* 背包失败不影响主快照 */ }
    try {
        ranchLevel = await api.getRanchLevelConfig();
    } catch { /* 牧场等级配置失败不影响主快照 */ }
    try {
        mallGoods = await api.getMallSupplyGoods();
    } catch { /* 商城补给失败不影响主快照 */ }

    const analyzed = ranch ? analysis.analyzeRanch(ranch, Date.now()) : {
        animals: [], harvestable: [], feedable: [], organicFeedable: [], normalFeedable: [], strokable: [],
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
        // 设施 DTO：等级取 config_id_2 尾号（实测 牧草机 7001001→Lv1、窝 6001002→Lv2，
        // 与游戏内一致；f5 不是等级，勿用）。
        // store={item 1007, num} 疑似升级花费；unknown_14 窝实测=4（=牧场格数），牧草机=100（=当前草量）。
        facility: facility ? {
            instId: Number(facility.inst_id),
            name: facility.name,
            level: Number(facility.config_id_2) % 1000,
            grass: Number(facility.grass && facility.grass.amount),
            capacity: Number(facility.unknown_14) || Number(facility.grass && facility.grass.amount) || 100,
        } : null,
        nest: nest ? {
            instId: Number(nest.inst_id),
            name: nest.name,
            level: Number(nest.config_id_2) % 1000,
            slots: Number(nest.unknown_14) || 0,
        } : null,
        ranchLevel: {
            current: api.getSelfRanchLevel(),
            levels: ranchLevel ? ((ranchLevel.levels) || []).map((lv: any) => ({
                level: Number(lv.level),
                requiredScore: Number(lv.required_score),
            })) : [],
        },
        cubShop: cubShop ? {
            shopId: cubShop.shopId,
            shopName: cubShop.shopName,
            cub: cubShop.cub,
        } : null,
        // 商城「牧场补给」商品（slot_type=6, scene=2），罐头在这里购买。
        // reward_items/price 是 corepb.Item（f1=id, f2=count），protobufjs 可能按 bytes 返回，需兼容两种形态。
        mallGoods: (mallGoods || []).map((g: any) => {
            const parseItem = (v: any): { id: number; count: number } => {
                if (!v) return { id: 0, count: 0 };
                if (typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)) {
                    return { id: Number(v.id ?? v.item_id) || 0, count: Number(v.count) || 0 };
                }
                // bytes: 逐字段读 varint（f1=id, f2=count）
                const buf: Buffer = Buffer.isBuffer(v) ? v : Buffer.from(v || []);
                let idx = 0, id = 0, count = 0;
                while (idx < buf.length) {
                    const key = buf[idx++]; const field = key >> 3; const wire = key & 0x07;
                    if (wire !== 0) break;
                    let val = 0, shift = 0;
                    while (idx < buf.length) { const b = buf[idx++]; val |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
                    if (field === 1) id = val; else if (field === 2) count = val;
                }
                return { id, count };
            };
            const rewards = Array.isArray(g.reward_items) ? g.reward_items : [];
            const reward = parseItem(rewards[0]);
            const price = parseItem(g.price);
            const limit = g.purchase_limit || {};
            return {
                goodsId: Number(g.goods_id),
                name: g.name,
                rewardItemId: reward.id,
                rewardCount: reward.count,
                priceCurrency: price.id,
                price: price.count,
                isFree: !!g.is_free,
                available: g.is_available !== false,
                bought: Number(limit.bought_count) || 0,
                limit: Number(limit.limit_count) || 0,
                discountText: g.discount_text || '',
            };
        }),
        cannedCount,
        bucketSeconds,
        // 牧草上限实测 100（RanchInfo.f5.amount 与牧草机 f14 一致），前端按容量显示进度。
        grassCapacity: (facility && Number(facility.unknown_14)) || Math.max(100, analyzed.grass),
        lastCheckAt: lastState.lastCheckAt,
        lastActions: lastState.lastActions,
        // 本轮“为什么没动作”的原因，例如罐头桶耗尽、牧草机已满、没有可收产物。
        notes: lastState.lastNotes,
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
            // 真实客户端（2026-11-16 抓包）永远是 TriggerProduce → HarvestRanch 成对出现：
            // 催产把动物产出结算到货架，收获再把货架收进背包。只发收获必回 1045211「没有可收取的产物」。
            const notes: string[] = [];
            let ranch: any = null;
            let shelves: any[] = [];
            let produced = 0;
            try {
                const tp = await api.triggerProduce();
                if (tp && tp.ranch) ranch = tp.ranch;
                if (tp && Array.isArray(tp.shelves)) {
                    shelves = tp.shelves;
                    produced = tp.shelves.length;
                    notes.push(`催产出 ${produced} 批产物`);
                }
            } catch (e: any) {
                const message = String(e && e.message ? e.message : e);
                // 1045232 = 当前没有可以生产的动物，属正常业务态。
                if (!/1045232|没有可以生产/.test(message)) notes.push(`催产失败：${readablePastureError(message)}`);
            }
            try {
                const res = await api.harvestRanch(input.ranchInstId, 1);
                if (res && res.ranch) ranch = res.ranch;
                if (res && Array.isArray(res.shelves)) shelves = res.shelves;
                if (shelves.length > 0) notes.push(`收获 ${shelves.length} 批产物`);
                return {
                    ok: true, ranch, shelves,
                    message: shelves.length > 0 ? `收获 ${shelves.length} 批产物` : '收获完成',
                    notes,
                };
            } catch (e: any) {
                const message = String(e && e.message ? e.message : e);
                if (/1045211/.test(message)) {
                    return {
                        ok: true, ranch, shelves,
                        message: '当前没有可收取的产物：动物要先喂食并积累产出，货架才有东西可收',
                        notes,
                    };
                }
                throw new Error(readablePastureError(message));
            }
        }
        case 'cleanAll': {
            const ranch = await api.cleanAllRanch();
            return { ok: true, ranch };
        }
        case 'rotationShopInfo': {
            const info = await api.getRotationShopInfo(Number(input.shopId) || 7);
            return {
                ok: true,
                rotationDaySec: info ? Number(info.rotation_day_sec) : 0,
                categories: ((info && info.categories) || []).map((c: any) => ({
                    id: Number(c.id), name: c.name,
                })),
                goods: ((info && info.goods) || []).map((g: any) => ({
                    goodsId: Number(g.goods_id),
                    itemId: Number(g.item_id),
                    price: Number(g.price),
                    categoryId: Number(g.category_id),
                    subType: Number(g.sub_type),
                })),
            };
        }
        case 'rotationBuy': {
            const res = await api.rotationBuyGoods(
                Number(input.goodsId) || 0, Number(input.num) || 1, Number(input.rotationDaySec) || 0);
            return { ok: true, result: res };
        }
        case 'triggerProduce': {
            const res = await api.triggerProduce();
            return { ok: true, ranch: res && res.ranch };
        }
        case 'feed': {
            const feedType = Number(input.feedType) || 1;
            try {
                const ranch = await api.feedAnimal(input.ranchInstId, feedType);
                return { ok: true, feedType, ranch };
            } catch (e: any) {
                const message = String(e && e.message ? e.message : e);
                // 1000020「请求参数错误」在喂养接口上实际含义是「当前这只动物不可喂」：
                // 抓包请求体 0a0308914e1001 与本项目编码字节完全一致，协议没问题，是游戏状态不允许。
                if (/1000020/.test(message)) {
                    throw new Error('当前没有可喂养的动物（可能刚喂过、还在罐头生效期，或罐头桶已空）');
                }
                throw new Error(readablePastureError(message));
            }
        }
        case 'addFeed': {
            const grass = await api.addFeed(input.instId || 10002, input.count || 1);
            return { ok: true, grass };
        }
        case 'stroke': {
            try {
                const ranch = await api.strokeAnimal(input.ownerGid, input.ranchInstId, input.animalInstId);
                return { ok: true, ranch };
            } catch (e: any) {
                const message = String(e && e.message ? e.message : e);
                // 服务端拒绝（1000020/1045207）：抓包里抚摸全部发生在好友家园，自己的动物通常不可抚摸。
                if (/1000020|1045207/.test(message)) throw new Error('该动物当前不可抚摸（服务端拒绝，抚摸一般在好友牧场里进行）');
                throw e;
            }
        }
        case 'putHazard': {
            // 没有灾害时 PutHazard 会回 1000020「请求参数错误」（线上实测），
            // 一键清理接口 CleanAllRanch 的语义等价且能直接得到「没有需要清理的」业务提示。
            const ranch = await api.cleanAllRanch();
            return { ok: true, ranch };
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
        case 'buyMallGoods': {
            // 从商城「牧场补给」购买罐头等道具，goodsId 来自快照 mallGoods
            const goodsId = Number(input.goodsId) || 0;
            const count = Math.max(1, Number(input.num || input.count) || 1);
            if (!goodsId) throw new Error('缺少商城商品 ID');
            const res = await api.purchaseMallGoods(goodsId, count);
            return { ok: true, goodsId, count, result: res };
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
                if (!friendRanch) throw new Error('未能读取到好友牧场数据：对方可能没有开通家园，或进入家园场景失败');
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
        case 'buildingList':
            return { ok: true, reply: await api.getBuildingList() };
        case 'facility':
            return { ok: true, facility: await api.getFacilityDetail(input.instId || 10002) };
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

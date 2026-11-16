export {};
/**
 * 牧场低级 API - protobuf 请求封装（2026-11-16 微信端实包抓取）
 *
 * 服务/方法/字段全部来自真实抓包，proto 定义见 animalpb.proto /
 * homesteadpb.proto / shoppb.proto / visitpb.proto。
 * 本项目只负责发与客户端相同的 GateMessage，发 RanchInfo 回包即最新全量状态，
 * 操作完无需再拉一次详情。
 */

const { sendMsgAsync, getUserState } = require('../../utils/network');
const { types, ensureProtoLoaded } = require('../../utils/proto');
const { toLong, toNum } = require('../../utils/utils');

const ANIMAL_SERVICE = 'gamepb.animalpb.AnimalService';
const RANCH_SERVICE = 'gamepb.animalpb.RanchService';
const HOMESTEAD_SERVICE = 'gamepb.homesteadpb.HomesteadService';
const FEED_MACHINE_SERVICE = 'gamepb.homesteadpb.FeedMachineService';
const SHOP_SERVICE = 'gamepb.shoppb.ShopService';
const ITEM_SERVICE = 'gamepb.itempb.ItemService';
const VISIT_SERVICE = 'gamepb.visitpb.VisitService';

function needType(name: string): any {
    const t = types && types[name];
    if (!t || !t.encode) throw new Error(`protobuf 类型 ${name} 未加载`);
    return t;
}

async function call(Req: any, req: any, service: string, method: string, Reply?: any): Promise<any> {
    await ensureProtoLoaded();
    const RequestType = typeof Req === 'string' ? needType(Req) : Req;
    const ReplyType = Reply ? (typeof Reply === 'string' ? needType(Reply) : Reply) : null;
    const body = RequestType.encode(RequestType.create(req || {})).finish();
    const { body: replyBody } = await sendMsgAsync(service, method, Buffer.from(body));
    return ReplyType ? ReplyType.decode(replyBody) : { ok: true };
}

/** 拉牧场详情（ranch + animals + grass）。这是自动化的数据源。 */
async function getRanchDetail(gid?: number | string): Promise<any> {
    const state = getUserState();
    const selfGid = toNum(gid || (state && state.gid) || 0);
    const reply = await call('GetRanchDetailRequest', { unknown_2: Buffer.alloc(0) },
        ANIMAL_SERVICE, 'GetRanchDetail', 'GetRanchDetailReply');
    const ranch = reply && reply.ranch;
    if (!ranch) return { ranch: null, ownerGid: selfGid };
    return { ranch, ownerGid: selfGid };
}

/** 操作配额表（op_id → 上限/已用/剩余）。实包请求 0a00（f1 空消息）。 */
async function getRanchOpTimes(): Promise<any> {
    const reply = await call('GetRanchOpTimesRequest', { unknown_1: Buffer.alloc(0) },
        RANCH_SERVICE, 'GetRanchOpTimes', 'GetRanchOpTimesReply');
    return reply && reply.quotas ? reply.quotas : [];
}

/** 喂动物，回包是最新 RanchInfo */
async function feedAnimal(ranchInstId: number | string, feedType: number = 1): Promise<any> {
    const reply = await call('FeedAnimalRequest', {
        ranch: { ranch_inst_id: toLong(ranchInstId) },
        feed_type: feedType,
    }, ANIMAL_SERVICE, 'FeedAnimal', 'FeedAnimalReply');
    return reply && reply.ranch;
}

/**
 * 收获产物（回包 RanchInfo + shelves），harvest_type 实测=1。
 * 2026-11-16 16:57 实包勘误：请求 f2 是空消息(1200)，不是 RanchRef{ranch_inst_id}。
 * 旧写法 120308914e1801 多次被服务器回「网络繁忙」；正确写法是 12001801。
 * ranchInstId 仅为兼容旧调用保留，不参与编码——收获目标由当前登录态决定。
 */
async function harvestRanch(ranchInstId?: number | string, harvestType: number = 1): Promise<any> {
    const reply = await call('HarvestRanchRequest', { unknown_2: Buffer.alloc(0), harvest_type: harvestType },
        ANIMAL_SERVICE, 'HarvestRanch', 'HarvestRanchReply');
    return reply;
}

/** 一键催产（空请求），回包 RanchInfo + shelves(f3) */
async function triggerProduce(): Promise<any> {
    return call('TriggerProduceRequest', {}, ANIMAL_SERVICE, 'TriggerProduce', 'TriggerProduceReply');
}

/** 抚摸动物（回包最新 RanchInfo） */
async function strokeAnimal(ownerGid: number | string, ranchInstId: number | string, animalInstId: number | string): Promise<any> {
    const reply = await call('StrokeAnimalRequest', {
        owner_gid: toLong(ownerGid),
        animal: { ranch_inst_id: toLong(ranchInstId), animal_inst_id: toLong(animalInstId) },
    }, ANIMAL_SERVICE, 'StrokeAnimal', 'StrokeAnimalReply');
    return reply && reply.ranch;
}

/** 清理灾害，回包 result/remaining/reward */
async function putHazard(ranchInstId: number | string, operatorGid: number | string, opId: number = 11003): Promise<any> {
    return call('PutHazardRequest', {
        ranch_inst_id: toLong(ranchInstId),
        operator_gid: toLong(operatorGid),
        op_id: toLong(opId),
        unknown_4: 1,
    }, RANCH_SERVICE, 'PutHazard', 'PutHazardReply');
}

/** 牧草机加草（inst_id 实测 10002），回包最新 Grass */
async function addFeed(instId: number | string, count: number = 1): Promise<any> {
    const reply = await call('AddFeedRequest', { inst_id: toLong(instId), count },
        FEED_MACHINE_SERVICE, 'AddFeed', 'AddFeedReply');
    return reply && reply.grass;
}

/** 商店概览（实包 f1 固定=2） */
async function getShopProfiles(): Promise<any> {
    return call('ShopProfilesRequest', { unknown_1: 2 },
        SHOP_SERVICE, 'ShopProfiles', 'ShopProfilesReply');
}

/** 指定商店商品列表 */
async function getShopInfo(shopId: number): Promise<any> {
    return call('ShopInfoRequest', { shop_id: toLong(shopId) },
        SHOP_SERVICE, 'ShopInfo', 'ShopInfoReply');
}

/**
 * 幼崽商店实包：shop_type=5 / shop_name=幼崽；商品 10003 → item_id=60002、单价 1080。
 * 这里动态取价，避免写死价格导致活动调价后买失败。
 */
async function getCubShopGoods(): Promise<any> {
    const profiles = await getShopProfiles();
    const list = (profiles && profiles.shop_profiles) || [];
    const shop = list.find((p: any) => toNum(p.shop_type) === 5)
        || list.find((p: any) => /幼崽|cub/i.test(String(p.shop_name || '')))
        || { shop_id: toLong(5), shop_name: '幼崽', shop_type: 5 };
    const shopId = toNum(shop.shop_id) || 5;
    const info = await getShopInfo(shopId);
    const nowSec = Date.now() / 1000;
    const goods = ((info && info.goods_list) || []).map((g: any) => {
        const discount = toNum(g.discount_price);
        const start = toNum(g.discount_start_time);
        const end = toNum(g.discount_end_time);
        const inDiscount = discount > 0
            && (!start || start <= nowSec)
            && (!end || end >= nowSec);
        return {
            goodsId: toNum(g.id),
            itemId: toNum(g.item_id),
            itemCount: toNum(g.item_count) || 1,
            price: inDiscount ? discount : toNum(g.price),
            limit: toNum(g.limit_count),
            bought: toNum(g.bought_num),
            unlocked: !!g.unlocked,
        };
    });
    // 60002 是实包里买到的幼崽；10003 是该商品的 goods_id，作为兼容兜底。
    const cub = goods.find((g: any) => g.itemId === 60002 && g.unlocked)
        || goods.find((g: any) => g.goodsId === 10003 && g.unlocked)
        || goods.find((g: any) => g.unlocked && g.itemId > 0)
        || null;
    return { shopId, shopName: String(shop.shop_name || '幼崽'), goods, cub };
}

/** 买幼崽。f4 实测=1，缺失会被服务器判为参数错误。 */
async function buyCub(goodsId: number, num: number, price: number): Promise<any> {
    return call('BuyGoodsRequest', {
        goods_id: toLong(goodsId), num: toLong(num), price: toLong(price), unknown_4: 1,
    }, SHOP_SERVICE, 'BuyGoods', 'BuyGoodsReply');
}

/** 批量使用道具（罐头换牧草：80031 罐头 → 7004 牧草，1 罐头=3600 草） */
async function batchUse(itemId: number, count: number): Promise<any> {
    return call('BatchUseRequest', {
        item: { item_id: itemId, count, unknown_6: 62478 },
        unknown_8: Buffer.alloc(0),
    }, ITEM_SERVICE, 'BatchUse', 'BatchUseReply');
}

/** 背包中某个道具的数量（用于判断是否还有罐头可换草） */
async function getBagItemCount(itemId: number): Promise<number> {
    const { getBag, getBagItems } = require('../warehouse');
    const bag = await getBag();
    const items: any[] = getBagItems(bag) || [];
    return items
        .filter((it: any) => toNum(it.id) === itemId)
        .reduce((sum: number, it: any) => sum + toNum(it.count), 0);
}

/** 进/出好友家园（回包 f1 是 BasicInfo） */
async function enterHomestead(hostGid: number | string, reason: number = 2): Promise<any> {
    return call('EnterRequest', { host_gid: toLong(hostGid), reason },
        VISIT_SERVICE, 'EnterHomestead', 'VisitEnterHomesteadReply');
}
async function leaveHomestead(hostGid: number | string): Promise<any> {
    return call('LeaveRequest', { host_gid: toLong(hostGid) }, VISIT_SERVICE, 'LeaveHomestead');
}

/** 一键清理牧场（实包 1200，回包最新 RanchInfo） */
async function cleanAllRanch(): Promise<any> {
    const reply = await call('CleanAllRanchRequest', { unknown_2: Buffer.alloc(0) },
        RANCH_SERVICE, 'CleanAllRanch', 'CleanAllRanchReply');
    return reply && reply.ranch;
}

/** 轮换商店信息（实包 shop_id=7「仓鼠驿站」，松果货币） */
async function getRotationShopInfo(shopId: number = 7): Promise<any> {
    return call('RotationShopInfoRequest', { shop_id: toLong(shopId) },
        SHOP_SERVICE, 'RotationShopInfo', 'RotationShopInfoReply');
}

/** 轮换商店购买：f3 用 getRotationShopInfo 回包的 rotation_day_sec */
async function rotationBuyGoods(goodsId: number, num: number, rotationDaySec: number): Promise<any> {
    return call('RotationBuyGoodsRequest', {
        goods_id: toLong(goodsId), num: toLong(num),
        rotation_day_sec: toLong(rotationDaySec), unknown_4: 1,
    }, SHOP_SERVICE, 'RotationBuyGoods', 'RotationBuyGoodsReply');
}

/** 牧草机详情（容量/库存） */
async function getFacilityDetail(instId: number | string = 10002): Promise<any> {
    const reply = await call('GetFacilityDetailRequest', { inst_id: toLong(instId) },
        HOMESTEAD_SERVICE, 'GetFacilityDetail', 'GetFacilityDetailReply');
    return reply && reply.facility;
}

module.exports = {
    getRanchDetail,
    getRanchOpTimes,
    feedAnimal,
    harvestRanch,
    triggerProduce,
    strokeAnimal,
    putHazard,
    addFeed,
    getShopProfiles,
    getShopInfo,
    getCubShopGoods,
    buyCub,
    batchUse,
    getBagItemCount,
    enterHomestead,
    leaveHomestead,
    getFacilityDetail,
    cleanAllRanch,
    getRotationShopInfo,
    rotationBuyGoods,
};

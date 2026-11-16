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
    const reply = await call('GetRanchDetailRequest', { unknown_2: null },
        ANIMAL_SERVICE, 'GetRanchDetail', 'GetRanchDetailReply');
    const ranch = reply && reply.ranch;
    if (!ranch) return { ranch: null, ownerGid: selfGid };
    return { ranch, ownerGid: selfGid };
}

/** 操作配额表（op_id → 上限/已用/剩余） */
async function getRanchOpTimes(): Promise<any> {
    const reply = await call('GetRanchOpTimesRequest', {}, RANCH_SERVICE, 'GetRanchOpTimes', 'GetRanchOpTimesReply');
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

/** 收获产物（回包 RanchInfo + shelves），harvest_type 实测=1 */
async function harvestRanch(ranchInstId?: number | string, harvestType: number = 1): Promise<any> {
    const ranch = ranchInstId != null ? { ranch_inst_id: toLong(ranchInstId) } : {};
    const reply = await call('HarvestRanchRequest', { ranch, harvest_type: harvestType },
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

/** 买幼崽。goodsId 实测 10003、price 从 ShopInfo 取。 */
async function buyCub(goodsId: number, num: number, price: number): Promise<any> {
    return call('BuyGoodsRequest', {
        goods_id: toLong(goodsId), num: toLong(num), price: toLong(price),
    }, SHOP_SERVICE, 'BuyGoods', 'BuyGoodsReply');
}

/** 批量使用道具（罐头换牧草：80031 罐头 → 7004 牧草，1 罐头=3600 草） */
async function batchUse(itemId: number, count: number): Promise<any> {
    return call('BatchUseRequest', {
        item: { item_id: itemId, count, unknown_6: 62478 },
        unknown_8: Buffer.alloc(0),
    }, ITEM_SERVICE, 'BatchUse', 'BatchUseReply');
}

/** 进/出好友家园（回包 f1 是 BasicInfo） */
async function enterHomestead(hostGid: number | string, reason: number = 2): Promise<any> {
    return call('EnterRequest', { host_gid: toLong(hostGid), reason },
        VISIT_SERVICE, 'EnterHomestead', 'VisitEnterHomesteadReply');
}
async function leaveHomestead(hostGid: number | string): Promise<any> {
    return call('LeaveRequest', { host_gid: toLong(hostGid) }, VISIT_SERVICE, 'LeaveHomestead');
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
    buyCub,
    batchUse,
    enterHomestead,
    leaveHomestead,
    getFacilityDetail,
};

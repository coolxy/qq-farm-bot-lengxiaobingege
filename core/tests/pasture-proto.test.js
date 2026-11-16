const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const proto = require('../dist/utils/proto');

// 2026-11-16 微信端牧场实测帧（tools/extract-har-frames.js + decode-latest-protocols.js 解出）。
// HarvestRanch 回包：3 只动物收获后，货架出现产物批 2060002/1102。
const RANCH_AFTER_HARVEST_HEX = '08914e10032a0208643001';
const ANIMAL_HEX = '08914e1001180420e2d4032804300250f4e3a99a9e3470f8a1c8999e34900101980101a00101a801e802b2010608ef0710f010b801b401c2010608ef0710d40cc801abe1e69d9e34f201024001';
const SHELF_HEX = '08914e10011804521108e2dd7d1001a20608220608ef0710f010520908ce0810e802a20600';

test('decodes RanchInfo captured from the live pasture session', async () => {
    await proto.ensureProtoLoaded();
    const ranch = proto.types.RanchInfo.decode(Buffer.from(RANCH_AFTER_HARVEST_HEX, 'hex'));
    assert.equal(Number(ranch.ranch_inst_id), 10001);
    assert.equal(ranch.capacity, 3);
    assert.equal(Number(ranch.grass.amount), 100);
    assert.equal(ranch.husbandry_type, 1);
    assert.equal(ranch.animals.length, 0);
});

test('decodes AnimalInst with growth clocks and expected sells', async () => {
    await proto.ensureProtoLoaded();
    const animal = proto.types.AnimalInst.decode(Buffer.from(ANIMAL_HEX, 'hex'));
    assert.equal(Number(animal.ranch_inst_id), 10001);
    assert.equal(animal.slot_index, 1);
    assert.equal(Number(animal.animal_inst_id), 4);
    assert.equal(Number(animal.animal_id), 60002);
    assert.equal(animal.stage, 4);
    assert.equal(Number(animal.expected_harvest_exp), 360);
    assert.equal(Number(animal.expected_harvest_sells.num), 2160);
    assert.equal(Number(animal.expected_produce_sells.num), 1620);
    assert.equal(animal.can_feed, 1);
    assert.equal(animal.limited_can_used, 1); // 普通罐头桶一生一次，已用过则只能走有机桶
    assert.ok(Number(animal.grow_ready_at_ms) > 0);
});

test('decodes Shelf lots produced by HarvestRanch', async () => {
    await proto.ensureProtoLoaded();
    const shelf = proto.types.Shelf.decode(Buffer.from(SHELF_HEX, 'hex'));
    assert.equal(Number(shelf.ranch_inst_id), 10001);
    assert.equal(shelf.slot_index, 1);
    assert.equal(Number(shelf.animal_inst_id), 4);
    assert.equal(shelf.lots.length, 2);
    assert.equal(Number(shelf.lots[0].item_id), 2060002);
    assert.equal(Number(shelf.lots[0].extra.sell.num), 2160);
    assert.equal(Number(shelf.lots[1].item_id), 1102);
    assert.equal(Number(shelf.lots[1].num), 360);
});

// 2026-11-16 第三段抓包：罐头批量使用补充罐头桶（ItemService.BatchUse）。
// 请求 {item:{item_id:80031(1小时有机罐头), count:60}, unknown_8:空}，回包 gained{7004(有机罐头容器), 216000 秒}。
const BATCH_USE_REQ_HEX = '0a0c089ff104103c308ee8034200';
const BATCH_USE_REPLY_HEX = '0a0a089ff104103c308ee803121208dc3610c0970d188092b8c398feffffff01';

test('decodes BatchUse can-to-bucket refill captured live', async () => {
    await proto.ensureProtoLoaded();
    const req = proto.types.BatchUseRequest.decode(Buffer.from(BATCH_USE_REQ_HEX, 'hex'));
    assert.equal(Number(req.item.item_id), 80031);
    assert.equal(Number(req.item.count), 60);
    assert.equal(Number(req.item.unknown_6), 62478);
    assert.equal((req.unknown_8 || Buffer.alloc(0)).length, 0);
    const rep = proto.types.BatchUseReply.decode(Buffer.from(BATCH_USE_REPLY_HEX, 'hex'));
    assert.equal(Number(rep.used.item_id), 80031);
    assert.equal(Number(rep.used.count), 60);
    assert.equal(Number(rep.gained.item_id), 7004);
    assert.equal(Number(rep.gained.count), 216000); // 60 罐头 × 3600 秒
});

// 2026-11-16 第四段抓包（16:13，好友牧场/互动/清灾害/买幼崽场景）。
// StrokeAnimal 请求：抚摸好友动物 {owner_gid:1215360471, animal:{10001,46}}。
const STROKE_REQ_HEX = '08d7dbc3c304120508914e102e';
// PutHazard 请求：清灾害 {ranch:10001, gid:1220383670, op:11003, 1}。
const HAZARD_REQ_HEX = '08914e10b6a7f6c50418fb552001';
// PutHazard 回包：结果=1、剩余=99、奖励 1102×5。
const HAZARD_REPLY_HEX = '080110631a0a080210c499a2cd041801220808ce081005a20600';
// BuyGoods 请求：买幼崽 {goods_id:10003, num:3, price:1080, f4:1}。
const BUY_CUB_REQ_HEX = '08934e100318b8082001';
// EnterHomestead 回包 f1：BasicInfo{gid:1215360471, name:婷児꧔, level:151}。
const ENTER_HOMESTEAD_BASIC_HEX = '08d7dbc3c3041209e5a9b7e58590eaa79418970120e192ab1e28bcd195cc01321c6f4c36314d7667656274317979355a687041387361383576596833633a9c0168747470733a2f2f746869726477782e716c6f676f2e636e2f6d6d6f70656e2f76695f33322f665a6472334842565a6436753962515069624d32314b6f6c74536831483135454969624e656d4633534c4733517a6266526a784e4852696150523737657064413563786d4f524435743369633263396d75554a6e59456a326f5769624e5567506961637a734747696276725531374c4f566b2f313332';

test('decodes StrokeAnimal / PutHazard / BuyGoods / EnterHomestead from live frames', async () => {
    await proto.ensureProtoLoaded();
    const stroke = proto.types.StrokeAnimalRequest.decode(Buffer.from(STROKE_REQ_HEX, 'hex'));
    assert.equal(Number(stroke.owner_gid), 1215360471);
    assert.equal(Number(stroke.animal.ranch_inst_id), 10001);
    assert.equal(Number(stroke.animal.animal_inst_id), 46);

    const hazardReq = proto.types.PutHazardRequest.decode(Buffer.from(HAZARD_REQ_HEX, 'hex'));
    assert.equal(Number(hazardReq.ranch_inst_id), 10001);
    assert.equal(Number(hazardReq.op_id), 11003);
    const hazardRep = proto.types.PutHazardReply.decode(Buffer.from(HAZARD_REPLY_HEX, 'hex'));
    assert.equal(hazardRep.result, 1);
    assert.equal(hazardRep.remaining, 99);
    assert.equal(Number(hazardRep.reward.item_id), 1102);
    assert.equal(Number(hazardRep.reward.num), 5);

    const buy = proto.types.BuyGoodsRequest.decode(Buffer.from(BUY_CUB_REQ_HEX, 'hex'));
    assert.equal(Number(buy.goods_id), 10003);
    assert.equal(Number(buy.price), 1080);
    assert.equal(Number(buy.unknown_4), 1);

    const basic = proto.types.UserBasicInfo.decode(Buffer.from(ENTER_HOMESTEAD_BASIC_HEX, 'hex'));
    assert.equal(Number(basic.gid), 1215360471);
    assert.equal(basic.name, '婷児꧔');
    assert.equal(Number(basic.level), 151);
});

// 2026-11-16 幼崽商店实包：ShopInfo(shop_id=5) 前两个商品。
// 10002→60001(2金)，10003→60002(1080金)，后者就是买幼崽用的商品。
const CUB_SHOP_REPLY_HEX = '0a2908924e1802280130e1d4033801420408031001608092b8c398feffffff01688092b8c398feffffff010a2a08934e18b808280130e2d4033801420408031003608092b8c398feffffff01688092b8c398feffffff01';

test('decodes cub shop goods and encodes ShopProfiles request', async () => {
    await proto.ensureProtoLoaded();
    const rep = proto.types.ShopInfoReply.decode(Buffer.from(CUB_SHOP_REPLY_HEX, 'hex'));
    assert.equal(rep.goods_list.length, 2);
    assert.equal(Number(rep.goods_list[0].id), 10002);
    assert.equal(Number(rep.goods_list[0].item_id), 60001);
    assert.equal(Number(rep.goods_list[1].id), 10003);
    assert.equal(Number(rep.goods_list[1].price), 1080);
    assert.equal(Number(rep.goods_list[1].item_id), 60002);
    const reqBytes = proto.types.ShopProfilesRequest.encode(
        proto.types.ShopProfilesRequest.create({ unknown_1: 2 })).finish();
    assert.equal(Buffer.from(reqBytes).toString('hex'), '0802');
});

// 2026-11-16 16:57 第五段抓包：请求格式勘误 + 新 RPC。
// HarvestRanch 请求实包 12001801（f2 空消息），旧写法塞 ranch_inst_id 会触发「网络繁忙」。
const HARVEST_REQ_HEX = '12001801';
// GetRanchOpTimes 请求实包 0a00（f1 空消息）。
const OP_TIMES_REQ_HEX = '0a00';
// RanchInfo.f8 extras：真实首帧快照末尾 2a020864(grass) 3001(husbandry) 420408031802(extras)。
// 这里去掉动物列表，仅保留头部 + grass + husbandry + extras。
const RANCH_EXTRAS_HEX = '08914e100418042a0208643001420408031802';

test('encodes HarvestRanch / GetRanchOpTimes requests exactly like the live client', async () => {
    await proto.ensureProtoLoaded();
    const harvest = proto.types.HarvestRanchRequest.encode(
        proto.types.HarvestRanchRequest.create({ unknown_2: Buffer.alloc(0), harvest_type: 1 })).finish();
    assert.equal(Buffer.from(harvest).toString('hex'), HARVEST_REQ_HEX);
    const opTimes = proto.types.GetRanchOpTimesRequest.encode(
        proto.types.GetRanchOpTimesRequest.create({ unknown_1: Buffer.alloc(0) })).finish();
    assert.equal(Buffer.from(opTimes).toString('hex'), OP_TIMES_REQ_HEX);
});

test('decodes RanchInfo.f8 extras and CleanAllRanch request from live frames', async () => {
    await proto.ensureProtoLoaded();
    const ranch = proto.types.RanchInfo.decode(Buffer.from(RANCH_EXTRAS_HEX, 'hex'));
    assert.equal(Number(ranch.ranch_inst_id), 10001);
    assert.equal(ranch.extras.unknown_1, 3);
    assert.equal(ranch.extras.unknown_3, 2);
    const cleanReq = proto.types.CleanAllRanchRequest.encode(
        proto.types.CleanAllRanchRequest.create({ unknown_2: Buffer.alloc(0) })).finish();
    assert.equal(Buffer.from(cleanReq).toString('hex'), '1200');
});

// RotationShopInfo 请求 0807（shop_id=7 仓鼠驿站）
const ROTATION_INFO_REQ_HEX = '0807';
// RotationBuyGoods 请求 08b80210011880aee7d7062001（goods_id=312, num=1, day=1794758400）
const ROTATION_BUY_REQ_HEX = '08b80210011880aee7d7062001';

test('encodes rotation shop requests from live frames', async () => {
    await proto.ensureProtoLoaded();
    const infoReq = proto.types.RotationShopInfoRequest.encode(
        proto.types.RotationShopInfoRequest.create({ shop_id: 7 })).finish();
    assert.equal(Buffer.from(infoReq).toString('hex'), ROTATION_INFO_REQ_HEX);
    const buyReq = proto.types.RotationBuyGoodsRequest.encode(
        proto.types.RotationBuyGoodsRequest.create({
            goods_id: 312, num: 1, rotation_day_sec: 1794758400, unknown_4: 1,
        })).finish();
    assert.equal(Buffer.from(buyReq).toString('hex'), ROTATION_BUY_REQ_HEX);
});

test('decodes/encodes牧场等级 GetRanchWeightScoreV2（f1 非等级勿用，f4 等级配置；BasicInfo.f20 才是等级）', async () => {
    await proto.ensureProtoLoaded();
    // 16:57 实包回包前缀 080a1801：f1=10（非等级，勿用）、f3=1，f4=等级配置表
    const T = proto.types.GetRanchWeightScoreV2Reply;
    const encoded = T.encode(T.create({
        unknown_1: 10,
        unknown_3: 1,
        levels: [{
            level: 1, required_score: 20,
            rewards: [
                { item_id: 1002, count: 300 },
                { item_id: 80023, count: 5 },
            ],
        }],
    })).finish();
    // 前缀必须与实包逐字节一致
    assert.equal(Buffer.from(encoded).slice(0, 3).toString('hex'), '080a18');
    const reply = T.decode(Buffer.from(encoded));
    assert.equal(reply.unknown_1, 10);
    assert.equal(reply.levels.length, 1);
    assert.equal(reply.levels[0].level, 1);
    assert.equal(reply.levels[0].required_score, 20);
    assert.equal(Number(reply.levels[0].rewards[0].item_id), 1002);
    assert.equal(Number(reply.levels[0].rewards[0].count), 300);
    const req = proto.types.GetRanchWeightScoreV2Request.encode(
        proto.types.GetRanchWeightScoreV2Request.create({})).finish();
    assert.equal(Buffer.from(req).toString('hex'), ''); // 空请求

    // 真正的牧场等级在登录回包 BasicInfo.f20（16:57 抓包实测=9，与游戏内一致）
    const b = proto.types.UserBasicInfo.encode(proto.types.UserBasicInfo.create({ ranch_level: 9 })).finish();
    assert.equal(Buffer.from(b).toString('hex'), 'a00109'); // f20 varint=9
    assert.equal(Number(proto.types.UserBasicInfo.decode(b).ranch_level), 9);
});

test('every牧场 API 请求/回包类型都在运行时注册表中', async () => {
    await proto.ensureProtoLoaded();
    const apiSource = fs.readFileSync(path.join(__dirname, '../src/services/pasture/api.ts'), 'utf8');
    const names = new Set();
    for (const match of apiSource.matchAll(/call\(\s*['"]([\w.]+)['"]/g)) names.add(match[1]);
    // 直接按名字调用的请求也要覆盖（call 里写成变量时上面的正则抓不到）
    for (const name of ['GetRanchDetailRequest', 'GetRanchOpTimesRequest', 'FeedAnimalRequest', 'HarvestRanchRequest', 'AddFeedRequest', 'EnterRequest', 'LeaveRequest', 'GetFacilityDetailRequest', 'GetRanchWeightScoreV2Request', 'GetRanchWeightScoreV2Reply']) {
        names.add(name);
    }
    const missing = [...names].filter(name => typeof proto.types[name]?.encode !== 'function');
    assert.deepEqual(missing, [], `未注册类型: ${missing.join(', ')}`);
});

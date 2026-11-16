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

// 2026-11-16 第三段抓包：罐头批量使用换牧草（ItemService.BatchUse）。
// 请求 {item:{item_id:80031(10小时有机罐头), count:60}, unknown_8:空}，回包 gained{7004(牧草), 216000}。
const BATCH_USE_REQ_HEX = '0a0c089ff104103c308ee8034200';
const BATCH_USE_REPLY_HEX = '0a0a089ff104103c308ee803121208dc3610c0970d188092b8c398feffffff01';

test('decodes BatchUse can-to-grass exchange captured live', async () => {
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
    assert.equal(Number(rep.gained.count), 216000); // 60 罐头 × 3600 牧草
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

test('every牧场 API 请求/回包类型都在运行时注册表中', async () => {
    await proto.ensureProtoLoaded();
    const apiSource = fs.readFileSync(path.join(__dirname, '../src/services/pasture/api.ts'), 'utf8');
    const names = new Set();
    for (const match of apiSource.matchAll(/call\(\s*['"]([\w.]+)['"]/g)) names.add(match[1]);
    // 直接按名字调用的请求也要覆盖（call 里写成变量时上面的正则抓不到）
    for (const name of ['GetRanchDetailRequest', 'GetRanchOpTimesRequest', 'FeedAnimalRequest', 'HarvestRanchRequest', 'AddFeedRequest', 'EnterRequest', 'LeaveRequest', 'GetFacilityDetailRequest']) {
        names.add(name);
    }
    const missing = [...names].filter(name => typeof proto.types[name]?.encode !== 'function');
    assert.deepEqual(missing, [], `未注册类型: ${missing.join(', ')}`);
});

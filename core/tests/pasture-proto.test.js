const assert = require('node:assert/strict');
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
// 请求 {item_id:80031(10小时有机罐头), count:60}，回包 gained{7004(牧草), 216000}。
const BATCH_USE_REQ_HEX = '089ff104103c308ee803';
const BATCH_USE_REPLY_HEX = '0a0a089ff104103c308ee803121208dc3610c0970d188092b8c398feffffff01';

test('decodes BatchUse can-to-grass exchange captured live', async () => {
    await proto.ensureProtoLoaded();
    const req = proto.types.BatchUseRequest.decode(Buffer.from(BATCH_USE_REQ_HEX, 'hex'));
    assert.equal(Number(req.item_id), 80031);
    assert.equal(Number(req.count), 60);
    assert.equal(Number(req.unknown_6), 62478);
    const rep = proto.types.BatchUseReply.decode(Buffer.from(BATCH_USE_REPLY_HEX, 'hex'));
    assert.equal(Number(rep.used.item_id), 80031);
    assert.equal(Number(rep.used.count), 60);
    assert.equal(Number(rep.gained.item_id), 7004);
    assert.equal(Number(rep.gained.count), 216000); // 60 罐头 × 3600 牧草
});

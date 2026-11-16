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

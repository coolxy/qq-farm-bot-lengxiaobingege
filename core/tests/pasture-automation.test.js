const assert = require('node:assert/strict');
const test = require('node:test');

const analysis = require('../dist/services/pasture/analysis');
const proto = require('../dist/utils/proto');

// 实包动物：grow_ready=1794814669300(15:37:49)，mature=1794821959851(17:39:19)
const ANIMAL_HEX = '08914e1001180420e2d4032804300250f4e3a99a9e3470f8a1c8999e34900101980101a80101a801e802b2010608ef0710f010b801b401c2010608ef0710d40cc801abe1e69d9e34f201024001';
const AT_TIME = new Date(2026, 10, 16, 16, 0, 0).getTime(); // 16:00

test('analyzeRanch marks harvestable by grow_ready clock and feed by can_feed', async () => {
    await proto.ensureProtoLoaded();
    const animal = proto.types.AnimalInst.decode(Buffer.from(ANIMAL_HEX, 'hex'));
    const ranch = proto.types.RanchInfo.decode(Buffer.from('08914e10032a0208643001','hex'));
    ranch.animals = [animal];
    const result = analysis.analyzeRanch(ranch, AT_TIME);
    assert.equal(result.animals.length, 1);
    assert.equal(result.animals[0].canHarvest, true, '16:00 已过 15:37 成熟点');
    assert.equal(result.animals[0].canFeed, true);
    assert.equal(result.animals[0].stage, 4);
    assert.equal(result.harvestable.length, 1);
    assert.equal(result.feedable.length, 1);
    assert.equal(result.grass, 100);
});

test('analyzeRanch treats un-matured animal as not harvestable', async () => {
    await proto.ensureProtoLoaded();
    const animal = proto.types.AnimalInst.decode(Buffer.from(ANIMAL_HEX, 'hex'));
    const before = new Date(2026, 10, 16, 15, 0, 0).getTime(); // 15:00, 早于 15:37
    const result = analysis.analyzeRanch({ animals: [animal] }, before);
    assert.equal(result.animals[0].canHarvest, false);
});

test('isGrassLow triggers on low amount or near-depletion clock', () => {
    const now = Date.now();
    const Long = require('long');
    const low = (n) => Long.fromNumber(n, true);
    assert.equal(analysis.isGrassLow({ grass: { amount: low(100) } }, 3000, now), true);
    assert.equal(analysis.isGrassLow({ grass: { amount: low(5000) } }, 3000, now), false);
    // 耗尽时间 10 分钟后（empty_at_ms 是毫秒墙钟）
    assert.equal(analysis.isGrassLow({ grass: { amount: low(5000), empty_at_ms: low(now + 600000) } }, 3000, now), true);
    // u64max 表示不会耗尽
    assert.equal(analysis.isGrassLow({ grass: { amount: low(5000), empty_at_ms: Long.MAX_UNSIGNED_VALUE } }, 3000, now), false);
});

test('cansToTarget converts grass deficit to canned count', () => {
    assert.equal(analysis.cansToTarget(0, 6000), 2);
    assert.equal(analysis.cansToTarget(3000, 6000), 1);
    assert.equal(analysis.cansToTarget(6000, 6000), 0);
    assert.equal(analysis.CANNED_TO_GRASS, 3600);
});

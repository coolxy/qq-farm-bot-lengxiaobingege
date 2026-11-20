const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeAccountConfig } = require('../dist/models/store/shared-state');
const { cubMap } = require('../dist/config/ranch-animals');

const coopCubs = [...cubMap.entries()].filter(([, animal]) => animal && animal.husbandry_type === '窝').slice(0, 2).map(([id]) => id);
const shedCub = [...cubMap.entries()].find(([, animal]) => animal && animal.husbandry_type === '棚')[0];

/**
 * 自动控制里选择「优先背包幼崽」后，窝/棚的幼崽优先级要能保存下来。
 * 之前 normalizeAccountConfig 的非布尔白名单漏了 ranch_coop_cub_priority /
 * ranch_shed_cub_priority，导致这两个数组走进 else 分支被 !!v 压成 true，
 * 保存后优先级顺序丢失、运行时 placeCubs 又兜底成空数组。
 * 这里锁住归一化会保留数组原值与顺序，且过滤不适用当前栏位的 id。
 */
test('归一化保留窝/棚幼崽优先级数组，不再压成布尔值', () => {
    const cfg = normalizeAccountConfig({
        automation: {
            ranch_coop_cub_priority: [coopCubs[0], coopCubs[1], coopCubs[0]],
            ranch_shed_cub_priority: [shedCub],
        },
    });
    assert.ok(Array.isArray(cfg.automation.ranch_coop_cub_priority), '窝优先级应保持数组');
    assert.ok(Array.isArray(cfg.automation.ranch_shed_cub_priority), '棚优先级应保持数组');
    assert.deepEqual(cfg.automation.ranch_coop_cub_priority, [coopCubs[0], coopCubs[1]], '保留顺序并去重');
    assert.deepEqual(cfg.automation.ranch_shed_cub_priority, [shedCub]);
});

test('归一化对栏位不匹配的幼崽 id 整段回退为空数组', () => {
    const cfg = normalizeAccountConfig({
        automation: {
            // 把棚幼崽混进窝的优先级：normalizeRanchSetting 校验失败，整段沿用默认空数组。
            ranch_coop_cub_priority: [shedCub, coopCubs[0]],
        },
    });
    assert.deepEqual(cfg.automation.ranch_coop_cub_priority, []);
});

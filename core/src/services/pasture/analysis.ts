export {};
/**
 * 牧场状态分析 - 把 RanchInfo 转成可执行的动作清单
 *
 * 判定规则全部来自 2026-11-16 微信端实包：
 * - grow_ready_at_ms 是「本阶段产物/成长就绪」墙钟，<= now 只表示该动物进入下一个可结算点；
 *   它不是「服务端一定同意收获」的充分条件（线上实测：就绪了但货架为空时 HarvestRanch 回 1045211），
 *   所以 canHarvest 只用来决定「这一轮值不值得发一次收获」，真正的判定交给服务端业务码；
 * - can_feed=1 表示该动物可喂（喂食后才会产出，罐头桶空了就会停在这）；
 * - mutation.strokable=1 表示可抚摸（每日有次数限制，走 OpQuota）；
 * - grass.empty_at_ms 是牧草耗尽墙钟，接近耗尽时需要加草/换罐头；
 * - mature_ready_at_ms 是动物长大可整只收获的墙钟，只有该字段出现时才代表倒计时可算。
 */

const { toNum } = require('../../utils/utils');

// 实包勘误（2026-11-16 补充）：BatchUse 回包里的 7004 不是牧草，
// 而是 ItemInfo.json 中的「有机罐头容器」——喂养动物真正消耗的是这个桶的时长（秒）。
// 80031「有机罐头(1小时)」用掉后给桶增加 3600 秒，不是 3600 株牧草。
const BUCKET_ITEM_ID = 7004;     // 有机罐头容器（余额单位：秒）
const CANNED_ITEM_ID = 80031;    // 有机罐头(1小时)
const CANNED_TO_BUCKET_SECONDS = 3600;
// 兼容旧调用的名字（语义实际是罐头桶，不是牧草）。
const GRASS_ITEM_ID = BUCKET_ITEM_ID;
const CANNED_TO_GRASS = CANNED_TO_BUCKET_SECONDS;

function num(v: any): number {
    return toNum(v);
}

interface AnimalView {
    ranch_inst_id: number;
    slot_index: number;
    animal_inst_id: string;
    animal_id: string;
    stage: number;
    canHarvest: boolean;
  canFeed: boolean;
  limitedCanUsed: boolean;
  canStroke: boolean;
    growReadyAt: number;
    matureReadyAt: number;
    produceCount: number;
    expectedHarvestGold: number;
}

/** 把动物列表转成带动作标记的前端视图 + 可 harvested 的实例列表 */
function analyzeRanch(ranch: any, now: number = Date.now()): {
    animals: AnimalView[];
    harvestable: any[];
    feedable: any[];
    organicFeedable: any[];
    normalFeedable: any[];
    strokable: any[];
    grass: number;
    grassEmptyAt: number;
    capacity: number;
    animalCount: number;
} {
    const source = (ranch && ranch.animals) || [];
    const animals: AnimalView[] = [];
    const harvestable: any[] = [];
    const feedable: any[] = [];
    const organicFeedable: any[] = [];
    const normalFeedable: any[] = [];
    const strokable: any[] = [];

    for (const a of source) {
        const growReadyAt = num(a.grow_ready_at_ms);
        const canHarvest = growReadyAt > 0 && growReadyAt <= now;
        const canFeed = num(a.can_feed) === 1;
        const limitedCanUsed = num(a.limited_can_used) === 1;
        const canStroke = !!(a.mutation && num(a.mutation.strokable) === 1);
        const view: AnimalView = {
            ranch_inst_id: num(a.ranch_inst_id),
            slot_index: num(a.slot_index),
            animal_inst_id: String(num(a.animal_inst_id)),
            animal_id: String(num(a.animal_id)),
            stage: num(a.stage),
            canHarvest, canFeed, limitedCanUsed, canStroke,
            growReadyAt,
            matureReadyAt: num(a.mature_ready_at_ms),
            produceCount: num(a.produce_count),
            expectedHarvestGold: num(a.expected_harvest_sells && a.expected_harvest_sells.num),
        };
        animals.push(view);
        if (canHarvest) harvestable.push(a);
        if (canFeed) {
            feedable.push(a);
            organicFeedable.push(a);
            if (!limitedCanUsed) normalFeedable.push(a);
        }
        if (canStroke) strokable.push(a);
    }

    const grass = ranch && ranch.grass ? num(ranch.grass.amount) : 0;
    const grassEmptyAt = ranch && ranch.grass ? num(ranch.grass.empty_at_ms) : 0;
    return {
        animals,
        harvestable,
        feedable,
        organicFeedable,
        normalFeedable,
        strokable,
        grass,
        grassEmptyAt,
        capacity: ranch ? num(ranch.capacity) : 0,
        animalCount: animals.length,
    };
}

/**
 * 牧草是否偏低。
 * 实包勘误（2026-11-16 线上）：牧场牧草上限就是 100，旧实现用 3000 做阈值会每轮都判定“缺草”，
 * 于是不停发 AddFeed，被服务器回「牧草机已满」。现在按容量比例判断，并保留耗尽时间作为兜底。
 */
function isGrassLow(ranch: any, capacity: number = 100, now: number = Date.now()): boolean {
    const emptyAt = ranch && ranch.grass ? num(ranch.grass.empty_at_ms) : 0;
    if (emptyAt > 0 && emptyAt < 9007199254740992 && emptyAt - now < 30 * 60 * 1000) return true;
    const amount = num(ranch && ranch.grass && ranch.grass.amount);
    const max = Math.max(1, num(capacity) || 100);
    return amount <= max * 0.2;
}

/** 需要几个罐头才能把牧草补到目标值 */
function cansToTarget(currentGrass: number, targetGrass: number): number {
    if (targetGrass <= currentGrass) return 0;
    return Math.ceil((targetGrass - currentGrass) / CANNED_TO_GRASS);
}

module.exports = {
    analyzeRanch,
    isGrassLow,
    cansToTarget,
    BUCKET_ITEM_ID,
    CANNED_ITEM_ID,
    CANNED_TO_BUCKET_SECONDS,
    GRASS_ITEM_ID,
    CANNED_TO_GRASS,
};

import type { RanchAutomationConfig } from '../../config/ranch-automation';
export {};

const { RANCH_SWITCH_KEYS } = require('../../config/ranch-automation');
const { getAutomation } = require('../../models/store');
const { inScene, isUnlocked, isManualWaiting, noteManualYield } = require('./transport');
const { loadRaw, snapshot, inventory, catalog, market, balance } = require('./state');
const { cubMap, quantity } = require('./model');
const { prepareAction, operate } = require('./actions');
const { getServerTimeSec, log } = require('../../utils/utils');
const { getShopGoodsById } = require('../../config/gameConfig');
const reservations = require('./operation-state');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const daily = require('./daily');

let nextCheckAt = 0;
let nextFriendIndex = 0;
let friendVisits = 0;
let pendingFriendGid: string | null = null;
let cycleStartedAt = 0;
let cycleChanged = false;
const completedPhases = new Set<string>();
const completedSteps = new Set<string>();
const PATROL_SLICE_MS = 5000;
const SCENE_REENTRY_MS = 20_000;
const MARKET_CHECK_MS = 6 * 60 * 60 * 1000;
const MARKET_EXCHANGES = [
    { currencyId: 7002, rewardPriority: [80012, 80011], minBalance: 3n },
    { currencyId: 1008, rewardPriority: [80013, 80012, 80011], minBalance: 1n },
];
let nextMarketCheckAt = 0;
let marketRunId = 0;
const lastMarketBalances = new Map<number, bigint>();

function resetCycle(): void {
    completedPhases.clear();
    completedSteps.clear();
    friendVisits = 0;
    pendingFriendGid = null;
    cycleStartedAt = 0;
    cycleChanged = false;
}
const FRIEND_CONTROLS: Record<string, string> = { stroke: 'ranch_stroke', steal: 'ranch_friend_steal', cleanFriend: 'ranch_friend_clean', putMosquito: 'ranch_friend_mosquito' };
const enabled = (key: string) => getAutomation()[key] === true;
function marketDue(): boolean {
    return getAutomation().ranch_market_organic === true && Date.now() >= nextMarketCheckAt;
}
const due = (state: any) => !state.doneToday && Date.now() >= (state.nextCheckAt || 0);

function getRoutineState(): any {
    const auto = getAutomation();
    const work = RANCH_SWITCH_KEYS.some((key: string) => !['ranch_task', 'ranch_share', 'ranch_grass_buy', 'ranch_market_organic'].includes(key) && auto[key]);
    const routineDue = work || auto.ranch_task && due(daily.getTaskRoutineState()) || auto.ranch_share && due(daily.getShareRoutineState());
    return {
        doneToday: !isUnlocked() || !(routineDue || auto.ranch_market_organic),
        nextCheckAt: routineDue ? nextCheckAt : Math.max(nextCheckAt, nextMarketCheckAt),
    };
}

function selectAnimal(goods: any[], settings: RanchAutomationConfig, kind: number): any {
    const strategy = settings.ranch_strategy === 'bag_priority' ? settings.ranch_bag_fallback : settings.ranch_strategy;
    const preferred = kind === 1 ? settings.ranch_coop_animal : settings.ranch_shed_animal;
    const candidates = goods.filter(good => good.available && good.animal?.enable_flag
        && good.animal.husbandry_type === (kind === 1 ? '窝' : '棚') && good.price.id === 1007 && BigInt(good.price.count) > 0n);
    if (strategy === 'preferred') return candidates.find(good => good.animal.id === preferred);
    const level = (good: any) => Number(getShopGoodsById(Number(good.id))?.conds?.match(/:(\d+)$/)?.[1] || good.requiredLevel || 0);
    return candidates.sort((a, b) => level(b) - level(a) || b.animal.id - a.animal.id)[0];
}

async function run(options: { farmDeadline?: () => number } = {}): Promise<void> {
    if (getRoutineState().doneToday) return;
    const auto: RanchAutomationConfig = getAutomation();
    if (!cycleStartedAt) cycleStartedAt = Date.now();
    nextCheckAt = cycleStartedAt + auto.ranch_check_minutes * 60_000;
    try {
        await inScene(async (cells: any) => {
            const startedAt = Date.now();
            let steps = 0;
            const shouldYield = () => Date.now() >= Math.min(startedAt + PATROL_SLICE_MS, options.farmDeadline?.() ?? Infinity);
            const checkpoint = () => {
                if (steps <= 0) return;
                // 面板上有人点了按钮：先让路，别让人等巡查跑完（5 秒内不重复让路）。
                if (isManualWaiting()) {
                    noteManualYield();
                    log('牧场', '检测到手动操作，本轮巡查让路', { module: 'ranch', event: 'ranch_patrol_yield', result: 'defer' });
                    throw Object.assign(new Error('牧场巡查让路'), { code: 'RANCH_PATROL_YIELD' });
                }
                if (shouldYield()) throw Object.assign(new Error('牧场巡查让路'), { code: 'RANCH_PATROL_YIELD' });
            };
            async function phase(name: string, work: () => Promise<any>): Promise<void> {
                if (completedPhases.has(name)) return;
                await work();
                completedPhases.add(name);
            }
            let raw = await loadRaw(cells);
            let nextActionAt = Infinity;
            const updateDeadline = () => {
                const state = snapshot(raw);
                const upcoming = state.facilities.flatMap((f: any) => [
                    ...(auto.ranch_harvest || auto.ranch_produce ? (f.ranch?.animals || []).map((a: any) => a.nextAtMs) : []),
                    auto.ranch_upgrade && f.upgradeState ? (f.upgradeEndTime < 100_000_000_000 ? f.upgradeEndTime * 1000 : f.upgradeEndTime) : 0,
                ]).filter((at: any) => at > state.serverTime);
                nextActionAt = upcoming.length ? Date.now() + Math.min(...upcoming) - state.serverTime : Infinity;
                // 续跑期间出现新成熟动物时，先处理自家产出，再接着原来的进度。
                for (const [action, flag] of [['harvest', 'can_harvest'], ['produce', 'can_deliver']]) {
                    const ready = raw.cells.facilities.some((f: any) => f.ranch?.animals.some((a: any) => a[flag])
                        || action === 'harvest' && f.ranch?.shelves.some((s: any) => s.can_collect));
                    if (ready && enabled(action === 'harvest' ? 'ranch_harvest' : 'ranch_produce')) {
                        completedPhases.delete(action);
                        completedSteps.delete(`${action}:{"all":true}`);
                        nextActionAt = Math.min(nextActionAt, Date.now());
                    }
                }
            };
            updateDeadline();
            const available = (id: number) => {
                const funds = balance(raw.bag, id);
                return BigInt(funds.total) - BigInt(funds.locked) - BigInt(reservations.forCurrentAccount().reserved(`item:${id}`));
            };
            const affordable = (good: any, wanted: number) => {
                const money = available(good.price.id);
                const count = money > 0n ? money / BigInt(good.price.count) : 0n;
                return Number(count < BigInt(wanted) ? count : BigInt(wanted));
            };
            async function act(key: string, action: string, input: any = {}, currency?: number, progress?: string, expectedRewardId?: number): Promise<boolean> {
                const isEnabled = () => enabled(key) && (key !== 'ranch_grass_buy' || enabled('ranch_grass'));
                if (!isEnabled()) return false;
                const step = `${action}:${JSON.stringify(input)}${progress === undefined ? '' : `:${progress}`}`;
                if (completedSteps.has(step)) return false;
                checkpoint();
                try {
                    const quote = await prepareAction(action, input);
                    if (quote.skipped || currency && quote.costItems.some((cost: any) => cost.id !== currency)
                        || expectedRewardId !== undefined && (quote.rewards.length !== 1 || Number(quote.rewards[0].id) !== expectedRewardId)) {
                        completedSteps.add(step);
                        steps++;
                        return false;
                    }
                    if (!isEnabled()) return false;
                    // 演练模式：拿到报价即停，只记录“本来会做什么”，不产生任何写请求。
                    if (auto.ranch_dry_run) {
                        completedSteps.add(step);
                        steps++;
                        const spend = quote.costItems.map((cost: any) => `${cost.name}×${cost.count}`).join('、') || '无消耗';
                        const gain = quote.rewards.map((item: any) => `${item.name}×${item.count}`).join('、') || '无产出';
                        log('牧场', `[演练] ${quote.label}：消耗 ${spend}，产出 ${gain}`, { module: 'ranch', event: `ranch_${action}`, result: 'dry' });
                        return false;
                    }
                    checkpoint();
                    const parent = getAmbientSendContext();
                    const result = await runWithSendContext({
                        check: (service: string, method: string) => parent?.check(service, method) || (isEnabled() ? null
                            : Object.assign(new Error('牧场操作开关已关闭'), { code: 'RANCH_AUTOMATION_DISABLED' })),
                        onSent: (service: string, method: string) => parent?.onSent(service, method),
                    }, () => operate(action, { ...input, expected: quote.expected }));
                    completedSteps.add(step);
                    steps++;
                    if (result.status === 'skipped') return false;
                    cycleChanged = true;
                    log('牧场', `${quote.label}${result.notice ? `：${result.notice}` : '完成'}`, { module: 'ranch', event: `ranch_${action}`, result: 'ok' });
                    raw = await loadRaw();
                    updateDeadline();
                    return true;
                } catch (error: any) {
                    // 状态或余额变化交给下一次巡查重新报价；已发出但结果未知的写入由持久账本保护。
                    if (['INSUFFICIENT_BALANCE', 'RESERVE_PROTECTED', 'PENDING_CONFIRMATION', 'RANCH_OFFER_CHANGED', 'GOODS_UNAVAILABLE', 'RANCH_STATE_CHANGED'].includes(error.code)) {
                        completedSteps.add(step);
                        steps++;
                        log('牧场', `${action} 暂未执行：${error.message}`, { module: 'ranch', event: `ranch_${action}`, result: 'skipped' });
                        return false;
                    }
                    throw error;
                }
            }

            await phase('harvest', async () => {
                if (await act('ranch_harvest', 'harvest', { all: true })) completedPhases.delete('buy');
            });
            await phase('produce', () => act('ranch_produce', 'produce', { all: true }));
            await phase('clean', () => act('ranch_clean', 'clean'));
            await phase('sell', () => act('ranch_sell', 'sell', { all: true }));

            await phase('market-organic', async () => {
                if (!enabled('ranch_market_organic')) return;
                const stockReady = MARKET_EXCHANGES.some(({ currencyId, minBalance }) => {
                    const stock = available(currencyId);
                    return stock >= minBalance && stock > (lastMarketBalances.get(currencyId) ?? 0n);
                });
                if (!marketDue() && !stockReady) return;
                checkpoint();
                const runId = marketRunId;
                const current = await market(raw);
                if (current.opened && current.present) {
                    for (const { currencyId, rewardPriority } of MARKET_EXCHANGES) {
                        const goods = current.goods.filter((entry: any) => entry.available && Number(entry.price.id) === currencyId
                            && BigInt(entry.price.count) > 0n && rewardPriority.includes(Number(entry.reward.id)));
                        goods.sort((a: any, b: any) => rewardPriority.indexOf(Number(a.reward.id)) - rewardPriority.indexOf(Number(b.reward.id)));
                        for (const good of goods) {
                            while (good.remaining !== 0) {
                                const stock = available(currencyId);
                                const count = affordable(good, Math.min(good.remaining ?? 2147483647, 2147483647));
                                if (count < 1) break;
                                const exchanged = await act('ranch_market_organic', 'exchange', { goodsId: good.id, count },
                                    currencyId, `${runId}:${good.id}:${stock}`, Number(good.reward.id));
                                if (!exchanged) break;
                                if (good.remaining !== null) good.remaining = Math.max(0, good.remaining - count);
                            }
                        }
                    }
                }
                // 完成后才推迟检查；让路时保留到期状态，到账通知也不能被旧一轮覆盖。
                for (const { currencyId } of MARKET_EXCHANGES) lastMarketBalances.set(currencyId, available(currencyId));
                if (runId === marketRunId) nextMarketCheckAt = Date.now() + MARKET_CHECK_MS;
            });

            await phase('upgrade', async () => {
                if (enabled('ranch_upgrade')) {
                    for (const facility of snapshot(raw).facilities) {
                        const end = facility.upgradeEndTime < 100_000_000_000 ? facility.upgradeEndTime * 1000 : facility.upgradeEndTime;
                        if (facility.active && facility.upgradeState && (facility.upgradeState === 2 || end <= getServerTimeSec() * 1000)) {
                            await act('ranch_upgrade', 'completeUpgrade', { facilityId: facility.id });
                        } else if (facility.next?.available) {
                            await act('ranch_upgrade', 'upgrade', { facilityId: facility.id }, 1007);
                        }
                    }
                }
            });

            if (enabled('ranch_buy')) {
                const bagFirst = auto.ranch_strategy === 'bag_priority';
                const pens: any[] = raw.cells.facilities.filter((f: any) => f.state === 1 && f.ranch?.animal_count < f.ranch?.capacity);
                const vacancies = (id: string) => {
                    const ranch = raw.cells.facilities.find((f: any) => quantity(f.instance_id) === id)?.ranch;
                    return ranch ? Math.max(0, ranch.capacity - ranch.animal_count) : 0;
                };
                async function placeCubs(pen: any, animalId?: number): Promise<boolean> {
                    const ranchId = quantity(pen.instance_id);
                    const isCoop = pen.ranch.husbandry_type === 1;
                    const ordered = isCoop ? auto.ranch_coop_cub_priority : auto.ranch_shed_cub_priority;
                    const ranks = new Map(ordered.map((id, index) => [id, index]));
                    const stock = inventory(raw).filter((item: any) => !item.locked && item.animalId && BigInt(item.count) > 0n
                        && cubMap.get(item.id).husbandry_type === (isCoop ? '窝' : '棚') && (bagFirst || item.animalId === animalId));
                    stock.sort((a: any, b: any) => (bagFirst ? (ranks.get(a.id) ?? ordered.length) - (ranks.get(b.id) ?? ordered.length) : 0)
                        || b.animalId - a.animalId || a.id - b.id);
                    for (const item of stock) {
                        const room = BigInt(vacancies(ranchId));
                        if (room === 0n) break;
                        const usable = available(item.id);
                        const count = Number(room < usable ? room : usable);
                        // 库存和空位重新确认后才能续放；已有未决操作时不转去购买同一栏位。
                        if (count > 0 && !await act('ranch_buy', 'place', { ranchId, itemId: item.id, count }, undefined, `${usable}:${room}`)) return false;
                    }
                    return true;
                }

                // 续跑也按最新空位放养。先处理两种设施的背包库存，之后才读取购买备选。
                const purchasePens: any[] = [];
                for (const pen of pens) {
                    if ((!bagFirst || await placeCubs(pen)) && vacancies(quantity(pen.instance_id)) > 0) purchasePens.push(pen);
                }
                if (purchasePens.length) await phase('buy', async () => {
                    checkpoint();
                    const shop = await catalog(raw, 5);
                    for (const pen of purchasePens) {
                        const selected = selectAnimal(shop.goods, auto, pen.ranch.husbandry_type);
                        if (!selected || !bagFirst && !await placeCubs(pen, selected.animal.id)) continue;
                        const id = quantity(pen.instance_id);
                        const count = affordable(selected, Math.min(vacancies(id), selected.maxCount, selected.remaining ?? Infinity));
                        if (count > 0) await act('ranch_buy', 'buy', { shopId: 5, goodsId: selected.id, count, autoPlace: true }, 1007, `${id}:${available(1007)}`);
                    }
                });
            }

            await phase('grass', async () => {
                if (enabled('ranch_grass')) {
                    for (const original of raw.cells.facilities.filter((f: any) => f.state === 1 && f.feed_machine)) {
                        const id = quantity(original.instance_id);
                        const room = original.capacity - original.feed_machine.feed_count;
                        if (room <= 0) continue;
                        const stock = Math.max(0, Number(available(7001)));
                        if (stock < room && enabled('ranch_grass_buy')) {
                            const shop = await catalog(raw, 6);
                            const good = shop.goods.find((g: any) => g.available && g.reward.id === 7001 && g.reward.count === '1' && g.price.id === 1007 && BigInt(g.price.count) > 0n);
                            if (good) {
                                const count = affordable(good, Math.min(room - stock, good.maxCount, good.remaining ?? Infinity));
                                if (count > 0) await act('ranch_grass_buy', 'buy', { shopId: 6, goodsId: good.id, count }, 1007);
                            }
                        }
                        const count = Math.min(room, Number(available(7001)));
                        if (count > 0) await act('ranch_grass', 'addGrass', { facilityId: id, count });
                    }
                }
            });

            await phase('cans', async () => {
                if (enabled('ranch_fill_cans')) {
                    for (const item of inventory(raw).filter((item: any) => item.can && !item.locked)) {
                        const count = Number(BigInt(item.count) < available(item.id) ? BigInt(item.count) : available(item.id));
                        if (count > 0) await act('ranch_fill_cans', 'useCan', { uid: item.uid, count });
                    }
                }
            });

            await phase('feed-normal', async () => { if (enabled('ranch_feed_normal') && available(7003) > 0n) await act('ranch_feed_normal', 'feed', { all: true, bucketType: 2 }); });
            await phase('feed-organic', async () => { if (enabled('ranch_feed_organic') && available(7004) > 0n) await act('ranch_feed_organic', 'feed', { all: true, bucketType: 1 }); });

            await phase('friends', async () => {
                if (Object.values(FRIEND_CONTROLS).some(enabled)) {
                    checkpoint();
                    const interactions = require('./friends');
                    const times = await interactions.getInteractionTimes();
                    const wanted = (action: string) => enabled(FRIEND_CONTROLS[action])
                        && (!['stroke', 'putMosquito'].includes(action) || times[action] > 0);
                    if (Object.keys(FRIEND_CONTROLS).some(wanted)) {
                        const friends = await require('../friend').getFriendsList();
                        // 沿用本轮巡查，每轮最多拜访三位，避免长期占用农牧场共用连接。
                        for (; friendVisits < Math.min(3, friends.length) && Object.keys(FRIEND_CONTROLS).some(wanted); friendVisits++) {
                            checkpoint();
                            const friend = friends.find((row: any) => String(row.gid) === pendingFriendGid) || friends[nextFriendIndex % friends.length];
                            try {
                                const result = await interactions.automateFriend(friend.gid, wanted, shouldYield);
                                Object.assign(times, result.times);
                                steps++;
                                for (const outcome of result.results) {
                                    daily.markTasksChanged();
                                    log('牧场', `${friend.name}：${outcome.notice}`, { module: 'ranch', event: `ranch_${outcome.action}`, result: 'ok' });
                                }
                                if (result.yielded) {
                                    pendingFriendGid = String(friend.gid);
                                    throw Object.assign(new Error('牧场好友巡查让路'), { code: 'RANCH_PATROL_YIELD' });
                                }
                            } catch (error: any) {
                                if (error.name !== 'GatewayError' || error.methodName !== 'EnterHomestead') throw error;
                                log('牧场', `暂不能拜访 ${friend.name}：${error.message}`, { module: 'ranch', event: 'ranch_friend', result: 'skipped' });
                            }
                            pendingFriendGid = null;
                            nextFriendIndex++;
                        }
                    }
                }
            });

            if (cycleChanged) daily.markTasksChanged();
            await phase('tasks', async () => { if (enabled('ranch_task') && due(daily.getTaskRoutineState())) { checkpoint(); await daily.claimTasks(); steps++; } });
            await phase('share', async () => { if (enabled('ranch_share') && due(daily.getShareRoutineState())) { checkpoint(); await daily.claimShare(); steps++; } });
            nextCheckAt = Math.max(Date.now() + SCENE_REENTRY_MS, Math.min(nextCheckAt, nextActionAt, cycleChanged ? Date.now() + 30_000 : Infinity));
            resetCycle();
        });
    } catch (error: any) {
        if (error.code === 'RANCH_PATROL_YIELD') {
            nextCheckAt = Date.now() + SCENE_REENTRY_MS;
            return;
        }
        resetCycle();
        if (error.code === 'RANCH_AUTOMATION_DISABLED') return;
        nextCheckAt = Date.now() + Math.max(auto.ranch_check_minutes, 10) * 60_000;
        log('牧场', `日常牧场巡查失败：${error.message}`, { module: 'ranch', event: 'ranch_automation', result: 'error' });
    }
}

module.exports = {
    run, getRoutineState, selectAnimal,
    resetSchedule: () => { marketRunId++; nextCheckAt = 0; nextMarketCheckAt = 0; lastMarketBalances.clear(); resetCycle(); },
    resetMarketSchedule: () => {
        nextMarketCheckAt = 0;
        lastMarketBalances.clear();
        marketRunId++;
        completedPhases.delete('market-organic');
        nextCheckAt = Math.min(nextCheckAt, Date.now() + SCENE_REENTRY_MS);
    },
};

export {};

const network = require('../../utils/network');
const { types } = require('../../utils/proto');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const { getAmbientRequestClass } = require('../../utils/request-context');
const { logWarn } = require('../../utils/utils');
const { error } = require('./model');

const ROUTES: Record<string, [string, string, string, string?]> = {
    cells: ['homesteadpb.HomesteadService', 'AllCells', 'RanchAllCells'],
    buildings: ['homesteadpb.HomesteadService', 'GetBuildingList', 'RanchGetBuildingList'],
    facility: ['homesteadpb.HomesteadService', 'GetFacilityDetail', 'RanchGetFacilityDetail'],
    activateShed: ['homesteadpb.HomesteadService', 'ActivateFacility', 'RanchActivateFacility'],
    upgrade: ['homesteadpb.HomesteadService', 'UpgradeBuilding', 'RanchUpgradeBuilding'],
    completeUpgrade: ['homesteadpb.HomesteadService', 'CompleteBuildingUpgrade', 'RanchCompleteBuildingUpgrade'],
    addGrass: ['homesteadpb.FeedMachineService', 'AddFeed', 'RanchAddFeed'],
    animals: ['animalpb.AnimalService', 'GetRanchDetail', 'RanchGetRanchDetail'],
    enterFriend: ['visitpb.VisitService', 'EnterHomestead', 'RanchEnterHomestead'],
    leaveFriend: ['visitpb.VisitService', 'LeaveHomestead', 'RanchLeaveHomestead'],
    steal: ['animalpb.AnimalService', 'StealProduce', 'RanchStealProduce'],
    place: ['animalpb.AnimalService', 'PlaceAnimal', 'RanchPlaceAnimal'],
    produce: ['animalpb.AnimalService', 'TriggerProduce', 'RanchTriggerProduce'],
    harvest: ['animalpb.AnimalService', 'HarvestRanch', 'RanchHarvestRanch'],
    feed: ['animalpb.AnimalService', 'FeedAnimal', 'RanchFeedAnimal'],
    clean: ['animalpb.RanchService', 'CleanAllRanch', 'RanchCleanAllRanch'],
    stroke: ['animalpb.RanchService', 'StrokeAnimal', 'RanchStrokeAnimal'],
    opTimes: ['animalpb.RanchService', 'GetRanchOpTimes', 'RanchGetRanchOpTimes'],
    release: ['animalpb.AnimalService', 'DonateAnimal', 'RanchDonateAnimal'],
    putMosquito: ['animalpb.RanchService', 'PutHazard', 'RanchPutHazard'],
    bag: ['itempb.ItemService', 'GetBag', 'RanchGetBag'],
    bagTabs: ['itempb.ItemService', 'GetBagTab', 'RanchGetBagTab'],
    sell: ['itempb.ItemService', 'Sell', 'RanchSell'],
    useCan: ['itempb.ItemService', 'Use', 'RanchUse'],
    shopProfiles: ['shoppb.ShopService', 'ShopProfiles', 'ShopProfiles'],
    shop: ['shoppb.ShopService', 'ShopInfo', 'ShopInfo'],
    buy: ['shoppb.ShopService', 'BuyGoods', 'BuyGoods'],
    market: ['shoppb.ShopService', 'RotationShopInfo', 'RanchRotationShopInfo'],
    exchange: ['shoppb.ShopService', 'RotationBuyGoods', 'RanchRotationBuyGoods'],
    tasks: ['taskpb.TaskService', 'TaskInfo', 'TaskInfo'],
    claimTask: ['taskpb.TaskService', 'ClaimTaskReward', 'ClaimTaskReward'],
    claimTasks: ['taskpb.TaskService', 'BatchClaimTaskReward', 'BatchClaimTaskReward'],
    reportTask: ['taskpb.TaskService', 'ClientReportProgress', 'ClientReportProgress'],
    book: ['illustratedpb.IllustratedService', 'GetIllustratedListV2', 'RanchGetIllustratedListV2'],
    weightBook: ['illustratedpb.IllustratedService', 'GetRanchWeightScoreV2', 'RanchGetRanchWeightScoreV2'],
    claimBook: ['illustratedpb.IllustratedService', 'ClaimAllRewardsV2', 'RanchClaimAllRewardsV2'],
    claimWeight: ['illustratedpb.IllustratedService', 'ClaimRanchWeightScoreRewardV2', 'RanchClaimRanchWeightScoreRewardV2'],
    checkShare: ['sharepb.ShareService', 'CheckCanShare', 'CheckCanShare'],
    reportShare: ['sharepb.ShareService', 'ReportShare', 'RanchReportShare'],
    claimShare: ['sharepb.ShareService', 'ClaimShareReward', 'RanchClaimShareReward'],
    activities: ['activitypb.ActivityService', 'List', 'ActivityList'],
    canShop: ['mallpb.MallService', 'GetMallListBySlotType', 'GetMallListBySlotType', 'GetMallListBySlotTypeResponse'],
    buyCan: ['mallpb.MallService', 'Purchase', 'Purchase', 'PurchaseResponse'],
};

async function rpc(route: string, input: any = {}, writing = false): Promise<any> {
    const [service, method, type, replyType] = ROUTES[route];
    const request = types[`${type}Request`];
    const body = request.encode(request.fromObject(input)).finish();
    const context = getAmbientSendContext();
    const reply = await network.sendMsgAsync(`gamepb.${service}`, method, body, {
        beforeSend: () => context?.check(`gamepb.${service}`, method) || null,
        onSent: () => {
            if (!writing) return;
            // 写过之后本地快照一定过期，宁可下次多读一次也不要拿旧数据报价。
            clearRawCache();
            context?.onSent(`gamepb.${service}`, method);
        },
    });
    return types[replyType || `${type}Reply`].decode(reply.body);
}

/**
 * 短期快照：报价与执行是两个 HTTP 请求，中间会重复读 AllCells + GetBag。
 * 这里按账号缓存最近一次全量读的结果，写请求发出即失效；读面板（getState）走 fresh 绕过缓存。
 */
const RAW_CACHE_TTL_MS = 20_000;
let rawCache: { gid: number; at: number; cells: any; bag: any } | null = null;

function currentGid(): number {
    return Number(network.getUserState().gid) || 0;
}

function clearRawCache(): void {
    rawCache = null;
}

function cacheGet(kind: 'cells' | 'bag'): any {
    if (!rawCache || rawCache.gid !== currentGid() || Date.now() - rawCache.at > RAW_CACHE_TTL_MS) return null;
    return rawCache[kind] || null;
}

function cacheSet(kind: 'cells' | 'bag', value: any): void {
    const gid = currentGid();
    if (!rawCache || rawCache.gid !== gid || Date.now() - rawCache.at > RAW_CACHE_TTL_MS) {
        rawCache = { gid, at: Date.now(), cells: kind === 'cells' ? value : null, bag: kind === 'bag' ? value : null };
        return;
    }
    rawCache[kind] = value;
}

/**
 * 手动操作让路标记。
 *
 * 自动巡查整体占着 ranch.scene 队列（最长一个 5 秒切片），而面板点「一键收获」排在队尾，
 * 用户要等到巡查跑完才有响应。这里用请求班次区分：HTTP 面板请求没有环境班次（前台），
 * 自动巡查跑在 farm 班次里（由 schedules.ts 注入）。巡查的 checkpoint 看到有人在等就让路，
 * 5 秒内不重复让路。注意班次必须是 request-priority 白名单里的合法值，否则注入失败会让
 * isManualRequest() 恒真、巡查把自己也当成手动请求而反复让路。
 */
const MANUAL_WAIT_MS = 30_000;
const MANUAL_YIELD_COOLDOWN_MS = 5_000;
let manualAt = 0;
let manualYieldAt = 0;

function isManualRequest(): boolean {
    return getAmbientRequestClass() === null;
}

function markManualTurn(): void {
    manualAt = Date.now();
}

function isManualWaiting(): boolean {
    if (!manualAt) return false;
    if (Date.now() - manualAt > MANUAL_WAIT_MS) {
        manualAt = 0;
        return false;
    }
    return !(manualYieldAt && Date.now() - manualYieldAt < MANUAL_YIELD_COOLDOWN_MS);
}

function noteManualYield(): void {
    manualYieldAt = Date.now();
    manualAt = 0;
}

/** 当前场景与降级状态，供快照如实回传给前端。 */
function sceneStatus(): { sceneId: number; fallback: boolean; retryAt: number } {
    const sceneId = Number(network.getUserState().globalSceneId) || 0;
    return { sceneId, fallback: sceneId !== 2 && Date.now() < sceneLockedUntil, retryAt: sceneLockedUntil || 0 };
}

function isUnlocked(): boolean {
    const user = network.getUserState();
    if (Array.isArray(user.unlockedSceneIds) && user.unlockedSceneIds.includes(2)) return true;
    // 实测：部分账号的 PlayerLogin 回包 unlocked_scene_ids 只回 [1]，但 BasicInfo.f20
    // （牧场等级）>0 说明牧场其实已经开通。真正能不能进，由 loginGameScene(2) 的回包校验，
    // 这里只做「值不值得试一次」的判断，避免把已开通的账号误判成未解锁。
    return Number(user.ranchLevel) > 0;
}

const SCENE_LOCKED_CODE = 1045002;
/** 场景 2 判定为不可用后，这段时间内不再尝试切场，直接用当前场景读数据，避免每次操作白跑一条失败请求。 */
const SCENE_LOCKED_RETRY_MS = 30 * 60 * 1000;
let sceneLockedUntil = 0;
let sceneFallbackLogged = false;
let probedGid = 0;

/** 服务端「该场景还未解锁」：账号没开通场景 2 的入口，但牧场数据本身仍可在当前场景读取。 */
function isSceneLocked(err: any): boolean {
    if (!err) return false;
    const code = Number(err.code || err.errorCode || 0);
    if (code === SCENE_LOCKED_CODE) return true;
    const message = String(err.message || err.errorMessage || '');
    return message.includes('该场景还未解锁');
}

/**
 * 在牧场场景内执行一组操作。
 *
 * 标准做法是「先切到场景 2，再发写请求」。实测部分账号 PlayerSceneLogin(2) 会回
 * 1045002 该场景还未解锁，但 AllCells / GetRanchDetail / GetBag(global_scene_id=2)
 * 在场景 1 里都能正常返回牧场数据，所以这里做了降级：
 *   1) 场景 2 能进 → 切进去，用回包里的 homestead_cells；
 *   2) 场景 2 未解锁 → 不切场景，直接用 AllCells 读当前场景的牧场格子。
 * 写请求按牧场 v2 协议字段构造，是否被接受由服务端判定。
 */
function inScene(run: (cells: any) => Promise<any>, options: { fresh?: boolean } = {}): Promise<any> {
    return runExclusiveAutomationTask('ranch.scene', async () => {
        if (!isUnlocked()) throw error('RANCH_LOCKED', '牧场尚未解锁，请先在游戏中完成开启条件');
        const user = network.getUserState();
        // 换账号后重新探测场景能力，不要沿用上一个账号的判定。
        const gid = Number(user.gid) || 0;
        if (gid !== probedGid) {
            probedGid = gid;
            sceneLockedUntil = 0;
            sceneFallbackLogged = false;
            clearRawCache();
        }
        const previous = user.globalSceneId;
        const socket = network.getWs();
        let entered = false;
        let cells: any = null;
        let result: any;
        try {
            if (previous !== 2) {
                if (Date.now() >= sceneLockedUntil) {
                    try {
                        const scene = await network.loginGameScene(2);
                        entered = true;
                        sceneLockedUntil = 0;
                        cells = types.RanchSceneData.decode(scene.big_farm_scene_ext_data).homestead_cells;
                    } catch (sceneError: any) {
                        if (!isSceneLocked(sceneError)) throw sceneError;
                        sceneLockedUntil = Date.now() + SCENE_LOCKED_RETRY_MS;
                        if (!sceneFallbackLogged) {
                            sceneFallbackLogged = true;
                            logWarn('牧场', '场景 2 未解锁，改用当前场景读写牧场数据（30 分钟内不再尝试切场）', { module: 'ranch', event: 'ranch_scene_fallback' });
                        }
                    }
                }
            }
            // 读面板要最新数据；报价/执行复用 20 秒内的快照，省掉一次 AllCells。
            if (!cells) cells = (options.fresh ? null : cacheGet('cells')) || await rpc('cells');
            cacheSet('cells', cells);
            result = await run(cells);
            return result;
        } finally {
            if (entered && previous !== 2 && network.getWs() === socket) {
                try {
                    // 调用方取消后仍在原队列任务中恢复场景。
                    await runWithSendContext({ check: () => null, onSent: () => {} }, () => network.loginGameScene(previous));
                } catch (error: any) {
                    logWarn('牧场', `恢复场景 ${previous} 失败：${error.message}`, { module: 'ranch', event: 'ranch_scene_restore' });
                    network.invalidateGameScene('牧场操作结束后场景恢复未确认，需要重新登录');
                    if (result) Object.assign(result, { sceneRestored: false, refreshRequired: true, notice: '场景恢复未确认，账号需重新登录；请刷新核对操作结果' });
                }
            }
        }
    });
}

module.exports = {
    rpc, inScene, isUnlocked, sceneStatus,
    cacheGet, cacheSet, clearRawCache,
    isManualRequest, markManualTurn, isManualWaiting, noteManualYield,
};

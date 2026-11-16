export {};

const network = require('../../utils/network');
const { types } = require('../../utils/proto');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const { logWarn } = require('../../utils/utils');
const { error } = require('./model');

const ROUTES: Record<string, [string, string, string, string?]> = {
    cells: ['homesteadpb.HomesteadService', 'AllCells', 'RanchAllCells'],
    buildings: ['homesteadpb.HomesteadService', 'GetBuildingList', 'RanchGetBuildingList'],
    facility: ['homesteadpb.HomesteadService', 'GetFacilityDetail', 'RanchGetFacilityDetail'],
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
        onSent: () => { if (writing) context?.onSent(`gamepb.${service}`, method); },
    });
    return types[replyType || `${type}Reply`].decode(reply.body);
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
 * 上游实现是「先切到场景 2，再发写请求」。实测本账号 PlayerSceneLogin(2) 会回
 * 1045002 该场景还未解锁，但 AllCells / GetRanchDetail / GetBag(global_scene_id=2)
 * 在场景 1 里都能正常返回牧场数据，所以这里做了降级：
 *   1) 场景 2 能进 → 切进去，用回包里的 homestead_cells；
 *   2) 场景 2 未解锁 → 不切场景，直接用 AllCells 读当前场景的牧场格子。
 * 写请求的字段与上游完全一致，是否被接受由服务端判定。
 */
function inScene(run: (cells: any) => Promise<any>): Promise<any> {
    return runExclusiveAutomationTask('ranch.scene', async () => {
        if (!isUnlocked()) throw error('RANCH_LOCKED', '牧场尚未解锁，请先在游戏中完成开启条件');
        const user = network.getUserState();
        // 换账号后重新探测场景能力，不要沿用上一个账号的判定。
        const gid = Number(user.gid) || 0;
        if (gid !== probedGid) {
            probedGid = gid;
            sceneLockedUntil = 0;
            sceneFallbackLogged = false;
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
            if (!cells) cells = await rpc('cells');
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

module.exports = { rpc, inScene, isUnlocked };

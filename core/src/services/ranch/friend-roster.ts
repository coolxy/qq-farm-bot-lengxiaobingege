import { extractReplyFriends, fetchAllFriendsForScene, fetchFriendsByGids, QQ_FRIEND_LIST_BATCH_SIZE } from '../friend/gid-manager';

export interface RanchFriend {
    gid: number;
    name: string;
    avatarUrl: string;
}

const { CONFIG } = require('../../config/config');
const { getKnownFriendGids, getFriendsListCacheTtlSec } = require('../../models/store');
const { getWs, getUserState } = require('../../utils/network');
const { randomDelay, toNum } = require('../../utils/utils');
const { error } = require('./model');

interface RosterScope {
    socket: unknown;
    key: string;
}

let cache: (RosterScope & { friends: RanchFriend[]; expiresAt: number }) | null = null;
let sync: (RosterScope & { offset: number; friends: Map<number, RanchFriend> }) | null = null;

// 调用方持有牧场场景任务。同步分批保留进度，让路后从下一批继续。
// 好友名单请求（GetGameFriends/GetAllFriends）自带 global_scene_id=2，不依赖连接当前场景；
// 因此场景 2 未解锁、走「当前场景读牧场」降级的账号也能同步好友，不再硬性要求 globalSceneId===2。
export async function getRanchFriendList(checkpoint?: (completedBatch: boolean) => void): Promise<RanchFriend[]> {
    const state = getUserState();
    const self = toNum(state.gid);
    const socket = getWs();
    const gids: number[] = CONFIG.platform === 'qq' ? getKnownFriendGids().filter((gid: number) => gid !== self) : [];
    const key = `${CONFIG.platform}:${self}:${gids.join(',')}`;
    if (cache && cache.socket === socket && cache.key === key && Date.now() < cache.expiresAt) return cache.friends;
    if (!sync || sync.socket !== socket || sync.key !== key) {
        sync = { socket, key, offset: 0, friends: new Map() };
    }
    const current = sync;
    while (current.offset < Math.max(gids.length, 1)) {
        checkpoint?.(false);
        const batch = gids.slice(current.offset, current.offset + QQ_FRIEND_LIST_BATCH_SIZE);
        const rows = batch.length
            ? await fetchFriendsByGids(batch, 2)
            : extractReplyFriends(await fetchAllFriendsForScene(2));
        // 只校验连接未变；不再要求 globalSceneId===2（降级账号在场景 1 同步好友名单）。
        if (getWs() !== socket) {
            throw error('RANCH_FRIEND_SESSION_CHANGED', '牧场好友同步期间连接已变化');
        }
        const requested = new Set(batch);
        for (const friend of rows) {
            const gid = toNum(friend.gid);
            // GID 只是查询线索，以牧场回包中的状态确认名单资格。
            if (gid <= 0 || gid === self || !friend.big_farm_status || (batch.length && !requested.has(gid))) continue;
            current.friends.set(gid, {
                gid,
                name: friend.name.trim() || friend.remark.trim() || `GID:${gid}`,
                avatarUrl: friend.avatar_url.trim(),
            });
        }
        current.offset += Math.max(batch.length, 1);
        checkpoint?.(true);
        if (current.offset < gids.length) await randomDelay(500, 1000);
    }
    const friends = [...current.friends.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.gid - b.gid);
    cache = { socket, key, friends, expiresAt: Date.now() + getFriendsListCacheTtlSec() * 1000 };
    sync = null;
    return friends;
}

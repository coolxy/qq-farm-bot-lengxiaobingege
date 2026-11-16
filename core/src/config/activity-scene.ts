import type { ActivityWindow } from './sell-conditions';

export {};

/**
 * 活动归属场景。
 *
 * ActivityList 是全局的：协议里没有场景字段（ActivityListRequest 是空消息），
 * 服务端也不按当前场景过滤，所以农场活动中心与牧场活动页此前拿到的是同一份数据，
 * 牧场页因此把「奶茶热销中」「故友重逢」这类农场/全局活动当成了牧场活动。
 *
 * 唯一可用的信号是 ActivityContent.extra 里的 UI 标识 uid：
 * 牧场活动主界面是 MugeMainUI（牧歌初启，2026-11-17 由抓到的真实 extra 确认）。
 * 新牧场活动如果换了界面标识，把前缀或活动 id 补进下面的表即可。
 */

/** 牧场活动界面标识前缀（Muge = 牧歌）。 */
const RANCH_UID_PREFIXES = ['Muge'];

/** 已确认的牧场活动 id：2026111700 牧歌初启，2026111707 以薯换福（牧歌初启内嵌兑换）。 */
const RANCH_ACTIVITY_IDS = new Set(['2026111700', '2026111707']);

export type ActivityScope = 'ranch' | 'global';

function isRanchByUid(uid: string): boolean {
    const value = String(uid || '').trim();
    if (!value) return false;
    return RANCH_UID_PREFIXES.some(prefix => value.startsWith(prefix));
}

/** 判断一条活动是否属于牧场场景。未识别的活动一律按全局处理，不混进牧场页。 */
export function activityScope(window: ActivityWindow): ActivityScope {
    if (!window) return 'global';
    if (isRanchByUid(window.uid || '')) return 'ranch';
    if (RANCH_ACTIVITY_IDS.has(String(window.id || '').trim())) return 'ranch';
    return 'global';
}

export function isRanchActivity(window: ActivityWindow): boolean {
    return activityScope(window) === 'ranch';
}

module.exports = { activityScope, isRanchActivity, RANCH_ACTIVITY_IDS };

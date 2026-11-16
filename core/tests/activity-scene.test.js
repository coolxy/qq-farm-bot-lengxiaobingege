const assert = require('node:assert/strict');
const test = require('node:test');

const { decodeActivityWindows, decodeActivityExtra } = require('../dist/services/activity-windows');
const { activityScope, isRanchActivity } = require('../dist/config/activity-scene');

/**
 * 牧场活动页此前直接展示全局 ActivityList，把「奶茶热销中」「故友重逢」这类农场活动
 * 当成了牧场活动。归属只能靠 ActivityContent.extra.uid 判断（协议里没有场景字段），
 * 这里锁住解码与归类两段逻辑。
 */
function extra(value) {
    return Buffer.from(JSON.stringify(value), 'utf8');
}

test('decodeActivityExtra 解析界面标识并剥离富文本标签', () => {
    const result = decodeActivityExtra(extra({
        uid: 'MugeMainUI',
        tips: { txt: ['<b>【活动时间】</b>', '2026年11月17日 — 2026年11月30日'] },
    }));
    assert.equal(result.uid, 'MugeMainUI');
    assert.deepEqual(result.rules, ['【活动时间】', '2026年11月17日 — 2026年11月30日']);
});

test('decodeActivityExtra 对非 JSON 内容返回空值而不是抛错', () => {
    assert.deepEqual(decodeActivityExtra(Buffer.from('not json')), { uid: '', rules: [] });
    assert.deepEqual(decodeActivityExtra(undefined), { uid: '', rules: [] });
});

test('decodeActivityWindows 把活动树里的 uid 与说明带到时间窗口上', () => {
    const windows = decodeActivityWindows({
        activity_windows: [
            { id: '2026111700', name: '牧歌初启', begin_time: 1794880800, end_time: 1796054399 },
            { id: '2026110100', name: '奶茶热销中', begin_time: 1792029600, end_time: 1794844799 },
        ],
        activities: [
            {
                activity: {
                    activity_id: '2026111700',
                    type: 1,
                    name: '牧歌初启',
                    extra: extra({ uid: 'MugeMainUI', tips: { txt: ['牧场活动'] } }),
                },
            },
            {
                activity: { activity_id: '2026110100', type: 1, name: '奶茶热销中', extra: extra({ uid: 'MilkTeaActivity' }) },
            },
        ],
    });
    assert.equal(windows.get('2026111700').uid, 'MugeMainUI');
    assert.deepEqual(windows.get('2026111700').rules, ['牧场活动']);
    assert.equal(windows.get('2026110100').uid, 'MilkTeaActivity');
});

test('activityScope 按 uid 前缀与已确认 id 区分牧场活动', () => {
    assert.equal(activityScope({ id: '2026111700', beginTime: 0, endTime: 0, uid: 'MugeMainUI' }), 'ranch');
    // ActivityList 的树里没有牧场活动节点时拿不到 uid，靠 id 兜底
    assert.equal(activityScope({ id: '2026111707', beginTime: 0, endTime: 0 }), 'ranch');
    assert.equal(activityScope({ id: '2026110100', beginTime: 0, endTime: 0, uid: 'MilkTeaActivity' }), 'global');
    assert.equal(activityScope({ id: '2026111800', beginTime: 0, endTime: 0 }), 'global');
    assert.equal(isRanchActivity({ id: '2026111700', beginTime: 0, endTime: 0, uid: 'MugeMainUI' }), true);
    assert.equal(isRanchActivity({ id: '2026092200', beginTime: 0, endTime: 0 }), false);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { decodeActivityWindows, decodeActivityExtra } = require('../dist/services/activity-windows');
const { activityScope, isRanchActivity, isGlobalActivity } = require('../dist/config/activity-scene');

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

test('isGlobalActivity 反向过滤牧场活动，农场活动中心据此不串台', () => {
    // 牧场专属活动被排除（含没有 uid 的子活动 id）
    assert.equal(isGlobalActivity({ id: '2026111700', beginTime: 0, endTime: 0, uid: 'MugeMainUI' }), false);
    assert.equal(isGlobalActivity({ id: '2026111707', beginTime: 0, endTime: 0 }), false);
    assert.equal(isGlobalActivity({ id: '2026111702', beginTime: 0, endTime: 0 }), false);
    assert.equal(isGlobalActivity({ id: '2026111708', beginTime: 0, endTime: 0 }), false);
    // 农场/全局活动保留；18 日的故友重逢不能被 17 日前缀误伤
    assert.equal(isGlobalActivity({ id: '2026110100', beginTime: 0, endTime: 0, uid: 'MilkTeaActivity' }), true);
    assert.equal(isGlobalActivity({ id: '2026111800', beginTime: 0, endTime: 0 }), true);
    // 未识别、无 id 的兜底项按全局处理，避免误删
    assert.equal(isGlobalActivity({ beginTime: 0, endTime: 0 }), true);
});

test('buildActivityDirectory 不把牧场活动混进农场活动目录', () => {
    const { buildActivityDirectory } = require('../dist/services/activity-center');
    const windows = [
        { id: '2026111700', name: '牧歌初启', beginTime: 1794880800, endTime: 1796054399, uid: 'MugeMainUI' },
        { id: '2026111702', name: '牧歌初启-子活动', beginTime: 0, endTime: 0 },
        { id: '2026111707', name: '以薯换福', beginTime: 0, endTime: 0 },
        { id: '2026111708', name: '以薯换福-子活动', beginTime: 0, endTime: 0 },
        { id: '2026110100', name: '奶茶热销中', beginTime: 1792029600, endTime: 1794844799, uid: 'MilkTeaActivity' },
        { id: '2026111800', name: '故友重逢', beginTime: 0, endTime: 0 },
    ];
    const names = buildActivityDirectory(windows, null, null, null, null).map((g) => g.name);
    assert.ok(names.includes('奶茶热销中'), '农场活动应保留');
    assert.ok(names.includes('故友重逢'), '18 日的全局活动应保留');
    assert.ok(!names.some(n => n.startsWith('牧歌初启')), '牧场活动不应出现在农场目录');
    assert.ok(!names.some(n => n.startsWith('以薯换福')), '牧场活动不应出现在农场目录');
});

# 牧场（ranch）模块说明

牧场功能整体移植自上游 [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot) 的 `ranch` 实现（PR #134 / #135 / #136），
替代原先自研的 `services/pasture`（旧实现只保留 `/api/pasture` 手动接口，不再参与调度）。

## 一、为什么不能直接合并上游

- 本地与上游是**两套独立 Git 历史**（`git merge` 直接报 unrelated histories），且本地领先 139 个提交、上游领先 132 个。
- worker 层结构完全不同：上游把 worker 收敛成单个 `core/src/core/worker.ts`，本地是按 `worker/{schedules,api-handlers,runtime-config,state...}.ts` 拆分。
- proto 同名消息字段不同：本地 `animalpb` 的 `HarvestRanch` / `FeedAnimal` / `GetRanchDetail` 是按我们自己的抓包手写的，
  与上游从官方定义整理的版本**字段编号语义不同**，直接复用会解码错位。

因此采用「**按模块移植 + 独立命名空间**」：

| 层 | 处理方式 |
| --- | --- |
| proto | 上游 `animalpb` / `homesteadpb` / `ranchpb` 合并成新包 `gamepb.ranchv2`（`core/src/proto/ranchv2.proto`，139 条消息），在 `utils/proto.ts` 以 `Ranch<名字>` 注册，与本地既有 proto 完全隔离 |
| 服务 | `core/src/services/ranch/`（13 个文件）原样搬入，仅补 `any` 类型标注 |
| 配置 | `core/src/gameConfig/ranch/*.json`（10 份，约 1.1MB）、`core/src/gameConfig/Goods.json`（商店商品，牧场补栏/升级要读）、`core/src/config/ranch-automation.ts`；`config/gameConfig.ts` 补 `getShopGoodsById`（运行时按 runtime-paths 加载，不走静态 import） |
| 网络 | 新增 `utils/network/scene.ts`：`loginGameScene` / `invalidateGameScene` / `applyShareInfos` / `getDailyShareInfo`；`S.user` 增加 `globalSceneId`、`unlockedSceneIds`；`sendMsgAsync` 支持 `beforeSend` / `onSent` 钩子 |
| 调度 | `worker/schedules.ts` 的牧场 tick 改为唤醒 `ranch/automation.run()`，间隔由 `ranch_check_minutes` 决定；开关变化时 `ranchAutomation.resetSchedule()` |
| 接口 | `GET /api/ranch?view=`、`POST /api/ranch/:action/quote`、`POST /api/ranch/:action`、`GET /api/ranch/automation-options` |
| 前端 | `web/src/components/ranch/*`（11 个面板）、`views/Ranch.vue`、`views/RanchOverview.vue`、`stores/ranch.ts`；侧边栏「牧场」进入概览，页内分区：概览 / 个人 / 图鉴 / 活动 / 好友 / 商城 |

## 二、关键适配：场景 2

上游所有牧场写操作都包在 `transport.inScene(2)` 里（先 `PlayerSceneLogin(2)` 切到牧场场景，再发写请求），
这是「请求字节完全正确但服务端一直拒绝」的根因。

实测本账号 `PlayerSceneLogin(2)` 返回 `1045002 该场景还未解锁`，而 `AllCells` / `GetRanchDetail` / `GetBag(global_scene_id=2)`
在场景 1 里都能正常返回牧场数据。因此 `inScene` 做了降级：

1. 场景 2 能进 → 切进去，用回包 `big_farm_scene_ext_data` 解出的 `homestead_cells`；
2. 场景 2 未解锁 → 不切场景，改用 `AllCells` 读当前场景的牧场格子，**30 分钟内不再重试切场**（避免每次操作白跑一条失败请求）；
3. 换账号（gid 变化）时重置该判定。

## 三、接口速查

| 能力 | 路由 |
| --- | --- |
| 快照 | `GET /api/ranch?view=animals\|facilities\|bag\|shop\|market\|cans\|tasks\|illustrated\|activities\|friends&shopId=&hostGid=` |
| 报价（不落库） | `POST /api/ranch/:action/quote`，返回 `expected.signature` |
| 执行 | `POST /api/ranch/:action`，body 需带 `expected.signature`，否则回 `RANCH_OFFER_CHANGED` |
| 动作 | `buy / place / addGrass / useCan / feed / produce / harvest / sell / clean / upgrade / completeUpgrade / claimTasks / reportEntry / exchange / claimIllustrated / claimDailyShare / buyCan / steal / stroke / release / putMosquito / cleanFriend` |

注意：`harvest` / `produce` / `feed` 等按单只动物操作时必须同时给 `ranchId` + `animalId`；批量用 `{ all: true }`。

## 四、自动化开关

`core/src/config/ranch-automation.ts` 定义，落库在账号配置 `automation.ranch_*`，默认值见 `models/store/shared-state.ts`。
非布尔键（`ranch_strategy` / `ranch_bag_fallback` / `ranch_check_minutes` / `ranch_coop_animal` / `ranch_shed_animal`）
在 `normalizeAccountConfig` 里走 `normalizeRanchSetting` 校验，不会被当成布尔值。

## 五、已验证

- `GET /api/ranch?view=animals` 返回牧场 Lv.9、金券/点券/金豆豆/松果、普通罐头 72.8h、有机罐头 0h、牧草 770、窝 Lv2 4/4（鹅 ×4）。
- 十个视图（animals / facilities / bag / shop / market / cans / tasks / illustrated / activities / friends）全部可读。
- 报价链路：`harvest` / `clean` / `addGrass` / `upgrade` 返回 skipped 或明确业务提示，不再抛服务端原始错误码。
- 前端概览、个人（动物详情卡片、喂养/放生/一键收获）、设置页牧场开关均正常渲染。
- 后端 360 项测试 359 通过 / 1 跳过 / 0 失败，前后端类型检查通过。

## 六、已知限制（游戏状态导致，不是代码问题）

- 有机罐头 0、普通罐头每只动物一生一次已用过 → 按钮点「喂养」会被服务端拒绝，属正常业务态。
- 动物全部处于生产期且 `canHarvest=false` → 收获/催产返回「没有可收取的产物」。
- 牧草机 100/100 已满 → 补草被拒（`RANCH_GRASS_CAPACITY`）。
- 棚（facility id=3）尚未建造，`state=2`，升级按钮不可用。

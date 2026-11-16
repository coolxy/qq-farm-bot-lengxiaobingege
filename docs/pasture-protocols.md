# 牧场协议实测记录（2026-11-16）

本文件记录牧场模块的线上实测结论。抓包来自微信端 1.17.0.3，请求体用项目自带
`core/src/utils/crypto-wasm.ts` 的 `decryptBuffer` 解密后逐字段核对（replies 方向解不开，
只能以"发了什么 + 服务器回什么错误码"推断）。

## 1. 关键事实

| 项目 | 结论 | 依据 |
| --- | --- | --- |
| 牧草上限 | **100**（不是 3000/6000） | `RanchInfo.f5.amount=100`、`GetFacilityDetail.unknown_14=100` |
| 牧场等级 | 登录回包 `BasicInfo.f20` | 实测 9，与游戏内一致 |
| 牧草机等级 | `FacilityDetail.config_id_2 % 1000` | 7001001 → Lv1 |
| 窝等级 | `FacilityDetail.config_id_2 % 1000` | 6001002 → Lv2；`unknown_14` = 格数 4 |
| 抚摸服务 | `gamepb.animalpb.RanchService.StrokeAnimal` | 发到 `AnimalService` 恒回 `1020002 网络繁忙` |
| 抚摸请求 | `{owner_gid, animal:{ranch_inst_id, animal_inst_id}}` | 解密报文 `08<gid>1205 08 914e 10 2e` |
| 好友牧场详情 | `GetRanchDetail{ f1 = 好友 gid, f2 = 空 }` | 解密报文 `08<gid>1200`；不带 f1 只会读回自己的牧场 |
| 清灾害 | 用 `RanchService.CleanAllRanch` | 无灾害回 `1045233 这里没有需要清理的蚊子或便便`；`PutHazard` 无灾害时回 `1000020 请求参数错误` |
| 商城罐头 | `MallService.GetMallListBySlotType{slot_type:6, global_scene_id:2}` | 80031 有机罐头 1 小时，5 金券 |

## 2. 业务态错误码（不是故障，不要按错误刷屏）

| 码 | 含义 | 处理 |
| --- | --- | --- |
| 1045211 | 当前没有可收取的产物 | 冷却 4 分钟，info 记录 |
| 1045233 | 没有需要清理的蚊子/便便 | 冷却 10 分钟 |
| 1045136 | 牧草机已满 | 冷却 10 分钟，加草前先看牧草机余量 |
| 1045234 | 罐头桶已耗尽，请先添加罐头 | 冷却 30 分钟，提示去牧场商店买有机罐头 |
| 1045226 | 该动物已用过无机罐头桶（一生一次） | 排除该动物，改用有机罐头桶 |
| 1045207 | 动物不存在（刷新/刚被收获） | 冷却 5 分钟 |
| 1000020 | 目标不存在或当前不可操作 | 冷却 60 分钟 |

## 3. 仍未打通

- **进入好友家园后拿不到对方牧场数据**：`EnterHomestead{host_gid, reason}` 回包带 `BasicInfo`
  （说明请求本身被接受），随后 `GetRanchDetail{f1=host_gid}` 只回 `f2=30` 的 2 字节空回包，
  没有 ranch。抓包里同样的请求能拿到数据，差异只可能在客户端场景状态（需真正切到好友家园场景）。
  当前实现会在日志里记一条"好友牧场数据未返回"，并跳过本轮，不再对多个好友连撞。
- **抚摸自己的动物**：请求形态与抓包完全一致，服务端仍回 `1000020`。抓包里的抚摸全部发生在
  好友家园（`owner_gid` = 好友），推测只允许抚摸他人动物。建议先用真实客户端在好友家园里
  抓一次"进入家园 + 抚摸"的完整包再定论。

## 4. 代码位置

- `core/src/services/pasture/api.ts` — 协议封装
- `core/src/services/pasture/analysis.ts` — 可收获/可喂/可抚摸判定，牧草阈值
- `core/src/services/pasture/scheduler.ts` — 自动班次、业务码分类、每轮"为什么没动作"的原因
- `core/src/services/pasture/index.ts` — 快照 DTO（等级/牧草机/窝/商城/日志说明）
- `web/src/views/Pasture.vue` — 牧场面板 + 牧场日志

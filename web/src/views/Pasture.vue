<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { NButton } from 'naive-ui/es/button'
import { NInputNumber } from 'naive-ui/es/input-number'
import { NSpin } from 'naive-ui/es/spin'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useFriendStore } from '@/stores/friend'
import { usePastureStore } from '@/stores/pasture'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const pastureStore = usePastureStore()
const statusStore = useStatusStore()
const friendStore = useFriendStore()
const toast = useToastStore()
const { currentAccountId } = storeToRefs(accountStore)
const { currentAccountConnected: isConnected } = storeToRefs(statusStore)
const { data, loading, operating, error } = storeToRefs(pastureStore)
const { friends } = storeToRefs(friendStore)

const buyCount = ref(1)
const canCount = ref(1)
const selectedFriendGid = ref<number | string>('')
const visitResult = ref('')
const friendRanch = ref<any>(null)

const animals = computed<any[]>(() => (data.value && Array.isArray(data.value.animals)) ? data.value.animals : [])
const quotas = computed<any[]>(() => (data.value && Array.isArray(data.value.quotas)) ? data.value.quotas : [])
const grass = computed(() => Number(data.value?.grass) || 0)
const capacity = computed(() => Number(data.value?.capacity) || 0)
const animalCount = computed(() => Number(data.value?.animalCount) || animals.value.length)
const facility = computed(() => data.value?.facility || null)
const nest = computed<any>(() => data.value?.nest || null)
const cubGoods = computed<any>(() => data.value?.cubShop?.cub || null)
const cannedCount = computed(() => Number(data.value?.cannedCount) || 0)
const bucketSeconds = computed(() => Number(data.value?.bucketSeconds) || 0)
const lastActions = computed<string[]>(() => (data.value && Array.isArray(data.value.lastActions)) ? data.value.lastActions : [])
const ranchLevel = computed(() => Number(data.value?.ranchLevel?.current) || 0)
const mallGoods = computed<any[]>(() => (data.value && Array.isArray(data.value.mallGoods)) ? data.value.mallGoods : [])
const cannedGoods = computed<any[]>(() => mallGoods.value.filter((g: any) => /罐头/.test(g.name || '')))
const rotationGoods = ref<any[]>([])
const rotationCategories = ref<any[]>([])
const rotationLoaded = ref(false)
const rotationDaySec = ref(0)

// 牧场日志：只取 module=pasture 的日志，跟「看板 · 运行日志」全量日志分开，
// 这样牧场相关的收获/喂养/补草/抚摸/清灾害/好友互动都能在一个地方看全。
const pastureLogs = ref<any[]>([])
const pastureLogLoading = ref(false)
const pastureLogKeyword = ref('')
const grassCapacity = computed(() => Number(data.value?.grassCapacity) || 100)
const notes = computed<string[]>(() => (data.value && Array.isArray(data.value.notes)) ? data.value.notes : [])
const machineFull = computed(() => {
  const f = facility.value
  return !!f && Number(f.capacity) > 0 && Number(f.grass) >= Number(f.capacity)
})

const filteredLogs = computed(() => {
  const keyword = pastureLogKeyword.value.trim()
  const list = [...pastureLogs.value]
  const filtered = keyword
    ? list.filter((log: any) => String(log.msg || '').includes(keyword) || String(log.tag || '').includes(keyword))
    : list
  return filtered
    .sort((a: any, b: any) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, 120)
})

function logLevel(log: any): string {
  const result = String(log?.meta?.result || '')
  if (result === 'error' || log?.tag === '错误')
    return 'error'
  if (result === 'skip' || log?.isWarn || log?.tag === '警告')
    return 'warn'
  if (result === 'ok')
    return 'success'
  return 'info'
}

function formatLogTime(log: any): string {
  const ts = Number(log?.ts) || Date.parse(String(log?.time || '')) || 0
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

async function fetchPastureLogs() {
  const accountId = currentAccountId.value
  if (!accountId)
    return
  pastureLogLoading.value = true
  try {
    const { data: body } = await api.get('/api/logs', {
      headers: { 'x-account-id': accountId },
      params: { limit: 200, module: 'pasture' },
      skipErrorToast: true,
    } as any)
    if (body?.ok)
      pastureLogs.value = Array.isArray(body.data) ? body.data : []
  }
  catch {
    // 日志读取失败不影响牧场主面板
  }
  finally {
    pastureLogLoading.value = false
  }
}

useIntervalFn(() => {
  if (currentAccountId.value)
    void fetchPastureLogs()
}, 10_000)

function currencyLabel(currencyId: number): string {
  return ({ 1002: '点券', 1004: '金券', 1007: '金券' } as any)[currencyId] || `货币${currencyId}`
}

async function buyMallItem(goodsId: number, name: string) {
  await run('buyMallGoods', { goodsId, num: 1 })
  if (!error.value) toast.success(`已购买 ${name}`)
}

async function loadRotationShop() {
  if (!currentAccountId.value || !isConnected.value) {
    toast.error('请先选择账号并确认已连接')
    return
  }
  const ok = await pastureStore.operate(currentAccountId.value, 'rotationShopInfo', { shopId: 7 })
  if (ok) {
    const result: any = pastureStore.lastResult
    rotationCategories.value = Array.isArray(result?.categories) ? result.categories : []
    rotationGoods.value = Array.isArray(result?.goods) ? result.goods : []
    rotationDaySec.value = Number(result?.rotationDaySec) || 0
    rotationLoaded.value = true
    toast.success('轮换商店已加载')
  }
  else {
    toast.error(error.value || '加载失败')
  }
}

async function buyRotationItem(goods: any) {
  await run('rotationBuy', {
    goodsId: goods.goodsId,
    rotationDaySec: rotationDaySec.value || 1794758400,
  })
}
const friendOptions = computed(() => friends.value
  .map((friend: any) => ({
    label: `${friend.name || friend.nick || '好友'} (${friend.gid})`,
    value: Number(friend.gid),
  }))
  .filter((option: any) => Number.isFinite(option.value) && option.value > 0))

function formatClock(ms: number): string {
  if (!ms || ms > 9007199254740992)
    return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatBucket(seconds: number): string {
  if (!seconds || seconds <= 0) return '0'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}小时${minutes ? `${minutes}分` : ''}` : `${minutes}分`
}

function stageLabel(stage: number): string {
  // 实包核对：stage 4 的动物 mature_ready_at 还没到，所以 stage4 不是「可收获」，只是成年后期。
  return ({ 1: '幼崽', 2: '成长期', 3: '成年', 4: '壮年', 5: '成熟' } as any)[stage] || `阶段${stage}`
}

/** 这只动物下一步该做什么：喂食 / 等产物 / 已就绪可收 */
function animalNextStep(a: any): string {
  if (a.canHarvest)
    return '产物就绪，点「一键收取」'
  if (a.matureReadyAt && a.matureReadyAt > Date.now())
    return `成熟倒计时：${formatRemain(a.matureReadyAt - Date.now())}`
  if (a.canFeed)
    return bucketSeconds.value > 0 ? '等待喂食（消耗罐头桶时长）' : '等待喂食，但罐头桶已空'
  return '产出积累中'
}

function formatRemain(ms: number): string {
  if (!ms || ms <= 0) return '已就绪'
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}小时${minutes % 60}分`
  return `${minutes}分`
}

function quotaLabel(opId: number): string {
  return ({ 11003: '清灾害', 11008: '抚摸', 11009: '其他互动' } as any)[opId] || `操作 ${opId}`
}

function refresh() {
  if (!currentAccountId.value)
    return
  void pastureStore.fetch(currentAccountId.value)
  void fetchPastureLogs()
}

async function run(action: string, input: any = {}) {
  if (!currentAccountId.value || !isConnected.value) {
    toast.error('请先选择账号并确认已连接')
    return
  }
  const base = { ranchInstId: data.value?.ranchInstId, ownerGid: data.value?.ownerGid }
  const ok = await pastureStore.operate(currentAccountId.value, action, { ...base, ...input })
  void fetchPastureLogs()
  if (ok) {
    // 后端会把「没有可收取的产物」这类业务态当作成功返回，但带一句人话说明，用 info 展示即可。
    const message = String(pastureStore.lastResult?.message || '')
    if (message && /没有可|没有需要|已满|已用完/.test(message))
      toast.info(message)
    else
      toast.success(message || '操作成功')
    return
  }
  const message = error.value || '操作失败'
  // 「没有可收取的产物」「没有需要清理的」等是服务器正常业务态，不该显示为红色错误。
  if (/没有可|不需要|没有需要|无需|已领取|已收获/.test(message))
    toast.info(message)
  else
    toast.error(message)
}

async function buyCub() {
  const count = Math.max(1, Number(buyCount.value) || 1)
  await run('buyCub', { num: count })
}

async function refillBucket() {
  const count = Math.max(1, Number(canCount.value) || 1)
  await run('refillBucket', { count })
}

async function visitFriend() {
  const hostGid = Number(selectedFriendGid.value) || 0
  if (!hostGid) {
    toast.error('请先选择一位好友')
    return
  }
  visitResult.value = ''
  friendRanch.value = null
  const base = { ranchInstId: data.value?.ranchInstId, ownerGid: data.value?.ownerGid }
  const ok = await pastureStore.operate(currentAccountId.value!, 'visitFriend', {
    ...base,
    hostGid,
    interact: true,
    stroke: true,
    clearHazard: true,
  })
  if (ok) {
    const result: any = pastureStore.lastResult
    friendRanch.value = result
    const interactions = Array.isArray(result?.interaction) ? result.interaction.join('、') : ''
    visitResult.value = interactions
      ? `已完成：${interactions}`
      : '本次无可互动项'
    toast.success('已访问好友牧场')
  }
  else {
    toast.error(error.value || '访问失败')
  }
}

watch(currentAccountId, (id) => {
  if (id) {
    refresh()
    void friendStore.fetchFriendsCache(id)
  }
  else {
    pastureStore.reset()
    pastureLogs.value = []
  }
})

onMounted(() => {
  refresh()
  if (currentAccountId.value)
    void friendStore.fetchFriendsCache(currentAccountId.value)
})
</script>

<template>
  <div class="page-stack">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
          牧场
        </h3>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          内测功能 · 数据来自客户端实包解析
        </p>
      </div>
      <NButton size="small" :loading="loading" @click="refresh">
        刷新
      </NButton>
    </div>

    <div v-if="loading && !data" class="py-16 text-center text-gray-500">
      <NSpin size="large" />
    </div>
    <EmptyState
      v-else-if="!data"
      :title="error ? '牧场数据读取失败' : '暂无牧场数据'"
      :description="error || '请确认账号已连接且已加入牧场内测'"
      :tone="error ? 'error' : 'default'"
    />
    <div v-else class="space-y-4">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            动物
          </div>
          <div class="mt-1 text-xl text-gray-900 font-bold dark:text-gray-100">
            {{ animalCount }} / {{ capacity }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            牧草
          </div>
          <div class="mt-1 text-xl text-gray-900 font-bold dark:text-gray-100">
            {{ grass }}<span class="text-xs text-gray-400">/{{ grassCapacity }}</span>
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            牧场等级
          </div>
          <div class="mt-1 text-sm text-gray-900 font-bold dark:text-gray-100">
            {{ ranchLevel ? `Lv.${ranchLevel}` : '—' }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            牧草机
          </div>
          <div class="mt-1 text-sm text-gray-900 font-bold dark:text-gray-100">
            {{ facility ? `Lv.${facility.level}` : '—' }}
          </div>
          <div v-if="facility" class="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
            草量 {{ facility.grass }}/{{ facility.capacity }}{{ machineFull ? ' · 已满' : '' }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            窝
          </div>
          <div class="mt-1 text-sm text-gray-900 font-bold dark:text-gray-100">
            {{ nest ? `Lv.${nest.level}` : '—' }}
          </div>
          <div v-if="nest" class="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
            {{ nest.slots }} 格
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            幼崽售价
          </div>
          <div class="mt-1 text-sm text-gray-900 font-bold dark:text-gray-100">
            {{ cubGoods ? `${cubGoods.price} 金` : '—' }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            罐头桶余量
          </div>
          <div class="mt-1 text-sm text-gray-900 font-bold dark:text-gray-100">
            {{ formatBucket(bucketSeconds) }}
          </div>
        </div>
      </div>

      <div
        v-if="!bucketSeconds && !cannedCount"
        class="border border-amber-200 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
      >
        饲料为 0：罐头桶余量和背包罐头都是空的，动物不会产生产物，所以「一键收取」只会收到「当前没有可收取的产物」。
        去下方「牧场补给（商城罐头）」买有机罐头，或先在游戏里补充罐头，再点收取才有东西可收。
      </div>

      <div class="flex flex-wrap gap-2">
        <NButton size="small" type="primary" :loading="operating === 'harvest'" :disabled="!isConnected" @click="run('harvest')">
          一键收取（催产+收获）
        </NButton>
        <NButton size="small" :loading="operating === 'triggerProduce'" :disabled="!isConnected" @click="run('triggerProduce')">
          一键催产
        </NButton>
        <NButton size="small" :loading="operating === 'feed'" :disabled="!isConnected || (!bucketSeconds && !cannedCount)" @click="run('feed', { feedType: bucketSeconds > 0 ? 1 : 2 })">
          喂一只{{ !bucketSeconds && !cannedCount ? '（无罐头）' : '' }}
        </NButton>
        <NButton size="small" :loading="operating === 'addFeed'" :disabled="!isConnected" @click="run('addFeed', { instId: facility?.instId || 10002, count: 1 })">
          牧草机加草
        </NButton>
        <NButton size="small" :loading="operating === 'cleanAll'" :disabled="!isConnected" @click="run('cleanAll')">
          一键清理（蚊子/便便）
        </NButton>
        <NButton size="small" type="primary" :loading="operating === 'check'" :disabled="!isConnected" @click="run('check')">
          立即自动执行
        </NButton>
      </div>

      <div class="flex flex-wrap items-center gap-2 border border-gray-200 rounded-lg p-3 dark:border-gray-700">
        <span class="text-xs text-gray-500 dark:text-gray-400">补栏：</span>
        <NInputNumber v-model:value="buyCount" :min="1" :max="20" size="small" class="w-24" />
        <NButton size="small" type="primary" :loading="operating === 'buyCub'" :disabled="!isConnected" @click="buyCub">
          买幼崽
        </NButton>
        <span class="ml-3 text-xs text-gray-500 dark:text-gray-400">罐头补桶（库存 {{ cannedCount }}）：</span>
        <NInputNumber v-model:value="canCount" :min="1" :max="100" size="small" class="w-24" />
        <NButton size="small" :loading="operating === 'refillBucket'" :disabled="!isConnected || cannedCount <= 0" @click="refillBucket">
          加 {{ formatBucket(canCount * 3600) }}
        </NButton>
        <span class="ml-3 text-xs text-gray-500 dark:text-gray-400">好友牧场：</span>
        <BaseSelect v-model="selectedFriendGid" :options="friendOptions" placeholder="选择好友" filterable class="w-56" />
        <NButton size="small" :loading="operating === 'visitFriend'" :disabled="!isConnected || !selectedFriendGid" @click="visitFriend">
          访问并互动
        </NButton>
      </div>
      <section v-if="friendRanch" class="border border-sky-200 rounded-lg p-3 dark:border-sky-800">
        <div class="mb-2 flex items-center justify-between">
          <h4 class="text-sm text-sky-800 font-bold dark:text-sky-300">
            好友牧场（{{ friendRanch.hostGid }}）
          </h4>
          <span v-if="visitResult" class="text-xs text-gray-500">{{ visitResult }}</span>
        </div>
        <div class="mb-2 text-xs text-gray-500 dark:text-gray-400">
          动物 {{ (friendRanch.animals || []).length }} 只 · 牧草 {{ friendRanch.grass }}
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="a in (friendRanch.animals || [])"
            :key="a.animal_inst_id"
            class="border border-gray-200 rounded-lg p-2 dark:border-gray-700"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs text-gray-900 font-bold dark:text-gray-100">栏位 {{ a.slot_index }} · {{ a.animal_id }}</span>
              <span class="text-[10px] text-gray-400">{{ stageLabel(a.stage) }}</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-1">
              <span v-if="a.canHarvest" class="rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-900/30 dark:text-green-300">可收获</span>
              <span v-if="a.canFeed" class="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">可喂</span>
              <span v-if="a.canStroke" class="rounded bg-pink-50 px-1.5 py-0.5 text-[10px] text-pink-700 dark:bg-pink-900/30 dark:text-pink-300">可抚摸</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 商城补给：罐头在这里买（slot_type=6, 牧场场景） -->
      <section>
        <div class="mb-2 flex items-center justify-between">
          <h4 class="text-sm text-gray-800 font-bold dark:text-gray-200">
            牧场商店 · 罐头补给
          </h4>
          <span class="text-xs text-gray-400">当前有机罐头 {{ cannedCount }} 个</span>
        </div>
        <div v-if="cannedGoods.length === 0" class="border border-gray-300 rounded-lg border-dashed p-4 text-center text-xs text-gray-500 dark:border-gray-600">
          暂无罐头商品（账号未连接或未加入内测）
        </div>
        <div v-else class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <div
            v-for="g in cannedGoods"
            :key="g.goodsId"
            class="border border-gray-200 rounded-lg p-2.5 dark:border-gray-700"
          >
            <div class="text-xs text-gray-900 font-medium dark:text-gray-100" :title="g.name">
              {{ g.name }}
            </div>
            <div class="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
              {{ g.rewardCount }} 个 · {{ currencyLabel(g.priceCurrency) }} {{ g.price }}
              <span v-if="g.discountText" class="ml-1 text-orange-500">{{ g.discountText }}</span>
            </div>
            <NButton
              size="tiny"
              type="primary"
              class="mt-2 w-full"
              :loading="operating === 'buyMallGoods'"
              :disabled="!isConnected"
              @click="buyMallItem(g.goodsId, g.name)"
            >
              购买
            </NButton>
          </div>
        </div>
      </section>

      <!-- 轮换商店：仓鼠驿站，松果/便便货币 -->
      <section>
        <div class="mb-2 flex items-center justify-between">
          <h4 class="text-sm text-gray-800 font-bold dark:text-gray-200">
            轮换商店 · 仓鼠驿站
          </h4>
          <NButton size="tiny" :loading="operating === 'rotationShopInfo'" :disabled="!isConnected" @click="loadRotationShop">
            {{ rotationLoaded ? '刷新' : '查看商品' }}
          </NButton>
        </div>
        <div v-if="!rotationLoaded" class="border border-gray-300 rounded-lg border-dashed p-4 text-center text-xs text-gray-500 dark:border-gray-600">
          点击查看本期轮换商品
        </div>
        <template v-else>
          <div v-for="cat in rotationCategories" :key="cat.id" class="mb-2">
            <div class="mb-1 text-xs text-gray-500 dark:text-gray-400">{{ cat.name }}</div>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div
                v-for="g in rotationGoods.filter((x:any)=>x.categoryId===cat.id)"
                :key="`${cat.id}-${g.goodsId}`"
                class="flex items-center justify-between border border-gray-200 rounded-lg px-2.5 py-2 dark:border-gray-700"
              >
                <span class="text-xs text-gray-800 dark:text-gray-200">商品 {{ g.goodsId }}</span>
                <NButton
                  size="tiny"
                  :loading="operating === 'rotationBuy'"
                  :disabled="!isConnected"
                  @click="buyRotationItem(g)"
                >
                  购买
                </NButton>
              </div>
            </div>
          </div>
        </template>
      </section>

      <section v-if="lastActions.length || notes.length">
        <h4 class="mb-2 text-sm text-gray-800 font-bold dark:text-gray-200">
          自动化最近动作
        </h4>
        <div v-if="lastActions.length" class="flex flex-wrap gap-2">
          <span
            v-for="(action, index) in lastActions"
            :key="`${index}-${action}`"
            class="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
          >
            {{ action }}
          </span>
        </div>
        <div v-if="notes.length" class="mt-2 space-y-1">
          <div
            v-for="(note, index) in notes"
            :key="`note-${index}`"
            class="rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
          >
            {{ note }}
          </div>
        </div>
      </section>

      <section>
        <h4 class="mb-2 text-sm text-gray-800 font-bold dark:text-gray-200">
          动物状态
        </h4>
        <div v-if="animals.length === 0" class="border border-gray-300 rounded-lg border-dashed p-6 text-center text-sm text-gray-500 dark:border-gray-600">
          牧场里还没有动物
        </div>
        <div v-else class="grid grid-cols-1 gap-2 lg:grid-cols-3 sm:grid-cols-2">
          <div
            v-for="a in animals"
            :key="a.animal_inst_id"
            class="border border-gray-200 rounded-lg p-3 dark:border-gray-700"
          >
            <div class="flex items-center justify-between">
              <span class="text-gray-900 font-bold dark:text-gray-100">栏位 {{ a.slot_index }}</span>
              <span class="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                {{ stageLabel(a.stage) }}
              </span>
            </div>
            <div class="mt-2 text-xs text-gray-600 space-y-1 dark:text-gray-400">
              <div>动物 ID：{{ a.animal_id }}</div>
              <div>产物就绪：{{ formatClock(a.growReadyAt) }}</div>
              <div>成熟时间：{{ a.matureReadyAt ? formatClock(a.matureReadyAt) : '—' }}</div>
              <div>已产出 {{ a.produceCount }} 次 · 预计收获 {{ a.expectedHarvestGold }} 金</div>
            </div>
            <div class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {{ animalNextStep(a) }}
            </div>
            <div class="mt-2 flex flex-wrap gap-1">
              <span v-if="a.canHarvest" class="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-300">产物就绪</span>
              <span v-if="a.canFeed" class="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">可喂</span>
              <span v-if="a.canStroke" class="rounded bg-pink-50 px-2 py-0.5 text-xs text-pink-700 dark:bg-pink-900/30 dark:text-pink-300">可抚摸</span>
            </div>
            <div v-if="a.canStroke" class="mt-2">
              <NButton size="tiny" :loading="operating === `stroke-${a.animal_inst_id}`" @click="run('stroke', { animalInstId: a.animal_inst_id })">
                抚摸
              </NButton>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h4 class="mb-2 text-sm text-gray-800 font-bold dark:text-gray-200">
          每日配额
        </h4>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="q in quotas"
            :key="q.opId"
            class="border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300"
          >
            {{ quotaLabel(q.opId) }}：剩余 {{ q.remaining }} / {{ q.limit }}
          </span>
        </div>
      </section>

      <!-- 牧场日志：只显示牧场模块的日志，不再和农场/好友日志混在一起 -->
      <section class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-sm text-gray-800 font-bold dark:text-gray-200">
            牧场日志
            <span class="ml-1 text-[10px] text-gray-400 font-normal">收获 · 喂养 · 补草 · 抚摸 · 清理 · 好友互动</span>
          </h4>
          <div class="flex items-center gap-2">
            <input
              v-model="pastureLogKeyword"
              placeholder="关键词"
              class="border border-gray-200 rounded px-2 py-1 text-xs outline-none dark:border-gray-600 dark:bg-gray-800"
            >
            <NButton size="tiny" :loading="pastureLogLoading" @click="fetchPastureLogs">
              刷新
            </NButton>
          </div>
        </div>
        <div v-if="filteredLogs.length === 0" class="border border-gray-300 rounded-lg border-dashed p-4 text-center text-xs text-gray-500 dark:border-gray-600">
          暂无牧场日志（自动化每 30~45 秒检查一次，开启「设置 → 自动控制 → 牧场」后开始记录）
        </div>
        <div v-else class="max-h-80 space-y-1 overflow-y-auto pr-1">
          <div
            v-for="(log, index) in filteredLogs"
            :key="`${log.ts}-${index}`"
            class="flex items-start gap-2 border-b border-gray-100 pb-1 text-xs last:border-0 dark:border-gray-700/60"
          >
            <span class="shrink-0 text-gray-400">{{ formatLogTime(log) }}</span>
            <span
              class="shrink-0 rounded px-1 text-[10px]"
              :class="{
                'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300': logLevel(log) === 'error',
                'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300': logLevel(log) === 'warn',
                'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300': logLevel(log) === 'success',
                'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300': logLevel(log) === 'info',
              }"
            >
              {{ log.tag || '牧场' }}
            </span>
            <span class="break-all text-gray-700 dark:text-gray-300">{{ log.msg }}</span>
          </div>
        </div>
      </section>

      <p class="text-xs text-gray-400 dark:text-gray-500">
        自动化开关在「设置 → 自动控制 → 牧场」中开启，包含空栏买幼崽、罐头补桶后喂养、好友牧场互动。操作需账号在线；点击后立即刷新快照。
      </p>
    </div>
  </div>
</template>

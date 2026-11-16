<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NSpin } from 'naive-ui/es/spin'
import { storeToRefs } from 'pinia'
import { computed, onMounted, watch } from 'vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { usePastureStore } from '@/stores/pasture'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const pastureStore = usePastureStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId } = storeToRefs(accountStore)
const { currentAccountConnected: isConnected } = storeToRefs(statusStore)
const { data, loading, operating, error } = storeToRefs(pastureStore)

const animals = computed<any[]>(() => (data.value && Array.isArray(data.value.animals)) ? data.value.animals : [])
const quotas = computed<any[]>(() => (data.value && Array.isArray(data.value.quotas)) ? data.value.quotas : [])
const grass = computed(() => Number(data.value?.grass) || 0)
const capacity = computed(() => Number(data.value?.capacity) || 0)
const animalCount = computed(() => Number(data.value?.animalCount) || animals.value.length)
const facility = computed(() => data.value?.facility || null)
const serverTime = computed(() => Number(data.value?.serverTime) || 0)

function formatClock(ms: number): string {
  if (!ms || ms > 9007199254740992)
    return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function stageLabel(stage: number): string {
  return ['幼崽', '成长期', '成年', '可收获', '成熟'][Math.max(0, Math.min(4, stage - 1))] || `阶段${stage}`
}

function quotaLabel(opId: number): string {
  return ({ 11003: '清灾害', 11008: '抚摸', 11009: '其他互动' } as any)[opId] || `操作 ${opId}`
}

function refresh() {
  if (!currentAccountId.value)
    return
  void pastureStore.fetch(currentAccountId.value)
}

async function run(action: string, input: any = {}) {
  if (!currentAccountId.value || !isConnected.value) {
    toast.error('请先选择账号并确认已连接')
    return
  }
  const base = { ranchInstId: data.value?.ranchInstId, ownerGid: data.value?.ownerGid }
  const ok = await pastureStore.operate(currentAccountId.value, action, { ...base, ...input })
  toast[ok ? 'success' : 'error'](ok ? '操作成功' : (error.value || '操作失败'))
}

watch(currentAccountId, (id) => {
  if (id)
    refresh()
  else
    pastureStore.reset()
})

onMounted(refresh)
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
    <EmptyState v-else-if="!data" title="暂无牧场数据" description="请确认账号已连接且已加入牧场内测" />
    <div v-else class="space-y-4">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
            {{ grass }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            牧草机
          </div>
          <div class="mt-1 text-sm text-gray-900 font-bold dark:text-gray-100">
            {{ facility ? `${facility.name} Lv.${facility.level}` : '—' }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg p-3 dark:border-gray-700">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            快照时间
          </div>
          <div class="mt-1 text-sm text-gray-900 font-bold dark:text-gray-100">
            {{ formatClock(serverTime) }}
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <NButton size="small" type="primary" :loading="operating === 'harvest'" :disabled="!isConnected" @click="run('harvest')">
          收获产物
        </NButton>
        <NButton size="small" :loading="operating === 'triggerProduce'" :disabled="!isConnected" @click="run('triggerProduce')">
          一键催产
        </NButton>
        <NButton size="small" :loading="operating === 'feed'" :disabled="!isConnected" @click="run('feed')">
          喂一只
        </NButton>
        <NButton size="small" :loading="operating === 'addFeed'" :disabled="!isConnected" @click="run('addFeed', { instId: facility?.instId || 10002, count: 1 })">
          牧草机加草
        </NButton>
        <NButton size="small" :loading="operating === 'putHazard'" :disabled="!isConnected" @click="run('putHazard', { opId: 11003 })">
          清灾害
        </NButton>
      </div>

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
              <div>产物成熟：{{ formatClock(a.growReadyAt) }}</div>
              <div>成年：{{ formatClock(a.matureReadyAt) }}</div>
              <div>已收获 {{ a.produceCount }} 次 · 期望售价 {{ a.expectedHarvestGold }}</div>
            </div>
            <div class="mt-2 flex flex-wrap gap-1">
              <span v-if="a.canHarvest" class="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-300">可收获</span>
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

      <section v-if="quotas.length">
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

      <p class="text-xs text-gray-400 dark:text-gray-500">
        自动化开关在「设置 → 自动控制 → 牧场」中开启。操作需账号在线；点击后立即刷新快照。
      </p>
    </div>
  </div>
</template>

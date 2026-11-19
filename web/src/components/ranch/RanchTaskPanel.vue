<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import DailyOverview from '@/components/DailyOverview.vue'
import { useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchGate from '@/components/ranch/RanchGate.vue'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'

/**
 * 牧场“我的任务”：与农场同一套展示，奖励由每日例程自动领取，这里只显示状态。
 * 每日任务、分享礼包是牧场自己的；邮箱、会员、月卡按账号与农场共用。
 */
// 账号级共用的礼包（后端 daily-gifts 按账号汇总，非场景隔离）：邮箱、商城免费礼包、月卡。
// vip_daily_gift 后端从不产出，是早期的死 key，已移除。
const SHARED_GIFTS = ['email_rewards', 'mall_free_gifts', 'month_card_gift']

const statusStore = useStatusStore()
const { dailyGifts, dailyGiftsLoading, currentAccountConnected: isConnected } = storeToRefs(statusStore)
const { currentAccountId } = storeToRefs(useAccountStore())
const { state, loading } = storeToRefs(useRanchStore())
const { refresh: refreshRanch } = useRanchLoader('tasks')

const tab = ref<'daily' | 'growth'>('daily')
const tasks = computed<any[]>(() => state.value?.tasks || [])
const dailyTasks = computed(() => tasks.value.filter(task => task.category === 'daily'))
const growthTasks = computed(() => tasks.value.filter(task => task.category === 'growth'))
const growthDone = computed(() => growthTasks.value.filter(task => task.claimed).length)

/**
 * 牧场「我的任务」：任务进度来自牧场自己的 TaskInfo（task_type 4/5），
 * 分享礼包状态优先取 /api/daily-gifts 的 ranch.gifts（服务端汇总），缺失时回退牧场快照 dailyShare；
 * 邮箱/商城礼包/月卡为账号级共用，沿用共享 dailyGifts。
 */
const overview = computed(() => {
  const shared = (key: string) => dailyGifts.value?.gifts?.find((gift: any) => gift.key === key)
  const daily = dailyTasks.value
  const claimed = daily.filter(task => task.claimed).length
  const taskGift = {
    key: 'task_claim',
    label: '每日任务',
    enabled: true,
    doneToday: daily.length > 0 && claimed === daily.length,
    completedCount: claimed,
    totalCount: daily.length,
  }
  // 服务端已汇总牧场分享状态（ranch.gifts），缺失时回退牧场快照，避免旧后端缓存导致空白。
  const ranchShare = (dailyGifts.value as any)?.ranch?.gifts?.find((gift: any) => gift.key === 'daily_share')
  const shareState: any = state.value?.dailyShare || {}
  const shareDone = ranchShare ? !!ranchShare.doneToday : !!shareState.claimed
  const shareGift = {
    key: 'daily_share',
    label: '分享礼包',
    enabled: true,
    mode: 'auto_claim',
    doneToday: shareDone,
    completedCount: shareDone ? 1 : 0,
    totalCount: 1,
  }
  const [email, mallFree, month] = SHARED_GIFTS.map(shared)
  return {
    timeZone: (dailyGifts.value as any)?.timeZone,
    gifts: [taskGift, email, mallFree, shareGift, month].filter(Boolean),
  }
})

function growthStatus(task: any) {
  if (task.claimed)
    return '已领取'
  if (task.canClaim)
    return '待领取'
  if (!task.unlocked)
    return '未解锁'
  return `进度：${task.progress}/${task.total}`
}

async function refreshGifts() {
  const id = String(currentAccountId.value || '')
  if (id && isConnected.value)
    await statusStore.fetchDailyGifts(id)
}
function refresh() {
  void refreshRanch()
  void refreshGifts()
}

watch([currentAccountId, isConnected], refreshGifts, { immediate: true })
</script>

<template>
  <div class="personal-panel">
    <div class="flex shrink-0 items-center gap-3">
      <NTabs v-model:value="tab" class="min-w-0 flex-1" type="line" animated>
        <NTab name="daily">
          每日礼包与任务
        </NTab>
        <NTab name="growth">
          成长任务
        </NTab>
      </NTabs>
      <NButton circle quaternary size="small" title="刷新任务" aria-label="刷新任务" :loading="loading || dailyGiftsLoading" @click="refresh">
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
      </NButton>
    </div>

    <RanchGate @retry="refreshRanch">
      <DailyOverview v-show="tab === 'daily'" :daily-gifts="overview" empty-text="暂无每日礼包与任务数据" />

      <!-- 成长任务：与农场同一张卡片 -->
      <section v-show="tab === 'growth'" class="personal-panel__card farm-card rounded-xl p-4">
        <div class="mb-3 flex shrink-0 items-center justify-between gap-3">
          <h3 class="flex items-center gap-2 font-medium" style="color: var(--theme-primary, #22c55e)">
            <span class="i-carbon-growth" />
            <span>成长任务</span>
          </h3>
          <span v-if="growthTasks.length" class="rounded-lg bg-blue-50 px-2.5 py-0.5 text-xs text-blue-600 font-bold dark:bg-blue-900/20 dark:text-blue-400">
            {{ growthDone }}/{{ growthTasks.length }}
          </span>
        </div>
        <div v-if="growthTasks.length" class="space-y-2">
          <div
            v-for="task in growthTasks"
            :key="task.id"
            class="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span class="min-w-0 break-words" style="color: var(--theme-text, #6b7280); opacity: 0.85">{{ task.desc }}</span>
            <span class="shrink-0 text-xs text-gray-500">{{ growthStatus(task) }}</span>
          </div>
        </div>
        <div v-else class="text-center text-sm text-gray-400">
          暂无成长任务
        </div>
      </section>
    </RanchGate>
  </div>
</template>

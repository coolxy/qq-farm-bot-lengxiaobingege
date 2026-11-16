<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BUCKETS, formatCount, formatDuration, formatHours, RANCH_IMAGE, useRanchActions, useRanchClock, useRanchLoader, useRanchUnmountReset } from '@/components/ranch/ranch-shared'
import RanchGate from '@/components/ranch/RanchGate.vue'
import RunLogCard from '@/components/RunLogCard.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { getPlatformLabel, useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, currentAccountConnected: isOnline } = storeToRefs(useStatusStore())
const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('animals')
const { remainingSeconds } = useRanchClock()
const { request, disabled: actionsDisabled } = useRanchActions()
const router = useRouter()
useRanchUnmountReset()

const facilities = computed<any[]>(() => state.value?.facilities || [])
const pens = computed(() => facilities.value.filter(f => f.ranch))
const animals = computed(() => pens.value.flatMap(f => (f.ranch.animals || []).map((animal: any) => ({ animal, pen: f.name }))))
const capacity = computed(() => pens.value.reduce((sum, f) => sum + (Number(f.ranch.capacity) || 0), 0))
const shelvesReady = computed(() => pens.value.reduce((sum, f) => sum + f.ranch.shelves.filter((s: any) => s.canCollect).length, 0))
const hazards = computed(() => pens.value.reduce((sum, f) => sum + (f.ranch.hazards?.length || 0), 0))
const blocked = computed(() => animals.value.filter(({ animal }) => animal.grassBlocked).length)

const displayName = computed(() => {
  const account = currentAccount.value
  const live = String(status.value?.accountId || '') === String(account?.id || '') ? status.value?.status?.name : ''
  return live || account?.nick || account?.name || '我的牧场'
})
const avatar = computed(() => {
  const account = currentAccount.value
  const live = String(status.value?.accountId || '') === String(account?.id || '') ? String(status.value?.status?.avatarUrl || '').trim() : ''
  return live || String(account?.avatar || '').trim()
})
const failedAvatar = ref('')
watch(avatar, () => failedAvatar.value = '')
const platformLabel = computed(() => getPlatformLabel(currentAccount.value?.platform))

const expPercent = computed(() => {
  const needed = Number(state.value?.neededExp) || 0
  return needed > 0 ? Math.min(100, Math.max(0, Number(state.value.currentExp) / needed * 100)) : 100
})
const expHint = computed(() => {
  if (!state.value?.neededExp)
    return '牧场已满级'
  const remain = Number(state.value.neededExp) - Number(state.value.currentExp)
  return `距 Lv.${Number(state.value.level) + 1} 还差 ${formatCount(Math.max(0, remain))} 经验`
})

const currency = (id: number) => state.value?.currencies?.find((c: any) => Number(c.id) === id)
const assetTiles = computed(() => [1007, 1002, 1005, 1008].map(id => currency(id)).filter(Boolean))
const stockTiles = computed(() => {
  const buckets = BUCKETS.map(bucket => ({
    key: bucket.id,
    label: bucket.name,
    image: bucket.image,
    value: formatHours(state.value?.buckets?.find((b: any) => Number(b.id) === bucket.id)?.seconds ?? 0),
    hours: true,
  }))
  const dung = currency(7002)
  return [
    { key: 7001, label: '牧草', image: RANCH_IMAGE(7001), value: formatCount(state.value?.grass ?? 0), hours: false },
    ...(dung ? [{ key: 7002, label: dung.name, image: dung.image, value: formatCount(dung.count), hours: false }] : []),
    ...buckets,
  ]
})

/** 待处理项点一下就直达：能一键处理的走报价弹窗，需要挑动物的跳到个人页。 */
const todo = computed(() => [
  {
    key: 'harvest',
    label: '可收获',
    icon: 'i-carbon-wheat text-amber-500',
    value: animals.value.filter(({ animal }) => animal.canHarvest).length + shelvesReady.value,
    go: () => request('harvest', { all: true }),
  },
  {
    key: 'produce',
    label: '可生产',
    icon: 'i-carbon-circle-dash text-green-500',
    value: animals.value.filter(({ animal }) => animal.canProduce).length,
    go: () => request('produce', { all: true }),
  },
  {
    key: 'feed',
    label: '可喂养',
    icon: 'i-carbon-flash text-sky-500',
    value: animals.value.filter(({ animal }) => animal.canFeed).length,
    // 喂养要先选普通/有机罐头，交给个人页的动物卡片处理。
    go: () => void router.push('/ranch/personal?tab=animals'),
  },
  {
    key: 'clean',
    label: '待清理',
    icon: 'i-carbon-clean text-violet-400',
    value: hazards.value,
    go: () => request('clean'),
  },
])

/** 今日动作计数来自后端 ranch-stats，只统计次数与产出，不含估值。 */
const todayStats = computed(() => {
  const counts = state.value?.todayStats?.counts
  if (!counts)
    return null
  const rows = [
    { key: 'harvest', label: '收获', value: Number(counts.harvest || 0), unit: '次' },
    { key: 'produce', label: '生产', value: Number(counts.produce || 0), unit: '次' },
    { key: 'sell', label: '出售', value: Number(counts.sell || 0), unit: '次' },
    { key: 'feed', label: '喂养', value: Number(counts.feed || 0), unit: '次' },
  ].filter(row => row.value > 0)
  return rows.length ? rows : null
})

function facilityMeter(f: any) {
  if (f.state === 2)
    return { text: '待建造', percent: 0 }
  if (f.upgradeState)
    return { text: `升级中 · ${formatDuration(remainingSeconds(f.upgradeEndTime))}`, percent: 0 }
  if (f.ranch)
    return { text: `${f.ranch.count} / ${f.ranch.capacity}`, percent: f.ranch.capacity ? f.ranch.count / f.ranch.capacity * 100 : 0 }
  if (f.feed)
    return { text: `牧草 ${f.feed.count} / ${f.capacity}`, percent: f.capacity ? f.feed.count / f.capacity * 100 : 0 }
  return { text: `容量 ${f.capacity}`, percent: 0 }
}
</script>

<template>
  <div class="page-stack flex flex-col gap-5">
    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="在左侧选择账号后查看牧场" icon="i-carbon-user-avatar" />
    <RanchGate v-else @retry="refresh">
      <div class="overview-grid">
        <!-- 账号：身份、在线状态与牧场等级 -->
        <section class="ov-card ov-account">
          <div class="ov-account__head">
            <div class="ov-avatar" :class="{ 'is-online': isOnline }">
              <img v-if="avatar && avatar !== failedAvatar" :key="avatar" :src="avatar" alt="" @error="failedAvatar = avatar">
              <span v-else class="i-carbon-user-avatar" />
              <i class="ov-avatar__dot" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="ov-account__name-row">
                <strong class="ov-account__name" :title="displayName">{{ displayName }}</strong>
                <span class="ov-level">牧场 Lv.{{ state.level }}</span>
              </div>
              <div class="ov-presence">
                <span class="ov-presence__state" :class="isOnline ? 'is-online' : 'is-offline'">{{ isOnline ? '在线' : '离线' }}</span>
                <span class="ov-presence__item"><span class="i-carbon-pet-image-o" />饲养 {{ animals.length }} / {{ capacity }}</span>
                <span v-if="platformLabel" class="ov-presence__item">{{ platformLabel }}</span>
              </div>
            </div>
            <NButton circle quaternary :loading="loading" title="刷新牧场" aria-label="刷新牧场" @click="refresh">
              <template #icon>
                <span class="i-carbon-renew" />
              </template>
            </NButton>
          </div>

          <div class="ov-exp">
            <div class="ov-exp__labels">
              <span>牧场经验</span>
              <span class="ov-exp__value">
                {{ formatCount(state.currentExp) }} / {{ state.neededExp ? formatCount(state.neededExp) : '—' }}
                <b>{{ Math.floor(expPercent) }}%</b>
              </span>
            </div>
            <div class="ov-exp__track">
              <div class="ov-exp__bar" :style="{ width: `${expPercent}%` }" />
            </div>
          </div>

          <div class="ov-account__foot">
            <span>{{ expHint }}</span>
          </div>
        </section>

        <!-- 资产 -->
        <section class="ov-card">
          <h3 class="ov-card__title">
            资产
          </h3>
          <div class="ov-tiles">
            <div v-for="item in assetTiles" :key="item.id" class="ov-tile">
              <span class="ov-tile__label"><img class="ov-tile__img" :src="item.image" alt="">{{ item.name }}</span>
              <strong class="ov-tile__value" :title="formatCount(item.count)">{{ formatCount(item.count) }}</strong>
            </div>
          </div>
        </section>

        <!-- 库存：牧草、便便与罐头桶 -->
        <section class="ov-card">
          <h3 class="ov-card__title">
            牧场库存
          </h3>
          <div class="ov-tiles">
            <div v-for="item in stockTiles" :key="item.key" class="ov-tile">
              <span class="ov-tile__label"><img class="ov-tile__img" :src="item.image" alt="">{{ item.label }}</span>
              <strong class="ov-tile__value">{{ item.value }}</strong>
            </div>
          </div>
        </section>
      </div>

      <div v-if="state.sceneFallback" class="ranch-alert" role="status">
        <span class="i-carbon-information" aria-hidden="true" />
        <span>该账号的牧场场景尚未解锁，数据在通用场景读取，部分写操作可能被服务端拒绝。</span>
      </div>

      <div v-if="blocked" class="ranch-alert" role="status">
        <span class="i-carbon-warning-alt" aria-hidden="true" />
        <span>牧草不足，{{ blocked }} 只动物已暂停成长。</span>
        <BaseButton variant="text" size="sm" to="/ranch/personal?tab=facilities">
          去补充牧草
        </BaseButton>
      </div>

      <div class="flex flex-1 flex-col items-stretch gap-6 md:flex-row">
        <!-- 运行日志与农场概览共用组件，这里默认只看牧场模块 -->
        <RunLogCard module="ranch" />

        <div class="min-w-0 flex flex-col gap-6 md:w-1/4">
          <!-- 待处理：对应农场的“今日统计” -->
          <section class="farm-card rounded-2xl p-5">
            <header class="ranch-card-head">
              <h3 class="flex items-center gap-2 text-lg font-display font-medium">
                <span class="i-carbon-task" /> <span>待处理</span>
              </h3>
              <BaseButton variant="text" size="sm" to="/ranch/personal">
                管理动物<span class="i-carbon-chevron-right" aria-hidden="true" />
              </BaseButton>
            </header>
            <div class="grid grid-cols-2 gap-2 2xl:gap-3">
              <button
                v-for="item in todo"
                :key="item.key"
                type="button"
                class="ranch-todo"
                :class="{ 'is-zero': !item.value }"
                :disabled="!item.value || actionsDisabled"
                :title="item.value ? `点击处理：${item.label}` : `暂无${item.label}`"
                @click="item.go()"
              >
                <div class="flex items-center gap-2">
                  <span class="select-none text-base" :class="item.icon" />
                  <span class="text-xs text-gray-500">{{ item.label }}</span>
                </div>
                <b>{{ item.value }}</b>
              </button>
            </div>
            <div v-if="todayStats" class="ranch-today">
              <span class="text-xs text-gray-500">今日</span>
              <span v-for="row in todayStats" :key="row.key" class="ranch-today__item">
                {{ row.label }}<b>{{ row.value }}</b>{{ row.unit }}
              </span>
            </div>
          </section>

          <!-- 设施 -->
          <section class="farm-card rounded-2xl p-5">
            <h3 class="mb-4 flex items-center gap-2 text-lg font-display font-medium">
              <span class="i-carbon-building" /> <span>牧场设施</span>
            </h3>
            <div class="ranch-facilities">
              <div v-for="f in facilities" :key="f.id" class="ranch-facility" :class="{ 'is-pending': f.state === 2 }">
                <div class="ranch-facility__row">
                  <span class="ranch-facility__name">{{ f.name }}<small>Lv.{{ f.level }}</small></span>
                  <span class="ranch-facility__value">{{ facilityMeter(f).text }}</span>
                </div>
                <div class="ranch-facility__track" aria-hidden="true">
                  <i :style="{ width: `${Math.min(100, facilityMeter(f).percent)}%` }" />
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </RanchGate>
  </div>
</template>

<style scoped src="@/styles/overview.css"></style>

<style scoped>
.ov-account__head > :deep(.n-button) {
  align-self: flex-start;
}

.ov-tile__img {
  width: 16px;
  height: 16px;
  flex: none;
  object-fit: contain;
}

.ranch-alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 30%, transparent);
  border-radius: var(--ui-radius-control);
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 13px;
}

.ranch-alert > :last-child {
  margin-left: auto;
}

.ranch-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.ranch-todo {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: var(--ui-surface-soft);
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.ranch-todo:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--ui-primary) 32%, transparent);
  background: color-mix(in srgb, var(--ui-primary-soft) 60%, var(--ui-surface-soft));
}

.ranch-todo:disabled {
  cursor: default;
}

.ranch-todo b {
  font-size: 15px;
}

.ranch-todo.is-zero {
  opacity: 0.6;
}

.ranch-today {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--ui-border);
  color: var(--ui-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.ranch-today__item b {
  margin: 0 1px 0 3px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.ranch-facilities {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ranch-facility__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}

.ranch-facility__name {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  color: var(--ui-ink);
  font-weight: var(--fw-600);
}

.ranch-facility__name small {
  color: var(--ui-subtle);
  font-size: 11px;
  font-weight: var(--fw-500);
}

.ranch-facility__value {
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.ranch-facility__track {
  height: 6px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.ranch-facility__track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #9fd17d, var(--ui-primary));
  transition: width 0.4s ease;
}

.ranch-facility.is-pending {
  opacity: 0.6;
}
</style>

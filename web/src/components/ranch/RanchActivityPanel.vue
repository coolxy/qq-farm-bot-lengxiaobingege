<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { formatDuration, useRanchActions, useRanchClock, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchGate from '@/components/ranch/RanchGate.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useRanchStore } from '@/stores/ranch'

/**
 * 牧场活动：只展示牧场场景专属的活动（后端按 ActivityContent.extra.uid 归类）。
 * 农场活动中心负责全站活动，两边不再重复列同一批数据。
 */
const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('activities')
const { serverNow, remainingSeconds } = useRanchClock()
const { request, disabled } = useRanchActions()
const router = useRouter()

/** 牧歌初启有独立详情页（含奖励进度与人格测试），从牧场活动卡片跳转过去。 */
function openMuge() {
  router.push({ name: 'activity-center', query: { activity: 'muge' } })
}
function hasMugeDetail(activity: any) {
  return String(activity?.id) === '2026111700' && phase(activity).tone !== 'ended'
}

const activities = computed<any[]>(() => state.value?.activities || [])
const dailyShare = computed<any>(() => state.value?.dailyShare || null)

function phase(activity: any) {
  if (activity.startTime > serverNow.value)
    return { text: '即将开始', tone: 'soon' }
  if (activity.endTime > 0 && activity.endTime <= serverNow.value)
    return { text: '已结束', tone: 'ended' }
  return { text: '进行中', tone: 'live' }
}

function range(activity: any) {
  const format = (ms: number) => new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  if (!activity.startTime)
    return ''
  return activity.endTime > 0 ? `${format(activity.startTime)} – ${format(activity.endTime)}` : `${format(activity.startTime)} 起`
}

/** 进行中看剩余时长，未开始看离开启还有多久，都用同一套倒计时文案。 */
function countdown(activity: any) {
  const { tone } = phase(activity)
  if (tone === 'ended')
    return ''
  const target = tone === 'soon' ? activity.startTime : activity.endTime
  if (!target)
    return tone === 'soon' ? '' : '长期开放'
  const seconds = remainingSeconds(target)
  if (seconds <= 0)
    return ''
  const text = formatDuration(seconds)
  return tone === 'soon' ? `${text}后开启` : `剩余 ${text}`
}

/** 进行中的活动直接把说明展开；三天内开启的也展开，避免用户以为卡片是空的。 */
function openByDefault(activity: any) {
  const tone = phase(activity).tone
  if (tone === 'live')
    return true
  if (tone !== 'soon')
    return false
  return remainingSeconds(activity.startTime) <= 3 * 86400
}

const liveCount = computed(() => activities.value.filter(item => phase(item).tone === 'live').length)

const shareRewardText = computed(() => {
  const rewards = dailyShare.value?.rewards || []
  return rewards.map((item: any) => `${item.name} ×${item.count}`).join('、') || '每日礼包'
})
const shareActionText = computed(() => {
  if (!dailyShare.value)
    return ''
  if (dailyShare.value.claimed)
    return '今日已领取'
  return dailyShare.value.shared ? '领取礼包' : '分享并领取'
})
</script>

<template>
  <div class="activity">
    <RanchGate @retry="refresh">
      <header class="activity-head">
        <div class="activity-head__title">
          <span class="activity-head__icon i-carbon-gift" aria-hidden="true" />
          <div>
            <h3>牧场活动</h3>
            <p>只列牧场场景的活动，农场活动请到左侧「活动」页查看</p>
          </div>
        </div>
        <div class="activity-head__meta">
          <span class="activity-head__pill" :class="{ 'is-idle': !liveCount }">
            <i />{{ liveCount ? `${liveCount} 个进行中` : '暂无进行中' }}
          </span>
          <NButton secondary circle title="刷新活动" aria-label="刷新活动" :loading="loading" @click="refresh">
            <template #icon>
              <span class="i-carbon-renew" />
            </template>
          </NButton>
        </div>
      </header>

      <!-- 每日分享是牧场自己的每日礼包（share_id 102），和农场分享互相独立 -->
      <section v-if="dailyShare" class="share" :class="{ 'is-claimed': dailyShare.claimed }">
        <div class="share__icon i-carbon-share" aria-hidden="true" />
        <div class="share__body">
          <strong>每日分享礼包</strong>
          <p>每天首次分享牧场可得 {{ shareRewardText }}，与农场分享互不影响。</p>
        </div>
        <NButton
          size="small"
          :type="dailyShare.claimed ? 'default' : 'primary'"
          :secondary="dailyShare.claimed"
          :disabled="disabled || dailyShare.claimed"
          @click="request('claimDailyShare')"
        >
          {{ shareActionText }}
        </NButton>
      </section>

      <div v-if="activities.length" class="activity-grid">
        <article v-for="item in activities" :key="item.id" class="act" :class="`is-${phase(item).tone}`">
          <header class="act__head">
            <h4 class="act__name" :title="item.name">
              {{ item.name }}
            </h4>
            <span class="act__phase">{{ phase(item).text }}</span>
          </header>
          <div class="act__meta">
            <span class="act__range">{{ range(item) }}</span>
            <span v-if="countdown(item)" class="act__countdown">{{ countdown(item) }}</span>
          </div>
          <NButton v-if="hasMugeDetail(item)" size="small" type="primary" secondary class="act__detail" @click="openMuge">
            查看活动详情
          </NButton>
          <details v-if="item.rules?.length" class="act__rules" :open="openByDefault(item) || undefined">
            <summary>活动说明</summary>
            <ul>
              <li v-for="(line, index) in item.rules" :key="index">
                {{ line }}
              </li>
            </ul>
          </details>
          <p v-else class="act__pending">
            活动详情将在开启后补充
          </p>
        </article>
      </div>

      <EmptyState
        v-else
        title="当前没有牧场活动"
        description="牧场开启限时活动后会显示在这里；牧歌初启等活动只在牧场生效，不会和农场活动混在一起"
        icon="i-carbon-calendar"
      />
    </RanchGate>
  </div>
</template>

<style scoped>
.activity {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 24px;
}

.activity-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 18px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: linear-gradient(120deg, color-mix(in srgb, var(--ui-primary-soft) 70%, transparent), transparent 65%);
}

.activity-head__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.activity-head__icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 12px;
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  font-size: 20px;
  place-items: center;
}

.activity-head h3 {
  margin: 0;
  color: var(--ui-ink);
  font-size: 15px;
  font-weight: var(--fw-650);
}

.activity-head p {
  margin: 2px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
}

.activity-head__meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.activity-head__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 10%, transparent);
  font-size: 12px;
  font-weight: var(--fw-600);
  white-space: nowrap;
}

.activity-head__pill i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent);
}

.activity-head__pill.is-idle {
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
}

.share {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border: 1px solid color-mix(in srgb, var(--ui-primary) 22%, var(--ui-border));
  border-radius: var(--ui-radius-card);
  background: color-mix(in srgb, var(--ui-primary-soft) 46%, var(--ui-surface));
}

.share.is-claimed {
  border-color: var(--ui-border);
  background: var(--ui-surface);
}

.share__icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 10px;
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 14%, transparent);
  font-size: 17px;
  place-items: center;
}

.share__body {
  min-width: 0;
  flex: 1;
}

.share__body strong {
  color: var(--ui-ink);
  font-size: 14px;
}

.share__body p {
  margin: 2px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
}

.activity-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
}

.act {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.act:hover {
  border-color: color-mix(in srgb, var(--ui-primary) 30%, var(--ui-border));
  box-shadow: 0 6px 18px -12px rgba(38, 74, 52, 0.4);
}

.act.is-soon {
  background: color-mix(in srgb, var(--ui-blue-soft) 26%, var(--ui-surface));
}

.act.is-ended {
  opacity: 0.7;
}

.act__head {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.act__name {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.act__phase {
  flex: none;
  padding: 1px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: var(--fw-600);
  line-height: 18px;
}

.act.is-live .act__phase {
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
}

.act.is-soon .act__phase {
  color: var(--ui-blue);
  background: color-mix(in srgb, var(--ui-blue) 14%, transparent);
}

.act.is-ended .act__phase {
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
}

.act__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.act__countdown {
  color: var(--ui-muted);
  font-weight: var(--fw-600);
}

.act__detail {
  margin-top: 10px;
}

.act.is-soon .act__countdown {
  color: var(--ui-blue);
}

.act__rules {
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px dashed var(--ui-border);
  color: var(--ui-muted);
  font-size: 12px;
}

.act__rules summary {
  cursor: pointer;
  color: var(--ui-primary);
  font-size: 12px;
  list-style: none;
  user-select: none;
}

.act__rules summary::-webkit-details-marker {
  display: none;
}

.act__pending {
  margin: auto 0 0;
  padding-top: 8px;
  border-top: 1px dashed var(--ui-border);
  color: var(--ui-subtle);
  font-size: 12px;
}

.act__rules summary::after {
  display: inline-block;
  margin-left: 4px;
  content: '▾';
  transition: transform 0.16s ease;
}

.act__rules[open] summary::after {
  transform: rotate(180deg);
}

.act__rules ul {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 8px 0 0;
  padding: 0 0 0 2px;
  list-style: none;
  line-height: 1.65;
}

.act__rules li::before {
  margin-right: 6px;
  color: var(--ui-primary);
  content: '·';
}

@media (max-width: 640px) {
  .activity-head,
  .share {
    padding: 12px 14px;
  }

  .activity-grid {
    grid-template-columns: 1fr;
  }

  .share {
    flex-wrap: wrap;
  }

  .share__body {
    flex-basis: calc(100% - 48px);
  }
}
</style>

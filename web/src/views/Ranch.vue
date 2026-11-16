<script setup lang="ts">
import { NTab } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageTabs from '@/components/PageTabs.vue'
import { provideRanchActions, useRanchUnmountReset } from '@/components/ranch/ranch-shared'
import RanchQuoteModal from '@/components/ranch/RanchQuoteModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'

type Section = 'overview' | 'personal' | 'illustrated' | 'mall' | 'friends' | 'activity'
/** instance 相同的页签共用一个面板实例（同一份数据，只切换展示），不重新读取。 */
interface Tab { key: string, label: string, icon: string, panel: any, props?: Record<string, unknown>, instance?: string }

const RanchOverview = defineAsyncComponent(() => import('@/views/RanchOverview.vue'))
const RanchAnimalsPanel = defineAsyncComponent(() => import('@/components/ranch/RanchAnimalsPanel.vue'))
const RanchFacilitiesPanel = defineAsyncComponent(() => import('@/components/ranch/RanchFacilitiesPanel.vue'))
const RanchBagPanel = defineAsyncComponent(() => import('@/components/ranch/RanchBagPanel.vue'))
const RanchTaskPanel = defineAsyncComponent(() => import('@/components/ranch/RanchTaskPanel.vue'))
const RanchBookPanel = defineAsyncComponent(() => import('@/components/ranch/RanchBookPanel.vue'))
const RanchMallPanel = defineAsyncComponent(() => import('@/components/ranch/RanchMallPanel.vue'))
const RanchFriendsPanel = defineAsyncComponent(() => import('@/components/ranch/RanchFriendsPanel.vue'))
const RanchActivityPanel = defineAsyncComponent(() => import('@/components/ranch/RanchActivityPanel.vue'))

// 与农场对应页面使用同样的分区：个人（牧场/设施/背包/任务）、图鉴、商城等。
const SECTIONS: Record<Section, Tab[]> = {
  overview: [{ key: 'overview', label: '概览', icon: 'i-carbon-dashboard', panel: RanchOverview }],
  personal: [
    { key: 'animals', label: '我的牧场', icon: 'i-carbon-pet-image-o', panel: RanchAnimalsPanel },
    { key: 'facilities', label: '牧场设施', icon: 'i-carbon-building', panel: RanchFacilitiesPanel },
    { key: 'bag', label: '我的背包', icon: 'i-carbon-box', panel: RanchBagPanel },
    { key: 'tasks', label: '我的任务', icon: 'i-carbon-task', panel: RanchTaskPanel },
  ],
  illustrated: [
    { key: 'normal', label: '动物图鉴', icon: 'i-carbon-book', panel: RanchBookPanel, props: { kind: 'normal' }, instance: 'book' },
    { key: 'giant', label: '巨大图鉴', icon: 'i-carbon-gem', panel: RanchBookPanel, props: { kind: 'giant' }, instance: 'book' },
  ],
  mall: [
    { key: 'shop', label: '牧场商店', icon: 'i-carbon-shopping-bag', panel: RanchMallPanel, props: { tab: 'shop' } },
    { key: 'market', label: '仓鼠集市', icon: 'i-carbon-store', panel: RanchMallPanel, props: { tab: 'market' } },
    { key: 'cans', label: '罐头商城', icon: 'i-carbon-shopping-cart', panel: RanchMallPanel, props: { tab: 'cans' } },
  ],
  friends: [{ key: 'friends', label: '好友', icon: 'i-carbon-user-multiple', panel: RanchFriendsPanel }],
  activity: [{ key: 'activity', label: '活动', icon: 'i-carbon-gift', panel: RanchActivityPanel }],
}

/** 顶部分区切换：侧边栏只放一个「牧场」入口，农牧场各分区在这里切。 */
const SECTION_NAV: Array<{ key: Section, label: string, icon: string, name: string }> = [
  { key: 'overview', label: '概览', icon: 'i-carbon-dashboard', name: 'ranch' },
  { key: 'personal', label: '个人', icon: 'i-carbon-sprout', name: 'ranch-personal' },
  { key: 'illustrated', label: '图鉴', icon: 'i-carbon-book', name: 'ranch-illustrated' },
  { key: 'activity', label: '活动', icon: 'i-carbon-gift', name: 'ranch-activity' },
  { key: 'friends', label: '好友', icon: 'i-carbon-user-multiple', name: 'ranch-friends' },
  { key: 'mall', label: '商城', icon: 'i-carbon-shopping-cart', name: 'ranch-game-mall' },
]

const route = useRoute()
const router = useRouter()
const { currentAccountId } = storeToRefs(useAccountStore())
const { pending } = provideRanchActions()
const { busy } = storeToRefs(useRanchStore())
// 读取中允许切换页签（旧请求的结果会被丢弃）；写入和确认期间锁定。
const locked = computed(() => busy.value || !!pending.value)
useRanchUnmountReset()

const section = computed<Section>(() => (route.meta.ranchSection as Section) || 'personal')
const tabs = computed(() => SECTIONS[section.value] || SECTIONS.personal)
const current = computed(() => tabs.value.find(tab => tab.key === route.query.tab) || tabs.value[0]!)

function selectSection(item: { key: Section, name: string }) {
  if (item.key === section.value || locked.value)
    return
  void router.push({ name: item.name })
}

function selectTab(key: string) {
  if (key === current.value.key || locked.value)
    return
  router.replace({ query: { ...route.query, tab: key === tabs.value[0]!.key ? undefined : key } })
}
</script>

<template>
  <div class="page-stack ranch-page">
    <!-- 牧场分区：概览 / 个人 / 图鉴 / 活动 / 好友 / 商城 -->
    <nav class="ranch-sections" aria-label="牧场分区">
      <button
        v-for="item in SECTION_NAV"
        :key="item.key"
        type="button"
        class="ranch-sections__item"
        :class="{ 'ranch-sections__item--active': item.key === section }"
        :disabled="locked && item.key !== section"
        @click="selectSection(item)"
      >
        <span :class="item.icon" />
        <span>{{ item.label }}</span>
      </button>
    </nav>

    <PageTabs v-if="tabs.length > 1" :value="current.key" @update:value="selectTab">
      <NTab v-for="tab in tabs" :key="tab.key" :name="tab.key" :disabled="locked && tab.key !== current.key">
        <span class="inline-flex items-center gap-2"><span :class="tab.icon" />{{ tab.label }}</span>
      </NTab>
    </PageTabs>

    <EmptyState v-if="!currentAccountId" title="请先选择账号" description="在左侧选择账号后查看牧场" icon="i-carbon-user-avatar" />
    <component :is="current.panel" v-else :key="`${currentAccountId}:${current.instance || current.key}`" v-bind="current.props" />

    <RanchQuoteModal />
  </div>
</template>

<style scoped>
.ranch-sections {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

.ranch-sections__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-bg) 70%, transparent);
  color: var(--ui-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease, border-color 0.16s ease;
}

.ranch-sections__item:hover:not(:disabled) {
  color: var(--ui-primary);
  border-color: color-mix(in srgb, var(--ui-primary) 40%, transparent);
}

.ranch-sections__item--active {
  border-color: transparent;
  background: var(--ui-primary-soft);
  color: var(--ui-primary);
  font-weight: 600;
}

.ranch-sections__item:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ranch-page {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

/* 与农场个人页一致：面板纵向排列，Tab 吸顶，工具栏在桌面端吸在 Tab 下方。 */
:deep(.personal-panel) {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
}

:deep(.personal-panel__card) {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

@media (max-width: 640px) {
  :deep(.personal-panel) {
    gap: 12px;
  }
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StrategyTab from '@/views/settings/StrategyTab.vue'
import AutomationTab from '@/views/settings/AutomationTab.vue'

/**
 * 「自动化设置」容器：把原先并列的「策略设置」与「自动控制」两个顶层模块合并到一处。
 * 两块配置数据彼此独立（localStrategySettings / localAutomationSettings），因此这里
 * 只做界面承载与子视图切换，各自的加载/保存逻辑仍留在原组件内，避免触碰业务代码。
 */
type SubView = 'strategy' | 'automation'

const STORAGE_KEY = 'settings-automation-view'
const route = useRoute()
const router = useRouter()

function normalizeView(value: string): SubView | null {
  if (value === 'strategy' || value === 'automation') return value
  return null
}

const stored = normalizeView(String(route.query.view || '')) || normalizeView(localStorage.getItem(STORAGE_KEY) || '')
const activeView = ref<SubView>(stored || 'strategy')

const subViews = [
  { key: 'strategy' as const, label: '策略配置', icon: 'i-carbon-sprout', hint: '种植策略、种子优先级与执行间隔' },
  { key: 'automation' as const, label: '自动控制', icon: 'i-carbon-settings-adjust', hint: '农场、施肥、好友、商人与牧场开关' },
]

const currentHint = computed(() => subViews.find(v => v.key === activeView.value)?.hint || '')

function selectView(key: SubView) {
  if (activeView.value === key) return
  activeView.value = key
}

watch(activeView, (view) => {
  localStorage.setItem(STORAGE_KEY, view)
  if (String(route.query.view || '') !== view) {
    router.replace({ query: { ...route.query, view } })
  }
})

watch(() => route.query.view, (value) => {
  const next = normalizeView(String(value || ''))
  if (next && next !== activeView.value)
    activeView.value = next
})
</script>

<template>
  <div class="automation-center-tab">
    <div class="ac-switcher" role="tablist" aria-label="自动化设置子模块">
      <button
        v-for="view in subViews"
        :key="view.key"
        type="button"
        role="tab"
        :aria-selected="activeView === view.key"
        class="ac-switcher__item"
        :class="{ 'is-active': activeView === view.key }"
        @click="selectView(view.key)"
      >
        <span :class="view.icon" class="ac-switcher__icon" />
        <span class="ac-switcher__label">{{ view.label }}</span>
      </button>
    </div>

    <p class="ac-hint">{{ currentHint }}</p>

    <div class="ac-body">
      <StrategyTab v-if="activeView === 'strategy'" />
      <AutomationTab v-else />
    </div>
  </div>
</template>

<style scoped>
.automation-center-tab {
  min-width: 0;
}

.ac-switcher {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface-soft);
}

.ac-switcher__item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--ui-muted);
  font-size: 14px;
  font-weight: var(--fw-600);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    box-shadow 0.15s ease;
}

.ac-switcher__item:hover {
  color: var(--ui-ink);
}

.ac-switcher__item.is-active {
  color: var(--ui-primary);
  background: var(--ui-surface-strong, var(--ui-surface));
  box-shadow: 0 1px 4px rgb(0 0 0 / 8%);
}

.ac-switcher__icon {
  font-size: 17px;
}

.ac-hint {
  margin: 10px 2px 0;
  color: var(--ui-muted);
  font-size: 12px;
}

.ac-body {
  margin-top: 12px;
}

@media (max-width: 640px) {
  .ac-switcher {
    display: flex;
    width: 100%;
  }

  .ac-switcher__item {
    flex: 1;
    justify-content: center;
    padding: 8px 10px;
  }
}
</style>

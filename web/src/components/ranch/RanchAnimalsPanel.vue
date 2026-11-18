<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { BUCKETS, formatCount, formatDuration, formatHours, RANCH_IMAGE, RANCH_TODO_TONES, useRanchActions, useRanchClock, useRanchLoader } from '@/components/ranch/ranch-shared'
import RanchAnimalCard from '@/components/ranch/RanchAnimalCard.vue'
import RanchGate from '@/components/ranch/RanchGate.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useRanchStore } from '@/stores/ranch'

const { state, loading } = storeToRefs(useRanchStore())
const { refresh } = useRanchLoader('animals')
const { disabled, request } = useRanchActions()
const { remainingSeconds } = useRanchClock()

const pens = computed<any[]>(() => (state.value?.facilities || []).filter((f: any) => f.ranch))
const animals = computed(() => pens.value.flatMap(f => (f.ranch.animals || []).map((animal: any) => ({ animal, pen: f.name, hazards: f.ranch.hazards?.length || 0 }))))

/**
 * 按设施分组：窝（6）在前、棚（7）在后。服务器返回的设施顺序不固定，
 * 组内再按栏位、实例编号排序，刷新后位置不变。
 * 分组基于当前筛选结果（visible），因此筛选与分组可同时使用。
 */
const PEN_ORDER: Record<number, number> = { 6: 0, 7: 1 }
const penGroups = computed(() => {
  const groups = new Map<number, { type: number, name: string, count: number, capacity: number, animals: any[] }>()
  for (const f of pens.value) {
    const type = Number(f.moduleType)
    const group = groups.get(type) || { type, name: f.name, count: 0, capacity: 0, animals: [] as any[] }
    group.count += Number(f.ranch.count) || 0
    group.capacity += Number(f.ranch.capacity) || 0
    groups.set(type, group)
  }
  for (const entry of visible.value) {
    const f = pens.value.find((pen: any) => pen.name === entry.pen)
    if (!f) continue
    const type = Number(f.moduleType)
    const group = groups.get(type)
    if (group && !group.animals.some((a: any) => a.id === entry.animal.id))
      group.animals.push(entry.animal)
  }
  return [...groups.values()]
    .sort((a, b) => (PEN_ORDER[a.type] ?? 9) - (PEN_ORDER[b.type] ?? 9) || a.type - b.type)
    .map(group => ({ ...group, animals: [...group.animals].sort((a, b) => (Number(a.slot) || 0) - (Number(b.slot) || 0) || Number(a.id) - Number(b.id)) }))
})
const capacity = computed(() => pens.value.reduce((sum, f) => sum + (Number(f.ranch.capacity) || 0), 0))
const shelves = computed(() => pens.value.flatMap(f => f.ranch.shelves.filter((s: any) => s.canCollect).map((s: any) => ({ ...s, pen: f.name, key: `${f.id}:${s.slot}` }))))
const hazards = computed(() => pens.value.reduce((sum, f) => sum + (f.ranch.hazards?.length || 0), 0))

/** 动物多时按状态筛一批出来处理；默认不排序，保持槽位稳定，避免筛完位置乱跳。 */
type AnimalFilter = 'all' | 'harvest' | 'produce' | 'blocked' | 'clean'
const filterKey = ref<AnimalFilter>('all')
const visible = computed(() => {
  if (filterKey.value === 'all')
    return animals.value
  return animals.value.filter(({ animal, hazards: penHazards }) => {
    if (filterKey.value === 'harvest')
      return animal.canHarvest
    if (filterKey.value === 'produce')
      return animal.canProduce
    if (filterKey.value === 'blocked')
      return animal.grassBlocked
    return (penHazards || 0) > 0
  })
})
function toggleFilter(key: AnimalFilter) {
  filterKey.value = filterKey.value === key ? 'all' : key
}

const canProduce = computed(() => animals.value.some(({ animal }) => animal.canProduce))
const canHarvest = computed(() => animals.value.some(({ animal }) => animal.canHarvest) || shelves.value.length > 0)

const summary = computed(() => [
  { key: 'harvest' as const, label: '可收获', icon: RANCH_TODO_TONES.harvest, value: animals.value.filter(({ animal }) => animal.canHarvest).length },
  { key: 'produce' as const, label: '可生产', icon: RANCH_TODO_TONES.produce, value: animals.value.filter(({ animal }) => animal.canProduce).length },
  { key: 'blocked' as const, label: '缺草', icon: RANCH_TODO_TONES.blocked, value: animals.value.filter(({ animal }) => animal.grassBlocked).length },
  { key: 'clean' as const, label: '待清理', icon: RANCH_TODO_TONES.clean, value: hazards.value },
])
const stock = computed(() => [
  { key: 'grass', label: '牧草', image: RANCH_IMAGE(7001), value: formatCount(state.value?.grass ?? 0) },
  ...BUCKETS.map(bucket => ({ key: bucket.id, label: bucket.name, image: bucket.image, value: formatHours(state.value?.buckets?.find((b: any) => Number(b.id) === bucket.id)?.seconds ?? 0) })),
])

/** 倒计时已到但服务器尚未推进阶段时，显示阶段名而不是“0秒”。 */
function animalRemaining(animal: any) {
  const seconds = animal.nextAtMs ? remainingSeconds(animal.nextAtMs) : 0
  return seconds > 0 ? formatDuration(seconds) : ''
}
function target(animal: any) {
  return { ranchId: animal.ranchId, animalId: animal.id }
}
</script>

<template>
  <div class="personal-panel">
    <RanchGate @retry="refresh">
      <div class="personal-panel__card farm-card rounded-2xl !p-0">
        <div class="ranch-head panel-sticky">
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <span class="i-carbon-pet-image-o text-green-600" /> 动物详情
            <small class="ranch-head__count">{{ animals.length }} / {{ capacity }}</small>
          </h3>
          <div class="ranch-actions">
            <NButton :disabled="disabled || !hazards" @click="request('clean')">
              <span class="i-carbon-clean" />一键清理
            </NButton>
            <NButton :disabled="disabled || !canProduce" @click="request('produce', { all: true })">
              <span class="i-carbon-circle-dash" />一键生产
            </NButton>
            <NButton type="primary" :disabled="disabled || !canHarvest" @click="request('harvest', { all: true })">
              <span class="i-carbon-flash" />一键收获
            </NButton>
            <NButton circle quaternary title="刷新牧场" aria-label="刷新牧场" :loading="loading" @click="refresh">
              <template #icon>
                <span class="i-carbon-renew" />
              </template>
            </NButton>
          </div>
        </div>

        <div class="ranch-summary">
          <div class="ranch-summary__states">
            <button
              type="button"
              class="ranch-state"
              :class="{ 'is-active': filterKey === 'all' }"
              @click="filterKey = 'all'"
            >
              全部<b>{{ animals.length }}</b>
            </button>
            <button
              v-for="item in summary"
              :key="item.key"
              type="button"
              class="ranch-state"
              :class="{ 'is-zero': !item.value, 'is-active': filterKey === item.key }"
              :disabled="!item.value"
              @click="toggleFilter(item.key)"
            >
              <span :class="item.icon" aria-hidden="true" />{{ item.label }}<b>{{ item.value }}</b>
            </button>
          </div>
          <div class="ranch-summary__stock">
            <span v-for="item in stock" :key="item.key" :title="item.label">
              <img :src="item.image" alt="">{{ item.label }}<b>{{ item.value }}</b>
            </span>
          </div>
        </div>

        <div class="p-4 sm:p-5">
          <div v-if="!animals.length" class="ranch-empty">
            <span class="i-carbon-pet-image-o" aria-hidden="true" />
            <strong>还没有饲养动物</strong>
            <p>在牧场商店购买幼崽，到背包里放养到窝或棚。</p>
            <BaseButton variant="secondary" size="sm" to="/ranch/game-mall">
              去牧场商店
            </BaseButton>
          </div>
          <div v-else-if="!visible.length" class="ranch-empty">
            <span class="i-carbon-filter" aria-hidden="true" />
            <strong>没有符合筛选条件的动物</strong>
            <p>换个筛选条件，或点「全部」查看所有动物。</p>
            <BaseButton variant="secondary" size="sm" @click="filterKey = 'all'">
              查看全部
            </BaseButton>
          </div>
          <template v-else>
            <section v-for="group in penGroups" :key="group.type" class="ranch-pen" :aria-label="`${group.name}的动物`">
              <header class="ranch-pen__head">
                <i aria-hidden="true" /><h4>{{ group.name }}</h4><span>{{ group.count }} / {{ group.capacity }}</span>
              </header>
              <div v-if="group.animals.length" class="ranch-grid">
                <RanchAnimalCard
                  v-for="animal in group.animals"
                  :key="`${animal.ranchId}:${animal.id}`"
                  :animal="animal"
                  :pen="group.name"
                  :remaining="animalRemaining(animal)"
                  actionable
                  :disabled="disabled"
                  @produce="request('produce', target(animal))"
                  @harvest="request('harvest', target(animal))"
                  @feed="type => request('feed', { ...target(animal), bucketType: type })"
                  @release="request('release', target(animal))"
                />
              </div>
              <p v-else class="ranch-pen__empty">
                {{ group.name }}里还没有动物，可在背包放养或到牧场商店购买幼崽。
              </p>
            </section>
          </template>

          <section v-if="shelves.length" class="ranch-shelves" aria-label="待收产物">
            <h4><span class="i-carbon-box" aria-hidden="true" />待收产物</h4>
            <div class="ranch-shelves__list">
              <template v-for="shelf in shelves" :key="shelf.key">
                <span v-for="product in shelf.products" :key="`${shelf.key}:${product.id}`" class="ranch-product" :title="`${shelf.pen} · 货架 ${shelf.slot}`">
                  <img :src="product.image" alt="">{{ product.name }}<b>×{{ formatCount(product.count) }}</b>
                </span>
              </template>
            </div>
          </section>
        </div>
      </div>
    </RanchGate>
  </div>
</template>

<style scoped>
.ranch-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card) var(--ui-radius-card) 0 0;
}

.ranch-head__count {
  color: var(--ui-subtle);
  font-size: 13px;
  font-weight: var(--fw-500);
  font-variant-numeric: tabular-nums;
}

.ranch-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ranch-actions :deep(.n-button__content) {
  gap: 4px;
}

.ranch-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
}

.ranch-summary__states {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ranch-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    color 0.16s ease,
    background-color 0.16s ease;
}

.ranch-state:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--ui-primary) 34%, transparent);
  color: var(--ui-primary);
}

.ranch-state.is-active {
  border-color: transparent;
  background: var(--ui-primary-soft);
  color: var(--ui-primary);
  font-weight: var(--fw-600);
}

.ranch-state:disabled {
  cursor: default;
}

.ranch-state b {
  margin-left: 2px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.ranch-state.is-zero {
  opacity: 0.65;
}

.ranch-summary__stock {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--ui-muted);
}

.ranch-summary__stock > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.ranch-summary__stock img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

.ranch-summary__stock b {
  margin-left: 2px;
  color: var(--ui-ink);
  font-weight: var(--fw-650);
}

.ranch-pen + .ranch-pen {
  margin-top: 18px;
}

/* 分组标题：与图鉴分组同一种色标 + 名称 + 计数。 */
.ranch-pen__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.ranch-pen__head > i {
  width: 3px;
  height: 14px;
  flex: none;
  border-radius: 2px;
  background: var(--ui-primary);
}

.ranch-pen__head h4 {
  margin: 0;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.ranch-pen__head span {
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.ranch-pen__empty {
  margin: 0;
  padding: 14px;
  border: 1px dashed var(--ui-border-strong);
  border-radius: 12px;
  color: var(--ui-subtle);
  font-size: 12px;
}

.ranch-grid {
  display: grid;
  /* auto-fit：动物少时卡片铺开占满一行，动物多时与 auto-fill 表现一致 */
  grid-template-columns: repeat(auto-fit, minmax(138px, 1fr));
  gap: 12px;
}

.ranch-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  color: var(--ui-muted);
  text-align: center;
}

.ranch-empty > span {
  margin-bottom: 4px;
  color: var(--ui-subtle);
  font-size: 30px;
}

.ranch-empty strong {
  color: var(--ui-ink);
  font-size: 15px;
}

.ranch-empty p {
  margin: 0 0 8px;
  font-size: 13px;
}

.ranch-shelves {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px dashed var(--ui-border-strong);
}

.ranch-shelves h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-650);
}

.ranch-shelves__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ranch-product {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 4px;
  border-radius: 10px;
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 13px;
}

.ranch-product img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.ranch-product b {
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 639px) {
  .ranch-head,
  .ranch-summary {
    padding-inline: 16px;
  }

  .ranch-actions {
    display: grid;
    width: 100%;
    grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
  }

  .ranch-actions :deep(.n-button:not(.n-button--circle)) {
    padding-inline: 8px;
  }

  .ranch-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
}

@media (max-width: 400px) {
  .ranch-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

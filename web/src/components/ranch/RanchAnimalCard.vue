<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NDropdown } from 'naive-ui/es/dropdown'
import { computed, ref, watch } from 'vue'
import EntityCard from '@/components/EntityCard.vue'

/** 单只动物：与农场土地卡同一套结构（顶部标签 / 图 / 名称 / 状态 / 进度条），可选底部操作。 */
const props = withDefaults(defineProps<{
  animal: any
  /** 所在设施名称，例如“窝”“棚”。 */
  pen?: string
  /** 距离下一阶段的剩余时间文本，由父组件按服务器时钟计算。 */
  remaining?: string
  actionable?: boolean
  friend?: boolean
  disabled?: boolean
}>(), { pen: '', remaining: '', actionable: false, friend: false, disabled: false })

const emit = defineEmits<{ produce: [], harvest: [], feed: [bucketType: 1 | 2], release: [], stroke: [] }>()
const failed = ref(false)
watch(() => props.animal?.image, () => failed.value = false)

const giant = computed(() => !!props.animal?.mutation?.type)
const weight = computed(() => {
  const x10 = Number(props.animal?.mutation?.weightX10) || 0
  return x10 > 0 ? `${(x10 / 100).toFixed(2).replace(/\.?0+$/, '')}kg` : ''
})
const status = computed(() => {
  const a = props.animal
  if (a.canHarvest)
    return { kind: 'ripe', text: '可收获', icon: 'i-carbon-checkmark-filled' }
  if (a.canProduce)
    return { kind: 'produce', text: '可生产', icon: 'i-carbon-circle-dash' }
  if (a.grassBlocked)
    return { kind: 'blocked', text: '缺少牧草', icon: 'i-carbon-warning-alt' }
  return null
})
const rounds = computed(() => {
  const max = Number(props.animal?.maxProduceCount) || 0
  return max > 0 ? { done: Math.min(max, Number(props.animal.produceCount) || 0), max } : null
})
const feedOptions = computed(() => [
  { key: 2, label: props.animal.limitedCanUsed ? '普通罐头（本轮已用）' : '普通罐头喂养', disabled: !!props.animal.limitedCanUsed },
  { key: 1, label: '有机罐头喂养' },
])
</script>

<template>
  <EntityCard class="pen" :class="[status ? `pen--${status.kind}` : '', { 'pen--giant': giant }]" :title-text="animal.name">
    <template #top>
      <span v-if="pen" class="pen__chip">{{ pen }}</span>
      <span v-if="giant" class="pen__giant" :title="weight ? `巨大 · ${weight}` : '巨大'">巨大<template v-if="weight"> {{ weight }}</template></span>
    </template>

    <template #media>
      <img v-if="animal.image && !failed" :src="animal.image" alt="" loading="lazy" @error="failed = true">
      <span v-else class="pen__placeholder i-carbon-pet-image-o" aria-hidden="true" />
    </template>

    <template #name>
      {{ animal.name }}
    </template>

    <template #state>
      <span v-if="status" class="pen__state" :class="`is-${status.kind}`"><span :class="status.icon" aria-hidden="true" />{{ status.text }}</span>
      <span v-else-if="remaining" class="pen__countdown"><span class="i-carbon-time" aria-hidden="true" />{{ remaining }}</span>
      <span v-else class="pen__state is-muted">{{ animal.stageName }}</span>
    </template>

    <template #progress>
      <div class="pen__rounds" :class="{ 'pen__rounds--empty': !rounds }" :title="rounds ? `已生产 ${rounds.done} / ${rounds.max} 轮` : undefined" :aria-label="rounds ? `已生产 ${rounds.done} / ${rounds.max} 轮` : undefined" :role="rounds ? 'img' : undefined" :aria-hidden="rounds ? undefined : true">
        <template v-if="rounds">
          <i v-for="n in rounds.max" :key="n" :class="{ 'is-done': n <= rounds.done }" />
        </template>
      </div>
    </template>

    <template v-if="actionable" #footer>
      <NButton v-if="friend" size="tiny" type="primary" secondary :disabled="disabled || !animal.canStroke" :aria-label="`抚摸${animal.name}，${pen}第${animal.slot}栏`" @click="emit('stroke')">
        {{ animal.stroked ? '已抚摸' : animal.canStroke ? '抚摸' : '不可抚摸' }}
      </NButton>
      <NButton v-else-if="animal.canHarvest" size="tiny" type="primary" :disabled="disabled" @click="emit('harvest')">
        收获
      </NButton>
      <NButton v-else-if="animal.canProduce" size="tiny" type="primary" secondary :disabled="disabled" @click="emit('produce')">
        生产
      </NButton>
      <NDropdown v-else-if="animal.canFeed" trigger="click" placement="bottom" :options="feedOptions" @select="(key: 1 | 2) => emit('feed', key)">
        <NButton size="tiny" secondary :disabled="disabled">
          <span class="i-carbon-flash mr-0.5" aria-hidden="true" />喂养
        </NButton>
      </NDropdown>
      <span v-else class="pen__idle">成长中</span>
      <NButton v-if="!friend && animal.canRelease" size="tiny" quaternary :disabled="disabled" :aria-label="`放生${animal.name}，${pen}第${animal.slot}栏`" @click="emit('release')">
        放生
      </NButton>
    </template>
  </EntityCard>
</template>

<style scoped>
/* 牧场卡复用 EntityCard 公共骨架，这里只保留动物专属：配色、徽章、轮次、操作。
   配色直接覆盖 EntityCard 的 --ec-*，差异尺寸用变量覆盖（原图 52px / 进度间距 6px / footer 间距 8px）。 */
.pen.pen {
  --ec-bg: #fbf8f1;
  --ec-line: #e6dbc2;
  --ec-ink: #86642e;
  --ec-chip: #f1e7d2;
  --ec-tint: #c9a867;
  --ec-media-size: 52px;
  --ec-progress-gap: 6px;
  --ec-footer-gap: 8px;
  padding-bottom: 10px;
}

.pen.pen--giant {
  --ec-bg: #fffae8;
  --ec-line: #ead57f;
  --ec-ink: #946600;
  --ec-chip: #f9e9a8;
}

.pen.pen--ripe {
  border-color: color-mix(in srgb, var(--ui-primary) 55%, var(--ec-line));
}

.pen.pen--blocked {
  border-color: color-mix(in srgb, var(--ui-warning) 60%, var(--ec-line));
}

.pen__chip,
.pen__giant {
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: var(--fw-700);
  line-height: 16px;
  white-space: nowrap;
}

.pen__chip {
  color: var(--ec-ink);
  background: var(--ec-chip);
}

.pen__giant {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: #fff;
  background: #c08a12;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.pen :deep(.entity-card__media img) {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.12));
}

.pen__placeholder {
  color: color-mix(in srgb, var(--ec-ink) 40%, transparent);
  font-size: 26px;
}

.pen__countdown {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--ui-warning);
  font-size: 11px;
  font-weight: var(--fw-700);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.pen__state {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: var(--fw-700);
  line-height: 18px;
  white-space: nowrap;
}

.pen__state.is-ripe {
  color: #fff;
  background: var(--ui-primary-fill);
}

.pen__state.is-produce {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.pen__state.is-blocked {
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}

.pen__state.is-muted {
  padding: 0;
  color: var(--ui-subtle);
  font-weight: var(--fw-500);
}

/* 生产轮次：一轮一格，替代土地卡的成长进度条。 */
.pen__rounds {
  display: flex;
  width: 100%;
  height: 4px;
  gap: 3px;
}
.pen__rounds--empty {
  height: auto;
  min-height: 4px;
}

.pen__rounds i {
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ec-ink) 14%, transparent);
}

.pen__rounds i.is-done {
  background: linear-gradient(90deg, #9fd17d, var(--ui-primary));
}

.pen :deep(.entity-card__footer) {
  min-height: 28px;
  border-top-style: dashed;
}

.pen :deep(.entity-card__footer .n-button) {
  min-width: 48px;
  min-height: 24px;
}

.pen__idle {
  color: var(--ui-subtle);
  font-size: 11px;
}

.dark .pen.pen--giant {
  --ec-tint: #e6c35a;
}

.dark .pen.pen--ripe {
  border-color: color-mix(in srgb, var(--ui-primary) 55%, transparent);
}

.dark .pen.pen--blocked {
  border-color: color-mix(in srgb, var(--ui-warning) 55%, transparent);
}

.dark .pen__chip {
  color: var(--ec-tint);
  background: color-mix(in srgb, var(--ec-tint) 15%, transparent);
}

.dark .pen__rounds i {
  background: rgba(255, 255, 255, 0.08);
}

.dark .pen__rounds i.is-done {
  background: linear-gradient(90deg, #6fae5a, var(--ui-primary));
}
</style>

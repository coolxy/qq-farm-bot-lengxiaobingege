<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  description?: string
  tone?: 'green' | 'amber' | 'blue' | 'violet'
}>(), { tone: 'green' })
</script>

<template>
  <div class="automation-section-header">
    <div class="automation-section-header__icon" :class="`is-${tone}`">
      <slot name="icon" />
    </div>
    <div class="min-w-0">
      <h4 class="automation-section-header__title">
        {{ title }}
      </h4>
      <p v-if="description" class="automation-section-header__desc">
        {{ description }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.automation-section-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}

.automation-section-header__icon {
  display: flex;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  font-size: 20px;
}

.automation-section-header__icon.is-green {
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
}

.automation-section-header__icon.is-amber {
  color: #b45309;
  background: rgb(245 158 11 / 12%);
}

.automation-section-header__icon.is-blue {
  color: #2563eb;
  background: rgb(59 130 246 / 12%);
}

.automation-section-header__icon.is-violet {
  color: #7c3aed;
  background: rgb(139 92 246 / 12%);
}

:global(.dark) .automation-section-header__icon.is-amber {
  color: #fcd34d;
}

:global(.dark) .automation-section-header__icon.is-blue {
  color: #93c5fd;
}

:global(.dark) .automation-section-header__icon.is-violet {
  color: #c4b5fd;
}

.automation-section-header__title {
  font-size: 16px;
  font-weight: var(--fw-700);
  color: var(--ui-ink);
  line-height: 1.35;
}

.automation-section-header__desc {
  margin-top: 2px;
  font-size: 12px;
  color: var(--ui-muted);
  line-height: 1.4;
}
</style>

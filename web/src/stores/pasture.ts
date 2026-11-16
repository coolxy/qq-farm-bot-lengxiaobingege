import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export const usePastureStore = defineStore('pasture', () => {
  const data = ref<any>(null)
  const loading = ref(false)
  const operating = ref('')
  const error = ref('')
  let requestId = 0

  async function fetch(accountId: string) {
    if (!accountId)
      return false
    const id = ++requestId
    loading.value = true
    error.value = ''
    try {
      const response = await api.get('/api/pasture', {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (id !== requestId)
        return false
      if (!response.data?.ok) {
        error.value = getApiErrorMessage(response.data, '无法读取牧场数据')
        return false
      }
      data.value = response.data.data || null
      return true
    }
    catch (cause: any) {
      if (id !== requestId)
        return false
      error.value = getApiErrorMessage(cause, '无法读取牧场数据')
      return false
    }
    finally {
      if (id === requestId)
        loading.value = false
    }
  }

  async function operate(accountId: string, action: string, input: any = {}) {
    if (!accountId)
      return false
    operating.value = action
    error.value = ''
    try {
      const response = await api.post(`/api/pasture/${action}`, input, {
        headers: { 'x-account-id': accountId },
      })
      if (!response.data?.ok) {
        error.value = getApiErrorMessage(response.data, '操作失败')
        return false
      }
      // 操作后刷新快照
      await fetch(accountId)
      return true
    }
    catch (cause: any) {
      error.value = getApiErrorMessage(cause, '操作失败')
      return false
    }
    finally {
      operating.value = ''
    }
  }

  function reset() {
    requestId++
    data.value = null
    loading.value = false
    error.value = ''
  }

  return { data, loading, operating, error, fetch, operate, reset }
})

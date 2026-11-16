import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export interface AdminInfo {
  username: string
  role: 'admin'
  avatar?: string
  mustChangePassword?: boolean
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: 'rate_limit' | 'locked' | 'invalid_credentials' | 'totp_required' | 'invalid_totp'
  remainingMs?: number
  data?: {
    token: string
    role: 'admin'
    user: { username: string }
    mustChangePassword?: boolean
  }
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  const userInfo = useStorage<AdminInfo | null>('user_info', null)
  const isLoggedIn = computed(() => !!token.value)
  const username = computed(() => userInfo.value?.username || '')
  const avatar = computed(() => userInfo.value?.avatar || '')

  async function login(username: string, password: string, totpCode?: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username, password, totpCode: totpCode || undefined })
      if (res.data.ok) {
        token.value = res.data.data.token
        userInfo.value = {
          username: res.data.data.user.username,
          role: 'admin',
          mustChangePassword: res.data.data.mustChangePassword,
        }
      }
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: getApiErrorMessage(data, '网络错误'), errorType: data.errorType, remainingMs: data.remainingMs }
        : { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      token.value = ''
      userInfo.value = null
    }
  }

  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok)
        userInfo.value = res.data.data
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post('/api/user/change-password', { oldPassword, newPassword })
    return res.data
  }

  async function getTotpStatus(): Promise<{ ok: boolean, data?: { enabled: boolean } }> {
    try {
      const res = await api.get('/api/user/totp/status')
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function beginTotpSetup(): Promise<{ ok: boolean, error?: string, data?: { secret: string, otpauthUrl: string } }> {
    try {
      const res = await api.post('/api/user/totp/setup')
      return res.data
    }
    catch (e: any) {
      return { ok: false, error: e.response?.data?.error || '生成绑定密钥失败' }
    }
  }

  async function activateTotp(code: string): Promise<{ ok: boolean, error?: string, message?: string }> {
    try {
      const res = await api.post('/api/user/totp/activate', { code })
      return res.data
    }
    catch (e: any) {
      return { ok: false, error: e.response?.data?.error || '激活失败' }
    }
  }

  async function disableTotp(password: string): Promise<{ ok: boolean, error?: string, message?: string }> {
    try {
      const res = await api.post('/api/user/totp/disable', { password })
      return res.data
    }
    catch (e: any) {
      return { ok: false, error: e.response?.data?.error || '关闭失败' }
    }
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    username,
    avatar,
    login,
    logout,
    fetchUserInfo,
    changePassword,
    getTotpStatus,
    beginTotpSetup,
    activateTotp,
    disableTotp,
  }
})

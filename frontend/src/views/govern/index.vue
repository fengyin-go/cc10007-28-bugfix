<template>
  <section class="page" data-module="govern">
    <header class="page-head">
      <div>
        <h2>存储治理管理</h2>
        <p class="page-desc">维护存储治理策略的输入、执行约束与结果记录，为存储生命周期管理提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记治理策略</button>
        <button class="btn" type="button" @click="exportRows">导出存储治理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>保护依据</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span :class="row['保护依据'] === '可恢复保护' ? 'badge ok' : 'badge bad'">
              {{ row['保护依据'] ?? '未引用快照' }}
            </span>
            <span v-if="row['保护说明']" class="protection-note">{{ row['保护说明'] }}</span>
            <span
              v-if="String(row.status) === '已停用' && row['停用原因']"
              class="protection-note"
            >{{ row['停用原因'] }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无存储治理数据，可先登记治理策略</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条存储治理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('govern')
const columns = ["策略编号", "目标表名", "快照策略编号", "治理类型", "冷热判定字段", "生命周期天数", "归档目标", "回收站保留", "执行频率"]
const actions = meta.actions
const statuses = meta.statuses
const filterFields = columns.slice(0, 4)

const rows = ref<EntryRow[]>([])
const allRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const stats = computed(() => [
  { label: meta.metrics[0], value: allRows.value.length },
  { label: meta.metrics[1], value: allRows.value.filter((row) => String(row.status) === '已启用').length },
  { label: meta.metrics[2], value: allRows.value.filter((row) => String(row.status) === '待校验').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '治理策略登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const payload: { expectedEvidenceVersion?: number } = {}
  if (action === '启用治理' && row['快照策略编号']) {
    payload.expectedEvidenceVersion = Number(row['保护证据版本'] ?? 0)
  }
  const result = applyAction(meta.key, Number(row.id), action, payload)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    allRows.value = listEntries(meta.key).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '存储治理列表读取失败'
  }
}

onMounted(reload)
</script>

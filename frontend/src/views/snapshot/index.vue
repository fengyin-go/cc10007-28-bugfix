<template>
  <section class="page" data-module="snapshot">
    <header class="page-head">
      <div>
        <h2>快照管理管理</h2>
        <p class="page-desc">维护数据快照策略的输入、执行约束与结果记录，为快照管理提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记快照策略</button>
        <button class="btn" type="button" @click="exportRows">导出快照管理清单</button>
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
          <th>保护资格</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span :class="row['保护资格'] === '具备' ? 'badge ok' : 'badge bad'">
              {{ row['保护资格'] ?? '不具备' }}
            </span>
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
            <button class="link" type="button" @click="openDetail(row)">恢复包</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无快照管理数据，可先登记快照策略</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条快照管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <aside v-if="detail" class="detail-panel" data-testid="snapshot-detail">
      <header class="detail-head">
        <div>
          <h3>恢复包 · {{ detail.policy['策略编号'] }}</h3>
          <p class="page-desc">目标表：{{ detail.policy['目标表名'] }} · 策略状态：{{ detail.policy.status }}</p>
        </div>
        <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
      </header>

      <p :class="detail.evidence.eligible ? 'evidence-ok' : 'evidence-bad'">
        恢复资格：{{ detail.evidence.eligible ? '具备' : '不具备' }}
        <template v-if="detail.evidence.reasons.length">
          （{{ detail.evidence.reasons.join('；') }}）
        </template>
      </p>

      <div class="detail-grid">
        <div><span>恢复测试结论</span><strong>{{ detail.evidence.conclusion }}</strong></div>
        <div><span>最近测试时间</span><strong>{{ detail.evidence.testedAt || '—' }}</strong></div>
        <div><span>有效期至</span><strong>{{ detail.evidence.expiresAt || '—' }}</strong></div>
        <div><span>保留份数</span><strong>{{ detail.evidence.retentionCopies ?? '缺失' }}</strong></div>
        <div><span>目标表证据</span><strong>{{ detail.evidence.targetEvidence || '缺失' }}</strong></div>
        <div><span>回执编号</span><strong>{{ detail.evidence.receiptId || '—' }}</strong></div>
        <div><span>证据版本</span><strong>{{ detail.evidence.evidenceVersion }}</strong></div>
        <div><span>恢复包编号</span><strong>{{ detail.evidence.packageId }}</strong></div>
      </div>

      <h4>恢复测试回执</h4>
      <table class="data-table compact">
        <thead>
          <tr><th>回执编号</th><th>版本</th><th>结论</th><th>测试时间</th><th>有效期至</th><th>保留份数</th><th>目标表证据</th></tr>
        </thead>
        <tbody>
          <tr v-for="receipt in detail.history" :key="receipt.receiptId || receipt.version">
            <td>{{ receipt.receiptId || '—' }}</td>
            <td>{{ receipt.version }}</td>
            <td>{{ receipt.conclusion }}</td>
            <td>{{ receipt.testedAt || '—' }}</td>
            <td>{{ receipt.expiresAt || '—' }}</td>
            <td>{{ receipt.retentionCopies ?? '—' }}</td>
            <td>{{ receipt.targetEvidence || '—' }}</td>
          </tr>
          <tr v-if="!detail.history.length">
            <td colspan="7" class="empty-state">尚无恢复测试回执</td>
          </tr>
        </tbody>
      </table>

      <form class="recovery-form" @submit.prevent="submitRecoveryTest">
        <h4>录入恢复测试</h4>
        <div class="detail-grid">
          <label>
            <span>回执编号</span>
            <input v-model="testForm.receiptId" placeholder="留空自动生成（同编号只记一次）" />
          </label>
          <label>
            <span>测试结论</span>
            <select v-model="testForm.conclusion">
              <option value="通过">通过</option>
              <option value="失败">失败</option>
            </select>
          </label>
          <label>
            <span>测试时间</span>
            <input v-model="testForm.testedAt" placeholder="YYYY-MM-DD" />
          </label>
          <label>
            <span>有效期至</span>
            <input v-model="testForm.expiresAt" placeholder="留空按有效天数计算" />
          </label>
          <label>
            <span>保留份数</span>
            <input v-model="testForm.retentionCopies" placeholder="正整数" />
          </label>
          <label>
            <span>目标表证据</span>
            <input v-model="testForm.targetEvidence" placeholder="需与目标表一致" />
          </label>
        </div>
        <p v-if="detailMessage" :class="detailError ? 'error-text' : 'success-text'">{{ detailMessage }}</p>
        <button class="btn primary" type="submit">提交恢复测试</button>
      </form>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  getSnapshotRecoveryPackage,
  listEntries,
  moduleMeta,
  recordRecoveryTest,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, SnapshotRecoveryPackage } from '@/data/types'

const meta = moduleMeta('snapshot')
const columns = [...meta.fields]
const actions = meta.actions
const statuses = meta.statuses
const filterFields = ["策略编号", "目标表名", "恢复测试"]

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

const detail = ref<SnapshotRecoveryPackage | null>(null)
const detailMessage = ref('')
const detailError = ref(false)
const testForm = reactive({
  receiptId: '',
  conclusion: '通过',
  testedAt: '',
  expiresAt: '',
  retentionCopies: '',
  targetEvidence: '',
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '快照策略登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  errorMessage.value = ''
  detailMessage.value = ''
  detailError.value = false
  // 先按当前证据刷新列表，详情与列表读同一份数据，避免详情打开后还显示旧对象。
  reload()
  const fresh = getSnapshotRecoveryPackage(Number(row.id))
  if (!fresh) {
    errorMessage.value = `没有找到编号为 ${row.id} 的快照策略`
    return
  }
  detail.value = fresh
  testForm.receiptId = ''
  testForm.conclusion = '通过'
  testForm.testedAt = ''
  testForm.expiresAt = ''
  testForm.retentionCopies = String(fresh.evidence.retentionCopies ?? '')
  testForm.targetEvidence = fresh.evidence.targetEvidence || fresh.evidence.targetTable
}

function closeDetail() {
  detail.value = null
  detailMessage.value = ''
}

function refreshDetail() {
  if (!detail.value) {
    return
  }
  const fresh = getSnapshotRecoveryPackage(detail.value.evidence.policyId)
  if (fresh) {
    detail.value = fresh
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const payload: { expectedEvidenceVersion?: number } = {}
  if (action === '启用策略') {
    payload.expectedEvidenceVersion = Number(row['恢复测试版本'] ?? 0)
  }
  const result = applyAction(meta.key, Number(row.id), action, payload)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (detail.value) {
    refreshDetail()
  }
}

function submitRecoveryTest() {
  if (!detail.value) {
    return
  }
  detailMessage.value = ''
  detailError.value = false
  const result = recordRecoveryTest(detail.value.evidence.policyId, {
    receiptId: testForm.receiptId,
    conclusion: testForm.conclusion,
    testedAt: testForm.testedAt,
    expiresAt: testForm.expiresAt,
    retentionCopies: testForm.retentionCopies,
    targetEvidence: testForm.targetEvidence,
  })
  if (!result.ok) {
    detailError.value = true
    detailMessage.value = result.message
    return
  }
  detailMessage.value = result.message
  refreshDetail()
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
    errorMessage.value = error instanceof Error ? error.message : '快照管理列表读取失败'
  }
}

onMounted(reload)
</script>

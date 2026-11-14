import type { EntryRow, RecoveryEvidence, RecoveryTestReceipt } from './types'

// 恢复测试的判定只在这里实现：快照列表、恢复包详情、分区策略和存储治理都调用同一份逻辑，
// 避免一个页面说「可恢复」、另一个页面又按自己的理解把未验证的能力当成保护。
export const RECOVERY_CONCLUSIONS = ['通过', '失败', '未测试'] as const

export const RECOVERY_FIELDS = {
  conclusion: '恢复测试结论',
  testedAt: '恢复测试时间',
  expiresAt: '恢复测试有效期至',
  receiptId: '恢复测试回执号',
  version: '恢复测试版本',
  history: '恢复测试历史',
  display: '恢复测试',
  targetEvidence: '目标表证据',
  retention: '保留份数',
  targetTable: '目标表名',
  policyCode: '策略编号',
} as const

const PASS_WORDS = ['通过', '成功', '有效', '已验证', '验证通过', 'pass', 'passed', 'ok', 'success']
const FAIL_WORDS = ['失败', '未通过', '无效', '不通过', 'fail', 'failed', 'error']
const DEFAULT_VALID_DAYS = 30

const REFERENCE_FIELDS = [
  '快照策略编号',
  '快照策略',
  '保护策略编号',
  '保护期策略编号',
  '恢复策略编号',
]

function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** 统一结论写法；含糊的文本一律按「未测试」处理，不能当成通过。 */
export function normalizeConclusion(value: unknown): string {
  const raw = text(value)
  if (!raw) {
    return '未测试'
  }
  const lowered = raw.toLowerCase()
  if (FAIL_WORDS.some((word) => lowered.includes(word.toLowerCase()))) {
    return '失败'
  }
  if (PASS_WORDS.some((word) => lowered.includes(word.toLowerCase()))) {
    return '通过'
  }
  return '未测试'
}

/** 支持 YYYY-MM-DD、YYYY/MM/DD 和完整 ISO 时间；无效日期返回空串。 */
export function normalizeDate(value: unknown): string {
  const raw = text(value)
  if (!raw) {
    return ''
  }
  const match = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = new Date(year, month - 1, day)
    if (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    ) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    return ''
  }
  return formatDate(parsed)
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

function dayStart(value: string): number {
  const normalized = normalizeDate(value)
  if (!normalized) {
    return Number.NaN
  }
  const [year, month, day] = normalized.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
}

function dayEnd(value: string): number {
  const start = dayStart(value)
  if (Number.isNaN(start)) {
    return Number.NaN
  }
  return start + 24 * 60 * 60 * 1000 - 1
}

export const DEFAULT_RECOVERY_VALID_DAYS = 30

function addDays(value: string, days: number): string {
  const start = dayStart(value)
  if (Number.isNaN(start)) {
    return ''
  }
  const date = new Date(start)
  date.setDate(date.getDate() + days)
  return formatDate(date)
}

export function defaultExpiry(testedAt: string, validDays?: unknown): string {
  const days = Number(text(validDays))
  return addDays(
    testedAt,
    Number.isInteger(days) && days > 0 ? days : DEFAULT_RECOVERY_VALID_DAYS,
  )
}

/** 保留份数必须是正整数；占位文本或 0 都不算有效。 */
export function parseRetentionCopies(value: unknown): number | null {
  const raw = text(value)
  if (!raw || !/^\d+$/.test(raw)) {
    return null
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

export function parseReceiptVersion(value: unknown): number {
  const parsed = Number(text(value))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

function parseHistory(rawHistory: unknown): RecoveryTestReceipt[] {
  const raw = text(rawHistory)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        receiptId: text(item.receiptId),
        conclusion: normalizeConclusion(item.conclusion),
        testedAt: normalizeDate(item.testedAt),
        expiresAt: normalizeDate(item.expiresAt),
        version: parseReceiptVersion(item.version),
        retentionCopies:
          item.retentionCopies === null || item.retentionCopies === undefined
            ? null
            : parseRetentionCopies(item.retentionCopies),
        targetEvidence: text(item.targetEvidence),
      }))
      .filter((item) => item.receiptId !== '' || item.version > 0)
  } catch {
    return []
  }
}

/** 从当前行字段读出的「最近一次测试」；没有测试痕迹返回 null。 */
export function receiptFromRow(row: EntryRow): RecoveryTestReceipt | null {
  const rawDisplay = text(row[RECOVERY_FIELDS.display])
  const rawConclusion = text(row[RECOVERY_FIELDS.conclusion])
  const rawTestedAt = text(row[RECOVERY_FIELDS.testedAt])
  const rawVersion = text(row[RECOVERY_FIELDS.version])
  const rawReceiptId = text(row[RECOVERY_FIELDS.receiptId])
  const hasTrace = rawDisplay || rawConclusion || rawTestedAt || rawVersion || rawReceiptId
  if (!hasTrace) {
    return null
  }

  const testedAt =
    normalizeDate(row[RECOVERY_FIELDS.testedAt]) || normalizeDate(rawDisplay)
  const expiresAt = normalizeDate(row[RECOVERY_FIELDS.expiresAt])

  return {
    receiptId: rawReceiptId,
    conclusion: normalizeConclusion(rawConclusion || rawDisplay),
    testedAt,
    expiresAt,
    version: parseReceiptVersion(row[RECOVERY_FIELDS.version]),
    retentionCopies: parseRetentionCopies(row[RECOVERY_FIELDS.retention]),
    targetEvidence: text(row[RECOVERY_FIELDS.targetEvidence]),
  }
}

export function readReceiptHistory(row: EntryRow): RecoveryTestReceipt[] {
  return parseHistory(row[RECOVERY_FIELDS.history])
}

function compareReceipts(a: RecoveryTestReceipt, b: RecoveryTestReceipt): number {
  if (a.version !== b.version) {
    return a.version - b.version
  }
  return dayStart(a.testedAt) - dayStart(b.testedAt)
}

/** 历史 + 当前行合并后的回执，按版本升序；同一个回执编号只保留一条。 */
export function listReceipts(row: EntryRow): RecoveryTestReceipt[] {
  const merged = new Map<string, RecoveryTestReceipt>()
  for (const receipt of readReceiptHistory(row)) {
    const key = receipt.receiptId || `v${receipt.version}`
    const existing = merged.get(key)
    if (!existing || compareReceipts(receipt, existing) > 0) {
      merged.set(key, receipt)
    }
  }
  const current = receiptFromRow(row)
  if (current) {
    const key = current.receiptId || `v${current.version}`
    const existing = merged.get(key)
    if (!existing || compareReceipts(current, existing) >= 0) {
      merged.set(key, current)
    }
  }
  return [...merged.values()].sort(compareReceipts)
}

function latestReceipt(row: EntryRow): RecoveryTestReceipt | null {
  const receipts = listReceipts(row)
  if (receipts.length === 0) {
    return null
  }
  return receipts.reduce((latest, candidate) =>
    compareReceipts(candidate, latest) > 0 ? candidate : latest,
  )
}

function isDescriptor(value: string): boolean {
  return [
    '已核对',
    '已登记',
    '已验证',
    '有效',
    '存在',
    'metadata',
    'catalog',
    'evidence',
    'evidence-ok',
  ].some((word) => value.toLowerCase().includes(word.toLowerCase()))
}

/**
 * 目标表证据必须是「这份快照对应的表」的证据：
 * 1) 直接写出目标表名/表编号；或
 * 2) 目标表已在建模侧登记，证据用明确的「已核对/已登记」描述。
 */
export function targetEvidenceMatches(
  targetTable: unknown,
  targetEvidence: unknown,
  knownTables: Set<string> = new Set(),
): boolean {
  const table = text(targetTable)
  const evidence = text(targetEvidence)
  if (!table || !evidence) {
    return false
  }
  const loweredTable = table.toLowerCase()
  const loweredEvidence = evidence.toLowerCase()
  if (loweredEvidence === loweredTable) {
    return true
  }
  if (loweredEvidence.includes(loweredTable)) {
    return true
  }
  if (loweredEvidence.length >= 4 && loweredTable.includes(loweredEvidence)) {
    return true
  }
  return knownTables.has(table) && isDescriptor(evidence)
}

/**
 * 计算一条快照策略的可恢复证据。所有模块都读取这个结果。
 * 版本更高者为准，因此旧回执即使在数据里残留也无法覆盖新结论。
 */
export function evaluateRecoveryEvidence(
  row: EntryRow,
  now: Date = new Date(),
  knownTables: Set<string> = new Set(),
): RecoveryEvidence {
  const policyId = Number(row.id)
  const policyCode = text(row[RECOVERY_FIELDS.policyCode]) || `#${policyId}`
  const targetTable = text(row[RECOVERY_FIELDS.targetTable])
  const latest = latestReceipt(row)
  const receipts = listReceipts(row)
  const evidenceVersion = receipts.reduce(
    (max, receipt) => Math.max(max, receipt.version),
    0,
  )

  const conclusion = latest?.conclusion ?? '未测试'
  const testedAt = latest?.testedAt ?? ''
  const retentionCopies =
    latest?.retentionCopies ?? parseRetentionCopies(row[RECOVERY_FIELDS.retention])
  const targetEvidence = latest?.targetEvidence ?? text(row[RECOVERY_FIELDS.targetEvidence])

  let expiresAt = latest?.expiresAt ?? ''
  if (!expiresAt && testedAt) {
    expiresAt = defaultExpiry(testedAt, row['恢复测试有效天数'])
  }

  const reasons: string[] = []
  if (!latest) {
    reasons.push('最近一次恢复测试为空')
  } else {
    if (conclusion === '失败') {
      reasons.push('最近一次恢复测试失败')
    } else if (conclusion !== '通过') {
      reasons.push(`最近一次恢复测试结论为「${conclusion || '未测试'}」，不能作为通过证据`)
    }
  }

  const testedAtMs = dayStart(testedAt)
  if (!testedAt) {
    reasons.push('恢复测试时间缺失')
  } else if (Number.isNaN(testedAtMs)) {
    reasons.push('恢复测试时间无效')
  } else if (testedAtMs > dayEnd(formatDate(now))) {
    reasons.push(`恢复测试时间 ${testedAt} 晚于当前日期`)
  }

  const expiresAtMs = dayEnd(expiresAt)
  if (!expiresAt) {
    reasons.push('恢复测试有效期缺失')
  } else if (Number.isNaN(expiresAtMs)) {
    reasons.push('恢复测试有效期无效')
  } else if (dayStart(formatDate(now)) > expiresAtMs) {
    reasons.push(`恢复测试已于 ${expiresAt} 过期`)
  }

  if (retentionCopies === null) {
    reasons.push('保留份数缺失或不是正整数')
  }

  const targetEvidenceOk = targetEvidenceMatches(targetTable, targetEvidence, knownTables)
  if (!targetEvidence) {
    reasons.push('目标表证据缺失')
  } else if (!targetTable) {
    reasons.push('目标表名为空，无法核对目标表证据')
  } else if (!targetEvidenceOk) {
    reasons.push(`目标表证据「${targetEvidence}」与目标表「${targetTable}」不一致`)
  }

  return {
    policyId,
    policyCode,
    targetTable,
    conclusion,
    testedAt,
    expiresAt,
    evidenceVersion,
    receiptId: latest?.receiptId ?? '',
    retentionCopies,
    retentionOk: retentionCopies !== null,
    targetEvidence,
    targetEvidenceOk,
    packageId: `${policyCode}-RECOVERY`,
    eligible: reasons.length === 0,
    reasons,
  }
}

export function snapshotReferenceOf(row: EntryRow): string {
  for (const field of REFERENCE_FIELDS) {
    const value = text(row[field])
    if (value) {
      return value
    }
  }
  return ''
}

export function referenceFields(): string[] {
  return [...REFERENCE_FIELDS]
}

/** 供 UI 展示的保护结论；调用方负责提供已计算好的快照证据。 */
export function describeProtection(
  reference: string,
  policy: EntryRow | null,
  evidence: RecoveryEvidence | null,
): { valid: boolean; label: string; reason: string } {
  if (!reference) {
    return { valid: false, label: '未引用快照', reason: '未绑定快照策略作为保护依据' }
  }
  if (!policy) {
    return {
      valid: false,
      label: '引用失效',
      reason: `引用的快照策略 ${reference} 不存在`,
    }
  }
  if (String(policy.status) !== '已启用') {
    return {
      valid: false,
      label: '保护不可用',
      reason: `快照策略 ${evidence?.policyCode ?? reference} 当前状态「${policy.status}」，未提供保护资格`,
    }
  }
  if (!evidence?.eligible) {
    return {
      valid: false,
      label: '保护不可用',
      reason: `快照策略 ${evidence?.policyCode ?? reference} 的恢复证据无效：${
        evidence?.reasons.join('；') ?? '没有恢复测试证据'
      }`,
    }
  }
  return {
    valid: true,
    label: '可恢复保护',
    reason: `快照策略 ${evidence.policyCode} 最近一次恢复测试通过，保留 ${evidence.retentionCopies} 份，有效期至 ${evidence.expiresAt}`,
  }
}

export function receiptSummary(receipt: RecoveryTestReceipt): string {
  const parts = [receipt.conclusion || '未测试']
  if (receipt.testedAt) {
    parts.push(receipt.testedAt)
  }
  if (receipt.receiptId) {
    parts.push(receipt.receiptId)
  }
  return parts.join(' · ')
}

import { MODULES, MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  RECOVERY_FIELDS,
  defaultExpiry,
  describeProtection,
  evaluateRecoveryEvidence,
  formatDate,
  listReceipts,
  normalizeConclusion,
  normalizeDate,
  parseReceiptVersion,
  parseRetentionCopies,
  snapshotReferenceOf,
} from '@/data/recovery'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  ProtectionStatus,
  RecoveryEvidence,
  RecoveryTestInput,
  RecoveryTestReceipt,
  RecoveryTestResult,
  RunActionOptions,
  SnapshotRecoveryPackage,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const SNAPSHOT_KEY = 'snapshot'
const PROTECTED_KEYS = new Set(['partition', 'govern'])
const SNAPSHOT_ENABLE_ACTION = '启用策略'

const INTERNAL_FIELDS = {
  enabledEvidenceVersion: '启用证据版本',
  enabledReceiptId: '启用回执编号',
  stopReason: '停用原因',
  protection: '保护资格',
  protectionReason: '保护说明',
  protectionEvidenceVersion: '保护证据版本',
  protectionLabel: '保护依据',
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

/** 收集建模侧已知的表名，用来判断「目标表证据」是否指向一张真实登记过的表。 */
function knownTableNames(): Set<string> {
  const tables = new Set<string>()
  const rows = allRows()
  for (const meta of MODULES) {
    for (const row of rows[meta.key] ?? []) {
      for (const field of meta.fields) {
        if (!field.includes('表名') || field.includes('源表') || field.includes('目标表')) {
          continue
        }
        const value = text(row[field])
        if (value) {
          tables.add(value)
        }
      }
    }
  }
  for (const row of rows[SNAPSHOT_KEY] ?? []) {
    const target = text(row[RECOVERY_FIELDS.targetTable])
    if (target) {
      tables.add(target)
    }
  }
  return tables
}

function snapshotRows(): EntryRow[] {
  return listRows(SNAPSHOT_KEY)
}

function findSnapshot(id: number): EntryRow | undefined {
  return snapshotRows().find((row) => Number(row.id) === id)
}

function snapshotCode(row: EntryRow): string {
  return text(row[RECOVERY_FIELDS.policyCode]) || `#${row.id}`
}

function matchSnapshot(reference: string): EntryRow | null {
  const raw = text(reference)
  if (!raw) {
    return null
  }
  const lowered = raw.toLowerCase()
  const rows = snapshotRows()
  const exact = rows.find(
    (row) =>
      snapshotCode(row).toLowerCase() === lowered ||
      String(row.id) === raw ||
      `#${row.id}` === lowered,
  )
  if (exact) {
    return exact
  }
  return (
    rows.find((row) => {
      const code = snapshotCode(row).toLowerCase()
      return code !== '' && lowered.includes(code)
    }) ?? null
  )
}

/**
 * 快照策略一旦失去恢复证据，就不能继续保持「已启用」。
 * 所有读取快照/分区/治理的入口都先走这里，保证三个模块看到同一状态。
 */
function reconcileSnapshotPolicies(now: Date = new Date()): void {
  const rows = snapshotRows()
  const knownTables = knownTableNames()
  if (rows.length > 0) {
    let changed = false
    const next = rows.map((row) => {
      if (String(row.status) !== '已启用') {
        return row
      }
      const evidence = evaluateRecoveryEvidence(row, now, knownTables)
      if (evidence.eligible) {
        return row
      }
      changed = true
      return {
        ...row,
        status: '已停用',
        pending: false,
        abnormal: true,
        [INTERNAL_FIELDS.protection]: '不具备',
        [INTERNAL_FIELDS.stopReason]: `恢复证据失效：${evidence.reasons.join('；')}`,
      }
    })
    if (changed) {
      saveRows(SNAPSHOT_KEY, next)
    }
  }
  reconcileProtectedPolicies(now, knownTables)
}

/**
 * 分区策略把快照恢复能力当作保护期，存储治理又引用同一份保护。
 * 引用的快照失去保护资格后，已经启用的下游策略不能继续挂着旧保护结论。
 */
function reconcileProtectedPolicies(now: Date, knownTables: Set<string>): void {
  for (const key of PROTECTED_KEYS) {
    const rows = listRows(key)
    if (rows.length === 0) {
      continue
    }
    let changed = false
    const next = rows.map((row) => {
      if (String(row.status) !== '已启用') {
        return row
      }
      const protection = protectionForRowInternal(key, row, now, knownTables)
      if (!protection.referenced || protection.valid) {
        return row
      }
      changed = true
      return {
        ...row,
        status: '已停用',
        pending: false,
        abnormal: true,
        [INTERNAL_FIELDS.stopReason]: `保护依据失效：${protection.reason}`,
      }
    })
    if (changed) {
      saveRows(key, next)
    }
  }
}

function evaluateRow(row: EntryRow, now: Date, knownTables?: Set<string>): RecoveryEvidence {
  return evaluateRecoveryEvidence(row, now, knownTables ?? knownTableNames())
}

type ResolvedProtection = {
  policy: EntryRow | null
  reference: string
  referenced: boolean
}

/**
 * 解析一条分区/治理记录引用的快照策略。
 * 治理若没有显式引用，沿用同表分区方案的引用，确保治理读到的还是分区那一条保护链。
 */
function resolveProtectionPolicy(key: string, row: EntryRow): ResolvedProtection {
  const reference = snapshotReferenceOf(row)
  if (reference) {
    return { policy: matchSnapshot(reference), reference, referenced: true }
  }

  const target = text(row[RECOVERY_FIELDS.targetTable])
  if (key === 'govern' && target) {
    const partition = listRows('partition').find(
      (item) => text(item[RECOVERY_FIELDS.targetTable]) === target,
    )
    const partitionReference = partition ? snapshotReferenceOf(partition) : ''
    if (partitionReference) {
      return {
        policy: matchSnapshot(partitionReference),
        reference: partitionReference,
        referenced: true,
      }
    }
  }

  return { policy: null, reference: '', referenced: false }
}

function protectionForRowInternal(
  key: string,
  row: EntryRow,
  now: Date,
  knownTables?: Set<string>,
): ProtectionStatus {
  const resolved = resolveProtectionPolicy(key, row)
  const evidence = resolved.policy
    ? evaluateRow(resolved.policy, now, knownTables)
    : null
  const description = describeProtection(resolved.reference, resolved.policy, evidence)
  return {
    referenced: resolved.referenced,
    valid: description.valid,
    policyCode: resolved.policy ? snapshotCode(resolved.policy) : resolved.reference,
    evidence,
    label: description.label,
    reason: description.reason,
  }
}

function decorateSnapshotRows(rows: EntryRow[], now: Date, knownTables?: Set<string>): EntryRow[] {
  return rows.map((row) => {
    const evidence = evaluateRow(row, now, knownTables)
    const expired = Boolean(evidence.expiresAt) && evidence.expiresAt < formatDate(now)
    const summary =
      evidence.conclusion === '未测试'
        ? '未测试'
        : `${evidence.conclusion}${evidence.testedAt ? ` · ${evidence.testedAt}` : ''}${
            expired ? `（${evidence.expiresAt} 已过期）` : ''
          }`
    return {
      ...row,
      [RECOVERY_FIELDS.display]: summary,
      [RECOVERY_FIELDS.conclusion]: evidence.conclusion,
      [RECOVERY_FIELDS.testedAt]: evidence.testedAt,
      [RECOVERY_FIELDS.expiresAt]: evidence.expiresAt,
      [RECOVERY_FIELDS.receiptId]: evidence.receiptId,
      [RECOVERY_FIELDS.version]: evidence.evidenceVersion,
      [RECOVERY_FIELDS.targetEvidence]: evidence.targetEvidence,
      [INTERNAL_FIELDS.protection]: evidence.eligible ? '具备' : '不具备',
    }
  })
}

function decorateProtectedRows(
  key: string,
  rows: EntryRow[],
  now: Date,
  knownTables?: Set<string>,
): EntryRow[] {
  return rows.map((row) => {
    const protection = protectionForRowInternal(key, row, now, knownTables)
    return {
      ...row,
      [RECOVERY_FIELDS.policyCode]: text(row[RECOVERY_FIELDS.policyCode]) || protection.policyCode,
      [INTERNAL_FIELDS.protectionLabel]: protection.label,
      [INTERNAL_FIELDS.protectionReason]: protection.reason,
      [INTERNAL_FIELDS.protectionEvidenceVersion]: protection.evidence?.evidenceVersion ?? 0,
    }
  })
}

function currentRows(key: string, now: Date): EntryRow[] {
  if (key === SNAPSHOT_KEY || PROTECTED_KEYS.has(key)) {
    reconcileSnapshotPolicies(now)
    const knownTables = knownTableNames()
    if (key === SNAPSHOT_KEY) {
      return decorateSnapshotRows(snapshotRows(), now, knownTables)
    }
    return decorateProtectedRows(key, listRows(key), now, knownTables)
  }
  return listRows(key)
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(
  key: string,
  filters: Record<string, string> = {},
  now: Date = new Date(),
): PageResult {
  const matched = filterRows(currentRows(key, now), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 详情读取与列表读取共用同一份数据，避免列表还是旧对象、详情又是另一个值。 */
export function getEntry(key: string, id: number, now: Date = new Date()): EntryRow | null {
  const rows = currentRows(key, now)
  return rows.find((row) => Number(row.id) === id) ?? null
}

export function getSnapshotEvidence(id: number, now: Date = new Date()): RecoveryEvidence | null {
  reconcileSnapshotPolicies(now)
  const row = findSnapshot(id)
  return row ? evaluateRow(row, now) : null
}

export function getSnapshotRecoveryPackage(
  id: number,
  now: Date = new Date(),
): SnapshotRecoveryPackage | null {
  reconcileSnapshotPolicies(now)
  const row = findSnapshot(id)
  if (!row) {
    return null
  }
  const knownTables = knownTableNames()
  return {
    policy: decorateSnapshotRows([row], now, knownTables)[0],
    evidence: evaluateRow(row, now, knownTables),
    history: listReceipts(row),
  }
}

export function getProtectionStatus(
  key: string,
  id: number,
  now: Date = new Date(),
): ProtectionStatus | null {
  reconcileSnapshotPolicies(now)
  const row = listRows(key).find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  return protectionForRowInternal(key, row, now)
}

function recoveryConflict(message: string): RecoveryTestResult {
  return { ok: false, changed: false, message }
}

/**
 * 记录一次恢复测试。
 * - 同一回执编号重复提交只算一次，不重复覆盖当前结论；
 * - 回执版本必须高于当前证据版本，旧回执不能覆盖新版本；
 * - 可通过 expectedVersion 锁定读取时的版本，让「测试完成」和「启用」有确定的先后关系。
 */
export function recordRecoveryTest(
  id: number,
  input: RecoveryTestInput = {},
  now: Date = new Date(),
): RecoveryTestResult {
  reconcileSnapshotPolicies(now)
  const rows = snapshotRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return recoveryConflict(`没有找到编号为 ${id} 的快照策略`)
  }

  const row = rows[index]
  const evidence = evaluateRow(row, now)
  const receipts = listReceipts(row)
  const currentVersion = evidence.evidenceVersion

  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
    return recoveryConflict(
      `恢复测试版本冲突：当前证据版本为 ${currentVersion}，提交版本为 ${input.expectedVersion}，请刷新后重试`,
    )
  }

  const receiptId = text(input.receiptId)
  if (receiptId && receipts.some((receipt) => receipt.receiptId === receiptId)) {
    return {
      ok: true,
      changed: false,
      message: `恢复测试回执 ${receiptId} 已存在，当前结论保持「${evidence.conclusion}」，未重复更新`,
      evidence,
      receipt: receipts.find((receipt) => receipt.receiptId === receiptId),
    }
  }

  const latest = receipts[receipts.length - 1]
  const requestedConclusion = normalizeConclusion(input.conclusion)
  const requestedTestedAt = normalizeDate(input.testedAt) || formatDate(now)
  const requestedExpiresAt =
    normalizeDate(input.expiresAt) || defaultExpiry(requestedTestedAt, row['恢复测试有效天数'])
  const requestedRetention =
    input.retentionCopies !== undefined
      ? parseRetentionCopies(input.retentionCopies)
      : evidence.retentionCopies
  const requestedTargetEvidence =
    input.targetEvidence !== undefined ? text(input.targetEvidence) : evidence.targetEvidence
  if (
    !receiptId &&
    latest &&
    latest.conclusion === requestedConclusion &&
    latest.testedAt === requestedTestedAt &&
    latest.expiresAt === requestedExpiresAt &&
    latest.retentionCopies === requestedRetention &&
    latest.targetEvidence === requestedTargetEvidence
  ) {
    // 没有回执编号的重复提交（例如连点）只认作同一次测试，不重复写版本。
    return {
      ok: true,
      changed: false,
      message: `本次恢复测试与回执 ${latest.receiptId || `v${latest.version}`} 相同，当前结论保持「${latest.conclusion}」，未重复更新`,
      evidence,
      receipt: latest,
    }
  }

  const nextVersion =
    input.version !== undefined
      ? parseReceiptVersion(input.version)
      : currentVersion + 1
  if (nextVersion <= currentVersion) {
    return recoveryConflict(
      `恢复测试回执版本 ${nextVersion} 不高于当前版本 ${currentVersion}，旧测试回执不能覆盖新版本`,
    )
  }

  const conclusion = normalizeConclusion(input.conclusion)
  if (conclusion === '未测试') {
    return recoveryConflict('请填写恢复测试结论，结论只能是「通过」或「失败」')
  }

  const testedAt = normalizeDate(input.testedAt) || formatDate(now)
  if (!testedAt) {
    return recoveryConflict('恢复测试时间无效，请填写 YYYY-MM-DD 格式的日期')
  }

  const expiresAt =
    normalizeDate(input.expiresAt) ||
    defaultExpiry(testedAt, row['恢复测试有效天数'])
  if (!expiresAt) {
    return recoveryConflict('恢复测试有效期无效，请填写 YYYY-MM-DD 格式的日期')
  }
  if (expiresAt < testedAt) {
    return recoveryConflict(`恢复测试有效期 ${expiresAt} 早于测试时间 ${testedAt}`)
  }

  let retentionCopies = evidence.retentionCopies
  if (input.retentionCopies !== undefined) {
    const parsed = parseRetentionCopies(input.retentionCopies)
    if (parsed === null) {
      return recoveryConflict('保留份数必须是大于 0 的整数')
    }
    retentionCopies = parsed
  }

  const targetEvidence =
    input.targetEvidence !== undefined
      ? text(input.targetEvidence)
      : evidence.targetEvidence

  const receipt: RecoveryTestReceipt = {
    receiptId: receiptId || `REC-${snapshotCode(row)}-v${nextVersion}`,
    conclusion,
    testedAt,
    expiresAt,
    version: nextVersion,
    retentionCopies,
    targetEvidence,
  }

  const history = [...receipts, receipt]
    .filter(
      (item, itemIndex, all) =>
        all.findIndex((candidate) => candidate.receiptId === item.receiptId) === itemIndex,
    )
    .sort((a, b) => {
      if (a.version !== b.version) {
        return a.version - b.version
      }
      return a.testedAt.localeCompare(b.testedAt)
    })
    .slice(-50)

  const updated: EntryRow = {
    ...row,
    [RECOVERY_FIELDS.display]: `${conclusion} · ${testedAt}`,
    [RECOVERY_FIELDS.conclusion]: conclusion,
    [RECOVERY_FIELDS.testedAt]: testedAt,
    [RECOVERY_FIELDS.expiresAt]: expiresAt,
    [RECOVERY_FIELDS.receiptId]: receipt.receiptId,
    [RECOVERY_FIELDS.version]: nextVersion,
    [RECOVERY_FIELDS.targetEvidence]: targetEvidence,
    [RECOVERY_FIELDS.history]: JSON.stringify(history),
    [RECOVERY_FIELDS.retention]: retentionCopies ?? '',
  }

  if (input.retentionCopies !== undefined && retentionCopies !== null) {
    updated[RECOVERY_FIELDS.retention] = retentionCopies
  }

  let message = `恢复测试回执 ${receipt.receiptId} 已记录，当前结论「${conclusion}」`
  const nextEvidence = evaluateRow(updated, now)
  if (String(updated.status) === '已启用') {
    if (!nextEvidence.eligible) {
      updated.status = '已停用'
      updated.pending = false
      updated.abnormal = true
      updated[INTERNAL_FIELDS.protection] = '不具备'
      updated[INTERNAL_FIELDS.stopReason] = `恢复证据失效：${nextEvidence.reasons.join('；')}`
      message += `；恢复证据失效，策略已退出保护资格并停用`
    } else {
      updated.abnormal = false
      updated[INTERNAL_FIELDS.protection] = '具备'
      updated[INTERNAL_FIELDS.stopReason] = ''
      message += '；策略继续具备保护资格'
    }
  } else {
    updated.abnormal = conclusion === '失败'
    updated[INTERNAL_FIELDS.protection] = nextEvidence.eligible ? '具备' : '不具备'
    if (nextEvidence.eligible) {
      updated[INTERNAL_FIELDS.stopReason] = ''
    } else {
      updated[INTERNAL_FIELDS.stopReason] = `恢复证据失效：${nextEvidence.reasons.join('；')}`
    }
  }

  const next = [...rows]
  next[index] = updated
  saveRows(SNAPSHOT_KEY, next)

  return {
    ok: true,
    changed: true,
    message,
    evidence: nextEvidence,
    receipt,
  }
}

/** 语义更明确的别名，方便页面与外部调用。 */
export const recordSnapshotRecoveryTest = recordRecoveryTest

function checkExpectedEvidenceVersion(
  expected: number | undefined,
  actual: number,
  what: string,
): ActionResult | null {
  if (expected === undefined || expected === actual) {
    return null
  }
  return {
    ok: false,
    message: `${what}证据版本冲突：当前版本为 ${actual}，操作基于版本 ${expected}，请刷新后重试`,
  }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: RunActionOptions = {},
  now: Date = new Date(),
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  if (key === SNAPSHOT_KEY || PROTECTED_KEYS.has(key)) {
    reconcileSnapshotPolicies(now)
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  if (key === SNAPSHOT_KEY && action === SNAPSHOT_ENABLE_ACTION) {
    const evidence = evaluateRow(rows[index], now)
    const conflict = checkExpectedEvidenceVersion(
      options.expectedEvidenceVersion,
      evidence.evidenceVersion,
      '恢复测试',
    )
    if (conflict) {
      return conflict
    }
    if (!evidence.eligible) {
      return {
        ok: false,
        message: `快照策略 ${evidence.policyCode} 不能启用：${evidence.reasons.join('；')}`,
      }
    }
  }

  if (PROTECTED_KEYS.has(key) && action.includes('启用')) {
    const protection = protectionForRowInternal(key, rows[index], now)
    if (protection.referenced && !protection.valid) {
      return {
        ok: false,
        message: `${meta.entity}不能启用：${protection.reason}`,
      }
    }
    if (protection.referenced && protection.evidence) {
      const conflict = checkExpectedEvidenceVersion(
        options.expectedEvidenceVersion,
        protection.evidence.evidenceVersion,
        `快照策略 ${protection.policyCode} 的恢复测试`,
      )
      if (conflict) {
        return conflict
      }
    }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }

  if (key === SNAPSHOT_KEY) {
    if (action === SNAPSHOT_ENABLE_ACTION) {
      const evidence = evaluateRow(rows[index], now)
      updated[INTERNAL_FIELDS.enabledEvidenceVersion] = evidence.evidenceVersion
      updated[INTERNAL_FIELDS.enabledReceiptId] = evidence.receiptId
      updated[INTERNAL_FIELDS.protection] = '具备'
      updated[INTERNAL_FIELDS.stopReason] = ''
      updated.abnormal = false
    }
  }

  if (PROTECTED_KEYS.has(key) && action.includes('启用')) {
    const protection = protectionForRowInternal(key, rows[index], now)
    updated[INTERNAL_FIELDS.protectionEvidenceVersion] =
      protection.evidence?.evidenceVersion ?? 0
    updated[INTERNAL_FIELDS.stopReason] = ''
  }

  if (target === '已停用' && !updated[INTERNAL_FIELDS.stopReason]) {
    updated[INTERNAL_FIELDS.stopReason] = '策略已停用'
  }

  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(
  key: string,
  now: Date = new Date(),
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  // 导出与页面读取同一份证据，避免导出文件里还留着已被判定失效的旧状态。
  const rows = currentRows(key, now)
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(now: Date = new Date()): OverviewResult {
  reconcileSnapshotPolicies(now)
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

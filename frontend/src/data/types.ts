/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 恢复测试回执：同一 policy 既有版本，也保留逐条回执用于回看。 */
export type RecoveryTestReceipt = {
  receiptId: string
  conclusion: string
  testedAt: string
  expiresAt: string
  version: number
  retentionCopies: number | null
  targetEvidence: string
}

/** 快照策略的可恢复证据：快照、分区、治理都从这里读取，不再各自推断。 */
export type RecoveryEvidence = {
  policyId: number
  policyCode: string
  targetTable: string
  conclusion: string
  testedAt: string
  expiresAt: string
  evidenceVersion: number
  receiptId: string
  retentionCopies: number | null
  retentionOk: boolean
  targetEvidence: string
  targetEvidenceOk: boolean
  packageId: string
  eligible: boolean
  reasons: string[]
}

export type SnapshotRecoveryPackage = {
  policy: EntryRow
  evidence: RecoveryEvidence
  history: RecoveryTestReceipt[]
}

/** 下游模块（分区/治理）读取到的保护依据。 */
export type ProtectionStatus = {
  referenced: boolean
  valid: boolean
  policyCode: string
  evidence: RecoveryEvidence | null
  label: string
  reason: string
}

export type RecoveryTestInput = {
  receiptId?: string
  conclusion?: string
  testedAt?: string
  expiresAt?: string
  version?: number
  expectedVersion?: number
  retentionCopies?: number | string
  targetEvidence?: string
}

export type RecoveryTestResult = ActionResult & {
  changed?: boolean
  evidence?: RecoveryEvidence
  receipt?: RecoveryTestReceipt
}

export type RunActionOptions = {
  /** 启用时锁定读到的证据版本；证据被并发更新则拒绝，保证确定先后关系。 */
  expectedEvidenceVersion?: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

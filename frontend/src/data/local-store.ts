import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'data-layer-studio:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!hasStorage()) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

// 没有浏览器存储（例如单测/构建期）时用内存兜底，保证读写仍然一致。
let memory: Record<string, EntryRow[]> | null = null

/**
 * 每次都从 localStorage 读最新数据，避免本标签页缓存旧对象：
 * 列表、详情和动作流转看到的是同一份数据，不会被另一个标签页或旧值覆盖。
 */
export function allRows(): Record<string, EntryRow[]> {
  if (!hasStorage()) {
    if (memory === null) {
      memory = clone(SEED_ROWS)
    }
    return memory
  }
  return readStorage()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  if (!hasStorage()) {
    memory = next
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

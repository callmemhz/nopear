// @nopear/core — client-shared core (crypto, SaaS client, worker channel, sync engine).
export {
  utf8, b64url, fromB64url, randomBytes, randomId, generateClientKey, publicKeyOf, deriveKey, seal, open,
  encodeFrame, decodeFrame, sha256Hex, sha256B64url, generateSigningKey, signingPublicKey, signAuthz, verifyAuthz,
  type KeyPair, type SigningKey,
} from './crypto';
export { memoryKV, type KV, type Platform } from './platform';
export { createSseParser, readSse, type SseMessage } from './sse';
export { SaasClient, SaasError } from './saas';
export { RpcCallError, WorkerChannel } from './channel';
export {
  emptyTimeline, applySessionEvent, upsertBtw, dismissBtw, addOptimistic, markSendFailed, markSent, markSending, dropPending, dropQueued, prependPage, selectMessages,
  type PendingSend, type TimelineState, type ViewItem,
} from './timeline';
export { editNeedsConfirm, queueActions, queueBadge, queueErrorText, queuePreview, type QueueAction } from './queue';
export { FILE_ICONS, fileBlobType, fileKind, type FileKind } from './fileKind';
export { noticeView, type NoticeTone, type NoticeView } from './notice';
export { IMAGE_BUDGET_BYTES, IMAGE_STEPS, ATTACHMENTS_TOTAL_MAX_BYTES, compressToBudget } from './images';
export { groupBoard, canDropOn, dropPatch, type BoardColumns } from './collab';
export { recentCwds, parentDir, pathCrumbs, joinDir, sessionPlaceLabel, type CwdSuggestion, type CwdSourceState, type SessionPlaceLabel } from './cwd';
export {
  UNGROUPED, matchesSearch, filterSessions, groupSessions, parseCollapsed, serializeCollapsed, toggleCollapsed, loadCollapsed,
  saveCollapsed, latestSession, pickProjectTarget, type SessionFilter, type SessionGroup, type SyncStorage,
} from './sessionGroups';
export {
  toolCategory, entryState, summarizeTools, buildTurns, sameEntries, sameSegments, isLongText,
  type ToolEntry, type ThinkingEntry, type GroupEntry, type Segment, type Turn, type ToolCategory, type EntryState, type ToolSummary,
} from './toolGroups';
export {
  TASK_STATE_LABEL, taskTone, splitTasks, activeTaskCount, taskTitle, activityLine, taskSeconds, transcriptTimeline, type TaskTone,
} from './tasks';
export { machineUpdateView, updateCommand, type MachineUpdateView, type UpdateTone } from './machineUpdate';
export { createNoPearEngine, type EngineNotice, type EngineState, type NoPearEngine, type MachineConn } from './engine';

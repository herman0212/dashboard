/** Read-only exports. No activity, writer, finalizer or collector is exposed. */

export { isManifest, isManifestCoherent } from './ai/reconciliation/manifest.js';
export { exploitationQueuePath, reconciliationManifestPath } from './ai/reconciliation/prepare.js';
export { publicationContractForClass } from './ai/reconciliation/publish.js';
export { isRunRecord as isCapellaRunRecord } from './ai/sast/capella/artifacts.js';
export { isNormalizedRepositoryPath, parseCodePath } from './ai/sast/capella/paths.js';
export { isCapellaFinding } from './ai/sast/capella/validation.js';
export { CAPELLA_PROGRESS_STAGES } from './ai/sast/types.js';
export { safeAgentFileSlug } from './audit/actor-projection.js';
export { isLoggableAgentName } from './audit/safe-fields.js';
export {
  ASSEMBLED_REPORT_FILENAME,
  ASSEMBLED_REPORT_PDF_FILENAME,
  FINAL_REPORT_MD_FILENAME,
  FINAL_REPORT_PDF_FILENAME,
  REPORT_FINALIZATION_MANIFEST_FILENAME,
  REPORT_JSON_FILENAME,
  SARIF_FILENAME,
} from './paths.js';
export { getAgentGitPaths } from './services/agent-git-paths.js';
export type { ReadOnlyCheckpointGit } from './services/report-checkpoints.js';
export {
  draftProgressIsCoherent,
  finalProgressIsCoherent,
  readFileAtCheckpoint,
  resolveCheckpointCommit,
  withCheckpointGitReader,
} from './services/report-checkpoints.js';
export { isReportFinalizationManifest } from './services/report-finalization.js';
export { AGENT_PHASE_MAP, AGENTS } from './session-manager.js';
export { ALL_AGENTS } from './types/agents.js';
export { ALL_RECONCILIATION_CLASSES } from './types/reconciliation.js';
export { isDurableScanState, isReportProgress, projectPartialReasons } from './types/run-state.js';

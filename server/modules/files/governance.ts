import { conflict, validation } from "../../core/errors.js";
import type { StageGovernance } from "../../../shared/workflowStages.js";

/** Pinned phase overrides; unset values inherit hard platform policy. */
export const uploadIntents = ["document", "recording", "prerecorded_audio"] as const;
export type UploadIntent = typeof uploadIntents[number];
export const platformPhaseCount = 100;
export const platformPhaseAudioSeconds = 7_200;

export function limitsForPhase(governance: StageGovernance, platformFileBytes: number, platformRecordingSeconds: number) {
  return {
    documentCount: Math.min(governance.documentCount ?? platformPhaseCount, platformPhaseCount),
    documentMaxBytes: Math.min(governance.documentMaxBytes ?? platformFileBytes, platformFileBytes),
    audioCount: Math.min(governance.audioCount ?? platformPhaseCount, platformPhaseCount),
    audioMaxBytes: Math.min(governance.audioMaxBytes ?? platformFileBytes, platformFileBytes),
    recordingMaxSeconds: Math.min(governance.recordingMaxSeconds ?? platformRecordingSeconds, platformRecordingSeconds),
    totalAudioMaxSeconds: Math.min(governance.totalAudioMaxSeconds ?? platformPhaseAudioSeconds, platformPhaseAudioSeconds),
  };
}

export type PhaseUsage = { documents: number; audio: number; audioDurationMs: number; unverifiedAudio: number };

export function verifyPhaseCapacity(limits: ReturnType<typeof limitsForPhase>, usage: PhaseUsage, isAudio: boolean,
  size: number, durationMs?: number) {
  if (size > (isAudio ? limits.audioMaxBytes : limits.documentMaxBytes)) {
    throw validation("PHASE_FILE_SIZE_LIMIT", "This file exceeds the phase file size limit.");
  }
  if (isAudio ? usage.audio >= limits.audioCount : usage.documents >= limits.documentCount) {
    throw conflict("PHASE_FILE_COUNT_LIMIT", "This phase has reached its file count limit for this format.");
  }
  if (isAudio) {
    if (durationMs === undefined || usage.unverifiedAudio > 0) {
      throw validation("AUDIO_DURATION_UNVERIFIED", "The total audio duration in this phase could not be verified.");
    }
    if (durationMs + usage.audioDurationMs > limits.totalAudioMaxSeconds * 1000) {
      throw conflict("PHASE_AUDIO_DURATION_LIMIT", "This file would exceed the total audio time allowed in this phase.");
    }
  }
}

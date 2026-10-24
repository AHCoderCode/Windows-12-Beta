/**
 * Shared audio settings for AeroShell voice calls.
 *
 * Disable browser automatic gain control because device-specific AGC can pump
 * microphone levels and make calls sound harsh or distorted. Keep echo
 * cancellation and noise suppression enabled.
 */
export const VOICE_MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
};

/**
 * Conservative receive-side level used on every call. This reduces unexpectedly
 * loud playback on phones and high-gain speakers without changing system volume.
 */
export const REMOTE_AUDIO_FALLBACK_VOLUME = 0.55;

export function setSafeRemoteAudioVolume(audio: Pick<HTMLMediaElement, 'volume'>): void {
  audio.volume = REMOTE_AUDIO_FALLBACK_VOLUME;
}

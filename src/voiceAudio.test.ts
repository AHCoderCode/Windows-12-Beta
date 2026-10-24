import { describe, expect, it } from 'vitest';
import {
  REMOTE_AUDIO_FALLBACK_VOLUME,
  setSafeRemoteAudioVolume,
  VOICE_MICROPHONE_CONSTRAINTS,
} from './voiceAudio';

describe('voice-call audio safety defaults', () => {
  it('keeps echo cancellation and noise suppression on while disabling automatic gain control', () => {
    expect(VOICE_MICROPHONE_CONSTRAINTS).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    });
  });

  it('sets incoming audio to a conservative default playback level', () => {
    const audio = { volume: 1 };

    setSafeRemoteAudioVolume(audio);

    expect(audio.volume).toBe(REMOTE_AUDIO_FALLBACK_VOLUME);
    expect(audio.volume).toBeLessThanOrEqual(0.55);
    expect(audio.volume).toBeGreaterThan(0);
  });
});

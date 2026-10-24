import { describe, expect, it } from 'vitest';
import { isValidAvatarData, MAX_PROFILE_AVATAR_DATA_LENGTH } from './profile-avatar-utils';

describe('profile avatar data validation', () => {
  it('accepts supported, bounded image data URLs', () => {
    expect(isValidAvatarData('data:image/jpeg;base64,SGVsbG8=')).toBe(true);
    expect(isValidAvatarData('data:image/png;base64,SGVsbG8=')).toBe(true);
    expect(isValidAvatarData('data:image/webp;base64,SGVsbG8=')).toBe(true);
  });

  it('rejects remote URLs, markup, malformed data, and oversized values', () => {
    expect(isValidAvatarData('https://example.com/avatar.png')).toBe(false);
    expect(isValidAvatarData('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isValidAvatarData('data:image/jpeg;base64,not valid!')).toBe(false);
    expect(isValidAvatarData('data:image/jpeg;base64,' + 'A'.repeat(MAX_PROFILE_AVATAR_DATA_LENGTH))).toBe(false);
    expect(isValidAvatarData(null)).toBe(false);
  });
});

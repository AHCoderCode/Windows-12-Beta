export const MAX_PROFILE_AVATAR_DATA_LENGTH = 60_000;

const PROFILE_AVATAR_DATA_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export function isValidAvatarData(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_PROFILE_AVATAR_DATA_LENGTH
    && PROFILE_AVATAR_DATA_PATTERN.test(value);
}

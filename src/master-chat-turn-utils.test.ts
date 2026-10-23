import { describe, expect, it } from 'vitest';
import { filterMeteredTurnServers } from './master-chat-turn-utils';

describe('Metered relay ICE server validation', () => {
  it('accepts authenticated Open Relay TURN URLs using TCP, UDP, or TLS', () => {
    const result = filterMeteredTurnServers([
      { urls: 'turn:global.relay.metered.ca:80', username: 'u', credential: 'p' },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'u', credential: 'p' },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'u', credential: 'p' },
    ]);
    expect(result).toHaveLength(3);
  });

  it('rejects STUN, untrusted hosts, and unauthenticated TURN entries', () => {
    const result = filterMeteredTurnServers([
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:evil.example:3478', username: 'u', credential: 'p' },
      { urls: 'turn:global.relay.metered.ca:80', username: '', credential: 'p' },
      { urls: 'turn:global.relay.metered.ca:80', username: 'u' },
    ]);
    expect(result).toEqual([]);
  });

  it('filters mixed URL arrays down to known TURN relay endpoints', () => {
    const result = filterMeteredTurnServers([{
      urls: [
        'stun:stun.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80',
        'turns:global.relay.metered.ca:443?transport=tcp',
        'turn:evil.example:3478',
      ],
      username: 'scoped-user',
      credential: 'scoped-secret',
    }]);
    expect(result).toEqual([{
      urls: [
        'turn:global.relay.metered.ca:80',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ],
      username: 'scoped-user',
      credential: 'scoped-secret',
    }]);
  });

  it('returns no servers for malformed or empty provider responses', () => {
    expect(filterMeteredTurnServers(null)).toEqual([]);
    expect(filterMeteredTurnServers({ iceServers: [] })).toEqual([]);
    expect(filterMeteredTurnServers([null, 1, {}, { urls: 'turn:global.relay.metered.ca:80' }])).toEqual([]);
  });
});

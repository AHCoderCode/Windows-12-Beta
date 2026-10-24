export type MeteredIceServerInput = {
  urls?: string | string[];
  username?: unknown;
  credential?: unknown;
};

const METERED_RELAY_URL = /^turns?:[a-z0-9.-]+\.relay\.metered\.ca:\d+(?:\?transport=(?:tcp|udp))?$/i;

/**
 * Restrict ICE configuration to authenticated Open Relay TURN URLs only.
 * STUN and unknown hosts are intentionally rejected because Master Chat runs
 * with iceTransportPolicy="relay" to prevent direct peer address exposure.
 */
export function filterMeteredTurnServers(input: unknown): RTCIceServer[] {
  if (!Array.isArray(input)) return [];

  const results: RTCIceServer[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object') continue;
    const server = value as MeteredIceServerInput;
    if (typeof server.username !== 'string' || !server.username.trim()) continue;
    if (typeof server.credential !== 'string' || !server.credential.trim()) continue;

    const candidates = Array.isArray(server.urls) ? server.urls : [server.urls];
    const urls = candidates.filter((url): url is string =>
      typeof url === 'string' && METERED_RELAY_URL.test(url.trim()),
    );
    if (!urls.length) continue;

    results.push({
      urls: urls.length === 1 ? urls[0] : urls,
      username: server.username,
      credential: server.credential,
    });
  }
  return results;
}

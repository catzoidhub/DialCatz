/**
 * The Pusher protocol over a WebSocket tab (#99): Laravel Reverb, Sockudo, Soketi and Pusher Channels speak it.
 *   address   ws://host:port/app/<key> (Reverb's default port is 8080; Pusher: wss://ws-<cluster>.pusher.com/app/<key>);
 *             DialCatz adds ?protocol=7&client=DialCatz when missing
 *   frames    JSON { event, channel?, data } — data is a JSON string from the server, an object from the client
 *   flow      pusher:connection_established { socket_id, activity_timeout } → pusher:subscribe { channel, auth?,
 *             channel_data? } → pusher_internal:subscription_succeeded; pusher:ping ↔ pusher:pong; pusher:error
 *   auth      private-* and presence-* channels: auth = "<key>:" + HMAC-SHA256(secret, "<socket_id>:<channel>"
 *             [+ ":" + channel_data for presence]); the secret comes from a {{variable}}, never from the request text
 *   client    client-* events on private / presence channels go back out as { event, channel, data }
 */

export function pusherUrl(input: string): { url: string; key: string } {
  const u = new URL(input);
  const key = u.pathname.match(/\/app\/([^/]+)/)?.[1] ?? '';
  if (!key) throw new Error('A Pusher address ends in /app/<key> (for Reverb: ws://localhost:8080/app/<REVERB_APP_KEY>)');
  if (!u.searchParams.has('protocol')) u.searchParams.set('protocol', '7');
  if (!u.searchParams.has('client')) u.searchParams.set('client', 'DialCatz');
  if (!u.searchParams.has('version')) u.searchParams.set('version', '1.0');
  return { url: u.toString(), key: decodeURIComponent(key) };
}

export const needsAuth = (channel: string) => /^(private|presence)-/.test(channel);
export const isPresence = (channel: string) => channel.startsWith('presence-');

/** The text a channel's auth signs. */
export const authText = (socketId: string, channel: string, channelData?: string) => `${socketId}:${channel}${channelData !== undefined ? `:${channelData}` : ''}`;

export function subscribeFrame(channel: string, auth?: string, channelData?: string): string {
  return JSON.stringify({ event: 'pusher:subscribe', data: { channel, ...(auth ? { auth } : {}), ...(channelData !== undefined ? { channel_data: channelData } : {}) } });
}
export const unsubscribeFrame = (channel: string) => JSON.stringify({ event: 'pusher:unsubscribe', data: { channel } });
export const pongFrame = () => JSON.stringify({ event: 'pusher:pong', data: {} });
export const pingFrame = () => JSON.stringify({ event: 'pusher:ping', data: {} });

/** A client event: its name gets client- when missing, data from the text typed (JSON, else a string). */
export function clientEventFrame(channel: string, event: string, dataText: string): string {
  if (!channel) throw new Error('Pick a channel: client events go to a private or presence channel');
  if (!needsAuth(channel)) throw new Error('Client events only go to private- and presence- channels');
  const name = event.trim().startsWith('client-') ? event.trim() : `client-${event.trim()}`;
  if (name === 'client-') throw new Error('Type the event name');
  let data: unknown = {};
  const t = dataText.trim();
  if (t) {
    try {
      data = JSON.parse(t);
    } catch {
      data = dataText;
    }
  }
  return JSON.stringify({ event: name, channel, data });
}

export interface PusherFrame {
  event: string;
  channel?: string;
  /** The data, parsed when it is JSON text. */
  data: unknown;
}

export function pusherDecode(frame: string): PusherFrame | null {
  try {
    const o = JSON.parse(frame) as { event?: unknown; channel?: unknown; data?: unknown };
    if (typeof o.event !== 'string') return null;
    let data = o.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        /* a plain string */
      }
    }
    return { event: o.event, ...(typeof o.channel === 'string' ? { channel: o.channel } : {}), data };
  } catch {
    return null;
  }
}

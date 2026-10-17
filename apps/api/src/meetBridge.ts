// Kreatix Meet bridge — the suite mints Jitsi JWTs so only signed-in
// members (or holders of a guest link) can create/join rooms on the
// self-hosted docker-jitsi-meet stack. Set KREATIX_MEET_BASE +
// KREATIX_MEET_APP_ID + KREATIX_MEET_SECRET to enable.
import { createHmac } from "node:crypto";

const MEET_BASE = () => (process.env.KREATIX_MEET_BASE ?? "").replace(/\/+$/, "");
const APP_ID = () => process.env.KREATIX_MEET_APP_ID ?? "kreatix-suite";

export const meetEnabled = () => !!(MEET_BASE() && process.env.KREATIX_MEET_SECRET);

export const meetBase = () => MEET_BASE();

/** Recording enabled when the Jibri recordings dir is mounted in. */
export const recDir = () => process.env.KREATIX_MEET_RECORDINGS_DIR ?? "";
export const recordingEnabled = () => !!recDir();

/** PSTN dial-in — set once a Jigasi SIP trunk is configured. The number is
 *  what participants dial; the IVR asks for the meeting code. */
export const dialInNumber = () => process.env.KREATIX_MEET_DIALIN_NUMBER ?? "";
export const dialOutEnabled = () => process.env.KREATIX_MEET_DIALOUT === "1";

const b64u = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Jitsi JWT (prosody token_verification): HS256 {aud,iss,sub,room,context.user}.
 *  sub is the XMPP domain (meet.jitsi inside the docker stack). */
export function mintMeetToken(opts: {
  room: string; name: string; email?: string; moderator?: boolean; ttlSec?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({
    aud: APP_ID(),
    iss: APP_ID(),
    sub: "meet.jitsi",
    room: opts.room,
    iat: now,
    nbf: now - 10,
    exp: now + (opts.ttlSec ?? 2 * 3600),
    context: {
      user: {
        name: opts.name,
        ...(opts.email ? { email: opts.email } : {}),
        moderator: !!opts.moderator,
      },
      features: {
        livestreaming: false,
        // moderators get the Jitsi record button when Jibri is wired in
        recording: !!opts.moderator && recordingEnabled(),
        // PSTN dial-out (invite by phone) once Jigasi+SIP is provisioned
        "outbound-call": !!opts.moderator && dialOutEnabled(),
      },
    },
  }));
  const sig = createHmac("sha256", process.env.KREATIX_MEET_SECRET!)
    .update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64u(sig)}`;
}

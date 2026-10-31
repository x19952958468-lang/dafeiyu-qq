import { prepareSpeechText } from './spoken-text.js';

/** The caller owns conversation history and limits. A delivery makes one QQ call. */
export function createReplyDelivery({ speech, transport, log = () => {} }) {
  return async function deliver({ key, text, prefix = [], target, userText = '', factual = false, source = 'chat', forceText = false, explicit = false, isCurrent = () => true }) {
    const isGroup = target?.groupId != null, isPrivate = target?.userId != null;
    if (isGroup === isPrivate || typeof text !== 'string') throw new Error('INVALID_DELIVERY');
    if (!isCurrent()) return { ok: false, cancelled: true, error: 'PERSONA_CHANGED', mode: 'text', text };
    const prepared = prepareSpeechText(text, { factual, userText });
    let rendered = { mode: 'text', text };
    if (!forceText && speech && !prepared.unsafeForVoice) {
      // NapCat passes normal mixed elements straight to QQ; only standalone PTT is reliable.
      // Keep automatic replies with required @ text intact. Requested voice takes priority.
      const allowAuto = prefix.every(segment => segment.type === 'reply');
      try { rendered = await speech.synthesize({ key, text, userText, factual, source, explicit, allowAuto }); }
      catch { log('[speech] synthesis unavailable; using original text'); }
    }
    let voice = rendered.mode === 'voice' && Buffer.isBuffer(rendered.audio) && rendered.audio.length > 0;
    let spokenText = text;
    if (voice) {
      // The production instance attests exactly which text produced these bytes.
      // Only legacy adapters without that method use deterministic extraction.
      const confirmed = typeof speech.verifyResult === 'function'
        ? speech.verifyResult(rendered, { text, key, userText, factual, preview: false }) : prepared.spokenText;
      if (typeof confirmed !== 'string' || !confirmed.trim()) {
        voice = false; log('[speech] unverified voice result; sending original text');
      } else spokenText = confirmed;
    }
    const segments = voice ? [{ type: 'record', data: { file: 'base64://' + rendered.audio.toString('base64') } }]
      : [...prefix, { type: 'text', data: { text } }];
    if (!isCurrent()) return { ok: false, cancelled: true, error: 'PERSONA_CHANGED', mode: voice ? 'voice' : 'text', text };
    let response;
    try { response = await (isGroup ? transport.sendGroup(target.groupId, segments) : transport.sendPrivate(target.userId, segments)); }
    catch { response = { ok: false, error: 'SEND_RESULT_UNKNOWN' }; }
    if (response?.ok && voice) {
      try { speech.remember(response.data?.message_id, spokenText, key); }
      catch { log('[speech] voice sent; transcript mapping could not be persisted'); }
    }
    // No text fallback after a QQ failure: a timeout may have delivered the voice.
    return { ...response, ok: response?.ok === true, mode: voice ? 'voice' : 'text', text,
      ...(voice ? { spokenText } : {}),
      ...(response?.ok ? {} : { unknown: true }) };
  };
}

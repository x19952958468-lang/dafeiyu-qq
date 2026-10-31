import { sleep, costOf, estimateTokens } from './util.js';
import { ACTION_PROMPT, parseActionIntent } from './action-intent.js';
import { SPEECH_DIRECTION_PROMPT, parseSpeechDirection } from './speech/direction.js';
import { SPEECH_PLAN_PROMPT, parseSpeechPlan } from './speech/plan.js';

const DRY_REPLIES = [
  '啊？叫我干嘛（甩尾巴）',
  '在吃饭…等一下',
  '这个我不会诶，别问我',
  '草，你这话说得\n有点离谱了吧',
  '嗯嗯嗯，你说得对（敷衍）',
];

export function createLLM(cfg) {
  const { baseUrl, apiKey, model, judgeModel, temperature, maxTokens, timeoutMs } = cfg.llm;
  const dry = !apiKey;
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  async function request({ messages, model: m, maxTokens: mt, temperature: t, requestTimeoutMs = timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: m,
          messages,
          temperature: t,
          max_tokens: mt,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${body.slice(0, 240)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return {
        text: (data.choices?.[0]?.message?.content ?? '').trim(),
        usage: data.usage ?? {},
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function withRetry(fn) {
    let lastErr;
    for (let i = 0; i < 2; i += 1) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const retriable = !e.status || e.status === 429 || e.status >= 500 || e.name === 'AbortError';
        if (!retriable || i === 1) break;
        await sleep(900 * (i + 1));
      }
    }
    throw lastErr;
  }

  /** 主生成 */
  async function chat({ messages, maxTokensOverride }) {
    if (dry) {
      await sleep(300);
      const text = DRY_REPLIES[Math.floor(Math.random() * DRY_REPLIES.length)];
      return { text, usage: { prompt_tokens: 0, completion_tokens: 0 }, dry: true };
    }
    const r = await withRetry(() =>
      request({
        messages,
        model,
        maxTokens: maxTokensOverride ?? maxTokens,
        temperature,
      }),
    );
    return { ...r, cost: costOf(r.usage, cfg.pricing) };
  }

  /**
   * L1 判定：这句话该不该接。只回一个字，成本极低。
   * 失败一律判「不接」（fail-closed），避免异常时变成刷屏。
   */
  async function shouldReply({ transcript, selfName, hint }) {
    if (dry) return true;
    const sys =
      `你在判断群聊机器人「${selfName}」此刻要不要开口。` +
      `它是个爱吃米饭、嘴硬心软的角色，爱凑热闹。` +
      `**只要最后那条消息里有实质内容就回「接」**——具体的事、观点、问题、情绪、吐槽，都算。` +
      (hint ? `本群常见话题：${hint}。` : '') +
      `只有这几种才回「不接」：纯附和（"对""哈哈""666""+1"）、纯表情或标点、` +
      `明显是两个人之间的私下对话（"你发我""收到""在吗"）、吵架、刷屏。` +
      `拿不准就回「接」。` +
      `只输出一个字：「接」或「不接」。`;
    try {
      const r = await withRetry(() =>
        request({
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: transcript },
          ],
          model: judgeModel,
          maxTokens: 4,
          temperature: 0,
        }),
      );
      return r.text.includes('接') && !r.text.includes('不接');
    } catch {
      return false;
    }
  }

  async function planAction({ text, recentAction, recentTargets }) {
    if (dry) return { action: { type: 'chat', task: false }, cost: 0 };
    const result = await withRetry(() => request({
      messages: [{ role: 'system', content: ACTION_PROMPT },
        { role: 'user', content: JSON.stringify({ currentRequest: text, recentAction: recentAction || null, recentTargets: recentTargets || [] }) }],
      model, maxTokens: 650, temperature: 0,
    }));
    return { action: parseActionIntent(result.text), cost: costOf(result.usage, cfg.pricing) };
  }

  async function directSpeech({ text, userText }) {
    if (dry) return { direction: null, cost: 0 };
    // Direction is optional. One bounded attempt must not stall delivery if the
    // language service is slow; the local emotion selector remains available.
    const result = await request({ messages: [{ role: 'system', content: SPEECH_DIRECTION_PROMPT },
      { role: 'user', content: JSON.stringify({ userText: String(userText || '').slice(0, 1200), reply: String(text || '').slice(0, 1600) }) }],
      model, maxTokens: 150, temperature: 0, requestTimeoutMs: Math.min(timeoutMs || 45000, 5000) });
    return { direction: parseSpeechDirection(result.text), cost: costOf(result.usage, cfg.pricing) };
  }

  async function planSpeech({ text, userText }) {
    if (dry) return { plan: null, cost: 0 };
    if (typeof text !== 'string' || !text || text.length > 2000) throw new Error('INVALID_SPEECH_PLAN_INPUT');
    // One bounded attempt. Unavailable or incomplete planning means text-only;
    // never fall back to reading the unreviewed original aloud.
    const result = await request({ messages: [{ role: 'system', content: SPEECH_PLAN_PROMPT },
      { role: 'user', content: JSON.stringify({ userText: String(userText || '').slice(0, 1200), reply: text }) }],
      model, maxTokens: Math.min(3000, Math.max(500, text.length * 3 + 250)), temperature: 0,
      requestTimeoutMs: Math.min(timeoutMs || 45000, 12000) });
    const parsed = parseSpeechPlan(result.text, text);
    return { plan: { decision: parsed.decision, parts: parsed.parts, direction: parsed.direction }, cost: costOf(result.usage, cfg.pricing) };
  }

  return { chat, shouldReply, planAction, directSpeech, planSpeech, dry, estimateTokens };
}

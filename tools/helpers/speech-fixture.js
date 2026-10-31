import { createSpeech as createRealSpeech } from '../../src/speech/index.js';

// Legacy unit fixtures already supply literal dialogue. Supply an explicit mock
// planner, while production and dedicated planner tests require a real decision.
export function createSpeech(options = {}) {
  const speech = createRealSpeech({ ...options, llm: {
    planSpeech: async ({ text }) => ({ plan: {
      decision: 'speak', parts: [{ kind: 'speech', text }],
      direction: { emotion: 'neutral', intent: 'chat', pace: 'natural', contour: 'steady' },
    }, cost: 0 }),
    ...options.llm,
  } });
  speech.updateConfig({ enabled: true });
  return speech;
}

// D140: saved replies share the history key, queue and encrypted record. No network or plaintext store.
export const SAVED_ANSWER_BYTES = 256_000;
const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const invalid = () => { throw new Error("The saved answers in this history export are invalid."); };

export function validateSavedAnswers(value = []) {
  if (!Array.isArray(value) || value.length > 1000) invalid();
  const result = value.map((a) => {
    if (!a || typeof a !== "object") invalid();
    const out = {};
    for (const key of ["id", "chatId", "messageId", "question", "answer", "model", "receiptId"]) {
      if (typeof a[key] !== "string" || a[key].length > (["question", "answer"].includes(key) ? SAVED_ANSWER_BYTES : key === "id" ? 5000 : 500)) invalid();
      out[key] = a[key];
    }
    if (!out.id || !out.messageId || !Number.isFinite(a.at) || a.at < 0 || a.at > 8.64e15) invalid();
    if (a.cost !== null && (typeof a.cost !== "number" || !Number.isFinite(a.cost) || a.cost < 0)) invalid();
    return { ...out, at: a.at, cost: a.cost };
  });
  if (size(result) > SAVED_ANSWER_BYTES) throw new Error("Saved answers are full. Unsave answers before adding more.");
  return result;
}

export function answerFromReply(lane, msg, chatId = "", at = Date.now()) {
  const index = lane.messages.indexOf(msg);
  const question = lane.messages.slice(0, index).findLast((m) => m.role === "user")?.text || "";
  return validateSavedAnswers([{
    id: JSON.stringify([chatId, lane.modelId || lane.id || "", msg.id]), chatId, messageId: msg.id,
    question, answer: msg.text || "", model: msg.model || lane.modelId || "", at,
    cost: Number.isFinite(msg.usage?.cost) && msg.usage.cost >= 0 ? msg.usage.cost : null,
    receiptId: msg.receipt?.id || "",
  }])[0];
}

export function mergeSavedAnswers(existing, incoming) {
  const ids = new Set(existing.map((a) => a.id));
  return validateSavedAnswers([...existing, ...validateSavedAnswers(incoming).filter((a) => !ids.has(a.id) && !!ids.add(a.id))]);
}

export function searchSavedAnswers(answers, query = "") {
  const q = query.trim().toLocaleLowerCase();
  return answers.filter((a) => !q || [a.question, a.answer].some((s) => s.toLocaleLowerCase().includes(q))).sort((a, b) => b.at - a.at);
}

// An ordinary Chat may still be on screen without being kept as a full conversation.
export function savedAnswerOnScreen(answer, lanes) {
  return lanes.some((lane) => lane.messages.some((m) => m.role === "assistant" && m.id === answer.messageId && m.text === answer.answer && (m.model || lane.modelId || "") === answer.model));
}

export function savedAnswerEdits({ serial, need, seal }) {
  const replace = async (s, answers) => {
    const savedAnswers = validateSavedAnswers(answers);
    await seal(s, s.chats, s.prompts, savedAnswers);
    s.savedAnswers = savedAnswers;
  };
  return {
    listSavedAnswers: () => structuredClone(need().savedAnswers || []),
    saveAnswer: (answer) => serial(async () => {
      const s = need();
      await replace(s, mergeSavedAnswers(s.savedAnswers || [], [answer]));
    }),
    unsaveAnswer: (id) => serial(async () => {
      const s = need();
      await replace(s, (s.savedAnswers || []).filter((a) => a.id !== id));
    }),
  };
}

export function savedAnswersFromExport(source) {
  const doc = JSON.parse(source); // Call after the existing history parser checks the envelope and size.
  return validateSavedAnswers(doc.savedAnswers);
}

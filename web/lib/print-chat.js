import { replyChargeModel } from './charge-links.js'; // J182
// H174: a transient projection of the conversation already shown, never a history write.
import { replyFacts } from "./harness.js";
import { safeImageUrl } from "./harness-images.js";
import { titleOf } from "./private-history.js";

const inlineImages = values => (values || []).map(safeImageUrl).filter(url => url?.startsWith("data:"));

export function printChatModel({ lanes = [], chat = null, find = () => null, now = Date.now() } = {}) {
  return {
    title: chat?.title || titleOf(lanes),
    at: chat?.at ?? now,
    lanes: lanes.map((lane, index) => ({
      number: index + 1,
      model: find(lane.modelId)?.name || lane.modelId || "Model unavailable",
      // G156 makes messages the shown path; deliberately never traverse branches.nodes.
      messages: (lane.messages || []).filter(message => ["user", "assistant"].includes(message.role)).map(message => {
        const facts = replyFacts(message);
        const images = inlineImages(message.role === "assistant" ? message.images : (message.attachments || []).filter(file => file.kind === "image").map(file => file.url));
        return {
          ...(message.pinned === true ? { pinned: true } : {}), // K191
          role: message.role,
          text: typeof message.text === "string" ? message.text : "",
          images,
          omittedImages: (message.role === "assistant" ? message.images?.length || 0 : (message.attachments || []).filter(file => file.kind === "image").length) - images.length,
          files: message.role === "user" ? (message.files || (message.attachments || []).filter(file => file.kind !== "image").map(file => file.name)).filter(Boolean) : [],
          ...(message.role === "assistant" ? {
            modelId: replyChargeModel(message, lane.modelId) || null, // J182
            model: find(message.model)?.name || message.model || find(lane.modelId)?.name || lane.modelId || "Model unavailable",
            cost: Number.isFinite(facts.cost) && facts.cost >= 0 ? facts.cost : null,
            receiptId: facts.receiptId || message.receiptId || null,
            status: message.status === "stopped" || message.stopped ? "Stopped" : message.status === "error" ? "Reply failed" : ["waiting", "streaming"].includes(message.status) ? "Reply in progress" : null,
          } : {}),
        };
      }),
    })),
  };
}

// Wait for inline images before opening the browser dialog. No fetching or persistence.
export async function openChatPrint(root, browser = globalThis) {
  const images = [...root.querySelectorAll("img")];
  let timer;
  try {
    await Promise.race([
      Promise.all(images.map(image => image.decode?.().catch(() => {}))),
      new Promise(resolve => { timer = browser.setTimeout(resolve, 2000); }),
    ]);
    browser.print();
  } finally {
    browser.clearTimeout(timer);
  }
}

import { snapshotLanes as snapshotText, restoreLanes as restoreText } from "./private-history.js";
import { imageHistoryFields } from "./harness-images.js";

// Keep generated outputs in the existing encrypted browser vault. Attachments still keep names only.
export function snapshotLanes(lanes) {
  return (lanes || []).map((lane) => {
    const messages = (lane.messages || []).flatMap((message) => {
      const fields = imageHistoryFields(message);
      const source = message.role === "assistant" && fields.images && !message.text ? { ...message, text: "Generated image" } : message;
      const saved = snapshotText([{ ...lane, messages: [source] }])[0].messages[0];
      return saved ? [{ ...saved, ...(message.role === "assistant" ? { ...fields, ...(typeof message.imageMode === "boolean" ? { imageMode: message.imageMode } : {}) } : {}), text: message.text || "" }] : [];
    });
    return { modelId: lane.modelId || null, messages };
  });
}

export function restoreLanes(saved, uid) {
  return restoreText(saved, uid).map((lane, index) => ({
    ...lane,
    messages: lane.messages.map((message, i) => {
      const source = saved?.[index]?.messages?.[i];
      return { ...message, ...(message.role === "assistant" ? { ...imageHistoryFields(source), imageMode: source?.imageMode ?? !!source?.images?.length } : {}) };
    }),
  }));
}

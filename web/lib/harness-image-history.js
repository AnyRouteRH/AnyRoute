import { snapshotLanes as snapshotText, restoreLanes as restoreText } from "./private-history.js";
import { imageHistoryFields, storedImages } from "./harness-images.js";

// Inputs and generated outputs extend the same encrypted browser vault, with no new storage key.
export function snapshotLanes(lanes) {
  const imageIds = new Map();
  return (lanes || []).map((lane) => {
    const messages = (lane.messages || []).flatMap((message) => {
      const fields = message.role === "assistant" ? imageHistoryFields(message) : {};
      const source = fields.images && !message.text ? { ...message, text: "Generated image" } : message;
      const saved = snapshotText([{ ...lane, messages: [source] }])[0].messages[0];
      if (message.role === "user") {
        const images = storedImages(message.attachments);
        if (images.length) return [{ ...(saved || { id: message.id, role: "user", text: message.text || "", files: [] }), attachments: images.map((image) => {
          // Compare lanes share inputs; keep their prepared bytes once in the bounded vault.
          if (imageIds.has(image.url)) return { imageRef: imageIds.get(image.url) };
          imageIds.set(image.url, image.id);
          return image;
        }) }];
        return saved ? [saved] : [];
      }
      return saved ? [{ ...saved, ...fields, ...(typeof message.imageMode === "boolean" ? { imageMode: message.imageMode } : {}), text: message.text || "" }] : [];
    });
    return { modelId: lane.modelId || null, messages };
  });
}

export function restoreLanes(saved, uid) {
  const images = new Map((saved || []).flatMap((lane) => (lane.messages || []).flatMap((message) => storedImages(message.attachments))).map((image) => [image.id, image]));
  return restoreText(saved, uid).map((lane, index) => ({
    ...lane,
    messages: lane.messages.map((message, i) => {
      const source = saved?.[index]?.messages?.[i];
      if (message.role === "user") return { ...message, attachments: storedImages((source?.attachments || []).map((image) => image.imageRef ? images.get(image.imageRef) || {} : image)) };
      const fields = imageHistoryFields(source);
      return { ...message, ...fields, imageMode: typeof source?.imageMode === "boolean" ? source.imageMode : !!fields.images?.length };
    }),
  }));
}

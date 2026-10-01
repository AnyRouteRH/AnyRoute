export const IMAGE_PRIVACY_NOTE = "Images are resized and stripped of location data on your device before sending.";

export function imageNoticeState(files = [], preparing = false, enabled = true) {
  const attached = files.some((file) => file.kind === "image");
  return { visible: attached || preparing, incompatible: attached && !enabled };
}

// Count queued images separately from documents, including overlapping selections.
export function createImagePreparationTracker(isImage, onChange) {
  let pending = 0;
  return (files) => {
    const images = files.filter(isImage).length;
    pending += images;
    if (images) onChange(true);
    return () => { pending -= images; if (images && !pending) onChange(false); };
  };
}

export function voiceStatus(phase) {
  return ({ starting: "Waiting for microphone permission…", listening: "Listening…", finishing: "Finishing transcript…", waiting: "Waiting for answer…", speaking: "Reading aloud…" })[phase] || "";
}

export function voiceMenuPosition(rect, viewport) {
  const width = Math.min(360, viewport.width - 24);
  return {
    left: Math.max(12, Math.min(rect.right - width, viewport.width - width - 12)),
    bottom: viewport.height - rect.top + 8,
    width,
    maxHeight: Math.max(0, Math.min(440, rect.top - 24)),
  };
}

export function bindVoiceMenuDismissal(doc, panel, trigger, close) {
  const outside = (event) => {
    if (!panel.contains(event.target) && !trigger.contains(event.target)) close(false);
  };
  const escape = (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(true); }
  };
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("focusin", outside);
  doc.addEventListener("keydown", escape);
  return () => {
    doc.removeEventListener("pointerdown", outside);
    doc.removeEventListener("focusin", outside);
    doc.removeEventListener("keydown", escape);
  };
}

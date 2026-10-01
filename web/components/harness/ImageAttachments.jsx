"use client";
import { useRef, useState } from "react";
import { attachmentKind, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../../lib/harness";
import { blobDataUrl, IMAGE_ACCEPT, prepareImage } from "../../lib/harness-images";
import s from "./ImageAttachments.module.css";

export function useImageAttachments({ files, setFiles, setNote, acceptsImages, acceptsFiles }) {
  const [preparing, setPreparing] = useState(false);
  const current = useRef(null);
  current.current = { files, acceptsImages, acceptsFiles };
  const pending = useRef(0);
  const queue = useRef(Promise.resolve());
  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    pending.current++;
    setPreparing(true);
    queue.current = queue.current.then(async () => {
      const notes = [];
      const out = [];
      for (const file of incoming) {
        if (current.current.files.length + out.length >= MAX_ATTACHMENTS) { notes.push(`Up to ${MAX_ATTACHMENTS} attachments per message.`); break; }
        const kind = attachmentKind(file.type, file.name);
        try {
          if (!kind) throw new Error("This file type is not sent.");
          if (kind === "image" && !current.current.acceptsImages) throw new Error("Switch to a vision model before attaching images. Every compare model must accept image input.");
          if (kind === "file" && !current.current.acceptsFiles) throw new Error("The selected model does not read files.");
          if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("Choose a file up to 8 MB.");
          const data = kind === "image" ? await prepareImage(file) : { kind, name: file.name || "file", url: await blobDataUrl(file), size: file.size };
          out.push({ ...data, id: crypto.randomUUID() });
        } catch (error) {
          notes.push(error?.message || "This image could not be prepared. Choose another image.");
        }
      }
      setFiles((previous) => [...previous, ...out].slice(0, MAX_ATTACHMENTS));
      setNote(notes.join(" "));
    }).finally(() => {
      pending.current--;
      if (!pending.current) setPreparing(false);
    });
    return queue.current;
  };
  return { addFiles, preparing, isPreparing: () => pending.current > 0 };
}

export function ImageAttach({ enabled, preparing, onFiles }) {
  const picker = useRef(null);
  const reason = !enabled ? "Every selected model must accept image input. Switch to a vision model." : preparing ? "Preparing images on your device" : "Attach images";
  return <>
    <button type="button" className={s.attach} aria-label={reason} aria-disabled={!enabled || preparing} title={reason} onClick={() => enabled && !preparing && picker.current?.click()}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" /><circle cx="6" cy="6" r="1.3" fill="currentColor" /><path d="m3 13 4-4 2 2 2-3 3 5" fill="none" stroke="currentColor" /></svg>
    </button>
    <input ref={picker} type="file" className="sr-only" tabIndex={-1} aria-label="Choose images" accept={IMAGE_ACCEPT} multiple disabled={!enabled || preparing} onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
  </>;
}

export function ImageNotice({ enabled, preparing, error, onSwitch, available }) {
  return <div className={s.notice}>
    <p>Images are resized and stripped of location data on your device before sending.</p>
    {preparing && <p role="status">Preparing images…</p>}
    {(!enabled || error) && <p role={error ? "status" : undefined}>{error || "Every selected model must accept image input."} {available ? <button type="button" className="text-button" onClick={onSwitch}>Switch to a vision model</button> : "No vision model is available in this catalogue."}</p>}
  </div>;
}

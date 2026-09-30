// Shapes shared by the hook, the components and the history vault. Plain data only, so a conversation can be
// kept (encrypted) and restored without any class instances.

/** A signed receipt as the router attaches it to the last chunk of a reply (only the parts the kit reads). */
export interface Receipt {
  id: string;
  payload?: { disclosure?: string; lane?: string; [key: string]: unknown };
  v2?: { claims?: { lane?: string; disclosure?: string; [key: string]: unknown } };
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  [key: string]: unknown;
}

/** An image attached to a user turn, as a data: or https: URL (sent to vision models as image_url parts). */
export interface Attachment {
  name: string;
  type: string;
  url: string;
}

export type MessageStatus = "streaming" | "done" | "stopped" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** User turns only. */
  attachments?: Attachment[];
  /** Assistant turns: the model the person asked for and the one that served. */
  model?: string;
  servedModel?: string;
  provider?: string;
  status?: MessageStatus;
  error?: string;
  usage?: Usage;
  receipt?: Receipt;
  /** Lane the router says it served on (x-anyroute-lane), when it said. */
  lane?: string;
  /** A note the router attached to the reply (for a character: how it ran). */
  note?: string;
  at?: number;
}

/** One entry of GET /api/v1/models (the parts the picker reads). */
export interface ModelInfo {
  id: string;
  name?: string;
  context_length?: number;
  input_modalities?: string[];
  architecture?: { input_modalities?: string[]; [key: string]: unknown };
  lanes?: string[];
  [key: string]: unknown;
}

/** A normalized privacy label (GET /api/v1/receipts/{id}/privacy). */
export interface PrivacyLabelData {
  receiptId: string;
  lane: string;
  rows: { key: string; title: string; text: string }[];
  summary: string[];
  verifyUrl: string;
}

// G156: optional lane metadata extends version 1 of the one Chat history format.
import { branchMessages, syncBranches } from "./harness-branches.js";
import { storedImages, imageHistoryFields } from "./harness-images.js";

const invalid = () => { throw new Error("Choose a history export with valid message versions."); };
const string = (value, max = 200) => {
  if (typeof value !== "string" || value.length > max) invalid();
  return value;
};

function extraFields(message) {
  const out = {};
  if (message.role === "assistant") {
    if (message.status !== undefined) {
      if (!["waiting", "streaming", "done", "stopped", "error"].includes(message.status)) invalid();
      out.status = ["waiting", "streaming"].includes(message.status) ? "stopped" : message.status;
    }
    for (const key of ["error", "errorKind"]) if (message[key] !== undefined) out[key] = string(message[key], 2_000_000);
    if (message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls) || message.toolCalls.length > 100) invalid();
      out.toolCalls = message.toolCalls.map(call => ({ id: string(call.id), name: string(call.name, 64), arguments: string(call.arguments || "{}", 2_000_000) }));
    }
  }
  return out;
}

export function snapshotBranches(lane, snapshotOne) {
  if (!lane.branches) return {};
  const branches = syncBranches(lane);
  return { branches: { selected: branches.selected, nodes: branches.nodes.map(node => {
    const message = node.message;
    if (message.role === "tool") return { parent: node.parent, message: { id: message.id, role: "tool", text: message.text || "", name: message.name, toolCallId: message.toolCallId } };
    // Keep empty/failed replies too, so a version and its reported cost do not disappear.
    const source = message.role === "assistant" ? { ...message, text: message.text || " ", status: "done", toolCalls: [] } : { ...message, text: message.text || " " };
    const saved = snapshotOne(source);
    return { parent: node.parent, message: { ...saved, text: message.text || "", ...extraFields(message) } };
  }) } };
}

export function validateBranches(value, validateMessage) {
  if (value === undefined) return {};
  if (!value || !Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 10000 || !Array.isArray(value.selected) || value.selected.length > value.nodes.length) invalid();
  const ids = new Set();
  const nodes = value.nodes.map(node => {
    if (!node || (node.parent !== null && (!ids.has(node.parent) || !string(node.parent)))) invalid();
    const message = node.message;
    if (!message || !string(message.id) || ids.has(message.id)) invalid();
    ids.add(message.id);
    if (message.role === "tool") return { parent: node.parent, message: { id: message.id, role: "tool", text: string(message.text, 2_000_000), name: string(message.name, 64), toolCallId: string(message.toolCallId) } };
    const clean = validateMessage(message);
    return { parent: node.parent, message: { ...clean, ...extraFields(message), ...imageHistoryFields(message), ...(message.role === "user" && storedImages(message.attachments).length ? { attachments: storedImages(message.attachments) } : {}), ...(typeof message.imageMode === "boolean" ? { imageMode: message.imageMode } : {}) } };
  });
  const selected = new Set(value.selected);
  if (selected.size !== value.selected.length || [...selected].some(id => !ids.has(id))) invalid();
  const parents = new Set();
  for (const node of nodes) if (selected.has(node.message.id)) {
    if (parents.has(node.parent)) invalid();
    parents.add(node.parent);
  }
  if (!parents.has(null)) invalid();
  return { branches: { nodes, selected: [...selected] } };
}

export function restoreBranches(saved, restoreOne) {
  if (!saved.branches) return {};
  const branches = { selected: [...saved.branches.selected], nodes: saved.branches.nodes.map(node => ({ parent: node.parent, message: node.message.role === "tool" ? { ...node.message } : { ...restoreOne(node.message), ...extraFields(node.message) } })) };
  return { branches, messages: branchMessages(branches) };
}

export const branchFingerprint = lane => lane.branches ? JSON.stringify(lane.branches) : "";

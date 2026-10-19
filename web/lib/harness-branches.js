// G156: messages is always the selected path. Other versions never enter a model request.
export function syncBranches(lane) {
  const nodes = (lane.branches?.nodes || []).map(node => ({ ...node }));
  const positions = new Map(nodes.map((node, i) => [node.message.id, i]));
  const ids = new Set(lane.branches?.selected || []);
  const selected = new Map(nodes.filter(node => ids.has(node.message.id)).map(node => [node.parent, node.message.id]));
  let parent = null;
  for (const message of lane.messages || []) {
    const node = { parent, message };
    if (positions.has(message.id)) nodes[positions.get(message.id)] = node;
    else { positions.set(message.id, nodes.length); nodes.push(node); }
    selected.set(parent, message.id);
    parent = message.id;
  }
  return { nodes, selected: [...selected.values()] };
}

export function branchMessages(branches) {
  const selected = new Set(branches.selected);
  const next = new Map(branches.nodes.filter(node => selected.has(node.message.id)).map(node => [node.parent, node.message]));
  const messages = [], seen = new Set();
  let parent = null;
  while (next.has(parent)) {
    const message = next.get(parent);
    if (seen.has(message.id)) break;
    seen.add(message.id); messages.push(message); parent = message.id;
  }
  return messages;
}

export function forkLane(lane, cut, replacements) {
  if (cut < 0 || cut > lane.messages.length) return lane;
  const branches = syncBranches(lane);
  let parent = lane.messages[cut - 1]?.id || null;
  const selected = new Set(branches.selected);
  for (const message of replacements) {
    for (const node of branches.nodes) if (node.parent === parent) selected.delete(node.message.id);
    branches.nodes.push({ parent, message }); selected.add(message.id); parent = message.id;
  }
  const { chatCostRemainder, ...rest } = lane;
  return { ...rest, messages: [...lane.messages.slice(0, cut), ...replacements], branches: { ...branches, selected: [...selected] } };
}

export function messageVersions(lane, messageId) {
  if (!lane.branches) return null;
  const branches = syncBranches(lane);
  const node = branches.nodes.find(node => node.message.id === messageId);
  if (!node) return null;
  const ids = branches.nodes.filter(other => other.parent === node.parent && other.message.role === node.message.role).map(other => other.message.id);
  return ids.length > 1 ? { ids, index: ids.indexOf(messageId) } : null;
}

export function switchVersion(lane, messageId, targetId) {
  const versions = messageVersions(lane, messageId);
  if (!versions?.ids.includes(targetId)) return lane;
  const branches = syncBranches(lane);
  const siblings = new Set(versions.ids);
  branches.selected = [...branches.selected.filter(id => !siblings.has(id)), targetId];
  const { chatCostRemainder, ...rest } = lane;
  return { ...rest, branches, messages: branchMessages(branches) };
}

export function editBranch(lane, messageId, text, attachments, uid) {
  const cut = lane.messages.findIndex(message => message.id === messageId && message.role === "user");
  if (cut < 0) return null;
  const user = { ...lane.messages[cut], id: uid(), text, attachments };
  delete user.pinned; // K191: a new version starts without the original version's pin.
  const reply = { id: uid(), role: "assistant", model: lane.modelId, status: "waiting", text: "" };
  const next = forkLane(lane, cut, [user, reply]);
  return { lane: next, history: next.messages.slice(0, -1), reply };
}

export function regenerateBranch(lane, modelId, uid) {
  const lastUser = lane.messages.findLastIndex(message => message.role === "user");
  const lastTool = lane.messages.findLastIndex(message => message.role === "tool");
  const cut = Math.max(lastUser, lastTool) + 1;
  if (!cut) return null;
  const reply = { id: uid(), role: "assistant", model: modelId, status: "waiting", text: "" };
  const next = forkLane({ ...lane, modelId }, cut, [reply]);
  return { lane: next, history: next.messages.slice(0, -1), reply };
}

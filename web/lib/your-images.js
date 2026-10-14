// H167: an ephemeral view of the existing unlocked history; no storage or network reads.
import { safeImageUrl } from './harness-images.js';
import { switchVersion, syncBranches } from './harness-branches.js';

export function collectYourImages(history) {
  if (!history?.unlocked) return [];
  const images = [];
  for (const summary of history.list()) {
    const chat = history.get(summary.id);
    if (!chat) continue;
    chat.lanes.forEach((lane, laneIndex) => {
      const branches = syncBranches(lane);
      const nodes = new Map(branches.nodes.map(node => [node.message.id, node]));
      branches.nodes.forEach((node, order) => {
        const message = node.message;
        if (message.role !== 'assistant') return;
        let parent = nodes.get(node.parent), prompt = '';
        const seen = new Set();
        while (parent && !seen.has(parent.message.id)) {
          seen.add(parent.message.id);
          if (parent.message.role === 'user') { prompt = parent.message.text || ''; break; }
          parent = nodes.get(parent.parent);
        }
        (message.images || []).forEach((url, imageIndex) => {
          // External links are excluded so opening this gallery cannot contact an image host.
          if (typeof url !== 'string' || !url.startsWith('data:') || !safeImageUrl(url)) return;
          images.push({ id: JSON.stringify([chat.id, laneIndex, message.id, imageIndex]), chatId: chat.id, title: chat.title,
            laneIndex, messageId: message.id, imageIndex, url, prompt,
            snippet: prompt.trim().replace(/\s+/g, ' ').slice(0, 160), model: message.model || lane.modelId || '', at: chat.at, order });
        });
      });
    });
  }
  // History records chat save times, not individual image creation times. Later turns come first within a chat.
  return images.sort((a, b) => b.at - a.at || b.order - a.order || a.laneIndex - b.laneIndex || a.imageIndex - b.imageIndex);
}

export function filterYourImages(images, { model = '', query = '' } = {}) {
  const search = query.trim().toLowerCase();
  return images.filter(image => (!model || image.model === model) && (!search || image.prompt.toLowerCase().includes(search)));
}

export function yourImagesAccess(history) {
  return history?.unlocked ? '' : 'Enable Private mode in Chat, then choose Keep history on this device or Unlock and enter your history passphrase. Your images appear only while this browser’s history is unlocked.';
}

// Open the saved version that contains this image using the existing branch format.
export function selectImageVersion(lanes, image) {
  return lanes.map((lane, index) => {
    if (index !== image.laneIndex || !lane.branches) return lane;
    const nodes = new Map(lane.branches.nodes.map(node => [node.message.id, node]));
    let node = nodes.get(image.messageId);
    if (!node) return lane;
    const path = [], seen = new Set();
    while (node && !seen.has(node.message.id)) {
      seen.add(node.message.id); path.push(node.message.id); node = nodes.get(node.parent);
    }
    let opened = lane;
    for (const id of path.reverse()) {
      const target = nodes.get(id);
      const current = opened.messages.find(message => nodes.get(message.id)?.parent === target.parent && message.role === target.message.role);
      if (current && current.id !== id) opened = switchVersion(opened, current.id, id);
    }
    return opened;
  });
}

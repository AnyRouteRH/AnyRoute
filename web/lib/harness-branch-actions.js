// G156: reuse the existing authenticated streaming path and its guards.
import { editBranch, regenerateBranch } from "./harness-branches.js";
import { contextSendBlock } from "./context-meter.js";
import { imageSendBlock } from "./harness-images.js";

export function resendEdit({ lanes, laneId, messageId, text, attachments, uid, setLanes, runLane, find, system, needKey, onError, onSaved }) {
  const lane = lanes.find(lane => (!laneId || lane.id === laneId) && lane.messages.some(message => message.id === messageId));
  const job = lane && editBranch(lane, messageId, text, attachments, uid);
  if (!job) return;
  const prefix = { ...lane, messages: job.history.slice(0, -1) };
  const error = contextSendBlock([prefix], find, system, text, attachments) || imageSendBlock([prefix], find, attachments);
  if (error) return onError(error);
  if (needKey("send") || !find(lane.modelId)) return;
  setLanes(lanes.map(lane => lane.id === job.lane.id ? job.lane : lane));
  onSaved();
  runLane(job.lane.id, job.lane.modelId, job.history, job.reply.id);
}

export function resendReply({ lane, modelId, uid, setLanes, runLane }) {
  const job = regenerateBranch(lane, modelId, uid);
  if (!job) return;
  setLanes(lanes => lanes.map(lane => lane.id === job.lane.id ? job.lane : lane));
  runLane(job.lane.id, modelId, job.history, job.reply.id, lane.messages.findLast(message => message.role === "assistant")?.imageMode ?? null);
}

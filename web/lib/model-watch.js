export const MODEL_WATCH_PATH = '/api/v1/account/model-watch';
export async function readModelWatches(request, options) { return request(MODEL_WATCH_PATH, options); }
export async function changeModelWatch(request, model, watched, options) {
  return request(MODEL_WATCH_PATH, { ...options, method: watched ? 'PUT' : 'DELETE', body: { model } });
}

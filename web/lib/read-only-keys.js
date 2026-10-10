// E149: only explicit read selection changes the existing creation request.
export const READ_ONLY_LABEL = "Read only: can see activity and statements, can't spend or change anything";
export const readScopeSelectable = caller => !!caller?.management && caller?.scope !== 'read';
export function withReadScope(request, values) {
  return (path, options) => request(path, path === '/api/v1/keys' && options.method === 'POST' && values.scope === 'read'
    ? { ...options, body: { ...options.body, scope: 'read' } } : options);
}

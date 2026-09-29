// Where a request came from. The gateway builds the request it hands to the router's own routes, and records here
// that it did and on behalf of which relay. The record lives in a WeakMap keyed by the Request object itself, so
// nothing a client sends (a header, a query string, a body field) can set or forge it: only code holding the
// Request the gateway constructed can be found in the map.

export type RelayIdentity = {
  operator: string;
  keyId: string;
  /** False when the relay's operator is the gateway's own operator: such a relay hides nothing from the gateway. */
  independent: boolean;
};

export type GatewayOrigin = { relay: RelayIdentity | null };

const origins = new WeakMap<Request, GatewayOrigin>();

export const markFromGateway = (req: Request, origin: GatewayOrigin) => void origins.set(req, origin);

/** The origin of a request the gateway dispatched, or undefined for a request that came in directly. */
export const gatewayOrigin = (req: Request): GatewayOrigin | undefined => origins.get(req);

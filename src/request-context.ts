import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  userId?: string;
  userName?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Get the current request's user context. Returns empty object outside of a request. */
export function getCurrentRequestContext(): RequestContext {
  return requestContext.getStore() ?? {};
}

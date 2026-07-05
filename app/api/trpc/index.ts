// Public surface of the tRPC transport layer (task 5.1).
//
// The Editor (task 6.2) imports `AppRouter` for its end-to-end typed client and
// `createGatewayContext` to authenticate each request; task 6 wires the concrete
// `GatewayHandlers` and the SSE/HTTP2 transport.

export * from './schemas.js';
export * from './trpc.js';
export * from './router.js';

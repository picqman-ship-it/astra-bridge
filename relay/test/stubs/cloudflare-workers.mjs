// Minimal stand-in for the `cloudflare:workers` module so DeviceRelay can be unit
// tested under Node with a fake DurableObjectState.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// A Workers runtime global, not a module export; defined here because every bundle
// that uses DeviceRelay imports this stub.
globalThis.WebSocketRequestResponsePair ??= class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

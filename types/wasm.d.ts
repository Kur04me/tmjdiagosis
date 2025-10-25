declare module "/wasm/tmj_core.js" {
  export default function init(
    input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module
  ): Promise<any>;

  export function greet_wasm(): string;
}

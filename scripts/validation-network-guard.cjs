// Isolated launch validation only. Never preload this in a production worker.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node --require preload is CommonJS.
const net = require("node:net");
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const pipe = typeof first === "string" ? first : first?.path;
  // tsx uses a local Windows named pipe for its launcher IPC, not a network service.
  if (typeof pipe === "string" && pipe.startsWith("\\\\.\\pipe\\") && pipe.includes("tsx")) {
    return original.apply(this, args);
  }
  const options = typeof first === "object" ? first : { port: first, host: args[1] };
  const host = options?.host ?? "localhost";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || Number(options?.port) !== 25439) {
    throw new Error("Isolated validation blocked a non-test database network connection");
  }
  return original.apply(this, args);
};
globalThis.fetch = async () => { throw new Error("Isolated validation blocked fetch"); };

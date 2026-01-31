import { WebWorkerMLCEngineHandler } from "https://esm.run/@mlc-ai/web-llm";

// This handler listens for messages from the main thread (index.html)
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => {
  handler.onmessage(msg);
};

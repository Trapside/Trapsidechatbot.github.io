// mlc-worker.js
// Worker (ES module) that hosts the MLC engine to keep heavy work off the main thread.
// Place this file next to index.html and ensure it's loaded with: new Worker('mlc-worker.js', {type: 'module'})
import * as webllm from "https://esm.run/@mlc-ai/web-llm";

let engine = null;
let currentRun = null; // { runId, aborted }

function postLog(msg) {
    self.postMessage({ type: 'log', msg });
}

self.onmessage = async (ev) => {
    const m = ev.data;
    try {
        if (m.type === 'init') {
            const t0 = performance.now();
            engine = await webllm.CreateMLCEngine(m.modelId || "SmolLM2-360M-Instruct-q4f16_1-MLC", {
                initProgressCallback: (p) => {
                    // forward progress logs
                    postLog(JSON.stringify(p));
                }
            });
            const initTime = Math.round(performance.now() - t0);
            self.postMessage({ type: 'ready', initTime });
        } else if (m.type === 'run' || m.type === 'summarize') {
            if (!engine) {
                throw new Error('Engine not initialized');
            }
            // If there's already a run, mark it aborted (we will break its loop)
            if (currentRun && !currentRun.aborted) currentRun.aborted = true;
            const runId = m.runId;
            currentRun = { runId, aborted: false };

            const opts = m.opts || {};
            const params = {
                messages: m.messages,
                stream: true,
                max_new_tokens: opts.max_new_tokens || 256,
                temperature: opts.temperature || 0.2,
                top_p: opts.top_p || 0.95
            };

            try {
                const chunks = await engine.chat.completions.create(params);
                for await (const chunk of chunks) {
                    if (currentRun.aborted) break;
                    const delta = chunk.choices?.[0]?.delta?.content || "";
                    if (delta) {
                        self.postMessage({ type: 'token', runId, token: delta });
                    }
                }
                if (!currentRun.aborted) {
                    self.postMessage({ type: 'done', runId });
                } else {
                    self.postMessage({ type: 'done', runId }); // treat aborted as done for main thread cleanup
                }
            } catch (err) {
                self.postMessage({ type: 'error', runId, error: (err && err.message) ? err.message : String(err) });
            } finally {
                // clear currentRun if it's this run
                if (currentRun && currentRun.runId === runId) currentRun = null;
            }
        } else if (m.type === 'abort') {
            if (currentRun && currentRun.runId === m.runId) {
                currentRun.aborted = true;
            } else {
                // best-effort: if different runId, still set aborted to ensure stop
                if (currentRun) currentRun.aborted = true;
            }
        } else if (m.type === 'shutdown') {
            try {
                if (engine) {
                    await engine.unload();
                    engine = null;
                }
            } catch (e) {
                postLog('engine unload failed: ' + e);
            }
            self.postMessage({ type: 'shutdown' });
            // optionally self.close() to terminate worker from inside
        }
    } catch (err) {
        const runId = m && m.runId ? m.runId : null;
        self.postMessage({ type: 'error', runId, error: (err && err.message) ? err.message : String(err) });
    }
};

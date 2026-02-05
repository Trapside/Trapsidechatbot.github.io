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
            // Initialize engine once
            const t0 = performance.now();
            try {
                engine = await webllm.CreateMLCEngine(m.modelId || "Arjun-G-Ravi/chat-GPT-2", {
                    initProgressCallback: (p) => {
                        // forward progress logs if needed
                        postLog(JSON.stringify(p));
                    }
                });
                const initTime = Math.round(performance.now() - t0);
                self.postMessage({ type: 'ready', initTime });
            } catch (err) {
                // Initialization may fail due to WebGPU / memory
                const msg = (err && err.message) ? err.message : String(err);
                self.postMessage({ type: 'error', error: 'init-failed: ' + msg });
            }
        } else if (m.type === 'run' || m.type === 'summarize') {
            if (!engine) {
                self.postMessage({ type: 'error', runId: m.runId, error: 'engine-not-initialized' });
                return;
            }
            // abort any existing run
            if (currentRun && !currentRun.aborted) currentRun.aborted = true;
            const runId = m.runId;
            currentRun = { runId, aborted: false };

            const opts = m.opts || {};
            const params = {
                messages: m.messages,
                stream: true,
                max_new_tokens: opts.max_new_tokens || 160,
                temperature: opts.temperature || 0.2,
                top_p: opts.top_p || 0.95
            };

            try {
                // Stream token-by-token; if engine errors, attempt to unload to free memory
                const chunks = await engine.chat.completions.create(params);
                for await (const chunk of chunks) {
                    if (currentRun.aborted) break;
                    const delta = chunk.choices?.[0]?.delta?.content || "";
                    if (delta) {
                        self.postMessage({ type: 'token', runId, token: delta });
                    }
                }
                // report done (even if aborted, main will clean up)
                self.postMessage({ type: 'done', runId });
            } catch (err) {
                const msg = (err && err.message) ? err.message : String(err);
                // Attempt to unload engine on fatal errors to free memory and allow main to restart
                try {
                    await engine.unload();
                    engine = null;
                    postLog('Engine unloaded after error');
                } catch (e) {
                    postLog('Engine unload failed after error: ' + e);
                }
                self.postMessage({ type: 'error', runId, error: msg });
            } finally {
                if (currentRun && currentRun.runId === runId) currentRun = null;
            }
        } else if (m.type === 'abort') {
            if (currentRun && currentRun.runId === m.runId) {
                currentRun.aborted = true;
            } else if (currentRun) {
                currentRun.aborted = true;
            }
        } else if (m.type === 'unload') {
            // Unload engine but keep worker alive. Main will re-init when needed.
            try {
                if (engine) {
                    await engine.unload();
                    engine = null;
                    self.postMessage({ type: 'unloaded' });
                } else {
                    self.postMessage({ type: 'unloaded' });
                }
            } catch (e) {
                postLog('engine unload failed during unload: ' + e);
                self.postMessage({ type: 'error', error: 'unload-failed: ' + (e && e.message ? e.message : String(e)) });
            }
        } else if (m.type === 'shutdown') {
            try {
                if (engine) {
                    await engine.unload();
                    engine = null;
                }
            } catch (e) {
                postLog('engine unload failed during shutdown: ' + e);
            }
            self.postMessage({ type: 'shutdown' });
            // Fully close worker if requested
            try {
                self.close();
            } catch (e) { /* ignore */ }
        }
    } catch (err) {
        const runId = m && m.runId ? m.runId : null;
        const msg = (err && err.message) ? err.message : String(err);
        self.postMessage({ type: 'error', runId, error: msg });
    }
};

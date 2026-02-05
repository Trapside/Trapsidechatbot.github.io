// mlc-worker-llama.js
import { Wllama } from 'https://cdn.jsdelivr.net/npm/@wllama/wllama/esm/index.js';

const CONFIG_PATHS = {
  'single-thread/wllama.wasm': 'https://cdn.jsdelivr.net/npm/@wllama/wllama/esm/single-thread/wllama.wasm',
  'multi-thread/wllama.wasm' : 'https://cdn.jsdelivr.net/npm/@wllama/wllama/esm/multi-thread/wllama.wasm',
};

let wllama = null;
let modelHandle = null;
let currentRun = null;

function postLog(msg){ self.postMessage({ type:'log', msg }); }

// Helper: chunk and post a full string back as tokens (emulate streaming)
async function streamStringAsChunks(runId, text, chunkMs = 25, chunkSize = 20, controller = { signal: { aborted:false } }) {
  let i = 0;
  while (i < text.length) {
    if (controller.signal && controller.signal.aborted) {
      postLog('stream aborted by controller');
      return;
    }
    const chunk = text.slice(i, i + chunkSize);
    try { self.postMessage({ type:'token', runId, token: chunk }); } catch(e){}
    i += chunkSize;
    // give main thread time to render
    await new Promise(r => setTimeout(r, chunkMs));
  }
}

// Initialize Wllama and load model from HF or URL
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      // m may contain: modelRepo & modelFile OR modelUrl, plus opts
      const t0 = performance.now();
      try {
        // create Wllama instance (passes wasm config map)
        wllama = new Wllama(CONFIG_PATHS);
        // Attempt to load via loadModelFromHF if modelRepo+modelFile provided (your snippet)
        if (m.modelRepo && m.modelFile) {
          postLog(`Loading from HF repo ${m.modelRepo} file ${m.modelFile}`);
          modelHandle = await wllama.loadModelFromHF(m.modelRepo, m.modelFile, {
            progressCallback: ({ loaded, total }) => {
              // forward progress
              const pct = Math.round((loaded/total) * 100);
              postLog(`Loading ${pct}%`);
            },
            ...(m.opts || {})
          });
          postLog('Model loaded via loadModelFromHF');
        } else if (m.modelUrl) {
          // Some Wllama variants provide loadModelFromUrl; try it
          postLog('Loading model from URL: ' + m.modelUrl);
          if (typeof wllama.loadModelFromUrl === 'function') {
            modelHandle = await wllama.loadModelFromUrl(m.modelUrl, m.opts || {});
            postLog('Model loaded via loadModelFromUrl');
          } else {
            // Fallback: fetch bytes and try loadModelFromBytes if available
            const resp = await fetch(m.modelUrl);
            if (!resp.ok) throw new Error('Failed to fetch model URL: ' + resp.status);
            const ab = await resp.arrayBuffer();
            if (typeof wllama.loadModelFromBytes === 'function') {
              modelHandle = await wllama.loadModelFromBytes(ab, m.opts || {});
              postLog('Model loaded via loadModelFromBytes');
            } else {
              throw new Error('Wllama does not expose loadModelFromUrl or loadModelFromBytes; adapt worker.');
            }
          }
        } else {
          throw new Error('init requires modelRepo+modelFile or modelUrl');
        }

        if (!modelHandle) throw new Error('Model handle null after load');
        const initTime = Math.round(performance.now() - t0);
        self.postMessage({ type:'ready', initTime });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        self.postMessage({ type:'error', error: 'init-failed: ' + msg });
      }
      return;
    }

    if (m.type === 'run' || m.type === 'summarize') {
      if (!wllama || !modelHandle) {
        self.postMessage({ type:'error', runId: m.runId, error: 'model-not-loaded' });
        return;
      }

      // abort previous run
      if (currentRun && !currentRun.aborted) {
        currentRun.aborted = true;
        if (currentRun.controller && currentRun.controller.signal) currentRun.controller.signal.aborted = true;
        try { currentRun.cancelFn && currentRun.cancelFn(); } catch(e){}
      }

      // build prompt string from messages or use prompt
      let promptText = '';
      if (Array.isArray(m.messages)) {
        promptText = m.messages.map(x => `${x.role.toUpperCase()}: ${x.content}`).join('\n');
      } else {
        promptText = String(m.prompt || '');
      }

      // set up controller for cooperative cancellation
      const controller = { signal: { aborted: false } };
      currentRun = { runId: m.runId, aborted: false, controller, cancelFn: null };

      // map options: max_new_tokens -> nPredict, sampling.temp->temp, top_k->top_k
      const nPredict = (m.opts && m.opts.max_new_tokens) ? m.opts.max_new_tokens : (m.type === 'summarize' ? 96 : 128);
      const sampling = {
        temp: (m.opts && m.opts.temperature) ? m.opts.temperature : 0.2,
        top_k: (m.opts && m.opts.top_k) ? m.opts.top_k : (m.opts && m.opts.top_p ? Math.round((m.opts.top_p||1.0)*100) : 40)
      };

      try {
        // Your Wllama snippet uses createCompletion(prompt, { nPredict, sampling })
        // Some Wllama builds may support a streaming callback; here we'll call createCompletion
        // and then stream the final output in chunks back to the main thread.
        postLog(`createCompletion: nPredict=${nPredict} temp=${sampling.temp} top_k=${sampling.top_k}`);
        const out = await wllama.createCompletion(promptText, {
          nPredict,
          sampling,
          // pass any extra opts user provided
          ...(m.opts && m.opts.extra ? m.opts.extra : {})
        });

        if (controller.signal && controller.signal.aborted) {
          postLog('Run aborted after completion');
          self.postMessage({ type:'done', runId: m.runId });
          return;
        }

        // If out is an object with text property, normalize
        const textOut = (out && typeof out === 'object' && out.text) ? out.text : String(out || '');

        // Stream the response back in small chunks (emulate streaming)
        await streamStringAsChunks(m.runId, textOut, 25, 20, controller);

        self.postMessage({ type:'done', runId: m.runId });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        postLog('createCompletion error: ' + msg);
        // Try to unload model to free memory (best-effort)
        try {
          if (wllama && typeof wllama.freeModel === 'function') { await wllama.freeModel(modelHandle); modelHandle = null; }
          else if (wllama && typeof wllama.unloadModel === 'function') { await wllama.unloadModel(modelHandle); modelHandle = null; }
        } catch (e) { postLog('freeModel/unloadModel failed: ' + e); }
        self.postMessage({ type:'error', runId: m.runId, error: msg });
      } finally {
        currentRun = null;
      }
      return;
    }

    if (m.type === 'abort') {
      if (currentRun && currentRun.runId === m.runId) {
        currentRun.aborted = true;
        if (currentRun.controller && currentRun.controller.signal) currentRun.controller.signal.aborted = true;
        try { currentRun.cancelFn && currentRun.cancelFn(); } catch(e){ postLog('cancelFn err: '+e); }
      } else if (currentRun) {
        currentRun.aborted = true;
        if (currentRun.controller && currentRun.controller.signal) currentRun.controller.signal.aborted = true;
        try { currentRun.cancelFn && currentRun.cancelFn(); } catch(e){ postLog('cancelFn err: '+e); }
      }
      return;
    }

    if (m.type === 'unload') {
      try {
        if (wllama && modelHandle) {
          if (typeof wllama.freeModel === 'function') await wllama.freeModel(modelHandle);
          else if (typeof wllama.unloadModel === 'function') await wllama.unloadModel(modelHandle);
          modelHandle = null;
        }
        self.postMessage({ type:'unloaded' });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        self.postMessage({ type:'error', error:'unload-failed: ' + msg });
      }
      return;
    }

    if (m.type === 'shutdown') {
      try {
        if (currentRun && currentRun.cancelFn) try { currentRun.cancelFn(); } catch(e){}
        if (wllama && typeof wllama.close === 'function') await wllama.close();
        wllama = null; modelHandle = null;
      } catch(e) { postLog('shutdown err: '+e); }
      self.postMessage({ type:'shutdown' });
      try { self.close(); } catch(e){}
      return;
    }

    postLog('Unknown message: ' + JSON.stringify(m && m.type));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    self.postMessage({ type:'error', error: msg });
  }
};

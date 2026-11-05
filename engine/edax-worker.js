// Runs Edax (WebAssembly) in a background thread so the board never freezes.
// Messages in:  { id, board, level, n }   (board: 64 chars a1..h8 + ' X' or ' O')
// Messages out: { type: 'ready' } | { id, result } | { id, error }
importScripts('build/edax.js');

let analyze = null;

createEdax({ locateFile: (f) => 'build/' + f }).then((Module) => {
  Module.ccall('edax_init', 'number', ['number'], [20]);
  analyze = Module.cwrap('edax_analyze', 'string', ['string', 'number', 'number']);
  postMessage({ type: 'ready' });
}).catch((e) => postMessage({ type: 'error', error: String(e) }));

onmessage = (e) => {
  const { id, board, level, n } = e.data;
  if (!analyze) { postMessage({ id, error: 'engine not ready' }); return; }
  try {
    postMessage({ id, result: JSON.parse(analyze(board, level, n)) });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};

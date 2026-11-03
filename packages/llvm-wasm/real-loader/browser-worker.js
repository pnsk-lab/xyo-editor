var lines = [];
var Module = {
  print: s => { lines.push(s); },
  printErr: s => { lines.push('stderr: ' + s); },
  onExit: status => postMessage({status, lines}),
  onAbort: reason => postMessage({status: 1, reason: String(reason), lines})
};
try { importScripts('browser.js'); } catch (e) { postMessage({status: 1, reason: String(e), lines}); }

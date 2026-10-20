// Classic worker: third-party scripts never run on the UI thread.
self.Prism = { manual: true, disableWorkerMessageHandler: true };
importScripts('vendor/prism/prism-core.min.js');
// Fixed order includes grammar dependencies and markup embedded JS/CSS support.
for (const name of ['markup', 'css', 'clike', 'javascript', 'typescript', 'jsx', 'tsx', 'json', 'bash', 'python', 'yaml', 'markdown', 'java', 'csharp', 'go']) {
  importScripts(`vendor/prism/prism-${name}.min.js`);
}
import('./diff-syntax.js').then(({ tokenLines, LIMITS }) => {
  self.onmessage = ({ data }) => {
    let lines = null;
    try {
      if (typeof data.source === 'string' && data.source.length * 2 <= LIMITS.source &&
          Object.hasOwn(Prism.languages, data.language)) {
        lines = tokenLines(Prism.tokenize(data.source, Prism.languages[data.language]), data.source);
      }
    } catch { /* Literal source is already visible. Never log source. */ }
    self.postMessage({ lines });
  };
  self.postMessage({ ready: true });
});

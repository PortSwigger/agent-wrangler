import { readAudioFile, playCue } from './preferences.js';

export default {
  register(slots) {
    const api = slots.api;
    let sounds = null;
    const panels = new Map();
    const requests = new Map();
    api.onMessage((msg) => {
      if (msg.kind === 'sounds') {
        sounds = msg.sounds;
        for (const [id, pending] of requests) {
          if (pending.type !== 'sounds-get') continue;
          requests.delete(id);
          clearTimeout(pending.timer);
          pending.resolve();
        }
        for (const state of panels.values()) {
          if (state.errors.delete('load')) state.status.textContent = [...state.errors.values()].join(' ');
          for (const kind of ['finished', 'needs-you']) {
            if (state.dirty.has(kind)) continue;
            if (sounds[kind]) state.draft.sounds[kind] = sounds[kind];
            else delete state.draft.sounds[kind];
            state.names.get(kind).textContent = sounds[kind]?.name || 'Built-in tone';
          }
        }
      }
      const pending = requests.get(msg.reqId);
      if (!pending) return;
      requests.delete(msg.reqId);
      clearTimeout(pending.timer);
      if (msg.kind === 'sounds-error') pending.reject(Error(msg.error));
      else if (msg.kind === 'sounds') pending.resolve();
    });
    const refresh = () => api.send({ type: 'sounds-get' });
    api.onConnect(refresh);
    refresh();
    const request = (type, payload = {}) => new Promise((resolve, reject) => {
      const reqId = crypto.randomUUID();
      const timer = setTimeout(() => { requests.delete(reqId); reject(Error('Sound settings request timed out. Reconnect and try again.')); }, 10000);
      requests.set(reqId, { type, resolve, reject, timer });
      api.send({ type, reqId, ...payload });
    });
    slots.register('notification.cue', {
      id: 'sounds',
      cue: (kind) => sounds === null ? false : playCue(kind, sounds),
    });
    slots.register('settings.panel', {
      id: 'sounds',
      mount(el) {
        el.className += ' sound-settings';
        const doc = el.ownerDocument;
        const draft = { sounds: structuredClone(sounds || {}) };
        const dirty = new Set();
        const revisions = new Map();
        const names = new Map();
        const pending = new Set();
        const errors = new Map();
        const make = (tag, text) => {
          const node = doc.createElement(tag);
          if (text) node.textContent = text;
          return node;
        };
        const intro = make('p', 'Upload an audio file for either cue, or keep the built-in tones. Files are saved on the server and shared across browsers. Each file can be up to 1 MB. Disable the Sounds extension to silence all cues. Focus mode silences other tasks.');
        el.append(intro);
        const status = make('p');
        status.className = 'sound-status';
        status.setAttribute('role', 'status');
        const showError = () => { status.textContent = [...errors.values()].join(' '); };
        for (const [kind, title] of [['finished', 'Session finished'], ['needs-you', 'Session needs you']]) {
          const row = make('fieldset');
          row.className = 'sound-cue';
          row.append(make('legend', title));
          const current = make('p', draft.sounds[kind]?.name || 'Built-in tone');
          names.set(kind, current);
          const uploadLabel = make('label', 'Upload audio ');
          const upload = make('input');
          upload.type = 'file';
          upload.accept = 'audio/*';
          uploadLabel.append(upload);
          const preview = make('button', 'Preview');
          preview.type = 'button';
          preview.className = 'ext-btn';
          const reset = make('button', 'Use default');
          reset.type = 'button';
          reset.className = 'ext-btn';
          let revision = 0;
          upload.addEventListener('change', () => {
            const file = upload.files?.[0];
            if (!file) return;
            dirty.add(kind);
            const latest = ++revision;
            revisions.set(kind, revision);
            const operation = (async () => {
              try {
                const sound = await readAudioFile(file);
                if (latest !== revision) return;
                draft.sounds[kind] = sound;
                current.textContent = sound.name;
                errors.delete(kind);
              } catch (err) {
                if (latest !== revision) return;
                errors.set(kind, err.message);
              }
              showError();
            })();
            pending.add(operation);
            operation.finally(() => pending.delete(operation));
            return operation;
          });
          preview.addEventListener('click', async () => {
            await Promise.all([...pending]);
            const ok = await playCue(kind, draft.sounds);
            status.textContent = ok ? '' : 'Could not play this sound. Check browser audio permissions and try again.';
          });
          reset.addEventListener('click', () => {
            revision++;
            revisions.set(kind, revision);
            dirty.add(kind);
            delete draft.sounds[kind];
            errors.delete(kind);
            upload.value = '';
            current.textContent = 'Built-in tone';
            showError();
          });
          row.append(current, uploadLabel, preview, reset);
          el.append(row);
        }
        el.append(status);
        panels.set(el, { draft, dirty, revisions, names, pending, errors, status });
        if (sounds === null) {
          const loading = request('sounds-get').catch((err) => { errors.set('load', err.message); showError(); });
          pending.add(loading);
          loading.finally(() => pending.delete(loading));
        }
      },
      async save(el) {
        const state = panels.get(el);
        await Promise.all([...state.pending]);
        try {
          if (state.errors.size) throw Error([...state.errors.values()].join(' '));
          const savedRevisions = new Map(state.revisions);
          await request('sounds-set', { sounds: structuredClone(state.draft.sounds) });
          for (const [kind, revision] of savedRevisions) {
            if (state.revisions.get(kind) === revision) state.dirty.delete(kind);
          }
          state.status.textContent = state.dirty.size ? 'Saved. Newer edits still need saving.' : 'Saved for all browsers.';
        } catch (err) {
          state.status.textContent = err.message;
          throw err;
        }
      },
      unmount(el) { panels.delete(el); },
    });
  },
};

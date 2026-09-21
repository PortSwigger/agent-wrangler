# AGENTS.md

## Invariants & footguns

- **The extensions API has its own document: [`docs/extensions.md`](docs/extensions.md).**
  Everything about manifests, the loader and quarantine posture, installation
  and provenance, the `host` façade and its capabilities, the client slots and
  the settings vocabulary lives there rather than here — it had grown to the
  point where it was the whole of this file. **Read it in full before touching
  `server/extensions/**`, `server/host-api/**`, `public/slots.js` or
  `public/extensions*.js`**; it is dense with invariants that are not
  recoverable from the code, and nothing in it is optional background.

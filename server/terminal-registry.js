// Ephemeral in-memory registry of plain-shell tmux sessions opened in the board.
// Never persisted: after a restart no browser can attach to a shell opened before it.
export class TerminalRegistry {
  constructor() {
    this._map = new Map(); // terminalId -> { tmuxName, socket, cwd, command?, detachable? }
  }

  set(terminalId, entry) {
    this._map.set(terminalId, entry);
  }

  get(terminalId) {
    return this._map.get(terminalId) ?? null;
  }

  remove(terminalId) {
    return this._map.delete(terminalId);
  }
}

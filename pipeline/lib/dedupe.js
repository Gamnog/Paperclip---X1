const fs = require('fs');
const path = require('path');

// Tracks which decisions have already been included in a digest, keyed by a
// stable id (case ref). Retention is minimal by design (FIR-16 §6): we only
// keep the id + when it was first seen, not the underlying document content —
// full decision content is re-fetched from the source at digest-build time.

class SeenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  has(id) {
    return Object.prototype.hasOwnProperty.call(this.data, id);
  }

  markSeen(id, meta = {}) {
    this.data[id] = { firstSeenAt: new Date().toISOString(), ...meta };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

module.exports = { SeenStore };

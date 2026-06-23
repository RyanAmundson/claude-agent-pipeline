import { connect } from './ws-client.js';

export class StreamDock {
  constructor({ port, uuid, registerEvent }) {
    this.port = port; this.uuid = uuid; this.registerEvent = registerEvent;
    this.handlers = new Map();   // eventName → cb
    this.ws = null;
  }
  on(eventName, cb) { this.handlers.set(eventName, cb); }
  onConnected(cb) { this._connectedCb = cb; }

  connect() {
    this.ws = connect({
      port: this.port,
      onOpen: () => {
        this._send({ event: this.registerEvent, uuid: this.uuid });
        this._connectedCb && this._connectedCb();
      },
      onMessage: (text) => {
        let ev; try { ev = JSON.parse(text); } catch { return; }
        const cb = this.handlers.get(ev.event);
        if (cb) cb(ev);
      },
    });
  }
  _send(obj) { this.ws.send(JSON.stringify(obj)); }

  setImage(context, image, state) {
    this._send({ event: 'setImage', context, payload: state == null ? { image } : { image, state } });
  }
  setTitle(context, title) {
    this._send({ event: 'setTitle', context, payload: { title: String(title) } });
  }
  setState(context, state) {
    this._send({ event: 'setState', context, payload: { state } });
  }
}

import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub that fans engine events out to every connected
 * Server-Sent Events client.
 *
 * Event types: run:created, run:updated, run:finished, result:updated,
 * log, analysis:updated, run-analysis:updated.
 */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(type, data) {
    this.emit('event', { type, data, ts: Date.now() });
  }

  /** Express handler for GET /api/events. */
  sseHandler() {
    return (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);

      const onEvent = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      this.on('event', onEvent);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

      req.on('close', () => {
        clearInterval(heartbeat);
        this.off('event', onEvent);
      });
    };
  }
}

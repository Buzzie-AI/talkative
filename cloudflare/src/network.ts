export class Network {
  private nodes: Map<string, { ws: WebSocket; busy: boolean }> = new Map();
  private pending: Map<string, (result: string) => void> = new Map();

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Node connecting as a worker
    if (url.pathname === '/node') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      const nodeId = crypto.randomUUID();
      (server as any)._nodeId = nodeId;
      this.nodes.set(nodeId, { ws: server, busy: false });
      server.send(JSON.stringify({ type: 'registered', node_id: nodeId }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Human submitting a task
    if (url.pathname === '/task' && request.method === 'POST') {
      const { text } = await request.json() as { text: string };
      const freeNodes = [...this.nodes.entries()].filter(([, n]) => !n.busy);
      if (freeNodes.length === 0) {
        return new Response(JSON.stringify({ error: 'No free nodes available' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const [nodeId, node] = freeNodes[Math.floor(Math.random() * freeNodes.length)];
      const taskId = crypto.randomUUID();
      node.busy = true;
      node.ws.send(JSON.stringify({ type: 'task', task_id: taskId, text }));

      const result = await new Promise<string>((resolve, reject) => {
        this.pending.set(taskId, resolve);
        setTimeout(() => {
          this.pending.delete(taskId);
          const n = this.nodes.get(nodeId);
          if (n) n.busy = false;
          reject(new Error('Task timed out'));
        }, 600_000);
      });

      return new Response(JSON.stringify({ node_id: nodeId, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Network status
    if (url.pathname === '/status') {
      const nodes = [...this.nodes.entries()].map(([id, n]) => ({
        node_id: id,
        busy: n.busy,
      }));
      return new Response(JSON.stringify({ nodes }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string) {
    const msg = JSON.parse(message);
    if (msg.type === 'result') {
      const resolve = this.pending.get(msg.task_id);
      if (resolve) {
        this.pending.delete(msg.task_id);
        const nodeId = (ws as any)._nodeId;
        const node = this.nodes.get(nodeId);
        if (node) node.busy = false;
        resolve(msg.text);
      }
    }
  }

  webSocketClose(ws: WebSocket) {
    const nodeId = (ws as any)._nodeId;
    if (nodeId) this.nodes.delete(nodeId);
  }
}

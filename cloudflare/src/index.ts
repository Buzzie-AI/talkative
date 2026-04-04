import { Network } from './network';
export { Network };

export default {
  async fetch(request: Request, env: { NETWORK: DurableObjectNamespace }): Promise<Response> {
    const id = env.NETWORK.idFromName('global');
    const stub = env.NETWORK.get(id);
    return stub.fetch(request);
  },
};

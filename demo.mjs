// Entirely synthetic: no claims about a real provider or account.
const address = '0x' + '1'.repeat(40);
export const suite = {
  version: 1, block: '0x1234', label: 'Synthetic fault-injection demo — not live provider data',
  cases: [
    { name: 'chain', method: 'eth_chainId', params: [] },
    { name: 'balance', method: 'eth_getBalance', params: [address, '0x1234'] },
    { name: 'nonce', method: 'eth_getTransactionCount', params: [address, '0x1234'] },
    { name: 'code', method: 'eth_getCode', params: [address, '0x1234'] },
    { name: 'storage', method: 'eth_getStorageAt', params: [address, '0x0', '0x1234'] }
  ]
};
export function demoTransports() {
  return [0, 1].map(side => async request => {
    let result;
    switch (request.method) {
      case 'eth_chainId': result = '0x1'; break;
      case 'eth_getBlockByNumber': result = { number: '0x1234', hash: '0x' + 'a'.repeat(64), parentHash: '0x' + 'b'.repeat(64), transactions: [] }; break;
      case 'eth_getBalance': result = side ? '0x11' : '0x10'; break;
      case 'eth_getTransactionCount': result = side ? '0x01' : '0x1'; break;
      case 'eth_getCode': result = side ? '0x60AB' : '0x60ab'; break;
      case 'eth_getStorageAt':
        return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: side ? 'Synthetic state unavailable' : 'Synthetic pruned state' } };
    }
    return { jsonrpc: '2.0', id: request.id, result };
  });
}

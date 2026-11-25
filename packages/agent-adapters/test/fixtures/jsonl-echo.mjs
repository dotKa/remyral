// JSON-RPC style peer over stdio. 'echo' -> {id, result: params}; 'fail' -> {id, error};
// 'notify' -> a notification and no response. Exits on stdin EOF.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'echo') send({ id: msg.id, result: msg.params });
  if (msg.method === 'fail') send({ id: msg.id, error: { code: -1, message: 'nope' } });
  if (msg.method === 'notify') send({ method: 'note', params: msg.params });
});
rl.on('close', () => process.exit(0));

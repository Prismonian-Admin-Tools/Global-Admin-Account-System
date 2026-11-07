// Minimal SMTP sink: accepts everything, stores raw messages in memory.
const net = require('net');
function startSink(port) {
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = ''; let inData = false; let data = '';
    const say = (l) => sock.write(l + '\r\n');
    say('220 sink ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; messages.push(data); data = ''; say('250 queued'); }
          else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') say('250 sink');
        else if (cmd === 'DATA') { inData = true; say('354 go'); }
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
        else say('250 ok');
      }
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ messages, close: () => server.close() })));
}
module.exports = { startSink };

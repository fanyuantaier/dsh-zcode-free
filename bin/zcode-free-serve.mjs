#!/usr/bin/env node
import { buildServer, args } from '../server.mjs';
import { resolveCredential } from '../lib/zcode-upstream.mjs';

const options = args();
const server = buildServer({ ...options, env: process.env });
server.on('error', (error) => {
  console.error('dsh-zcode-free: cannot bind ' + options.host + ':' + options.port + ' -> ' + error.message);
  process.exit(2);
});
server.listen(options.port, options.host, () => {
  console.log('dsh-zcode-free listening on http://' + options.host + ':' + options.port);
  console.log('  models  GET  http://' + options.host + ':' + options.port + '/v1/models');
  console.log('  balance GET  http://' + options.host + ':' + options.port + '/v1/balance');
  console.log('  chat    POST http://' + options.host + ':' + options.port + '/v1/chat/completions');
  const credential = resolveCredential(process.env);
  if (credential && !credential.error) {
    console.log('  login   ' + credential.jwt_source + ' / ' + credential.device_source + ' / app ' + credential.app_version);
  } else {
    console.log('  login   ' + (credential && credential.error) || 'no ZCode login found');
  }
});

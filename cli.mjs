import { resolveCredential, fetchEntitledModels, fetchModels, fetchBalance, chatMessages } from './lib/zcode-upstream.mjs';
import { openaiToAnthropic, anthropicToOpenai, anthropicSseToOpenai, mapStopReason } from './lib/translate.mjs';

const command = process.argv[2] || 'help';

function bail(message) {
  console.error('ERROR ' + message);
  process.exit(1);
}

function credential() {
  const cred = resolveCredential();
  if (!cred) bail('No ZCode login found. Log in to ZCode once, or set ZCODE_JWT.');
  if (cred.error) bail(cred.error);
  return cred;
}

// anthropicSseToOpenai 是异步生成器（上游 SSE 是异步流），不能用同步 spread 收集。
async function collectAsync(generator) {
  const out = [];
  for await (const item of generator) out.push(item);
  return out;
}

async function selftest() {
  let passed = 0;
  const assert = (name, condition, detail) => {
    if (!condition) bail('selftest FAILED: ' + name + (detail ? ' -> ' + detail : ''));
    passed++;
    console.log('  ok  ' + name);
  };

  const request = {
    model: 'glm-5.3-flash',
    max_tokens: 128,
    stream: false,
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'system', content: 'Never lie.' },
      { role: 'user', content: 'Say hi' },
      { role: 'assistant', content: 'Hi', tool_calls: [{ id: 'call_1', function: { name: 'get_time', arguments: '{"zone":"Asia/Shanghai"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '17:20' },
      { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
    ],
    tools: [{ type: 'function', function: { name: 'get_time', description: 'Get time', parameters: { type: 'object', properties: { zone: { type: 'string' } } } } }],
  };

  const body = openaiToAnthropic(request);
  assert('system merged into one array', Array.isArray(body.system) && body.system.length === 2);
  assert('system text concatenated', body.system.map((b) => b.text).join(' ').includes('You are terse.') && body.system.map((b) => b.text).join(' ').includes('Never lie.'));
  assert('roles alternate (tool_result merges into the following user turn)', JSON.stringify(body.messages.map((m) => m.role)) === JSON.stringify(['user', 'assistant', 'user']));
  assert('tool_result attached with tool_use_id', body.messages[2].content[0].type === 'tool_result' && body.messages[2].content[0].tool_use_id === 'call_1');
  assert('user text merges after the tool_result block', body.messages[2].content[1].type === 'text' && body.messages[2].content[1].text === 'Thanks');
  assert('tool_use input parsed to an object', body.messages[1].content[1].type === 'tool_use' && body.messages[1].content[1].input.zone === 'Asia/Shanghai');
  assert('tools carry input_schema', body.tools && body.tools.length === 1 && body.tools[0].input_schema.type === 'object');
  assert('tool_choice default is auto', JSON.stringify(body.tool_choice) === JSON.stringify({ type: 'auto' }));
  assert('max_tokens forwarded', body.max_tokens === 128);
  assert('model forwarded', body.model === 'glm-5.3-flash');

  const noneBody = openaiToAnthropic({ ...request, tool_choice: 'none' });
  assert('tool_choice none drops tools', !('tools' in noneBody) && !('tool_choice' in noneBody));
  const namedBody = openaiToAnthropic({ ...request, tool_choice: { type: 'function', function: { name: 'get_time' } } });
  assert('tool_choice function maps to tool', JSON.stringify(namedBody.tool_choice) === JSON.stringify({ type: 'tool', name: 'get_time' }));
  const namedCall = openaiToAnthropic({ model: 'glm-5.3-flash', max_tokens: 32, messages: [{ role: 'user', content: 'go' }], tools: request.tools, tool_choice: { type: 'function', function: { name: 'get_time' } } });
  assert('tool_choice function with one tool keeps tools', namedCall.tools.length === 1 && namedCall.tool_choice.name === 'get_time');
  const namedCall2 = openaiToAnthropic({ model: 'glm-5.3-flash', max_tokens: 32, messages: [{ role: 'user', content: 'go' }], tools: request.tools, tool_choice: { type: 'function', function: { name: 'get_time' } } });
  assert('tool_choice function keeps tools present', namedCall2.tools.length === 1);
  const imageBody = openaiToAnthropic({ model: 'glm-5.3-flash', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }, { type: 'text', text: 'what?' }] }] });
  assert('data-url image becomes an anthropic image block', imageBody.messages[0].content.some((b) => b.type === 'image' && b.source.type === 'base64' && b.source.media_type === 'image/png'));
  const assistantFirst = openaiToAnthropic({ model: 'glm-5.3-flash', max_tokens: 32, messages: [{ role: 'assistant', content: 'Hello' }] });
  assert('conversation is forced to start with a user message', assistantFirst.messages[0].role === 'user' && assistantFirst.messages[1].role === 'assistant');
  const noTools = openaiToAnthropic({ model: 'glm-5.3-flash', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] });
  assert('no tools means no tool block', !('tools' in noTools) && !('tool_choice' in noTools));

  const response = {
    id: 'msg_1',
    model: 'glm-5.3-flash',
    content: [{ type: 'text', text: 'The time is ' }, { type: 'tool_use', id: 'call_9', name: 'get_time', input: { zone: 'UTC' } }, { type: 'text', text: 'done.' }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 11, output_tokens: 7 },
  };
  const openai = anthropicToOpenai(response, 'glm-5.3-flash', 'chatcmpl-fallback');
  assert('completion id kept', openai.id === 'msg_1');
  assert('finish_reason maps tool_use', openai.choices[0].finish_reason === 'tool_calls');
  assert('tool_calls serialized as JSON arguments', openai.choices[0].message.tool_calls[0].function.arguments === '{"zone":"UTC"}');
  assert('usage mapped', openai.usage.prompt_tokens === 11 && openai.usage.completion_tokens === 7 && openai.usage.total_tokens === 18);

  assert('stop_reason maps length', mapStopReason('max_tokens') === 'length');
  assert('stop_reason maps stop', mapStopReason('end_turn') === 'stop');

  const frames = [
    { event: 'message_start', data: { message: { id: 'msg_s', usage: { input_tokens: 3 } } } },
    { event: 'content_block_start', data: { index: 0, content_block: { type: 'text' } } },
    { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
    { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'lo' } } },
    { event: 'content_block_stop', data: { index: 0 } },
    { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
    { event: 'message_stop', data: {} },
  ];
  const text = (await collectAsync(anthropicSseToOpenai(frames, 'glm-5.3-flash'))).join('');
  const lines = text.split('\n\n').filter(Boolean);
  assert('stream emits only message events plus [DONE]', lines.every((l) => l.startsWith('event: message') || l.startsWith('data: [DONE]')), text);
  assert('stream ends with [DONE]', text.trim().endsWith('data: [DONE]'));
  const firstChunk = JSON.parse(lines[0].split('\n').find((l) => l.startsWith('data:')).slice(5));
  assert('stream chunk carries text delta', firstChunk.choices[0].delta.content === 'Hel' && firstChunk.id === 'msg_s');
  const secondChunk = JSON.parse(lines[1].split('\n').find((l) => l.startsWith('data:')).slice(5));
  assert('stream deltas arrive as separate chunks', secondChunk.choices[0].delta.content === 'lo');
  assert('two text deltas concatenate to the final text', (firstChunk.choices[0].delta.content || '') + (secondChunk.choices[0].delta.content || '') === 'Hello');
  const tail = lines.filter((l) => l.startsWith('event: message')).pop().split('\n').find((l) => l.startsWith('data:')).slice(5);
  const tailChunk = JSON.parse(tail);
  assert('stream terminal chunk carries finish_reason and usage', tailChunk.choices[0].finish_reason === 'stop' && tailChunk.usage.total_tokens === 5);

  const errorFrames = [{ event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'boom' } } }];
  const errorText = (await collectAsync(anthropicSseToOpenai(errorFrames, 'glm-5.3-flash'))).join('');
  assert('stream errors are surfaced as an event: error frame', errorText.includes('event: error') && errorText.includes('"boom"'));

  console.log('\nselftest: ' + passed + ' assertions passed');
}

async function run(command, arg) {
  const cred = credential();
  if (command === 'models') {
    const result = await fetchEntitledModels(cred);
    if (!result.ok) bail('upstream error ' + result.error + ' ' + truncate(result.text));
    for (const model of result.models) {
      console.log(model.id + '  ctx ' + (model.contextWindow || '?') + ' max ' + (model.maxTokens || '?') + '  free remaining ' + (model.remainingTokens ?? '?') + ' / ' + (model.totalTokens ?? '?'));
    }
    return;
  }
  if (command === 'catalog') {
    const result = await fetchModels(cred);
    if (!result.ok) bail('upstream error ' + result.error + ' ' + truncate(result.text));
    for (const model of result.models) {
      console.log(model.id + '  ctx ' + (model.contextWindow || '?') + ' max ' + (model.maxTokens || '?') + '  remaining ' + (model.remainingTokens ?? '?') + ' / ' + (model.totalTokens ?? '?'));
    }
    return;
  }
  if (command === 'balance') {
    const result = await fetchBalance(cred);
    if (!result.ok) bail('upstream error ' + result.error + ' ' + truncate(result.text));
    console.log('plans:');
    for (const plan of result.plans) console.log('  ' + plan.name + ' [' + plan.status + '] ' + plan.id);
    console.log('buckets:');
    for (const bucket of result.buckets) console.log('  ' + (bucket.label || bucket.model) + '  remaining ' + bucket.remaining + ' / ' + bucket.total + '  used ' + bucket.used);
    return;
  }
  if (command === 'chat') {
    const prompt = arg || 'Reply with exactly: OK';
    const body = openaiToAnthropic({ model: 'glm-5.3-flash', max_tokens: 64, messages: [{ role: 'user', content: prompt }] });
    const result = await chatMessages(cred, { ...body, stream: false });
    if (!result.ok || result.error) {
      console.log('status ' + result.status + ' error ' + result.error);
      console.log(truncate(result.text, 800));
      return;
    }
    console.log(JSON.stringify(anthropicToOpenai(result.json, 'glm-5.3-flash', 'chatcmpl-cli'), null, 2));
    return;
  }
  if (command === 'json') {
    const prompt = arg || 'Reply with exactly: OK';
    const body = openaiToAnthropic({ model: 'glm-5.3-flash', max_tokens: 64, messages: [{ role: 'user', content: prompt }] });
    const result = await chatMessages(cred, body);
    if (!result.ok || result.error) {
      console.log('status ' + result.status + ' error ' + result.error);
      console.log(truncate(result.text, 800));
      return;
    }
    console.log('streamed ' + (result.ok ? 'ok' : 'fail'));
    return;
  }
  bail('unknown command ' + command);
}

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? s.slice(0, n) + '...' : s;
}

if (command === 'selftest') {
  selftest().catch((error) => bail(error.message));
} else if (command === 'help' || command === undefined) {
  console.log('usage: node cli.mjs <models|catalog|balance|chat [prompt]|json [prompt]|selftest>');
} else {
  run(command, process.argv[3]).catch((error) => bail(error.message));
}
